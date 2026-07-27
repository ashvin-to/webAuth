// Helia P2P Sync Adapter
// Uses Helia/IPFS for distributed, P2P synchronization
const HeliaP2PSync = (function () {
    const STORAGE_KEY = 'webauth_p2p_pairing_code';
    let heliaNode = null;
    let libp2p = null;
    let pairwiseConnection = null;
    let pairingCode = null;
    let activePeers = new Map();
    let status = 'disconnected';
    let statusDetails = '';
    let reconnectTimeout = null;
    let syncTopic = null;
    let topicName = null;
    let roomId = null;

    const vaultReceivedCallbacks = new Set();
    const statusChangeCallbacks = new Set();

    // Ensure crypto for WebRTC (Helia requires this)
    if (typeof crypto === 'undefined') {
        console.error('Helia requires Web Crypto API. Please use a modern browser.');
    }

    function updateStatus(newStatus, details = '') {
        status = newStatus;
        statusDetails = details;
        const currentStatusObj = getStatus();
        statusChangeCallbacks.forEach(cb => {
            try { cb(currentStatusObj); } catch (e) { console.error('HeliaP2PSync status listener error:', e); }
        });
    }

    function getStatus() {
        return {
            status: status,
            pairingCode: pairingCode || getPairingCode(),
            peerCount: activePeers.size,
            isHost: true,
            peerId: libp2p?.peerId?.toString(),
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

    // Initialize Helia with WebRTC and proper configuration
    async function init(code) {
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }

        pairingCode = code ? code.trim().toUpperCase() : getPairingCode();
        roomId = `webauth-vault-${pairingCode}`;
        topicName = `webauth-vault-sync-${pairingCode}`;

        updateStatus('connecting', 'Initializing Helia node...');

        try {
            // Import Helia and related modules
            const { createHelia } = await import('https://esm.run/helia');
            const { createLibp2p } = await import('https://esm.run/libp2p');
            const { webSockets } = await import('https://esm.run/@libp2p/websockets');
            const { webRTC } = await import('https://esm.run/@libp2p/webrtc');
            const { noise } = await import('https://esm.run/@chainsafe/libp2p-noise');
            const { yamux } = await import('https://esm.run/@chainsafe/libp2p-yamux');
            const { gossipsub } = await import('https://esm.run/@chainsafe/libp2p-gossipsub');
            const { pubsubPeerDiscovery } = await import('https://esm.run/@libp2p/pubsub-peer-discovery');
            const { bootstrap } = await import('https://esm.run/@libp2p/bootstrap');
            const { circuitRelayTransport } = await import('https://esm.run/@libp2p/circuit-relay-v2');
            const { identify } = await import('https://esm.run/@libp2p/identify');
            const { multiaddr } = await import('https://esm.run/@multiformats/multiaddr');

            const options = {
                addresses: {
                    listen: [
                        '/webrtc',
                        '/p2p-circuit'
                    ]
                },
                transports: [
                    webSockets({ filter: all }),
                    webRTC(),
                    circuitRelayTransport()
                ],
                connectionEncrypters: [noise()],
                streamMuxers: [yamux()],
                connectionGater: {
                    denyDialMultiaddr: () => false
                },
                peerDiscovery: [
                    pubsubPeerDiscovery({
                        interval: 10000,
                        topics: [topicName]
                    }),
                    bootstrap({
                        list: [
                            '/dnsaddr/bootstrap.libp2p.io/p2p/12D3KooQLMcLw2gS2jMGMCqm3hGXhY9uKD8a5pQc9z6n'
                        ]
                    })
                ],
                services: {
                    pubsub: gossipsub(),
                    identify: identify()
                }
            };

            libp2p = await createLibp2p(options);
            heliaNode = await createHelia({ libp2p });

            // Get a reference to the pubsub service
            const pubsub = libp2p.services.pubsub;

            // Subscribe to our sync topic
            syncTopic = await pubsub.subscribe(topicName);
            console.log(`Subscribed to topic: ${topicName}`);

            // Listen for incoming messages
            syncTopic.addEventListener('message', async (event) => {
                const peerId = event.detail.from.toString();
                const data = new TextDecoder().decode(event.detail.data);

                if (peerId === libp2p.peerId.toString()) return;

                try {
                    const msg = JSON.parse(data);
                    if (msg.type === 'VAULT_SYNC' && msg.payload) {
                        vaultReceivedCallbacks.forEach(cb => {
                            try { cb(msg.payload); } catch (e) { console.error('HeliaP2PSync vault listener error:', e); }
                        });
                    }
                } catch (err) {
                    console.error('HeliaP2PSync message processing error:', err);
                }
            });

            updateStatus('connected', 'Helia sync established');

        } catch (err) {
            console.error('Helia initialization error:', err);
            updateStatus('error', 'Failed to initialize Helia');
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

    async function broadcastVault(payload) {
        if (status !== 'connected' || !syncTopic) {
            return 0;
        }

        const message = JSON.stringify({
            type: 'VAULT_SYNC',
            payload: payload,
            timestamp: Date.now()
        });

        try {
            await syncTopic.publish(new TextEncoder().encode(message));
            const count = libp2p.getPeers().length;
            console.log(`Broadcasted to ${count} peers via Helia`);
            return count;
        } catch (err) {
            console.error('Helia broadcast error:', err);
            return 0;
        }
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
        
        if (syncTopic) {
            syncTopic.stop();
            syncTopic = null;
        }
        
        activePeers.clear();
        
        if (libp2p) {
            libp2p.removeEventListener('peer:discovery', () => {});
            libp2p.stop();
            libp2p = null;
        }
        
        if (heliaNode) {
            heliaNode.stop();
            heliaNode = null;
        }
        
        roomId = null;
        topicName = null;
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

// Helper for websockets filter
const all = () => true;

// Assign to global namespace
window.P2PSync = HeliaP2PSync;