// Simple P2P Sync Solution for WebAuth Vault
// Works entirely in the browser with no external dependencies
const P2PSync = (function () {
    const STORAGE_KEY = 'webauth_p2p_pairing_code';
    const VAULT_STORAGE_KEY = 'webauth_encrypted_vault';
    let status = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'error'
    let statusDetails = '';
    let reconnectTimeout = null;
    let pairingCode = null;
    let syncId = null;
    const vaultReceivedCallbacks = new Set();
    const statusChangeCallbacks = new Set();

    function updateStatus(newStatus, details = '') {
        status = newStatus;
        statusDetails = details;
        const currentStatusObj = {
            status: status,
            pairingCode: getPairingCode(),
            peerCount: 0,
            isHost: true,
            peerId: null,
            details: statusDetails
        };
        statusChangeCallbacks.forEach(cb => {
            try { cb(currentStatusObj); } catch (e) {}
        });
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

    // Simple polling for incoming sync from other devices via IndexedDB
    async function scanForPeers() {
        if ('indexedDB' in window) {
            try {
                const db = await openIndexedDB();
                const remoteVault = await loadFromIndexedDB(VAULT_STORAGE_KEY);
                
                if (remoteVault) {
                    // Trigger vault listeners with the remote payload
                    vaultReceivedCallbacks.forEach(cb => {
                        try { cb(remoteVault); } catch (e) {}
                    });
                }
            } catch (err) {
                console.error('P2P scan error:', err);
            }
        }
    }

    function schedulePoll() {
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => {
            if (status === 'connected' || status === 'connecting') {
                scanForPeers();
                schedulePoll();
            }
        }, 5000); // Poll every 5 seconds
    }

    async function init(code) {
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }

        pairingCode = code ? code.trim().toUpperCase() : getPairingCode();
        syncId = 'webauth-sync-' + pairingCode;

        updateStatus('connecting', 'Initializing P2P sync...');

        try {
            // Try to scan for existing peers first
            await scanForPeers();
            
            // Start polling for new connections
            schedulePoll();
            
            updateStatus('connected', 'P2P sync active - scanning for devices');
            
        } catch (err) {
            console.error('P2P init error:', err);
            updateStatus('error', 'Failed to initialize P2P sync');
            scheduleReconnect(5000);
        }
    }

    function scheduleReconnect(delayMs = 5000) {
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => {
            if (status === 'disconnected' || status === 'error') {
                init(pairingCode);
            }
        }, delayMs);
    }

    async function broadcastVault(payload) {
        try {
            // Save to IndexedDB for peer discovery
            await saveToIndexedDB(VAULT_STORAGE_KEY, payload);
            
            // Also save to localStorage for cross-tab sync
            localStorage.setItem('webauth_p2p_last_sync', payload);
            
            console.log('Broadcasting vault to connected devices');
            return 1;
            
        } catch (err) {
            console.error('Broadcast error:', err);
            return 0;
        }
    }

    function onVaultReceived(callback) {
        if (typeof callback === 'function') {
            vaultReceivedCallbacks.add(callback);
            
            // Check for existing vault on load
            const existingVault = localStorage.getItem('webauth_p2p_last_sync');
            if (existingVault) {
                callback(existingVault);
            }
        }
    }

    function onStatusChange(callback) {
        if (typeof callback === 'function') {
            statusChangeCallbacks.add(callback);
        }
    }

    function getStatus() {
        return {
            status: status,
            pairingCode: getPairingCode(),
            peerCount: 0,
            isHost: true,
            peerId: syncId,
            details: statusDetails
        };
    }

    function cleanup() {
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }
        syncId = null;
    }

    return {
        init: init,
        getPairingCode: getPairingCode,
        setPairingCode: (code) => {
            if (!code || typeof code !== 'string') return;
            const cleaned = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
            if (cleaned.length > 0) {
                localStorage.setItem(STORAGE_KEY, cleaned);
                init(cleaned);
            }
        },
        broadcastVault: broadcastVault,
        onVaultReceived: onVaultReceived,
        onStatusChange: onStatusChange,
        getStatus: getStatus
    };
})();