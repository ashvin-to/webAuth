/**
 * WebRTC Persistent Sync Engine for WebAuth Vault
 * Zero-knowledge P2P synchronization using PeerJS data channels.
 */
const P2PSync = (function () {
    const STORAGE_KEY = 'webauth_p2p_pairing_code';
    let pairingCode = null;
    let peer = null;
    let isHost = false;
    let activeConnections = new Map(); // peerId -> DataConnection
    let status = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'error'
    let statusDetails = '';
    let reconnectTimeout = null;

    const vaultReceivedCallbacks = new Set();
    const statusChangeCallbacks = new Set();

    /**
     * Generates a 16-character alphanumeric pairing code (A-Z, 0-9).
     */
    function generatePairingCode() {
        const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const randomBuffer = new Uint8Array(16);
        crypto.getRandomValues(randomBuffer);
        let code = '';
        for (let i = 0; i < 16; i++) {
            code += charset[randomBuffer[i] % charset.length];
        }
        return code;
    }

    /**
     * Gets the persistent pairing code from localStorage or generates a new one.
     */
    function getPairingCode() {
        let savedCode = localStorage.getItem(STORAGE_KEY);
        if (!savedCode || typeof savedCode !== 'string' || savedCode.trim().length === 0) {
            savedCode = generatePairingCode();
            localStorage.setItem(STORAGE_KEY, savedCode);
        }
        pairingCode = savedCode.trim().toUpperCase();
        return pairingCode;
    }

    /**
     * Sets a new pairing code, stores in localStorage, and re-initializes connection.
     */
    function setPairingCode(code) {
        if (!code || typeof code !== 'string') return;
        const cleaned = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (cleaned.length > 0) {
            pairingCode = cleaned;
            localStorage.setItem(STORAGE_KEY, cleaned);
            init(cleaned);
        }
    }

    /**
     * Hashes the pairing code using SHA-256 to create a deterministic room ID for PeerJS.
     */
    async function hashPairingCode(code) {
        const encoder = new TextEncoder();
        const data = encoder.encode('webauth-p2p-room:' + code);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return hashHex.substring(0, 32);
    }

    /**
     * Updates connection status and notifies listeners.
     */
    function updateStatus(newStatus, details = '') {
        status = newStatus;
        statusDetails = details;
        const currentStatusObj = getStatus();
        statusChangeCallbacks.forEach(cb => {
            try { cb(currentStatusObj); } catch (e) { console.error('P2PSync status listener error:', e); }
        });
    }

    /**
     * Gets the current status object.
     */
    function getStatus() {
        return {
            status: status,
            pairingCode: pairingCode || getPairingCode(),
            peerCount: activeConnections.size,
            isHost: isHost,
            peerId: peer ? peer.id : null,
            details: statusDetails
        };
    }

    /**
     * Sets up event listeners on a PeerJS DataConnection.
     */
    function setupConnection(conn) {
        const peerId = conn.peer;

        conn.on('open', () => {
            activeConnections.set(peerId, conn);
            updateStatus('connected', `Connected to peer (${activeConnections.size} active)`);
            
            // Send current local vault state immediately to newly connected peer
            const currentPayload = localStorage.getItem('webauth_vault_data');
            if (currentPayload) {
                try {
                    conn.send(JSON.stringify({
                        type: 'VAULT_SYNC',
                        payload: currentPayload,
                        timestamp: Date.now()
                    }));
                } catch (e) {}
            }
        });

        conn.on('data', (data) => {
            try {
                const msg = typeof data === 'string' ? JSON.parse(data) : data;
                if (msg && msg.type === 'VAULT_SYNC' && msg.payload) {
                    // Trigger payload listeners
                    vaultReceivedCallbacks.forEach(cb => {
                        try { cb(msg.payload); } catch (e) { console.error('P2PSync vault listener error:', e); }
                    });

                    // Relay to other connected peers if host
                    if (isHost) {
                        relayVaultPayload(msg.payload, peerId);
                    }
                } else if (msg && msg.type === 'PING') {
                    if (conn.open) conn.send({ type: 'PONG' });
                }
            } catch (err) {
                console.error('P2PSync received invalid data:', err);
            }
        });

        conn.on('close', () => {
            activeConnections.delete(peerId);
            if (activeConnections.size === 0) {
                updateStatus(isHost ? 'connected' : 'disconnected', isHost ? 'Waiting for peers...' : 'Disconnected from host');
            } else {
                updateStatus('connected', `Connected to peer (${activeConnections.size} active)`);
            }
            if (!isHost) {
                scheduleReconnect();
            }
        });

        conn.on('error', (err) => {
            console.error(`P2PSync connection error with ${peerId}:`, err);
            activeConnections.delete(peerId);
        });
    }

    /**
     * Relays a received vault payload to all connected peers except the sender.
     */
    function relayVaultPayload(payload, senderPeerId) {
        const msg = JSON.stringify({
            type: 'VAULT_SYNC',
            payload: payload,
            timestamp: Date.now()
        });

        activeConnections.forEach((conn, peerId) => {
            if (peerId !== senderPeerId && conn && conn.open) {
                try {
                    conn.send(msg);
                } catch (e) {
                    console.error(`Failed to relay vault to ${peerId}:`, e);
                }
            }
        });
    }

    /**
     * Schedules auto-reconnection.
     */
    function scheduleReconnect(delayMs = 3000) {
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => {
            if (status === 'disconnected' || status === 'error') {
                init(pairingCode);
            }
        }, delayMs);
    }

    /**
     * Cleans up existing Peer instance and connections.
     */
    function cleanup() {
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }

        activeConnections.forEach(conn => {
            try { conn.close(); } catch (e) {}
        });
        activeConnections.clear();

        if (peer) {
            try {
                peer.off();
                peer.destroy();
            } catch (e) {}
            peer = null;
        }
        isHost = false;
    }

    /**
     * Initializes the WebRTC connection lifecycle for the specified or stored pairing code.
     */
    async function init(code) {
        cleanup();

        if (typeof Peer === 'undefined') {
            updateStatus('error', 'PeerJS library not loaded');
            scheduleReconnect(5000);
            return;
        }

        pairingCode = code ? code.trim().toUpperCase() : getPairingCode();
        updateStatus('connecting', 'Deriving room ID...');

        let roomHash;
        try {
            roomHash = await hashPairingCode(pairingCode);
        } catch (err) {
            updateStatus('error', 'Failed to hash pairing code');
            return;
        }

        const hostPeerId = `webauth-vault-${roomHash}`;
        updateStatus('connecting', 'Connecting to signaling server...');

        // Attempt 1: Try registering as Host
        try {
            peer = new Peer(hostPeerId, { debug: 1 });
        } catch (err) {
            updateStatus('error', 'Peer initialization failed');
            return;
        }

        let isInitialized = false;

        peer.on('open', (id) => {
            isInitialized = true;
            isHost = true;
            updateStatus('connected', 'Host ready, waiting for peer connections...');
        });

        peer.on('connection', (conn) => {
            setupConnection(conn);
        });

        peer.on('error', (err) => {
            console.warn('P2PSync Peer error:', err.type, err.message);

            if (!isInitialized && (err.type === 'unavailable-id' || err.type === 'peer-unavailable')) {
                // Host ID is taken -> connect as Client
                try {
                    if (peer) {
                        peer.off();
                        peer.destroy();
                    }
                } catch (e) {}

                isHost = false;
                peer = new Peer(undefined, { debug: 1 });

                peer.on('open', (myId) => {
                    updateStatus('connecting', 'Connecting to host device...');
                    const conn = peer.connect(hostPeerId, { reliable: true });
                    setupConnection(conn);
                });

                peer.on('error', (clientErr) => {
                    console.error('P2PSync client peer error:', clientErr);
                    updateStatus('error', `Connection error: ${clientErr.type || 'unknown'}`);
                    scheduleReconnect(5000);
                });

                peer.on('disconnected', () => {
                    updateStatus('disconnected', 'Disconnected from signaling server');
                    scheduleReconnect(3000);
                });
            } else {
                updateStatus('error', `Peer error: ${err.type || err.message}`);
                scheduleReconnect(5000);
            }
        });

        peer.on('disconnected', () => {
            if (isHost) {
                updateStatus('disconnected', 'Disconnected from signaling server');
                scheduleReconnect(3000);
            }
        });
    }

    /**
     * Broadcasts encrypted vault payload to all connected peers.
     */
    function broadcastVault(payload) {
        if (!payload) return 0;
        let sentCount = 0;
        const msg = JSON.stringify({
            type: 'VAULT_SYNC',
            payload: payload,
            timestamp: Date.now()
        });

        activeConnections.forEach((conn, peerId) => {
            if (conn && conn.open) {
                try {
                    conn.send(msg);
                    sentCount++;
                } catch (err) {
                    console.error(`P2PSync send error to ${peerId}:`, err);
                }
            }
        });

        return sentCount;
    }

    /**
     * Registers a callback for received vault payloads.
     */
    function onVaultReceived(callback) {
        if (typeof callback === 'function') {
            vaultReceivedCallbacks.add(callback);
        }
    }

    /**
     * Registers a callback for status changes.
     */
    function onStatusChange(callback) {
        if (typeof callback === 'function') {
            statusChangeCallbacks.add(callback);
        }
    }

    // Public API
    return {
        init: init,
        getPairingCode: getPairingCode,
        setPairingCode: setPairingCode,
        broadcastVault: broadcastVault,
        onVaultReceived: onVaultReceived,
        onStatusChange: onStatusChange,
        getStatus: getStatus
    };
})();
