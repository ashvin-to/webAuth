/**
 * Real-Time WebRTC P2P Sync Engine powered by Trystero (Torrent strategy)
 * Direct browser-to-browser encrypted vault synchronization.
 *
 * SECURITY — Pairing Protocol v2:
 *   - Room discovery uses a RANDOM pairing credential (64 hex chars / 256 bits),
 *     NEVER the master password.
 *   - The pairing credential is generated with crypto.getRandomValues().
 *   - QR pairing encodes only the random credential, never the master password.
 *   - Vault sync payloads are encrypted with the master password using
 *     AES-256-GCM before leaving the browser.
 *   - TURN/signaling infrastructure is untrusted — it only sees encrypted
 *     ciphertext and cannot decrypt vault contents.
 *   - Device IDs (localStorage) are NOT cryptographic authentication. They are
 *     used for UX (peer approval prompts) only. A malicious peer on the same
 *     room cannot read vault data without the master password.
 *
 * SECURITY — TURN Trust Model:
 *   The default TURN credentials (openrelayproject) are PUBLIC, shared
 *   credentials for a free relay service. They are NOT private secrets.
 *   All vault data transiting TURN is AES-256-GCM encrypted end-to-end.
 */

const STORAGE_KEY_ROOM = 'webauth_trystero_room';
const STORAGE_KEY_ACTIVE = 'webauth_trystero_active';

// SECURITY: These are PUBLIC shared credentials for a free TURN relay,
// not private secrets. All vault data is encrypted end-to-end (AES-256-GCM)
// before reaching any relay infrastructure.
const ICE_SERVERS = [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
        urls: [
            'turn:openrelay.metered.ca:80',
            'turn:openrelay.metered.ca:443',
            'turn:openrelay.metered.ca:443?transport=tcp'
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject'
    }
];

// Curated public WebSocket trackers for the torrent signaling strategy.
// NOTE: tracker.btorrent.xyz was probed and removed (returning 502 / down).
const TRACKER_URLS = [
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.openwebtorrent.com:443/announce'
];

// Public Nostr relays that accept Trystero's ephemeral kind 29333 signaling events.
const NOSTR_RELAY_URLS = [
    'wss://nos.lol',
    'wss://relay.snort.social',
    'wss://relay.nostr.net',
    'wss://nostr.mom',
    'wss://relay.primal.net'
];

// SECURITY: Trystero is now VENDORED locally (bundled single-file ESM via
// esbuild under vendor/trystero-esm/) so no third-party CDN JavaScript is ever
// executed. This also lets us enforce a strict Content-Security-Policy
// (script-src 'self') without allowing jsDelivr's dynamically-injected inline
// module scripts, which the previous CDN +esm loading triggered. Versions are
// pinned (trystero@0.19.0). The vault data sent through Trystero is always
// AES-256-GCM encrypted with the master password before transmission, so
// Trystero itself never has access to plaintext vault contents.
const STRATEGY_MODULES = [
    { label: 'torrent', module: './vendor/trystero-esm/trystero-torrent.mjs', opts: { relayUrls: TRACKER_URLS } },
    { label: 'nostr', module: './vendor/trystero-esm/trystero-nostr.mjs', opts: { relayUrls: NOSTR_RELAY_URLS } }
];

let sendVaultAction = null;
let getVaultAction = null;
let peerCount = 0;
let receiveCallbacks = new Set();
let peerChangeCallbacks = new Set();
let errorCallbacks = new Set();
let stateChangeCallbacks = new Set();
let lastErrorMsg = null;

// ── P2P Connection State Machine ────────────────────────────────────────────
// Valid states:  idle | signaling | connecting | connected | reconnecting | failed | leaving
// Transitions:
//   idle        → signaling   (join() called, loading strategy modules)
//   signaling   → connecting  (at least one room joined, waiting for peers)
//   connecting  → connected   (first usable peer joined via onPeerJoin)
//   connected   → connecting  (last peer left but rooms still active)
//   connecting  → reconnecting(backoff triggered after ICE failures)
//   connecting  → failed      (all strategies failed during join)
//   connected   → leaving     (leave() called)
//   connecting  → leaving     (leave() called)
//   reconnecting→ signaling   (backoff timer expired, retrying)
//   *           → leaving     (leave() called from any active state)
//   leaving     → idle        (cleanup complete)
let connectionState = 'idle';

