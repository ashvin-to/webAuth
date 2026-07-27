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

async function deriveRoomId(masterPassword) {
    if (!masterPassword) return null;
    const enc = new TextEncoder();
    const data = enc.encode(masterPassword + ROOM_ID_SALT);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
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

async function join(masterPassword) {
    if (!masterPassword) return false;
    const roomId = await deriveRoomId(masterPassword);
    if (!roomId) return false;
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
        roomInstance = joinRoom(rtcOpts, roomId);
        
        const [sendVault, getVault] = roomInstance.makeAction('vault');
        sendVaultAction = sendVault;
        getVaultAction = getVault;

        getVaultAction((payload, peerId) => {
            receiveCallbacks.forEach(cb => {
                try { cb(payload, peerId); } catch (e) {}
            });
        });

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
        sendVaultAction(serializedPayload);
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
    isActive,
    setActive,
    isConnected: () => isJoined
};
