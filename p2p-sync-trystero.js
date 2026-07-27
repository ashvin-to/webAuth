/**
 * Real-Time WebRTC P2P Sync Engine powered by Trystero (Torrent strategy)
 * Direct browser-to-browser encrypted vault synchronization.
 */

const STORAGE_KEY_ROOM = 'webauth_trystero_room';
const STORAGE_KEY_ACTIVE = 'webauth_trystero_active';

const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:openrelay.metered.ca:80' },
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

let roomInstance = null;
let sendVaultAction = null;
let getVaultAction = null;
let peerCount = 0;
let receiveCallbacks = new Set();
let peerChangeCallbacks = new Set();
let errorCallbacks = new Set();
let lastErrorMsg = null;
let isJoined = false;

function notifyError(msg) {
    lastErrorMsg = msg;
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

let secondaryRoomInstance = null;

async function join(passphraseOverride) {
    const effectivePass = passphraseOverride || getCustomPassphrase();
    if (!effectivePass) return false;
    
    const roomIdCurrent = await deriveRoomId(effectivePass, 0);
    const roomIdPrev = await deriveRoomId(effectivePass, -7);
    if (!roomIdCurrent) return false;

    if (isJoined && roomInstance) {
        return true;
    }

    try {
        const { joinRoom } = await import('https://esm.sh/trystero@0.19.0/torrent');
        const rtcOpts = {
            appId: 'webauth-vault-sync',
            rtcConfig: { iceServers: ICE_SERVERS },
            config: { iceServers: ICE_SERVERS },
            iceServers: ICE_SERVERS
        };

        roomInstance = joinRoom(rtcOpts, roomIdCurrent);
        
        const [sendVault, getVault] = roomInstance.makeAction('vault');
        sendVaultAction = sendVault;
        getVaultAction = getVault;

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

        getVaultAction(handleIncomingVaultMessage);

        const peersMap = new Set();

        roomInstance.onPeerJoin(peerId => {
            peersMap.add(peerId);
            peerCount = peersMap.size;
            notifyPeerChange(peerId, 'join');
        });

        roomInstance.onPeerLeave(peerId => {
            peersMap.delete(peerId);
            peerCount = peersMap.size;
            notifyPeerChange(peerId, 'leave');
        });

        // Overlap secondary room for previous week
        try {
            secondaryRoomInstance = joinRoom(rtcOpts, roomIdPrev);
            const [, getVaultSecondary] = secondaryRoomInstance.makeAction('vault');
            getVaultSecondary(handleIncomingVaultMessage);
        } catch (secErr) {
            console.warn('Secondary room join warning:', secErr);
        }

        isJoined = true;
        setActive(true);
        notifyPeerChange();
        return true;
    } catch (err) {
        console.warn('Trystero P2P module failed to initialize (CDN/network unavailable):', err);
        isJoined = false;
        return false;
    }
}

function broadcast(serializedPayload) {
    if (!isJoined || !sendVaultAction) return false;
    try {
        const msgObj = {
            deviceId: getDeviceId(),
            payload: serializedPayload
        };
        sendVaultAction(JSON.stringify(msgObj));
        return true;
    } catch (err) {
        console.error('Trystero broadcast error:', err);
        return false;
    }
}

function leave() {
    if (roomInstance) {
        try { roomInstance.leave(); } catch (e) {}
        roomInstance = null;
    }
    if (secondaryRoomInstance) {
        try { secondaryRoomInstance.leave(); } catch (e) {}
        secondaryRoomInstance = null;
    }
    sendVaultAction = null;
    getVaultAction = null;
    peerCount = 0;
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

window.TrysteroSync = {
    join,
    leave,
    broadcast,
    onReceive,
    onPeerChange,
    onError,
    getLastError,
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