// ── Lifecycle guards ────────────────────────────────────────────────────────
// Prevent overlapping join/leave operations which create duplicate rooms or
// leave behind orphaned RTCPeerConnections.
let joinInProgress = false;
let leaveInProgress = false;

// Failure backoff: on restrictive networks every connection attempt fails, and
// Trystero re-announces every ~5s, accumulating RTCPeerConnections until the
// browser throws "Cannot create so many PeerConnections". When enough
// consecutive failures occur with zero connected peers, pause to free them,
// then auto-retry with exponential backoff instead of disabling sync.
let consecutiveFailures = 0;
let backoffUntil = 0;
let backoffReason = null;
let backoffRetryTimer = null;
let backoffAttempt = 0;
let lastJoinCredential = null;
const FAILURE_THRESHOLD = 5;
const BACKOFF_BASE_MS = 30 * 1000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const MAX_BACKOFF_RETRIES = 6;

function isFailureMessage(msg) {
    return /peer failed|Ice connection failed|Connection failed|Cannot create so many PeerConnections|setRemoteDescription|set remote answer/i.test(msg);
}

function isResourceExhaustion(msg) {
    return /Cannot create so many PeerConnections/i.test(msg);
}

function setConnectionState(newState) {
    const prev = connectionState;
    if (prev === newState) return;
    connectionState = newState;
    stateChangeCallbacks.forEach(cb => {
        try { cb(newState, prev); } catch (e) {}
    });
}

function scheduleBackoff() {
    consecutiveFailures = 0;
    backoffAttempt++;

    // ── Max retries reached — stop auto-retrying, let the user decide. ──
    if (backoffAttempt > MAX_BACKOFF_RETRIES) {
        cleanupRooms();
        setConnectionState('failed');
        backoffReason = 'Connection failed after ' + MAX_BACKOFF_RETRIES + ' attempts. Use \u201cRetry connection\u201d to try again.';
        errorCallbacks.forEach(cb => {
            try { cb(backoffReason); } catch (e) {}
        });
        return;
    }

    const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, backoffAttempt - 1), BACKOFF_MAX_MS);
    backoffUntil = Date.now() + delay;

    // Leave frees the accumulated RTCPeerConnections so the browser cap clears.
    // Use internal cleanup to avoid resetting state to idle — we want reconnecting.
    cleanupRooms();
    setConnectionState('reconnecting');

    backoffReason = 'WebRTC appears blocked on this network — retrying automatically in ' + Math.round(delay / 1000) + 's.';
    errorCallbacks.forEach(cb => {
        try { cb(backoffReason); } catch (e) {}
    });

    if (backoffRetryTimer) clearTimeout(backoffRetryTimer);
    backoffRetryTimer = setTimeout(() => {
        backoffRetryTimer = null;
        if (lastJoinCredential) {
            join().catch(() => {});
        }
    }, delay);
}

/**
 * Internal room cleanup shared by scheduleBackoff() and leave().
 * Does NOT change connectionState — callers set it afterwards.
 */
function cleanupRooms() {
    for (const { room } of activeRooms) {
        try {
            const res = room.leave();
            if (res && typeof res.catch === 'function') res.catch(() => {});
        } catch (e) {}
    }
    activeRooms = [];
    allPeers.clear();
    peerCount = 0;
    strategyStatus = [];
    sendVaultAction = null;
    getVaultAction = null;
    setActive(false);
    notifyPeerChange();
}

function notifyError(msg) {
    lastErrorMsg = msg;

    const isFailure = isFailureMessage(msg);
    if (isFailure) {
        consecutiveFailures++;
        // Resource exhaustion (PeerConnection cap) is an immediate backoff
        // signal — do not wait for the normal threshold.
        const shouldBackoff = isResourceExhaustion(msg)
            ? Date.now() >= backoffUntil
            : (consecutiveFailures >= FAILURE_THRESHOLD && getPeerCount() === 0 && Date.now() >= backoffUntil);
        if (shouldBackoff) {
            scheduleBackoff();
            return;
        }
    }

    errorCallbacks.forEach(cb => {
        try { cb(msg); } catch (e) {}
    });
}

