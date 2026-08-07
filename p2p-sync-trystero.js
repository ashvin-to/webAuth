/**
 * Real-Time WebRTC P2P Sync Engine powered by Trystero (Torrent strategy)
 * Direct browser-to-browser encrypted vault synchronization.
 */

const STORAGE_KEY_ROOM = 'webauth_trystero_room';
const STORAGE_KEY_ACTIVE = 'webauth_trystero_active';

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
const TRACKER_URLS = [
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.btorrent.xyz',
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

// Multiple signaling strategies joined simultaneously. Peers only need ONE shared
// strategy to reach each other, so a blocked tracker or relay no longer kills sync.
// NOTE: Trystero's getRelays reads the `relayUrls` config key for ALL strategies,
// including torrent (the docs' "trackerUrls" is ignored).
const STRATEGY_MODULES = [
    { label: 'torrent', module: 'https://esm.sh/trystero@0.19.0/torrent', opts: { relayUrls: TRACKER_URLS } },
    { label: 'nostr', module: 'https://esm.sh/trystero@0.19.0/nostr', opts: { relayUrls: NOSTR_RELAY_URLS } }
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
// consecutive failures occur with zero connected peers, pause to free them.
let consecutiveFailures = 0;
let backoffUntil = 0;
let backoffReason = null;
const FAILURE_THRESHOLD = 5;
const BACKOFF_MS = 5 * 60 * 1000;

function isFailureMessage(msg) {
    return /peer failed|Ice connection failed|Cannot create so many PeerConnections/i.test(msg);
}

function notifyError(msg) {
    lastErrorMsg = msg;

    if (isFailureMessage(msg)) {
        consecutiveFailures++;
        if (consecutiveFailures >= FAILURE_THRESHOLD && getPeerCount() === 0 && Date.now() >= backoffUntil) {
            consecutiveFailures = 0;
            backoffUntil = Date.now() + BACKOFF_MS;
            backoffReason = 'WebRTC appears blocked on this network — P2P paused for 5 minutes. Click "Enable P2P Auto-Sync" to retry.';
            console.warn('[P2P] ' + backoffReason);
            try { leave(); } catch (e) {}
            errorCallbacks.forEach(cb => {
                try { cb(backoffReason); } catch (e) {}
            });
            return;
        }
    }

    errorCallbacks.forEach(cb => {
        try { cb(msg); } catch (e) {}
    });
}

if (typeof window !== 'undefined') {
    window.addEventListener('error', (e) => {
        if (e && e.message && e.message.includes('Ice connection failed')) {
            notifyError('Connection to peer failed — this can happen on restrictive networks');
        }
    });

    window.addEventListener('unhandledrejection', (e) => {
        if (e && e.reason && (e.reason.message || String(e.reason)).includes('Ice connection failed')) {
            notifyError('Connection to peer failed — this can happen on restrictive networks');
        }
    });
}

const ROOM_ID_SALT = 'webauth-vault-trystero-room-v1';

function getDeviceId() {
    let id = localStorage.getItem('webauth_device_id');
    if (!id || typeof id !== 'string' || id.length < 8) {
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

function getWeekNumber(daysOffset = 0) {
    const timestamp = Date.now() + (daysOffset * 86400 * 1000);
    return Math.floor(timestamp / (7 * 24 * 60 * 60 * 1000));
}

async function deriveRoomId(passphrase, daysOffset = 0) {
    if (!passphrase) return null;
    const weekNum = getWeekNumber(daysOffset);
    const enc = new TextEncoder();
    const data = enc.encode(passphrase + ROOM_ID_SALT + '-week-' + weekNum);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function getCustomPassphrase() {
    return localStorage.getItem(STORAGE_KEY_CUSTOM_PASS) || '';
}

function setCustomPassphrase(pass) {
    if (pass && pass.trim()) {
        localStorage.setItem(STORAGE_KEY_CUSTOM_PASS, pass.trim());
    } else {
        localStorage.removeItem(STORAGE_KEY_CUSTOM_PASS);
    }
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

function makeRtcOpts(strategyOpts, password) {
    return {
        appId: 'webauth-vault-sync',
        password: password,
        rtcConfig: { iceServers: ICE_SERVERS },
        config: { iceServers: ICE_SERVERS },
        iceServers: ICE_SERVERS,
        ...strategyOpts
    };
}

function wireRoom(room) {
    const [sendVault, getVault] = room.makeAction('vault');
    getVault(handleIncomingVaultMessage);
    room.onPeerJoin(peerId => {
        consecutiveFailures = 0;
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

async function join(passphraseOverride) {
    const effectivePass = passphraseOverride || getCustomPassphrase();
    if (!effectivePass) return false;

    const roomIdCurrent = await deriveRoomId(effectivePass, 0);
    const roomIdPrev = await deriveRoomId(effectivePass, -7);
    if (!roomIdCurrent) return false;

    if (isJoined && activeRooms.length > 0) {
        return true;
    }

    let joinedAny = false;
    strategyStatus = [];

    for (const strat of STRATEGY_MODULES) {
        try {
            const { joinRoom } = await import(strat.module);
            const room = joinRoom(makeRtcOpts(strat.opts, effectivePass), roomIdCurrent);
            wireRoom(room);
            activeRooms.push({ room, label: strat.label });
            strategyStatus.push(strat.label + ': joined');
            joinedAny = true;

            // Overlap secondary room for previous week
            try {
                const secRoom = joinRoom(makeRtcOpts(strat.opts, effectivePass), roomIdPrev);
                wireRoom(secRoom);
                activeRooms.push({ room: secRoom, label: strat.label + '-prev' });
            } catch (secErr) {
                console.warn(strat.label + ' secondary room join warning:', secErr);
            }
        } catch (err) {
            console.warn('Trystero strategy "' + strat.label + '" failed to initialize:', err);
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
                room.__sendVault(serialized);
                any = true;
            }
        } catch (err) {
            console.error('Trystero broadcast error:', err);
        }
    }
    return any;
}

function leave() {
    for (const { room } of activeRooms) {
        try { room.leave(); } catch (e) {}
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
    isActive,
    setActive,
    isConnected: () => isJoined
};
