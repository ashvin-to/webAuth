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
let lastErrorMsg = null;
let isJoined = false;

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

function isFailureMessage(msg) {
    return /peer failed|Ice connection failed|Connection failed|Cannot create so many PeerConnections|setRemoteDescription|set remote answer/i.test(msg);
}

function isResourceExhaustion(msg) {
    return /Cannot create so many PeerConnections/i.test(msg);
}

function scheduleBackoff() {
    consecutiveFailures = 0;
    backoffAttempt++;
    const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, backoffAttempt - 1), BACKOFF_MAX_MS);
    backoffUntil = Date.now() + delay;

    // Leave frees the accumulated RTCPeerConnections so the browser cap clears.
    try { leave(); } catch (e) {}

    backoffReason = 'WebRTC appears blocked on this network — retrying automatically in ' + Math.round(delay / 1000) + 's.';
    errorCallbacks.forEach(cb => {
        try { cb(backoffReason); } catch (e) {}
    });

    if (backoffRetryTimer) clearTimeout(backoffRetryTimer);
    backoffRetryTimer = setTimeout(() => {
        backoffRetryTimer = null;
        backoffAttempt = 0;
        if (lastJoinCredential) {
            join().catch(() => {});
        }
    }, delay);
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
        notifyPeerChange(peerId, 'join');
    });
    room.onPeerLeave(peerId => {
        allPeers.delete(peerId);
        peerCount = allPeers.size;
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

    if (isJoined && activeRooms.length > 0) {
        return true;
    }

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
        isJoined = false;
        setActive(false);
        return false;
    }

    isJoined = true;
    setActive(true);
    notifyPeerChange();
    return true;
}

function broadcast(serializedPayload) {
    if (!isJoined || activeRooms.length === 0) return false;
    const msgObj = {
        deviceId: getDeviceId(),
        payload: serializedPayload
    };
    const serialized = JSON.stringify(msgObj);
    let any = false;
    for (const { room } of activeRooms) {
        try {
            if (room && room.__sendVault) {
                const res = room.__sendVault(serialized);
                // sendVault may reject asynchronously (null data-channel during
                // teardown when WebRTC is blocked) — swallow it to avoid an
                // unhandledrejection.
                if (res && typeof res.catch === 'function') res.catch(() => {});
                any = true;
            }
        } catch (err) {}
    }
    return any;
}

function leave() {
    for (const { room } of activeRooms) {
        try {
            // Trystero's leave() is async and internally destroys peers, which can
            // reject asynchronously (e.g. a null data-channel during teardown when
            // WebRTC is blocked). A sync try/catch won't swallow that rejection, so
            // attach .catch() to the returned promise to avoid an unhandledrejection.
            const res = room.leave();
            if (res && typeof res.catch === 'function') res.catch(() => {});
        } catch (e) {}
    }
    activeRooms = [];
    allPeers.clear();
    peerCount = 0;
    strategyStatus = [];
    backoffReason = null;
    sendVaultAction = null;
    getVaultAction = null;
    isJoined = false;
    setActive(false);
    notifyPeerChange();
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

function isConnected() {
    return isJoined;
}

function onError(cb) {
    if (typeof cb === 'function') {
        errorCallbacks.add(cb);
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
    onReceive,
    onPeerChange,
    onError,
    getLastError,
    getStrategyStatus,
    getPeerCount,
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
    isConnected: () => isJoined
};