if (typeof window !== 'undefined') {
    window.addEventListener('error', (e) => {
        if (e && e.message && isFailureMessage(e.message)) {
            notifyError(e.message);
        }
    });

    window.addEventListener('unhandledrejection', (e) => {
        if (e && e.reason) {
            const msg = e.reason && e.reason.message || String(e.reason);
            // Expected Trystero teardown races (e.g. null data channel while a
            // peer is being destroyed on an ICE-failed connection). Suppress the
            // browser's "Uncaught (in promise)" console error — ICE failures are
            // already surfaced via notifyError/backoff; this rejection is send
            // noise and must not spam the console.
            if (/channel is null|cannot access property "bufferedAmount"|trystero/i.test(msg)) {
                if (e.preventDefault) e.preventDefault();
                return;
            }
            if (isFailureMessage(msg)) {
                notifyError(msg);
            }
        }
    });

    // Peer failures (ICE/connection failed, datachannel errors) are dispatched
    // by the vendored Trystero glue as a CustomEvent so they feed the failure
    // backoff without surfacing as uncaught errors.
    window.addEventListener('trystero-peer-error', (e) => {
        if (e && e.detail) {
            notifyError(e.detail);
        }
    });
}

const ROOM_ID_SALT = 'webauth-vault-trystero-room-v2';

/**
 * SECURITY: Generate a cryptographically random pairing credential.
 * 32 bytes (256 bits) encoded as hex. Used for room discovery — the master
 * password is NEVER used for room ID derivation.
 */
function generatePairingCredential() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getDeviceId() {
    let id = localStorage.getItem('webauth_device_id');
    if (!id || typeof id !== 'string' || id.length < 8) {
        // SECURITY: Device IDs use CSPRNG but are NOT cryptographic
        // authentication. They are used for UX (peer approval prompts) only.
        const randomBuffer = new Uint8Array(8);
        crypto.getRandomValues(randomBuffer);
        id = Array.from(randomBuffer).map(b => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('webauth_device_id', id);
    }
    return id;
}

function getTrustedPeers() {
    try {
        const saved = localStorage.getItem('webauth_trusted_peers');
        return new Set(saved ? JSON.parse(saved) : []);
    } catch (e) {
        return new Set();
    }
}

function approvePeer(deviceId) {
    if (!deviceId) return;
    const peers = getTrustedPeers();
    peers.add(deviceId);
    localStorage.setItem('webauth_trusted_peers', JSON.stringify(Array.from(peers)));
}

function isPeerApproved(deviceId) {
    if (!deviceId) return false;
    if (deviceId === getDeviceId()) return true;
    return getTrustedPeers().has(deviceId);
}

const STORAGE_KEY_CUSTOM_PASS = 'webauth_trystero_custom_pass';
const STORAGE_KEY_TURN = 'webauth_turn_servers';

// Custom TURN relays entered in the P2P modal. Free/public TURN is unreliable
// and some networks block UDP, so allow the user to supply their own
// relay (e.g. a self-hosted coturn on a VPS) to punch through restrictive NATs.
function getTurnServers() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_TURN);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

function setTurnServers(servers) {
    const list = Array.isArray(servers) ? servers.filter(s => s && s.urls) : [];
    try {
        if (list.length) {
            localStorage.setItem(STORAGE_KEY_TURN, JSON.stringify(list));
        } else {
            localStorage.removeItem(STORAGE_KEY_TURN);
        }
    } catch (e) {}
    return list.length;
}

function getIceServers() {
    const custom = getTurnServers();
    if (!custom.length) return ICE_SERVERS;
    return ICE_SERVERS.concat(custom);
}

function getWeekNumber(daysOffset = 0) {
    const timestamp = Date.now() + (daysOffset * 86400 * 1000);
    return Math.floor(timestamp / (7 * 24 * 60 * 60 * 1000));
}

/**
 * SECURITY: Derive room ID from the random pairing credential, NOT from the
 * master password. The credential is a 256-bit random value, so SHA-256 hashing
 * does not enable password guessing (there is no password to guess).
 */
