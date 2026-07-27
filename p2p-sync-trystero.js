// Trystero P2P Sync Adapter
// Wraps Trystero for WebAuth Vault compatibility
const TrysteroSyncAdapter = (function () {
    const STORAGE_KEY = 'webauth_p2p_pairing_code';
    let trysteroRoom = null;
    let pairingCode = null;
    let activePeers = new Map();
    let status = 'disconnected';
    let statusDetails = '';
    let reconnectTimeout = null;
    let syncId = null;
    let appId = 'webauth-vault';
    
    const vaultReceivedCallbacks = new Set();
    const statusChangeCallbacks = new Set();

    function updateStatus(newStatus, details = '') {
        status = newStatus;
        statusDetails = details;
        const currentStatusObj = getStatus();
        statusChangeCallbacks.forEach(cb => {
            try { cb(currentStatusObj); } catch (e) { console.error('TrysteroSync status listener error:', e); }
        });
    }

    function getStatus() {
        return {
            status: status,
            pairingCode: pairingCode || getPairingCode(),
            peerCount: activePeers.size,
            isHost: true,
            peerId: trysteroRoom?.getLocalPeerId(),
            details: statusDetails
        };
    }

    function getPairingCode() {
        let savedCode = localStorage.getItem(STORAGE_KEY);
        if (!savedCode || typeof savedCode !== 'string' || savedCode.trim().length === 0) {
            savedCode = generatePairingCode();
            localStorage.setItem(STORAGE_KEY, savedCode);
        }
        pairingCode = savedCode.trim().toUpperCase();
        return pairingCode;
    }

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

    function setPairingCode(code) {
        if (!code || typeof code !== 'string') return;
        const cleaned = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (cleaned.length > 0) {
            pairingCode = cleaned;
            localStorage.setItem(STORAGE_KEY, cleaned);
            init(cleaned);
        }
    }

    async function init(code) {
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }

        pairingCode = code ? code.trim().toUpperCase() : getPairingCode();
        updateStatus('connecting', 'Initializing sync room...');

        const roomId = `webauth-vault-${pairingCode}`;
        syncId = roomId;

        try {
            // Import trystero and use the Nostr strategy for decentralized discovery
            const { joinRoom } = await import('@trystero-p2p/nostr');
            
            // Use a password derived from pairing code for encryption to prevent ID conflicts
            const config = {
                appId: appId,
                password: pairingCode, // Use pairing code as password for deterministic connections
                relayConfig: {
                    urls: ['wss://purple-robin-62.nostr.io']
                }
            };
            
            trysteroRoom = await joinRoom(config, roomId, {
                onJoinError: (details) => {
                    console.error('Trystero join error:', details);
                    updateStatus('error', `Connection error: ${details.error}`);
                    scheduleReconnect(5000);
                }
            });

            updateStatus('connected', 'Sync established');

        } catch (err) {
            console.error('Trystero initialization error:', err);
            updateStatus('error', 'Failed to initialize sync');
            scheduleReconnect(5000);
        }
    }

    function scheduleReconnect(delayMs = 3000) {
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => {
            if (status === 'disconnected' || status === 'error') {
                init(pairingCode);
            }
        }, delayMs);
    }

    function broadcastVault(payload) {
        if (!trysteroRoom || status !== 'connected') {
            return 0;
        }

        let sentCount = 0;
        
        trysteroRoom.onMessage((data, peerId) => {
            if (peerId === trysteroRoom.getLocalPeerId()) return;
            
            try {
                // Process received vault payload
                const msg = typeof data === 'string' ? JSON.parse(data) : data;
                if (msg && msg.type === 'VAULT_SYNC' && msg.payload) {
                    vaultReceivedCallbacks.forEach(cb => {
                        try { cb(msg.payload); } catch (e) { console.error('Trystero vault listener error:', e); }
                    });
                }
            } catch (err) {
                console.error('Trystero message processing error:', err);
            }
        });

        // Send to all peers
        trysteroRoom.sendAll(JSON.stringify({
            type: 'VAULT_SYNC',
            payload: payload,
            timestamp: Date.now()
        }));

        sentCount = activePeers.size;
        return sentCount;
    }

    function onVaultReceived(callback) {
        if (typeof callback === 'function') {
            vaultReceivedCallbacks.add(callback);
        }
    }

    function onStatusChange(callback) {
        if (typeof callback === 'function') {
            statusChangeCallbacks.add(callback);
        }
    }

    function cleanup() {
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }
        
        activePeers.clear();
        trysteroRoom = null;
        syncId = null;
    }

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

// Assign to global namespace
window.P2PSync = TrysteroSyncAdapter;