async function deriveRoomId(credential, daysOffset = 0) {
    if (!credential) return null;
    const weekNum = getWeekNumber(daysOffset);
    const enc = new TextEncoder();
    const data = enc.encode(credential + ROOM_ID_SALT + '-week-' + weekNum);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Get the stored pairing credential (encrypted at rest via SecretStore).
 * This is the random pairing secret, NEVER the master password.
 */
async function getCustomPassphrase() {
    const raw = localStorage.getItem(STORAGE_KEY_CUSTOM_PASS) || '';
    if (!raw) return '';
    if (window.SecretStore) {
        try {
            const value = await SecretStore.open(raw);
            if (value === null) return '';
            // Legacy plaintext value (written before SecretStore existed) — re-seal now.
            if (typeof value === 'string' && !raw.startsWith('v1:') && value) {
                try {
                    await setCustomPassphrase(value);
                } catch (e) {}
            }
            return value || '';
        } catch (e) {
            return '';
        }
    }
    return raw;
}

async function setCustomPassphrase(pass) {
    if (pass && pass.trim()) {
        let stored = pass.trim();
        if (window.SecretStore) {
            try {
                stored = await SecretStore.seal(stored);
            } catch (e) {}
        }
        localStorage.setItem(STORAGE_KEY_CUSTOM_PASS, stored);
    } else {
        localStorage.removeItem(STORAGE_KEY_CUSTOM_PASS);
    }
}

// Eagerly re-seal any legacy plaintext passphrase written before SecretStore
// existed, so the raw value is removed from storage even if nothing reads it.
async function migrateLegacyCustomPassphrase() {
    const raw = localStorage.getItem(STORAGE_KEY_CUSTOM_PASS) || '';
    if (!raw || raw.startsWith('v1:')) return;
    if (!window.SecretStore) return;
    try {
        await setCustomPassphrase(raw);
    } catch (e) {}
}
if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', () => {
        migrateLegacyCustomPassphrase().catch(() => {});
    });
}

function isActive() {
    return localStorage.getItem(STORAGE_KEY_ACTIVE) === 'true';
}

function setActive(active) {
    localStorage.setItem(STORAGE_KEY_ACTIVE, active ? 'true' : 'false');
}

function notifyPeerChange(peerId, action) {
    peerChangeCallbacks.forEach(cb => {
        try { cb(peerCount, peerId, action); } catch (e) {}
    });
}

let activeRooms = [];
let allPeers = new Set();
let strategyStatus = [];

function makeRtcOpts(strategyOpts, credential) {
    const iceServers = getIceServers();
    return {
        appId: 'webauth-vault-sync',
        // SECURITY: 'password' is Trystero's room namespace filter, NOT an
        // encryption key. It is the random pairing credential, never the
        // master password.
        password: credential,
        rtcConfig: { iceServers },
        config: { iceServers },
        iceServers,
        ...strategyOpts
    };
}

function wireRoom(room) {
    const [sendVault, getVault] = room.makeAction('vault');
    getVault(handleIncomingVaultMessage);
    room.onPeerJoin(peerId => {
        consecutiveFailures = 0;
        backoffAttempt = 0;
        backoffReason = null;
        allPeers.add(peerId);
        peerCount = allPeers.size;
        // First usable peer: transition connecting → connected
        if (peerCount > 0 && (connectionState === 'connecting' || connectionState === 'signaling')) {
            setConnectionState('connected');
        }
        notifyPeerChange(peerId, 'join');
    });
    room.onPeerLeave(peerId => {
        allPeers.delete(peerId);
        peerCount = allPeers.size;
        // Last peer left: transition connected → connecting (still in rooms, waiting)
        if (peerCount === 0 && connectionState === 'connected') {
            setConnectionState('connecting');
        }
        notifyPeerChange(peerId, 'leave');
    });
    room.__sendVault = sendVault;
}

const handleIncomingVaultMessage = (rawMessage, peerId) => {
    let deviceId = peerId;
    let payload = rawMessage;
    try {
        const parsed = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : rawMessage;
        if (parsed && parsed.deviceId && parsed.payload) {
            deviceId = parsed.deviceId;
            payload = parsed.payload;
        }
    } catch (e) {}

    receiveCallbacks.forEach(cb => {
        try { cb(payload, peerId, deviceId); } catch (e) {}
    });
};

/**
 * Join P2P sync rooms using the stored pairing credential.
 *
 * SECURITY: If no credential exists, one is auto-generated with CSPRNG.
 * The master password is NEVER used for room discovery or as a Trystero
 * room password.
 */
async function join() {
    // Guard: do not create overlapping join operations.
    if (joinInProgress) return false;
    // Guard: wait for any in-progress leave to finish.
    if (leaveInProgress) return false;

    joinInProgress = true;
    try {
        let credential = await getCustomPassphrase();
        if (!credential) {
            // SECURITY: Auto-generate a random pairing credential on first use.
            credential = generatePairingCredential();
            await setCustomPassphrase(credential);
        }

        lastJoinCredential = credential;
        const roomIdCurrent = await deriveRoomId(credential, 0);
        const roomIdPrev = await deriveRoomId(credential, -7);
        if (!roomIdCurrent) return false;

        // Already joined and rooms are active — no-op.
        if (connectionState !== 'idle' && connectionState !== 'failed' && connectionState !== 'reconnecting' && activeRooms.length > 0) {
            return true;
        }

        setConnectionState('signaling');
        let joinedAny = false;
        strategyStatus = [];

        for (const strat of STRATEGY_MODULES) {
            try {
                const { joinRoom } = await import(strat.module);
                const room = joinRoom(makeRtcOpts(strat.opts, credential), roomIdCurrent);
                wireRoom(room);
                activeRooms.push({ room, label: strat.label });
                strategyStatus.push(strat.label + ': joined');
                joinedAny = true;

                // Overlap secondary room for previous week
                try {
                    const secRoom = joinRoom(makeRtcOpts(strat.opts, credential), roomIdPrev);
                    wireRoom(secRoom);
                    activeRooms.push({ room: secRoom, label: strat.label + '-prev' });
                } catch (secErr) {}
            } catch (err) {
                strategyStatus.push(strat.label + ': failed (' + (err && err.message || err) + ')');
                notifyError('P2P signaling unavailable via ' + strat.label + (err && err.message ? ' (' + err.message + ')' : ''));
            }
        }

        if (!joinedAny) {
            setConnectionState('failed');
            setActive(false);
            return false;
        }

        // Rooms joined, waiting for peers — transition to connecting.
        // If peers are already present (unlikely but possible in fast reconnect),
        // wireRoom's onPeerJoin will promote to 'connected'.
        if (connectionState === 'signaling') {
            setConnectionState('connecting');
        }
        setActive(true);
        notifyPeerChange();
        return true;
    } finally {
        joinInProgress = false;
    }
}

/**
 * Broadcast an encrypted payload to all connected peers.
 *
 * ASYNC & REJECTION-SAFE:
 *   - Each Trystero send is normalized with Promise.resolve() and individually
 *     awaited so that closed/null data-channel errors are caught per-room.
 *   - Returns true only when ≥1 peer actually accepted the send.
 *   - Returns false when there are no active peers or all sends failed.
 *   - Failed rooms (dead data channels) are removed from activeRooms.
 *   - Never generates an unhandled rejection.
 */
async function broadcast(serializedPayload) {
    if (connectionState !== 'connected' || peerCount === 0 || activeRooms.length === 0) return false;
    const msgObj = {
        deviceId: getDeviceId(),
        payload: serializedPayload
    };
    const serialized = JSON.stringify(msgObj);
    let succeeded = 0;
    const failedRooms = [];

    for (const entry of activeRooms) {
        const { room } = entry;
        try {
            if (room && room.__sendVault) {
                // Normalize: Trystero may return a promise, a value, or throw
                // synchronously. Wrapping in Promise.resolve() covers all cases.
                await Promise.resolve(room.__sendVault(serialized));
                succeeded++;
            }
        } catch (err) {
            const msg = err && err.message || String(err);
            // Classify: channel-is-null, bufferedAmount, closed data channels,
            // and teardown errors are recoverable peer failures.
            if (/channel is null|bufferedAmount|closed|teardown|destroyed/i.test(msg)) {
                failedRooms.push(entry);
            } else {
                // Non-recoverable send error — still mark room as failed
                // so we stop trying it, but don't surface as unhandled rejection.
                failedRooms.push(entry);
            }
        }
    }

    // Remove rooms whose data channel is dead so we don't keep trying them.
    if (failedRooms.length > 0) {
        activeRooms = activeRooms.filter(r => !failedRooms.includes(r));
        // If all rooms failed, transition back to connecting.
        if (activeRooms.length === 0) {
            allPeers.clear();
            peerCount = 0;
            setConnectionState('connecting');
            notifyPeerChange();
        }
    }

    // Return true only when at least one peer actually accepted the send.
    // Do not claim success merely because a room object exists.
    return succeeded > 0;
}

/**
 * Leave all P2P rooms and reset state to idle.
 * Idempotent — safe to call multiple times. Returns a promise so callers
 * can await cleanup completion before starting a new join.
 */
function leave() {
    // Guard: prevent overlapping leave operations.
    if (leaveInProgress) return Promise.resolve();
    // Already idle — nothing to do.
    if (connectionState === 'idle') return Promise.resolve();

    leaveInProgress = true;
    setConnectionState('leaving');

    // Cancel any pending backoff retry so it doesn't fire after leave.
    if (backoffRetryTimer) {
        clearTimeout(backoffRetryTimer);
        backoffRetryTimer = null;
    }
    backoffReason = null;
    backoffAttempt = 0;
    consecutiveFailures = 0;

    cleanupRooms();
    setConnectionState('idle');
    leaveInProgress = false;
    return Promise.resolve();
}

/**
 * Manual retry: reset backoff state and attempt to rejoin.
 * Exposed to the UI so users can retry after the bounded retry limit is hit.
 */
async function retryConnection() {
    // Cancel any pending auto-retry.
    if (backoffRetryTimer) {
        clearTimeout(backoffRetryTimer);
        backoffRetryTimer = null;
    }
    backoffAttempt = 0;
    consecutiveFailures = 0;
    backoffReason = null;
    backoffUntil = 0;
    lastErrorMsg = null;

    // If currently in a non-idle state, leave first.
    if (connectionState !== 'idle') {
        leave();
    }

    if (lastJoinCredential) {
        return join();
    }
    return false;
}

function onReceive(cb) {
    if (typeof cb === 'function') {
        receiveCallbacks.add(cb);
    }
}

function onPeerChange(cb) {
    if (typeof cb === 'function') {
        peerChangeCallbacks.add(cb);
    }
}

function getPeerCount() {
    return peerCount;
}

/**
 * Returns true ONLY when the P2P system is in 'connected' state AND at least
 * one usable peer exists. A joined signaling room with zero peers is NOT
 * considered connected.
 */
function isConnected() {
    return connectionState === 'connected' && peerCount > 0;
}

/**
 * Return the current explicit P2P connection state.
 * One of: idle, signaling, connecting, connected, reconnecting, failed, leaving.
 */
function getConnectionState() {
    return connectionState;
}

/**
 * Returns true when at least one peer is connected and the data channel is
 * ready for encrypted vault transfer. Equivalent to isConnected() — provided
 * as a semantic alias for clarity in calling code.
 */
function isDataChannelReady() {
    return connectionState === 'connected' && peerCount > 0;
}

function onError(cb) {
    if (typeof cb === 'function') {
        errorCallbacks.add(cb);
    }
}

/**
 * Register a callback invoked whenever the connection state changes.
 * Callback signature: (newState: string, previousState: string) => void
 */
function onStateChange(cb) {
    if (typeof cb === 'function') {
        stateChangeCallbacks.add(cb);
    }
}

function getLastError() {
    return lastErrorMsg;
}

function getStrategyStatus() {
    return strategyStatus.slice();
}

window.TrysteroSync = {
    join,
    leave,
    broadcast,
    retryConnection,
    onReceive,
    onPeerChange,
    onError,
    onStateChange,
    getLastError,
    getStrategyStatus,
    getConnectionState,
    getPeerCount,
    isDataChannelReady,
    deriveRoomId,
    getDeviceId,
    getTrustedPeers,
    approvePeer,
    isPeerApproved,
    getCustomPassphrase,
    setCustomPassphrase,
    generatePairingCredential,
    migrateLegacyCustomPassphrase,
    getTurnServers,
    setTurnServers,
    getIceServers,
    isActive,
    setActive,
    isConnected
};
