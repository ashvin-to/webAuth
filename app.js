/**
 * Application Logic & TOTP Generator with IndexedDB & Auto File Backup
 */
let masterKeyPassword = null;
let recoveryKeyInMemory = null;
let vaultData = [];
let cameraStream = null;
let cameraAnimationId = null;
let timerInterval = null;
let activeDetailAccountId = null;
let dragAccountId = null;

const VAULT_STORAGE_KEY = 'webauth_encrypted_vault';
const RECOVERY_KEY_STORAGE = 'webauth_recovery_key';
const BACKUP_AUTOSAVE_KEY = 'webauth_auto_backup_vault';
const SESSION_CACHE_KEY = 'webauth_session_pass';
const TOMBSTONES_STORAGE_KEY = 'webauth_tombstones';

// Session cache is encrypted at rest via SecretStore (non-extractable key in
// IndexedDB) so the master password never appears in plaintext storage.
async function setSessionCache(pass) {
    try {
        if (window.SecretStore && pass) {
            sessionStorage.setItem(SESSION_CACHE_KEY, await SecretStore.seal(pass));
        } else if (pass) {
            sessionStorage.setItem(SESSION_CACHE_KEY, pass);
        } else {
            sessionStorage.removeItem(SESSION_CACHE_KEY);
        }
    } catch (e) {
        console.warn('Failed to cache session pass securely:', e);
        try { sessionStorage.removeItem(SESSION_CACHE_KEY); } catch (e2) {}
    }
}

function clearSessionCache() {
    try { sessionStorage.removeItem(SESSION_CACHE_KEY); } catch (e) {}
}

// --- P2P sync state (last-write-wins merge + delete tombstones) ---
let tombstoneMap = new Map();       // secret -> { secret, updatedAt }
let lastSyncAt = 0;                 // epoch ms of last successful P2P exchange
let pendingSyncChanges = { upserts: new Map(), deletes: new Map() };
const TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// --- IndexedDB Persistent Vault Backup Store ---
const DB_NAME = 'WebAuthPersistentVaultDB';
const DB_VERSION = 1;
const STORE_NAME = 'vault_backup';

function openIndexedDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

async function saveToIndexedDB(key, value) {
    try {
        const db = await openIndexedDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(value, key);
        return tx.complete;
    } catch (e) {
        console.error("IndexedDB Save Error:", e);
    }
}

async function loadFromIndexedDB(key) {
    try {
        const db = await openIndexedDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        console.error("IndexedDB Load Error:", e);
        return null;
    }
}

async function removeFromIndexedDB(key) {
    try {
        const db = await openIndexedDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
        return tx.complete;
    } catch (e) {
        console.error("IndexedDB Remove Error:", e);
    }
}

// SECURITY: Debug logging is restricted. Never log secrets, passwords,
// recovery keys, or decrypted vault data.
function logDebug(msg) {
    // In production, debug logging should be disabled entirely.
    // This function is kept for non-sensitive operational messages only.
    if (typeof console !== 'undefined' && console.log) {
        console.log('[WebAuth]', msg);
    }
}

// --- Global error trap: surfaces runtime errors visibly for diagnosis ---
(function () {
    function show(msg) {
        try {
            let box = document.getElementById('errorLogBox');
            if (!box) {
                box = document.createElement('div');
                box.id = 'errorLogBox';
                box.style.cssText = 'position:fixed;bottom:8px;left:8px;right:8px;max-height:40vh;overflow:auto;z-index:99999;background:rgba(20,20,30,.95);color:#f87171;font:11px/1.4 monospace;padding:8px 10px;border-radius:8px;border:1px solid #f87171;white-space:pre-wrap;';
                document.body.appendChild(box);
            }
            const line = document.createElement('div');
            line.textContent = msg;
            box.appendChild(line);
        } catch (e) {}
    }
    window.addEventListener('error', (e) => {
        const msg = (e && e.message) || (e && e.type) || '';
        // Expected WebRTC noise (Trystero/simple-peer); surfaced via the P2P modal note instead.
        if (msg.includes('Ice connection failed')) return;
        if (msg.includes('Cannot create so many PeerConnections')) return;
        if (msg.includes('Connection failed')) return;
        show('[ERROR] ' + msg + ' @ ' + (e.filename || '') + ':' + (e.lineno || '?'));
    });
    window.addEventListener('unhandledrejection', (e) => {
        const msg = (e.reason && (e.reason.message || e.reason)) || 'unhandled rejection';
        if (String(msg).includes('Ice connection failed')) return;
        if (String(msg).includes('Cannot create so many PeerConnections')) return;
        if (String(msg).includes('Connection failed')) return;
        show('[PROMISE] ' + msg);
    });
    window.showAppError = show;
})();

// --- P2P / file-sync merge helpers ---

function normalizeVault() {
    vaultData = (vaultData || []).map(a => ({ ...a, updatedAt: a.updatedAt || 0 }));
}

async function loadTombstones() {
    if (!masterKeyPassword) return;
    let raw = localStorage.getItem(TOMBSTONES_STORAGE_KEY);
    if (!raw) raw = await loadFromIndexedDB(TOMBSTONES_STORAGE_KEY);
    if (!raw) return;
    try {
        const decrypted = await CryptoVault.decrypt(JSON.parse(raw), masterKeyPassword);
        const list = Array.isArray(decrypted) ? decrypted : [];
        tombstoneMap = new Map(list.map(d => [d.secret, { secret: d.secret, updatedAt: d.updatedAt || 0 }]));
        pruneTombstones();
    } catch (e) {
        console.warn('Could not load tombstones:', e);
    }
}

async function persistTombstones() {
    if (!masterKeyPassword) return;
    pruneTombstones();
    const encrypted = await CryptoVault.encrypt(Array.from(tombstoneMap.values()), masterKeyPassword);
    const serialized = JSON.stringify(encrypted);
    localStorage.setItem(TOMBSTONES_STORAGE_KEY, serialized);
    await saveToIndexedDB(TOMBSTONES_STORAGE_KEY, serialized);
}

function pruneTombstones() {
    const cutoff = Date.now() - TOMBSTONE_MAX_AGE_MS;
    for (const [secret, t] of tombstoneMap) {
        if (t.updatedAt < cutoff) tombstoneMap.delete(secret);
    }
}

function markAccountChanged(acc) {
    if (!acc || !acc.secret) return;
    pendingSyncChanges.upserts.set(acc.secret, acc);
    pendingSyncChanges.deletes.delete(acc.secret);
}

function markAccountDeleted(secret, updatedAt) {
    if (!secret) return;
    pendingSyncChanges.upserts.delete(secret);
    pendingSyncChanges.deletes.set(secret, { secret, updatedAt: updatedAt || Date.now() });
}

// Merge remote accounts + deletes using last-write-wins. Returns true if local data changed.
async function mergeRemoteAccounts(remoteAccounts, remoteDeletes) {
    if (!masterKeyPassword) return false;
    let changed = false;
    const localBySecret = new Map(vaultData.map(a => [a.secret, a]));

    // 1) Apply incoming deletes (tombstones) first
    for (const del of (remoteDeletes || [])) {
        if (!del || !del.secret) continue;
        const delTs = del.updatedAt || 0;
        const existingTomb = tombstoneMap.get(del.secret);
        if (existingTomb && existingTomb.updatedAt > delTs) continue;
        const local = localBySecret.get(del.secret);
        if (local && (local.updatedAt || 0) <= delTs) {
            localBySecret.delete(del.secret);
            tombstoneMap.set(del.secret, { secret: del.secret, updatedAt: delTs });
            changed = true;
        } else if (!local && !existingTomb) {
            tombstoneMap.set(del.secret, { secret: del.secret, updatedAt: delTs });
            changed = true;
        }
    }

    // 2) Apply incoming accounts (last-write-wins by updatedAt)
    for (const acc of (remoteAccounts || [])) {
        if (!acc || !acc.secret) continue;
        const accTs = acc.updatedAt || 0;
        const tomb = tombstoneMap.get(acc.secret);
        if (tomb && accTs <= tomb.updatedAt) continue;
        const local = localBySecret.get(acc.secret);
        if (!local) {
            localBySecret.set(acc.secret, acc);
            tombstoneMap.delete(acc.secret);
            changed = true;
        } else if (accTs > (local.updatedAt || 0)) {
            localBySecret.set(acc.secret, acc);
            tombstoneMap.delete(acc.secret);
            changed = true;
        }
    }

    if (changed) {
        vaultData = Array.from(localBySecret.values());
        await persistTombstones();
        await persistVaultLocal();
        buildAccountsDOM();
        logDebug('Sync merge applied: ' + vaultData.length + ' account(s) after merge.');
    }
    return changed;
}

// Write vault + recovery backup + linked file locally (no P2P broadcast).
async function persistVaultLocal() {
    if (!masterKeyPassword) return;

    const encryptedPayload = await CryptoVault.encrypt(vaultData, masterKeyPassword);
    const serializedPayload = JSON.stringify(encryptedPayload);

    localStorage.setItem(VAULT_STORAGE_KEY, serializedPayload);
    await saveToIndexedDB(VAULT_STORAGE_KEY, serializedPayload);

    const storedRecKey = recoveryKeyInMemory;

    if (storedRecKey) {
        const backupEncryptedPayload = await CryptoVault.encrypt(vaultData, storedRecKey);
        const serializedBackup = JSON.stringify(backupEncryptedPayload);
        localStorage.setItem(BACKUP_AUTOSAVE_KEY, serializedBackup);
        await saveToIndexedDB(BACKUP_AUTOSAVE_KEY, serializedBackup);
    }

    if (window.FileSync && FileSync.hasFile()) {
        await syncWithLinkedFile();
    }

    logDebug('Vault persisted locally. Total accounts: ' + vaultData.length);
}

// Broadcast a full encrypted snapshot of the entire vault + tombstones.
async function broadcastP2pSnapshot() {
    if (!masterKeyPassword || !window.TrysteroSync || !TrysteroSync.isConnected()) {
        return;
    }
    const message = { full: true, accounts: vaultData, deletes: Array.from(tombstoneMap.values()) };
    const encrypted = await CryptoVault.encrypt(message, masterKeyPassword);
    const ok = TrysteroSync.broadcast(JSON.stringify(encrypted));
    if (ok) lastSyncAt = Date.now();
    return ok;
}

// Broadcast only the accounts that changed since the last broadcast (delta).
async function broadcastP2pDelta() {
    if (!masterKeyPassword || !window.TrysteroSync || !TrysteroSync.isConnected()) return false;
    if (pendingSyncChanges.upserts.size === 0 && pendingSyncChanges.deletes.size === 0) return false;
    const message = {
        full: false,
        accounts: Array.from(pendingSyncChanges.upserts.values()),
        deletes: Array.from(pendingSyncChanges.deletes.values())
    };
    const encrypted = await CryptoVault.encrypt(message, masterKeyPassword);
    const ok = TrysteroSync.broadcast(JSON.stringify(encrypted));
    if (ok) {
        pendingSyncChanges.upserts.clear();
        pendingSyncChanges.deletes.clear();
        lastSyncAt = Date.now();
    }
    return ok;
}

// Ask all connected peers to resend their snapshot, then send ours.
async function requestP2pSync() {
    if (!masterKeyPassword || !window.TrysteroSync || !TrysteroSync.isConnected()) {
        alert('P2P sync is not connected. Enable P2P Auto-Sync first.');
        return;
    }
    const message = { request: true };
    const encrypted = await CryptoVault.encrypt(message, masterKeyPassword);
    TrysteroSync.broadcast(JSON.stringify(encrypted));
    await broadcastP2pSnapshot();
    logDebug('P2P sync requested from peers.');
}


document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW registration failed:', e));
        });
    }
    const themeBtn = document.getElementById('themeToggleBtn');
    if (themeBtn) {
        themeBtn.addEventListener('click', () => {
            const current = document.documentElement.getAttribute('data-theme');
            applyTheme(current === 'light' ? 'dark' : 'light');
        });
    }
    initAuthScreen();
    setupEventListeners();
});

function applyTheme(theme) {
    const isLight = theme === 'light';
    document.documentElement.setAttribute('data-theme', isLight ? 'light' : 'dark');
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.textContent = isLight ? 'Dark' : 'Light';
    try { localStorage.setItem('webauth_theme', theme); } catch (e) {}
}

function initTheme() {
    let theme = 'dark';
    try {
        const saved = localStorage.getItem('webauth_theme');
        if (saved === 'light' || saved === 'dark') theme = saved;
    } catch (e) {}
    applyTheme(theme);
}

async function initAuthScreen() {
    try {
        let existingVault = localStorage.getItem(VAULT_STORAGE_KEY);
        
        // Fallback to IndexedDB if localStorage was wiped
        if (!existingVault) {
            existingVault = await loadFromIndexedDB(VAULT_STORAGE_KEY);
            if (existingVault) {
                localStorage.setItem(VAULT_STORAGE_KEY, existingVault);
                logDebug("Restored vault data from persistent IndexedDB backup!");
            }
        }

        const authTitle = document.getElementById('authTitle');
        const authSubtitle = document.getElementById('authSubtitle');
        const confirmGroup = document.getElementById('confirmPassGroup');
        const recoveryNotice = document.getElementById('recoveryKeyNotice');
        const submitBtn = document.getElementById('authSubmitBtn');
        const ackEl = document.getElementById('recoveryKeyAck');

        // Security: purge any recovery key previously stored in plaintext.
        try {
            localStorage.removeItem(RECOVERY_KEY_STORAGE);
            await removeFromIndexedDB(RECOVERY_KEY_STORAGE);
        } catch (e) {}

        const cachedPassRaw = sessionStorage.getItem(SESSION_CACHE_KEY);
        let cachedPass = null;
        if (cachedPassRaw) {
            if (window.SecretStore) {
                try {
                    cachedPass = await SecretStore.open(cachedPassRaw);
                } catch (e) {
                    cachedPass = null;
                }
                if (!cachedPass) {
                    sessionStorage.removeItem(SESSION_CACHE_KEY);
                } else if (cachedPassRaw && !cachedPassRaw.startsWith('v1:')) {
                    // Legacy plaintext cached pass — re-seal so it is no longer readable at rest.
                    await setSessionCache(cachedPass);
                }
            } else {
                cachedPass = cachedPassRaw;
            }
        }
        if (existingVault && cachedPass) {
            try {
                const encryptedPayload = JSON.parse(existingVault);
                vaultData = await CryptoVault.decrypt(encryptedPayload, cachedPass);
                masterKeyPassword = cachedPass;
                logDebug(`Auto-unlocked session from browser storage. Loaded ${vaultData.length} accounts.`);
                showDashboard();
                return;
            } catch (err) {
                clearSessionCache();
            }
        }

        if (!existingVault) {
            authTitle.textContent = 'Create Master Password';
            authSubtitle.textContent = 'Set a master password to encrypt your 2FA vault on this device.';
            confirmGroup.style.display = 'block';
            
            const newRecoveryKey = generateRandomRecoveryKey();
            document.getElementById('generatedRecoveryKey').value = newRecoveryKey;
            recoveryNotice.style.display = 'block';

            submitBtn.textContent = 'Create Vault';
            // Block submit until the user confirms they saved the recovery key.
            if (ackEl && submitBtn) {
                submitBtn.disabled = true;
                ackEl.addEventListener('change', () => {
                    submitBtn.disabled = !ackEl.checked;
                });
            }
        } else {
            authTitle.textContent = 'Unlock Vault';
            authSubtitle.textContent = 'Enter your master password or Recovery Key to decrypt your 2FA keys.';
            confirmGroup.style.display = 'none';
            recoveryNotice.style.display = 'none';
            submitBtn.textContent = 'Unlock';
            if (submitBtn) submitBtn.disabled = false;
        }
    } catch (e) {
        console.error("Initialization error:", e);
    }
}

/**
 * SECURITY: Recovery key generation uses crypto.getRandomValues() (CSPRNG).
 * The alphabet has 31 characters, and rejection sampling avoids modulo bias.
 * 16 characters from a 31-char alphabet = ~79 bits of entropy.
 */
function generateRandomRecoveryKey() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const maxUnbiased = 256 - (256 % chars.length); // reject values >= this to avoid modulo bias
    let key = 'RECOVER-';
    const randomBytes = new Uint8Array(64); // over-provision to handle rejections
    crypto.getRandomValues(randomBytes);
    let byteIdx = 0;
    for (let i = 0; i < 16; i++) {
        if (i > 0 && i % 4 === 0) key += '-';
        // Rejection sampling: skip bytes that would introduce modulo bias
        let val;
        do {
            if (byteIdx >= randomBytes.length) {
                crypto.getRandomValues(randomBytes);
                byteIdx = 0;
            }
            val = randomBytes[byteIdx++];
        } while (val >= maxUnbiased);
        key += chars.charAt(val % chars.length);
    }
    return key;
}

function showRecoveryQr() {
    const qrBox = document.getElementById('recoveryQrBox');
    const keyEl = document.getElementById('generatedRecoveryKey');
    if (!qrBox || !keyEl) return;
    if (qrBox.style.display !== 'none' && qrBox.dataset.rendered === 'yes') {
        qrBox.style.display = 'none';
        return;
    }
    qrBox.style.display = 'flex';
    SVGQRCode.renderInto(qrBox, keyEl.value, 170);
    qrBox.dataset.rendered = 'yes';
}

function printRecoveryBackup() {
    const keyEl = document.getElementById('generatedRecoveryKey');
    const printKeyEl = document.getElementById('printRecoveryKeyText');
    const printQrEl = document.getElementById('printRecoveryQr');
    if (!keyEl || !printKeyEl || !printQrEl) return;
    printKeyEl.textContent = keyEl.value;
    SVGQRCode.renderInto(printQrEl, keyEl.value, 200);
    window.print();
}

function setupEventListeners() {
    document.getElementById('authForm').addEventListener('submit', handleAuthSubmit);
    document.getElementById('lockBtn').addEventListener('click', lockVault);
    
    const copyRecBtn = document.getElementById('copyRecoveryKeyBtn');
    if (copyRecBtn) {
        copyRecBtn.addEventListener('click', () => {
            const keyVal = document.getElementById('generatedRecoveryKey').value;
            copyTextToClipboard(keyVal).then(() => {
                showToast('Emergency Recovery Key copied to clipboard', 'success');
            }).catch(() => {
                showToast('Copy failed — clipboard unavailable', 'error');
            });
        });
    }
    // Linked Folder Sync Modal
    const folderBtn = document.getElementById('folderSyncBtn');
    if (folderBtn) {
        if (!('showSaveFilePicker' in window)) {
            folderBtn.style.display = 'none';
        } else {
            folderBtn.addEventListener('click', openFolderSyncModal);
        }
    }
    const closeFolder1 = document.getElementById('closeFolderSyncModal');
    if (closeFolder1) closeFolder1.addEventListener('click', () => toggleModal('folderSyncModal', false));
    const closeFolder2 = document.getElementById('closeFolderSyncBtn');
    if (closeFolder2) closeFolder2.addEventListener('click', () => toggleModal('folderSyncModal', false));

    const p2pBtn = document.getElementById('p2pSyncModalBtn');
    if (p2pBtn) p2pBtn.addEventListener('click', openP2pSyncModal);
    const closeP2p1 = document.getElementById('closeP2pSyncModal');
    if (closeP2p1) closeP2p1.addEventListener('click', () => toggleModal('p2pSyncModal', false));
    const closeP2p2 = document.getElementById('closeP2pSyncBtn');
    if (closeP2p2) closeP2p2.addEventListener('click', () => toggleModal('p2pSyncModal', false));

    const changePassBtn = document.getElementById('changePassModalBtn');
    if (changePassBtn) changePassBtn.addEventListener('click', openChangePassModal);
    const closeChangePass1 = document.getElementById('closeChangePassModal');
    if (closeChangePass1) closeChangePass1.addEventListener('click', () => toggleModal('changePassModal', false));
    const closeChangePass2 = document.getElementById('cancelChangePassModal');
    if (closeChangePass2) closeChangePass2.addEventListener('click', () => toggleModal('changePassModal', false));
    const changePassForm = document.getElementById('changePassForm');
    if (changePassForm) changePassForm.addEventListener('submit', handleChangePasswordSubmit);

    const joinP2pBtn = document.getElementById('joinP2pSyncBtn');
    if (joinP2pBtn) joinP2pBtn.addEventListener('click', handleJoinP2pSync);
    const leaveP2pBtn = document.getElementById('leaveP2pSyncBtn');
    if (leaveP2pBtn) leaveP2pBtn.addEventListener('click', handleLeaveP2pSync);

    const saveTurnBtn = document.getElementById('saveTurnServerBtn');
    if (saveTurnBtn) saveTurnBtn.addEventListener('click', handleSaveTurnServer);

    const showPairingBtn = document.getElementById('showP2pPairingQrBtn');
    if (showPairingBtn) showPairingBtn.addEventListener('click', showP2pPairingQr);
    const scanPairingBtn = document.getElementById('scanP2pPairingQrBtn');
    if (scanPairingBtn) scanPairingBtn.addEventListener('click', scanP2pPairingQr);

    const showRecQrBtn = document.getElementById('showRecoveryQrBtn');
    if (showRecQrBtn) showRecQrBtn.addEventListener('click', showRecoveryQr);
    const printRecBtn = document.getElementById('printRecoveryBtn');
    if (printRecBtn) printRecBtn.addEventListener('click', printRecoveryBackup);

    const exportBtn = document.getElementById('exportMigrationBtn');
    if (exportBtn) exportBtn.addEventListener('click', openExportModal);
    const closeExport1 = document.getElementById('closeExportModal');
    if (closeExport1) closeExport1.addEventListener('click', () => toggleModal('exportModal', false));
    const closeExport2 = document.getElementById('closeExportBtn');
    if (closeExport2) closeExport2.addEventListener('click', () => toggleModal('exportModal', false));
    const copyMigBtn = document.getElementById('copyMigrationUriBtn');
    if (copyMigBtn) copyMigBtn.addEventListener('click', copyMigrationUri);
    const dlMigBtn = document.getElementById('downloadMigrationBtn');
    if (dlMigBtn) dlMigBtn.addEventListener('click', downloadMigrationUri);

    const createFolderBtn = document.getElementById('createFolderSyncBtn');
    if (createFolderBtn) createFolderBtn.addEventListener('click', handleCreateFolderSync);
    const openFolderBtn = document.getElementById('openFolderSyncBtn');
    if (openFolderBtn) openFolderBtn.addEventListener('click', handleOpenFolderSync);
    const syncNowBtn = document.getElementById('syncNowFolderBtn');
    if (syncNowBtn) syncNowBtn.addEventListener('click', handleSyncNowFolder);
    const unlinkBtn = document.getElementById('unlinkFolderBtn');
    if (unlinkBtn) unlinkBtn.addEventListener('click', handleUnlinkFolder);
    document.getElementById('addAccountBtn').addEventListener('click', () => openAddModal('manual'));
    document.getElementById('emptyAddBtn').addEventListener('click', () => openAddModal('manual'));
    const accTypeEl = document.getElementById('accType');
    if (accTypeEl) {
        accTypeEl.addEventListener('change', () => {
            const counterGroup = document.getElementById('accCounterGroup');
            if (counterGroup) counterGroup.style.display = accTypeEl.value === 'HOTP' ? 'block' : 'none';
        });
    }
    document.getElementById('closeAddModal').addEventListener('click', () => toggleModal('addModal', false));
    document.getElementById('cancelAddModal').addEventListener('click', () => toggleModal('addModal', false));
    
    // Account Detail Modal
    document.getElementById('closeDetailModal').addEventListener('click', () => toggleModal('detailModal', false));
    document.getElementById('closeDetailBtn').addEventListener('click', () => toggleModal('detailModal', false));
    document.getElementById('toggleSecretBtn').addEventListener('click', toggleSecretReveal);
    document.getElementById('deleteDetailBtn').addEventListener('click', deleteCurrentDetailAccount);

    // Tabs in Add Modal
    document.getElementById('tabManualBtn').addEventListener('click', () => switchAddTab('manual'));
    document.getElementById('tabImageBtn').addEventListener('click', () => switchAddTab('image'));
    
    // Dropzone / Image upload
    const dropZone = document.getElementById('dropZone');
    const qrFileInput = document.getElementById('qrFileInput');
    dropZone.addEventListener('click', () => qrFileInput.click());
    qrFileInput.addEventListener('change', handleImageUpload);
    dropZone.addEventListener('dragover', (e) => e.preventDefault());
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) {
            qrFileInput.files = e.dataTransfer.files;
            handleImageUpload();
        }
    });

    // Camera Scanner Modal
    document.getElementById('scanCameraBtn').addEventListener('click', startCameraScanner);
    document.getElementById('emptyScanBtn').addEventListener('click', startCameraScanner);
    document.getElementById('closeCameraModal').addEventListener('click', stopCameraScanner);
    document.getElementById('cancelCameraModal').addEventListener('click', stopCameraScanner);

    document.getElementById('addAccountForm').addEventListener('submit', handleAddAccount);
    document.getElementById('searchInput').addEventListener('input', renderAccountsListOnly);
    document.getElementById('exportBtn').addEventListener('click', exportVaultFile);
    
    // Import Backup JSON File
    const importFileInput = document.getElementById('importJsonFileInput');
    document.getElementById('importFileBtn').addEventListener('click', () => importFileInput.click());
    importFileInput.addEventListener('change', handleImportVaultFile);
}

function updateFolderSyncUI() {
    const statusEl = document.getElementById('folderSyncStatusText');
    if (!statusEl) return;
    const fileName = window.FileSync ? FileSync.getFileName() : null;
    if (fileName) {
        statusEl.textContent = `Linked: ${fileName}`;
        statusEl.className = 'p2p-status-badge badge-connected';
    } else {
        statusEl.textContent = 'No file linked';
        statusEl.className = 'p2p-status-badge badge-disconnected';
    }
}

function openFolderSyncModal() {
    toggleModal('folderSyncModal', true);
    updateFolderSyncUI();
}

async function handleCreateFolderSync() {
    if (!window.FileSync) return;
    const success = await FileSync.selectSaveFile();
    updateFolderSyncUI();
    if (success) {
        await syncWithLinkedFile();
    }
}

async function handleOpenFolderSync() {
    if (!window.FileSync) return;
    const fileData = await FileSync.selectOpenFile();
    updateFolderSyncUI();
    if (fileData !== null || FileSync.hasFile()) {
        await syncWithLinkedFile();
    }
}

async function handleSyncNowFolder() {
    if (!window.FileSync || !FileSync.hasFile()) {
        alert('No linked file to sync. Create or open a linked file first.');
        return;
    }
    await syncWithLinkedFile();
    updateFolderSyncUI();
}

async function handleUnlinkFolder() {
    if (!window.FileSync) return;
    await FileSync.disconnect();
    updateFolderSyncUI();
}

let syncingLinkedFile = false;
async function syncWithLinkedFile() {
    if (syncingLinkedFile) return;
    if (!window.FileSync || !FileSync.hasFile() || !masterKeyPassword) return;
    syncingLinkedFile = true;
    try {
        const fileContents = await FileSync.readVaultFromFile();
        if (fileContents && fileContents.trim()) {
            try {
                const parsedPayload = JSON.parse(fileContents);
                const decryptedData = await CryptoVault.decrypt(parsedPayload, masterKeyPassword);
                if (decryptedData && Array.isArray(decryptedData)) {
                    await mergeRemoteAccounts(decryptedData, []);
                }
            } catch (err) {
                console.warn('Linked file decrypt error:', err);
                alert('Linked file could not be decrypted with your current master password — skipping merge.');
            }
        }

        // Push current local vault data to linked file
        const encryptedPayload = await CryptoVault.encrypt(vaultData, masterKeyPassword);
        const serialized = JSON.stringify(encryptedPayload);
        const writeOk = await FileSync.writeVaultToFile(serialized);
        if (!writeOk && FileSync.hasFile()) {
            const statusEl = document.getElementById('folderSyncStatusText');
            if (statusEl) {
                statusEl.textContent = `Permission denied: ${FileSync.getFileName()}`;
                statusEl.className = 'p2p-status-badge badge-disconnected';
            }
        } else {
            updateFolderSyncUI();
        }
    } catch (err) {
        console.error('Error during linked file sync:', err);
    } finally {
        syncingLinkedFile = false;
    }
}

function updateP2pStatusUI() {
    const chip = document.getElementById('p2pHeaderChip');
    if (chip) {
        if (!window.TrysteroSync || (!TrysteroSync.isActive() && !TrysteroSync.isConnected())) {
            chip.style.display = 'none';
        } else if (TrysteroSync.isConnected()) {
            const peerCount = TrysteroSync.getPeerCount();
            chip.style.display = 'inline-flex';
            chip.textContent = peerCount > 0 ? `P2P · ${peerCount}` : 'P2P · searching';
            chip.className = peerCount > 0 ? 'p2p-chip chip-connected' : 'p2p-chip chip-connecting';
        } else {
            chip.style.display = 'inline-flex';
            chip.textContent = 'P2P · connecting…';
            chip.className = 'p2p-chip chip-connecting';
        }
    }

    const statusEl = document.getElementById('p2pSyncStatusText');
    if (statusEl) {
        if (!window.TrysteroSync || !TrysteroSync.isConnected()) {
            statusEl.textContent = 'Disconnected';
            statusEl.className = 'p2p-status-badge badge-disconnected';
        } else {
            const peerCount = TrysteroSync.getPeerCount();
            if (peerCount > 0) {
                statusEl.textContent = `Connected (${peerCount} device(s) online)`;
                statusEl.className = 'p2p-status-badge badge-connected';
            } else {
                statusEl.textContent = 'Waiting for peer...';
                statusEl.className = 'p2p-status-badge badge-connecting';
            }
        }
    }

    const lastSyncEl = document.getElementById('p2pLastSyncText');
    if (lastSyncEl) {
        lastSyncEl.textContent = lastSyncAt
            ? `Last synced: ${new Date(lastSyncAt).toLocaleTimeString()}`
            : 'Not synced yet';
    }

    const strategyEl = document.getElementById('p2pStrategyText');
    if (strategyEl && window.TrysteroSync && TrysteroSync.isConnected()) {
        const status = TrysteroSync.getStrategyStatus ? TrysteroSync.getStrategyStatus() : [];
        strategyEl.textContent = 'Signaling: ' + (status.length ? status.join(' · ') : 'connecting…');
    } else if (strategyEl) {
        strategyEl.textContent = '';
    }
}

function openChangePassModal() {
    const currentInput = document.getElementById('currentMasterPassword');
    const newInput = document.getElementById('newMasterPassword');
    const confirmInput = document.getElementById('confirmNewMasterPassword');
    if (currentInput) currentInput.value = '';
    if (newInput) newInput.value = '';
    if (confirmInput) confirmInput.value = '';
    const errEl = document.getElementById('changePassError');
    if (errEl) errEl.style.display = 'none';
    toggleModal('changePassModal', true);
}

async function handleChangePasswordSubmit(e) {
    e.preventDefault();
    const currentInput = (document.getElementById('currentMasterPassword')?.value || '').trim();
    const newInput = (document.getElementById('newMasterPassword')?.value || '').trim();
    const confirmInput = (document.getElementById('confirmNewMasterPassword')?.value || '').trim();
    const errEl = document.getElementById('changePassError');

    const showError = (msg) => {
        if (errEl) {
            errEl.textContent = msg;
            errEl.style.display = 'block';
        }
    };

    if (errEl) errEl.style.display = 'none';

    if (currentInput !== masterKeyPassword) {
        showError('Current master password does not match.');
        return;
    }

    if (!newInput || newInput.length < 12) {
        showError('New master password must be at least 12 characters.');
        return;
    }

    if (newInput !== confirmInput) {
        showError('New passwords do not match.');
        return;
    }

    try {
        const newPassword = newInput;
        masterKeyPassword = newPassword;

        if (typeof sessionStorage !== 'undefined') {
            await setSessionCache(masterKeyPassword);
        }

        // Re-encrypt local storage & IndexedDB
        await saveVault();
        await persistTombstones();

        // Re-join P2P room if active. SECURITY: join() uses the stored random
        // pairing credential, not the master password.
        if (window.TrysteroSync && TrysteroSync.isActive()) {
            TrysteroSync.leave();
            setupTrysteroListeners();
            const joined = await TrysteroSync.join();
            if (joined) {
                await broadcastP2pSnapshot();
            }
        }

        document.getElementById('currentMasterPassword').value = '';
        document.getElementById('newMasterPassword').value = '';
        document.getElementById('confirmNewMasterPassword').value = '';

        toggleModal('changePassModal', false);
        alert('Master password updated successfully! Your vault has been re-encrypted with your new password.');
    } catch (err) {
        console.error('Error changing master password:', err);
        showError('Failed to change master password: ' + (err.message || err));
    }
}

async function openP2pSyncModal() {
    toggleModal('p2pSyncModal', true);
    if (window.TrysteroSync) {
        const passInput = document.getElementById('p2pCustomPassphraseInput');
        if (passInput) {
            passInput.value = await TrysteroSync.getCustomPassphrase();
        }
        populateTurnServerForm();
    }
    updateP2pStatusUI();
}

function populateTurnServerForm() {
    if (!window.TrysteroSync) return;
    const urlInput = document.getElementById('turnServerUrlInput');
    const userInput = document.getElementById('turnServerUsernameInput');
    const credInput = document.getElementById('turnServerCredentialInput');
    const statusEl = document.getElementById('turnServerStatus');
    const servers = TrysteroSync.getTurnServers();
    const first = servers[0] || {};
    if (urlInput) urlInput.value = first.urls || '';
    if (userInput) userInput.value = first.username || '';
    if (credInput) credInput.value = first.credential || '';
    if (statusEl) {
        statusEl.textContent = servers.length
            ? 'Using custom TURN relay. Rejoin P2P to apply.'
            : 'No custom TURN — using default STUN/TURN servers.';
    }
}

function handleSaveTurnServer() {
    if (!window.TrysteroSync) return;
    const urlInput = document.getElementById('turnServerUrlInput');
    const userInput = document.getElementById('turnServerUsernameInput');
    const credInput = document.getElementById('turnServerCredentialInput');
    const url = (urlInput ? urlInput.value.trim() : '');
    if (!url) {
        TrysteroSync.setTurnServers([]);
        showToast('Custom TURN relay cleared.', 'success');
    } else {
        const list = [{ urls: url, username: (userInput ? userInput.value.trim() : '') || undefined, credential: (credInput ? credInput.value.trim() : '') || undefined }];
        TrysteroSync.setTurnServers(list);
        showToast('TURN relay saved — rejoin P2P to apply.', 'success');
    }
    populateTurnServerForm();
    // SECURITY: Rejoin with stored credential, not master password.
    if (TrysteroSync.isActive()) {
        TrysteroSync.leave();
        setupTrysteroListeners();
        TrysteroSync.join().then(() => updateP2pStatusUI());
    }
}

/**
 * SECURITY: QR pairing encodes a random pairing credential, NEVER the master
 * password. The credential is auto-generated if one doesn't exist.
 */
async function showP2pPairingQr() {
    const qrBox = document.getElementById('p2pPairingQr');
    const hintEl = document.getElementById('p2pPairingHint');
    if (!qrBox || !window.TrysteroSync) return;

    if (qrBox.style.display !== 'none' && qrBox.dataset.rendered === 'yes') {
        qrBox.style.display = 'none';
        return;
    }

    // Ensure a random pairing credential exists
    let credential = await TrysteroSync.getCustomPassphrase();
    if (!credential) {
        credential = TrysteroSync.generatePairingCredential();
        await TrysteroSync.setCustomPassphrase(credential);
    }

    qrBox.style.display = 'flex';
    // SECURITY: QR contains only 'webauth-pair:v2:<random_credential>'
    // The master password is never included.
    SVGQRCode.renderInto(qrBox, 'webauth-pair:v2:' + credential, 190);
    qrBox.dataset.rendered = 'yes';
    if (hintEl) {
        hintEl.textContent = 'Scan this QR on the new device to pair. The QR contains a random sync credential — your master password is never shared.';
    }
}

function scanP2pPairingQr() {
    if (!window.TrysteroSync) {
        showToast('P2P Sync module is unavailable.', 'error');
        return;
    }
    startCameraScanner();
    const status = document.getElementById('cameraStatus');
    if (status) status.textContent = 'Point camera at the pairing QR from the other device...';
}

async function handleJoinP2pSync() {
    if (!window.TrysteroSync) {
        showToast('P2P Sync module is unavailable.', 'error');
        return;
    }
    if (!masterKeyPassword) return;
    setupTrysteroListeners();
    // SECURITY: join() uses the stored random pairing credential (auto-generated
    // if none exists). The master password is NEVER passed to join().
    const joined = await TrysteroSync.join();
    updateP2pStatusUI();
    if (joined) {
        await broadcastP2pSnapshot();
    }
}

function handleLeaveP2pSync() {
    if (!window.TrysteroSync) return;
    TrysteroSync.leave();
    updateP2pStatusUI();
}
let pendingPeerDeviceId = null;
let pendingPeerPayload = null;

function promptPeerApproval(deviceId, payload) {
    pendingPeerDeviceId = deviceId;
    pendingPeerPayload = payload;
    const promptBox = document.getElementById('p2pPendingApprovals');
    const fingerprintEl = document.getElementById('p2pPendingFingerprint');
    if (promptBox && fingerprintEl) {
        fingerprintEl.textContent = deviceId ? deviceId.slice(0, 8) : 'Unknown';
        promptBox.style.display = 'block';
    }
}

async function processIncomingP2pPayload(payload) {
    if (!masterKeyPassword) return;
    try {
        const encryptedPayload = typeof payload === 'string' ? JSON.parse(payload) : payload;
        const decryptedData = await CryptoVault.decrypt(encryptedPayload, masterKeyPassword);
        if (Array.isArray(decryptedData)) {
            // Legacy format: plain full vault array
            await mergeRemoteAccounts(decryptedData, []);
        } else if (decryptedData && typeof decryptedData === 'object') {
            if (decryptedData.request) {
                await broadcastP2pSnapshot();
            } else {
                await mergeRemoteAccounts(decryptedData.accounts || [], decryptedData.deletes || []);
            }
        }
    } catch (err) {
        console.warn('[P2P] decrypt/merge error:', err);
    }
}

let trysteroListenersWired = false;
function setupTrysteroListeners() {
    if (!window.TrysteroSync || trysteroListenersWired) return;
    trysteroListenersWired = true;

    const approveBtn = document.getElementById('approveP2pPeerBtn');
    if (approveBtn) approveBtn.addEventListener('click', () => {
        if (!pendingPeerDeviceId || !window.TrysteroSync) return;
        TrysteroSync.approvePeer(pendingPeerDeviceId);
        const promptBox = document.getElementById('p2pPendingApprovals');
        if (promptBox) promptBox.style.display = 'none';
        if (pendingPeerPayload) {
            processIncomingP2pPayload(pendingPeerPayload);
            pendingPeerPayload = null;
        }
        pendingPeerDeviceId = null;
    });

    const savePassBtn = document.getElementById('saveP2pCustomPassBtn');
    if (savePassBtn) savePassBtn.addEventListener('click', async () => {
        if (!window.TrysteroSync) return;
        const passInput = document.getElementById('p2pCustomPassphraseInput');
        const passVal = passInput ? passInput.value.trim() : '';
        // SECURITY: If user clears the field, auto-generate a random credential
        // instead of falling back to the master password.
        const credential = passVal || TrysteroSync.generatePairingCredential();
        await TrysteroSync.setCustomPassphrase(credential);
        if (TrysteroSync.isActive()) {
            TrysteroSync.leave();
            const joined = await TrysteroSync.join();
            updateP2pStatusUI();
            if (joined) {
                await broadcastP2pSnapshot();
            }
        }
        showToast(passVal ? 'Sync credential saved — devices will re-pair.' : 'New random sync credential generated — re-pair devices.', 'success');
    });

    TrysteroSync.onPeerChange(async (peerCount, peerId, action) => {
        // SECURITY: Do not log peer IDs to avoid leaking device identifiers.
        updateP2pStatusUI();
        if (action === 'join' && masterKeyPassword) {
            await broadcastP2pSnapshot();
            logDebug(`P2P snapshot broadcast sent to newly joined peer (${peerId || 'peer'})`);
        }
    });

    const syncNowBtn = document.getElementById('p2pSyncNowBtn');
    if (syncNowBtn) syncNowBtn.addEventListener('click', requestP2pSync);

    const p2pErrorEl = document.getElementById('p2pErrorText');
    TrysteroSync.onError((msg) => {
        if (p2pErrorEl) {
            p2pErrorEl.textContent = 'P2P note: ' + msg;
            p2pErrorEl.style.display = 'block';
        }
        updateP2pStatusUI();
        console.warn('[P2P]', msg);
    });

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && masterKeyPassword) {
            broadcastP2pSnapshot();
        }
    });

    TrysteroSync.onReceive(async (payload, peerId, deviceId) => {
        if (!masterKeyPassword) return;
        const effectiveId = deviceId || peerId;
        if (window.TrysteroSync && !TrysteroSync.isPeerApproved(effectiveId)) {
            promptPeerApproval(effectiveId, payload);
            return;
        }
        await processIncomingP2pPayload(payload);
    });
}



async function handleAuthSubmit(e) {
    e.preventDefault();
    const pass = document.getElementById('masterPassword').value.trim();
    const confirmPass = document.getElementById('confirmPassword').value.trim();
    const errorEl = document.getElementById('authError');
    let existingVault = localStorage.getItem(VAULT_STORAGE_KEY);

    if (!existingVault) {
        existingVault = await loadFromIndexedDB(VAULT_STORAGE_KEY);
    }

    errorEl.style.display = 'none';

    if (!existingVault) {
        if (pass.length < 12) {
            showError(errorEl, 'Master password must be at least 12 characters.');
            return;
        }
        if (pass !== confirmPass) {
            showError(errorEl, 'Passwords do not match.');
            return;
        }
        const ackEl = document.getElementById('recoveryKeyAck');
        if (ackEl && !ackEl.checked) {
            showError(errorEl, 'Please confirm you have saved your Emergency Recovery Key before creating the vault.');
            return;
        }
        masterKeyPassword = pass;
        vaultData = [];

        // Recovery key is shown ONCE and never persisted — the user must save it
        // offline. It is kept in memory so the recovery backup can be (re)built.
        recoveryKeyInMemory = document.getElementById('generatedRecoveryKey').value;

        try {
            await saveVault();
            await setSessionCache(pass);
            showDashboard();
        } catch (vaultErr) {
            showError(errorEl, vaultErr.message || 'Failed to initialize vault.');
            return;
        }
    } else {
        try {
            const encryptedPayload = JSON.parse(existingVault);
            vaultData = await CryptoVault.decrypt(encryptedPayload, pass);
            masterKeyPassword = pass;
            recoveryKeyInMemory = null;
            await setSessionCache(pass);
            normalizeVault();
            await loadTombstones();
            logDebug(`Vault unlocked with password. Loaded ${vaultData.length} accounts.`);
            showDashboard();
            return;
        } catch (err) {}

        // Password failed — the typed value may be the Emergency Recovery Key,
        // which decrypts the recovery backup (stored under BACKUP_AUTOSAVE_KEY).
        try {
            let backupPayloadStr = localStorage.getItem(BACKUP_AUTOSAVE_KEY);
            if (!backupPayloadStr) {
                backupPayloadStr = await loadFromIndexedDB(BACKUP_AUTOSAVE_KEY);
            }
            if (backupPayloadStr) {
                const encryptedPayload = JSON.parse(backupPayloadStr);
                vaultData = await CryptoVault.decrypt(encryptedPayload, pass);
                masterKeyPassword = pass;
                recoveryKeyInMemory = pass;
                await setSessionCache(pass);
                normalizeVault();
                await loadTombstones();
                logDebug(`Vault unlocked via Emergency Recovery Key!`);
                showDashboard();
                return;
            }
        } catch (recErr) {}

        showError(errorEl, 'Incorrect master password or recovery key.');
    }
}

async function saveVault() {
    if (!masterKeyPassword) return;

    await persistVaultLocal();

    if (window.TrysteroSync && TrysteroSync.isConnected()) {
        await broadcastP2pDelta();
    }
}

async function showDashboard() {
    document.getElementById('authSection').style.display = 'none';
    document.getElementById('dashboardSection').style.display = 'block';
    document.getElementById('headerActions').style.display = 'block';
    buildAccountsDOM();
    startTotpTimer();

    if (window.FileSync) {
        if (!('showSaveFilePicker' in window)) {
            const folderBtn = document.getElementById('folderSyncBtn');
            if (folderBtn) folderBtn.style.display = 'none';
        } else {
            const restored = await FileSync.init();
            if (restored) {
                await syncWithLinkedFile();
            }
        }
    }

    // SECURITY: Auto-rejoin P2P with stored random credential, not master password.
    if (window.TrysteroSync && TrysteroSync.isActive() && masterKeyPassword) {
        setupTrysteroListeners();
        await TrysteroSync.join();
    }
}

function lockVault() {
    masterKeyPassword = null;
    vaultData = [];
    clearSessionCache();
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    document.getElementById('masterPassword').value = '';
    document.getElementById('confirmPassword').value = '';
    document.getElementById('dashboardSection').style.display = 'none';
    document.getElementById('headerActions').style.display = 'none';
    document.getElementById('authSection').style.display = 'block';
    initAuthScreen();
}

function openDeviceSyncModal() {
    if (vaultData.length === 0) {
        alert('Vault is empty. Add accounts before syncing.');
        return;
    }
    toggleModal('syncModal', true);
    const container = document.getElementById('syncQrContainer');

    const compactData = vaultData.map(a => [a.issuer, a.account, a.secret, a.period || 30, a.digits || 6]);
    const syncString = 'webauth://sync/' + encodeURIComponent(JSON.stringify(compactData));
    SVGQRCode.renderInto(container, syncString, 240);

    document.getElementById('syncPairCode').textContent = `Total Accounts Ready: ${vaultData.length}`;
}

const AVATAR_COLORS = ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#3b82f6'];

function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
}

function avatarColorFor(issuer) {
    return AVATAR_COLORS[hashString((issuer || '?').trim().toLowerCase()) % AVATAR_COLORS.length];
}

function issuerInitial(issuer) {
    const t = (issuer || '?').trim();
    return t ? t.charAt(0).toUpperCase() : '?';
}

function sortedVault() {
    return [...vaultData].sort((a, b) => {
        const pa = a.pinned ? 1 : 0;
        const pb = b.pinned ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    });
}

function togglePinAccount(event, id) {
    event.stopPropagation();
    const acc = vaultData.find(a => a.id === id);
    if (!acc) return;
    acc.pinned = !acc.pinned;
    acc.updatedAt = Date.now();
    markAccountChanged(acc);
    saveVault().then(buildAccountsDOM);
}

function buildAccountsDOM() {
    const grid = document.getElementById('accountsList');
    const emptyState = document.getElementById('emptyState');
    grid.innerHTML = '';

    logDebug(`Building DOM for ${vaultData.length} accounts.`);

    if (vaultData.length === 0) {
        emptyState.style.display = 'block';
        grid.style.display = 'none';
        return;
    } else {
        emptyState.style.display = 'none';
        grid.style.display = 'grid';
    }

    const items = sortedVault();
    items.forEach(acc => {
        const card = document.createElement('div');
        card.className = 'account-card' + (acc.pinned ? ' pinned' : '');
        card.setAttribute('data-id', acc.id);
        card.setAttribute('draggable', 'true');
        card.setAttribute('data-issuer', (acc.issuer || '').toLowerCase());
        card.setAttribute('data-account', (acc.account || '').toLowerCase());
        
        card.addEventListener('click', (e) => {
            if (e.target.closest('.btn') || e.target.closest('.code-display')) {
                return;
            }
            openAccountDetailModal(acc.id);
        });

        card.addEventListener('dragstart', (e) => {
            dragAccountId = acc.id;
            card.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', acc.id); } catch (err) {}
        });
        card.addEventListener('dragend', () => {
            dragAccountId = null;
            card.classList.remove('dragging');
            grid.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        });
        card.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (dragAccountId && dragAccountId !== acc.id) card.classList.add('drag-over');
        });
        card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
        card.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            card.classList.remove('drag-over');
            if (dragAccountId && dragAccountId !== acc.id) {
                reorderAccount(dragAccountId, acc.id);
            }
            dragAccountId = null;
        });

        const type = accountType(acc);
        const hotpNextBtn = type === 'HOTP'
            ? `<button class="btn-hotp-next" id="next-${acc.id}" title="Next counter" style="display:none;" onclick="advanceHotpCounter(event, '${acc.id}')">Next</button>`
            : '';

        card.innerHTML = `
            <div class="account-header-row">
                <div class="acc-avatar" style="background: ${avatarColorFor(acc.issuer)};">${issuerInitial(acc.issuer)}</div>
                <div class="account-info">
                    <h4>${escapeHtml(acc.issuer)}</h4>
                    <p>${escapeHtml(acc.account)}</p>
                </div>
                <div class="account-actions">
                    <button class="btn btn-secondary btn-sm pin-btn" title="${acc.pinned ? 'Unpin' : 'Pin to top'}" onclick="togglePinAccount(event, '${acc.id}')">${acc.pinned ? '★' : '☆'}</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteAccountDirect(event, '${acc.id}')">Delete</button>
                </div>
            </div>
            <div class="code-display" onclick="copyAccountCode(event, '${acc.id}')">
                <span class="code-number" id="code-${acc.id}">------</span>
                ${hotpNextBtn}
                <span class="timer-circle" id="timer-${acc.id}">--s</span>
                <span class="code-progress"><span class="code-progress-fill" id="fill-${acc.id}"></span></span>
            </div>
        `;
        grid.appendChild(card);
    });

    updateTotpCodes();
}

function reorderAccount(draggedId, targetId) {
    const from = vaultData.findIndex(a => a.id === draggedId);
    const to = vaultData.findIndex(a => a.id === targetId);
    if (from === -1 || to === -1 || from === to) return;
    const [moved] = vaultData.splice(from, 1);
    vaultData.splice(to, 0, moved);
    vaultData.forEach((a, i) => { a.sortOrder = i; });
    saveVault().then(buildAccountsDOM);
}

async function deleteAccountDirect(event, id) {
    event.stopPropagation();
    if (confirm('Are you sure you want to delete this account?')) {
        vaultData = vaultData.filter(a => a.id !== id);
        await saveVault();
        buildAccountsDOM();
    }
}

function openAccountDetailModal(id) {
    logDebug(`Opening detail modal for ID: ${id}`);
    const acc = vaultData.find(a => a.id === id);
    if (!acc) {
        logDebug(`Error: Account ID ${id} not found in vaultData`);
        return;
    }
    activeDetailAccountId = id;

    document.getElementById('detailTitle').textContent = `${acc.issuer} (${acc.account})`;
    document.getElementById('detailIssuer').textContent = acc.issuer;
    document.getElementById('detailAccount').textContent = acc.account;
    
    const secretTextEl = document.getElementById('detailSecret');
    secretTextEl.textContent = '••••••••••••••••';
    secretTextEl.setAttribute('data-secret', acc.secret);
    document.getElementById('toggleSecretBtn').textContent = 'Show';

    const type = accountType(acc);
    document.getElementById('detailType').textContent = type === 'STEAM' ? 'Steam' : (acc.type || 'TOTP');
    document.getElementById('detailAlgorithm').textContent = acc.algorithm || 'SHA1';
    document.getElementById('detailDigits').textContent = type === 'STEAM' ? '5' : (acc.digits || '6');
    document.getElementById('detailPeriod').textContent = type === 'HOTP' ? `counter C${acc.counter || 0}` : `${acc.period || 30}s`;

    const container = document.getElementById('detailQrCanvas');
    const cleanIssuer = encodeURIComponent(acc.issuer.trim());
    const cleanAccount = encodeURIComponent(acc.account.trim());
    let otpUri;
    if (type === 'HOTP') {
        otpUri = `otpauth://hotp/${cleanIssuer}:${cleanAccount}?secret=${acc.secret.replace(/\s+/g, '')}&issuer=${cleanIssuer}&counter=${acc.counter || 0}&digits=${acc.digits || 6}`;
    } else {
        otpUri = `otpauth://totp/${cleanIssuer}:${cleanAccount}?secret=${acc.secret.replace(/\s+/g, '')}&issuer=${cleanIssuer}&period=${acc.period || 30}&digits=${acc.digits || 6}`;
    }
    if (type === 'STEAM') {
        otpUri = `otpauth://totp/Steam%3A${cleanAccount.replace(/^Steam%3A/, '')}?secret=${acc.secret.replace(/\s+/g, '')}&issuer=Steam`;
    }

    SVGQRCode.renderInto(container, otpUri, 180);

    toggleModal('detailModal', true);
}

function toggleSecretReveal() {
    const secretTextEl = document.getElementById('detailSecret');
    const btn = document.getElementById('toggleSecretBtn');
    const realSecret = secretTextEl.getAttribute('data-secret');

    if (btn.textContent === 'Show') {
        secretTextEl.textContent = realSecret;
        btn.textContent = 'Hide';
    } else {
        secretTextEl.textContent = '••••••••••••••••';
        btn.textContent = 'Show';
    }
}

async function deleteCurrentDetailAccount() {
    if (!activeDetailAccountId) return;
    if (!confirm('Are you sure you want to delete this account?')) return;

    const target = vaultData.find(a => a.id === activeDetailAccountId);
    if (target) {
        const delTs = Date.now();
        tombstoneMap.set(target.secret, { secret: target.secret, updatedAt: delTs });
        markAccountDeleted(target.secret, delTs);
    }

    vaultData = vaultData.filter(a => a.id !== activeDetailAccountId);
    await saveVault();
    await persistTombstones();
    toggleModal('detailModal', false);
    buildAccountsDOM();
}

function renderAccountsListOnly() {
    const filter = document.getElementById('searchInput').value.toLowerCase();
    const cards = document.querySelectorAll('.account-card');
    cards.forEach(card => {
        const issuer = card.getAttribute('data-issuer');
        const account = card.getAttribute('data-account');
        if (issuer.includes(filter) || account.includes(filter)) {
            card.style.display = 'flex';
        } else {
            card.style.display = 'none';
        }
    });
}

const STEAM_ALPHABET = '23456789BCDFGHJKMNPQRTVWXY';

/**
 * SECURITY: Steam TOTP now uses Web Crypto HMAC-SHA1 instead of CryptoJS.
 * This is async (returns a Promise) because Web Crypto sign() is async.
 */
async function generateSteamCode(secret, epoch) {
    const counter = Math.floor(epoch / 30);
    const counterBuffer = new ArrayBuffer(8);
    const counterView = new DataView(counterBuffer);
    // HMAC-SHA1 counter is big-endian 64-bit; high 32 bits are always 0 for
    // realistic counter values.
    counterView.setUint32(4, counter, false);

    const keyBytes = base32DecodeString(secret);
    const cryptoKey = await crypto.subtle.importKey(
        'raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
    );
    const hmacBuffer = await crypto.subtle.sign('HMAC', cryptoKey, counterBuffer);
    const hmacBytes = new Uint8Array(hmacBuffer);

    const offset = hmacBytes[19] & 0x0f;
    let full = ((hmacBytes[offset] & 0x7f) << 24) |
               ((hmacBytes[offset + 1] & 0xff) << 16) |
               ((hmacBytes[offset + 2] & 0xff) << 8) |
               (hmacBytes[offset + 3] & 0xff);
    let result = '';
    for (let i = 0; i < 5; i++) {
        result += STEAM_ALPHABET[full % 26];
        full = Math.floor(full / 26);
    }
    return result;
}

function isSteamAccount(acc) {
    return (acc.type || '').toUpperCase() === 'STEAM' ||
           ((acc.type || 'TOTP').toUpperCase() === 'TOTP' && (acc.issuer || '').trim().toUpperCase() === 'STEAM');
}

function accountType(acc) {
    if (isSteamAccount(acc)) return 'STEAM';
    return (acc.type || 'TOTP').toUpperCase();
}

async function updateTotpCodes() {
    const epoch = Math.floor(Date.now() / 1000);
    for (const acc of vaultData) {
        const codeEl = document.getElementById('code-' + acc.id);
        const timerEl = document.getElementById('timer-' + acc.id);
        const nextEl = document.getElementById('next-' + acc.id);
        const progressEl = document.getElementById('fill-' + acc.id);
        if (!codeEl || !timerEl) continue;

        try {
            const cleanSecret = acc.secret.replace(/\s+/g, '');
            if (!cleanSecret || cleanSecret.length < 16 || cleanSecret.length > 64) {
                throw new Error('Invalid secret length');
            }

            const type = accountType(acc);
            const period = acc.period || 30;
            let tokenCode;
            let remaining = null;

            if (type === 'STEAM') {
                // SECURITY: Steam HMAC now uses Web Crypto (async)
                tokenCode = await generateSteamCode(cleanSecret, epoch);
                remaining = period - (epoch % period);
            } else if (type === 'HOTP') {
                const hotp = new OTPAuth.HOTP({
                    issuer: acc.issuer || 'Service',
                    label: acc.account || 'Account',
                    algorithm: acc.algorithm || 'SHA1',
                    digits: acc.digits || 6,
                    counter: acc.counter || 0,
                    secret: OTPAuth.Secret.fromBase32(cleanSecret)
                });
                tokenCode = hotp.generate();
            } else {
                const totp = new OTPAuth.TOTP({
                    issuer: acc.issuer || 'Service',
                    label: acc.account || 'Account',
                    algorithm: acc.algorithm || 'SHA1',
                    digits: acc.digits || 6,
                    period: period,
                    secret: OTPAuth.Secret.fromBase32(cleanSecret)
                });
                tokenCode = totp.generate();
                remaining = period - (epoch % period);
            }

            if (type === 'STEAM') {
                codeEl.textContent = tokenCode;
            } else {
                codeEl.textContent = tokenCode.length > 6 ? tokenCode : tokenCode.slice(0, 3) + ' ' + tokenCode.slice(3);
            }
            codeEl.setAttribute('data-fullcode', tokenCode);

            if (type === 'HOTP') {
                timerEl.textContent = 'C' + (acc.counter || 0);
                if (nextEl) nextEl.style.display = 'inline-flex';
                if (progressEl) progressEl.style.width = '0%';
            } else {
                timerEl.textContent = remaining + 's';
                if (nextEl) nextEl.style.display = 'none';
                if (progressEl) {
                    progressEl.style.width = ((remaining / period) * 100) + '%';
                    progressEl.style.background = remaining <= 5 ? 'var(--danger-color)' : remaining <= 10 ? 'var(--accent-cyan)' : 'var(--success-color)';
                }
            }
        } catch (e) {
            codeEl.textContent = 'INVALID';
            timerEl.textContent = '--s';
            // SECURITY: Do not log the secret or full error in production.
        }
    }
}

function advanceHotpCounter(event, id) {
    event.stopPropagation();
    const acc = vaultData.find(a => a.id === id);
    if (!acc) return;
    acc.counter = (acc.counter || 0) + 1;
    acc.updatedAt = Date.now();
    markAccountChanged(acc);
    saveVault().then(() => {
        updateTotpCodes();
        showToast(`Counter advanced to C${acc.counter}`, 'success');
    });
}

function startTotpTimer() {
    if (timerInterval) clearInterval(timerInterval);
    updateTotpCodes();
    timerInterval = setInterval(updateTotpCodes, 1000);
}

function openAddModal(tab) {
    toggleModal('addModal', true);
    switchAddTab(tab);
}

function switchAddTab(tab) {
    const tabManualBtn = document.getElementById('tabManualBtn');
    const tabImageBtn = document.getElementById('tabImageBtn');
    const addAccountForm = document.getElementById('addAccountForm');
    const tabImageContent = document.getElementById('tabImageContent');

    if (tab === 'manual') {
        tabManualBtn.classList.add('active');
        tabImageBtn.classList.remove('active');
        addAccountForm.style.display = 'block';
        tabImageContent.style.display = 'none';
    } else {
        tabImageBtn.classList.add('active');
        tabManualBtn.classList.remove('active');
        addAccountForm.style.display = 'none';
        tabImageContent.style.display = 'block';
    }
}

async function handleAddAccount(e) {
    e.preventDefault();
    const inputSecret = document.getElementById('accSecret').value.trim();
    const errorEl = document.getElementById('addError');

    if (inputSecret.startsWith('otpauth-migration://') || inputSecret.includes('data=')) {
        const migratedAccounts = parseGoogleAuthMigrationUri(inputSecret);
        if (migratedAccounts && migratedAccounts.length > 0) {
            let count = 0;
            for (let acc of migratedAccounts) {
                const added = await saveNewAccount(acc);
                if (added) count++;
            }
            toggleModal('addModal', false);
            document.getElementById('addAccountForm').reset();
            buildAccountsDOM();
            alert(`Processed QR: Imported/Updated ${count} account(s)!`);
            return;
        } else {
            showError(errorEl, 'Invalid or unparseable otpauth-migration:// URI.');
            return;
        }
    }

    let issuer = document.getElementById('accIssuer').value.trim();
    let account = document.getElementById('accAccount').value.trim();
    let secret = inputSecret;
    let period = parseInt(document.getElementById('accPeriod').value) || 30;
    let digits = parseInt(document.getElementById('accDigits').value) || 6;
    let type = document.getElementById('accType').value || 'TOTP';
    let counter = parseInt(document.getElementById('accCounter').value) || 0;

    if (inputSecret.startsWith('otpauth://')) {
        try {
            const parsed = OTPAuth.URI.parse(inputSecret);
            issuer = parsed.issuer || issuer || 'Unknown';
            account = parsed.label || account || 'Account';
            secret = parsed.secret.base32;
            period = parsed.period || period;
            digits = parsed.digits || digits;
            if (parsed.type === 'hotp') {
                type = 'HOTP';
                counter = parsed.counter || counter || 0;
            } else if (parsed.type === 'totp' && (parsed.issuer || '').trim().toUpperCase() === 'STEAM') {
                type = 'Steam';
            }
        } catch (err) {
            showError(errorEl, 'Invalid otpauth:// URI string.');
            return;
        }
    } else {
        try {
            secret = secret.toUpperCase().replace(/\s+/g, '').replace(/=+$/, '');
            OTPAuth.Secret.fromBase32(secret);
        } catch (e) {
            showError(errorEl, 'Invalid Base32 secret key format.');
            return;
        }
    }

    if (!issuer) issuer = 'Service';
    if (!account) account = 'Account';

    await saveNewAccount({ issuer, account, secret, period, digits, type, counter });
    toggleModal('addModal', false);
    document.getElementById('addAccountForm').reset();
    buildAccountsDOM();
}

async function saveNewAccount(acc) {
    // SECURITY: Treat imported data as untrusted. Validate and sanitize.
    if (!acc) return false;
    let obj = acc;
    if (Array.isArray(acc)) {
        obj = {
            issuer: acc[0],
            account: acc[1],
            secret: acc[2],
            period: acc[3] || 30,
            digits: acc[4] || 6
        };
    }
    if (typeof obj !== 'object') return false;
    // Prototype pollution guard: safely check own properties (not inherited prototype properties)
    if (Object.prototype.hasOwnProperty.call(obj, '__proto__') || Object.prototype.hasOwnProperty.call(obj, 'prototype')) {
        logDebug('[IMPORT] rejected object with suspicious prototype keys');
        return false;
    }
    const rawSecret = obj.secret || obj.key || obj.secret_key || obj.raw_secret || obj.secretKey;
    if (typeof rawSecret !== 'string' || !rawSecret.trim()) {
        logDebug('[IMPORT] rejected account with missing/invalid secret');
        return false;
    }
    if (rawSecret.length > 500) {
        logDebug('[IMPORT] rejected account with oversized secret');
        return false;
    }
    const cleanSecret = rawSecret.toUpperCase().replace(/\s+/g, '');
    // Truncate issuer/account to prevent oversized DOM injection.
    const cleanIssuer = (typeof obj.issuer === 'string' ? obj.issuer : 'Service').trim().slice(0, 200);
    const cleanAccount = (typeof obj.account === 'string' ? obj.account : 'Account').trim().slice(0, 200);

    const existingIndex = vaultData.findIndex(a => 
        a.secret === cleanSecret || 
        (a.issuer.toLowerCase() === cleanIssuer.toLowerCase() && a.account.toLowerCase() === cleanAccount.toLowerCase())
    );

    if (existingIndex !== -1) {
        logDebug(`Updating existing account: "${cleanIssuer} (${cleanAccount})"`);
        vaultData[existingIndex] = {
            ...vaultData[existingIndex],
            issuer: cleanIssuer,
            account: cleanAccount,
            secret: cleanSecret,
            period: acc.period || 30,
            digits: acc.digits || 6,
            algorithm: acc.algorithm || 'SHA1',
            type: (acc.type || 'TOTP').toUpperCase() === 'HOTP' ? 'HOTP' : isSteamAccount(acc) ? 'Steam' : (acc.type || 'TOTP'),
            counter: acc.counter != null ? acc.counter : vaultData[existingIndex].counter,
            updatedAt: Date.now()
        };
        markAccountChanged(vaultData[existingIndex]);
    } else {
        logDebug('Adding new account: ' + cleanIssuer);
        // SECURITY: Account IDs use CSPRNG instead of Math.random().
        const idRandom = new Uint8Array(6);
        crypto.getRandomValues(idRandom);
        const newAccount = {
            id: Date.now().toString() + Array.from(idRandom).map(b => b.toString(36)).join('').slice(0, 4),
            issuer: cleanIssuer,
            account: cleanAccount,
            secret: cleanSecret,
            period: acc.period || 30,
            digits: acc.digits || 6,
            algorithm: acc.algorithm || 'SHA1',
            type: (acc.type || 'TOTP').toUpperCase() === 'HOTP' ? 'HOTP' : isSteamAccount(acc) ? 'Steam' : (acc.type || 'TOTP'),
            counter: acc.counter != null ? acc.counter : 0,
            pinned: !!acc.pinned,
            sortOrder: Date.now(),
            updatedAt: Date.now()
        };
        vaultData.push(newAccount);
        markAccountChanged(newAccount);
    }
    await saveVault();
    return true;
}

function handleImageUpload() {
    const fileInput = document.getElementById('qrFileInput');
    const errorEl = document.getElementById('imageParseError');
    errorEl.style.display = 'none';

    if (!fileInput.files.length) return;
    const file = fileInput.files[0];
    const reader = new FileReader();

    reader.onload = function (e) {
        const img = new Image();
        img.onload = function () {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0, img.width, img.height);
            
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            
            if (typeof jsQR === 'undefined') {
                showError(errorEl, 'QR scanner library failed to load.');
                logDebug('Error: jsQR is undefined.');
                return;
            }

            const code = jsQR(imageData.data, imageData.width, imageData.height, {
                inversionAttempts: "attemptBoth"
            });

            if (code) {
                logDebug(`QR Code decoded from image. Payload length: ${code.data.length}`);
                parseAndAddQrPayload(code.data);
            } else {
                showError(errorEl, 'No valid QR code found in the uploaded image.');
                logDebug('jsQR failed to locate a QR code in the image.');
            }
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

async function startCameraScanner() {
    toggleModal('cameraModal', true);
    const video = document.getElementById('cameraVideo');
    const status = document.getElementById('cameraStatus');
    status.textContent = 'Accessing camera...';

    const getMedia = navigator.mediaDevices?.getUserMedia ||
                     (navigator.getUserMedia ? (constraints) => new Promise((res, rej) => navigator.getUserMedia(constraints, res, rej)) : null) ||
                     (navigator.webkitGetUserMedia ? (constraints) => new Promise((res, rej) => navigator.webkitGetUserMedia(constraints, res, rej)) : null) ||
                     (navigator.mozGetUserMedia ? (constraints) => new Promise((res, rej) => navigator.mozGetUserMedia(constraints, res, rej)) : null);

    if (!getMedia) {
        status.textContent = 'Camera access requires HTTPS or localhost (or camera is not supported on this browser). Use "Upload Image" instead.';
        return;
    }

    try {
        cameraStream = await getMedia.call(navigator.mediaDevices || navigator, { video: { facingMode: 'environment' } });
        video.srcObject = cameraStream;
        video.setAttribute('playsinline', true);
        video.play();
        status.textContent = 'Point camera at QR code...';
        scanCameraFrame();
    } catch (err) {
        status.textContent = 'Error accessing camera: ' + (err.message || 'Permission denied or device in use.');
    }
}

function scanCameraFrame() {
    const video = document.getElementById('cameraVideo');
    const canvas = document.getElementById('cameraCanvas');
    const ctx = canvas.getContext('2d');

    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        
        if (typeof jsQR !== 'undefined') {
            const code = jsQR(imageData.data, imageData.width, imageData.height, {
                inversionAttempts: "attemptBoth"
            });
            if (code) {
                stopCameraScanner();
                logDebug(`Camera scanned QR length: ${code.data.length}`);
                parseAndAddQrPayload(code.data);
                return;
            }
        }
    }
    cameraAnimationId = requestAnimationFrame(scanCameraFrame);
}

function stopCameraScanner() {
    if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
        cameraStream = null;
    }
    if (cameraAnimationId) {
        cancelAnimationFrame(cameraAnimationId);
        cameraAnimationId = null;
    }
    toggleModal('cameraModal', false);
}

async function parseAndAddQrPayload(payload) {
    logDebug('Parsing QR payload...');

    let cleanPayload = payload.trim();

    // SECURITY: Handle v2 pairing protocol (random credential, no password)
    if (cleanPayload.startsWith('webauth-pair:v2:')) {
        const credential = cleanPayload.slice('webauth-pair:v2:'.length);
        if (!window.TrysteroSync) {
            showToast('P2P Sync module is unavailable.', 'error');
            return;
        }
        if (credential && credential.length >= 32) {
            await TrysteroSync.setCustomPassphrase(credential);
            setupTrysteroListeners();
            const joined = await TrysteroSync.join();
            updateP2pStatusUI();
            if (joined) {
                await broadcastP2pSnapshot();
                showToast('Pairing complete — P2P sync enabled', 'success');
            } else {
                showToast('Pairing failed — could not join sync room', 'error');
            }
        } else {
            showToast('Invalid pairing QR — credential too short', 'error');
        }
        return;
    }

    // Legacy v1 pairing: treat the value as a sync credential (not as a
    // password, since v1 QR may have contained the master password).
    // SECURITY: Warn the user this is an old-format QR.
    if (cleanPayload.startsWith('webauth-pair:')) {
        const legacyCredential = cleanPayload.slice('webauth-pair:'.length);
        if (!window.TrysteroSync) {
            showToast('P2P Sync module is unavailable.', 'error');
            return;
        }
        if (legacyCredential) {
            // Generate a NEW random credential instead of using the legacy value
            // (which may be the master password from a v1 QR).
            const newCredential = TrysteroSync.generatePairingCredential();
            await TrysteroSync.setCustomPassphrase(newCredential);
            setupTrysteroListeners();
            const joined = await TrysteroSync.join();
            updateP2pStatusUI();
            showToast('Old pairing QR detected — generated new secure credential. Re-pair the other device.', 'error');
        }
        return;
    }

    if (cleanPayload.startsWith('webauth://sync/') || cleanPayload.startsWith('webauth://batch/')) {
        cleanPayload = cleanPayload.replace('webauth://sync/', '').replace('webauth://batch/', '');
        try {
            cleanPayload = decodeURIComponent(cleanPayload);
        } catch (e) {}
    }

    if (cleanPayload.startsWith('[') || cleanPayload.startsWith('{')) {
        try {
            const rawData = JSON.parse(cleanPayload);
            let importedCount = 0;
            if (Array.isArray(rawData)) {
                for (let item of rawData) {
                    if (Array.isArray(item)) {
                        await saveNewAccount({
                            issuer: item[0],
                            account: item[1],
                            secret: item[2],
                            period: item[3] || 30,
                            digits: item[4] || 6
                        });
                        importedCount++;
                    } else if (typeof item === 'object') {
                        await saveNewAccount(item);
                        importedCount++;
                    }
                }
            } else if (typeof rawData === 'object') {
                await saveNewAccount(rawData);
                importedCount++;
            }
            buildAccountsDOM();
            toggleModal('addModal', false);
            alert(`Sync successful! Imported/Updated ${importedCount} 2FA account(s).`);
            return;
        } catch (e) {
            logDebug(`Error decoding JSON sync payload: ${e.message}`);
        }
    }
    else if (payload.startsWith('otpauth-migration://') || payload.includes('data=')) {
        const migratedAccounts = parseGoogleAuthMigrationUri(payload);
        if (migratedAccounts && migratedAccounts.length > 0) {
            for (let acc of migratedAccounts) {
                await saveNewAccount(acc);
            }
            buildAccountsDOM();
            toggleModal('addModal', false);
            alert(`Successfully imported ${migratedAccounts.length} account(s) from Migration QR!`);
        } else {
            alert('Failed to decode Google Authenticator Migration payload.');
        }
    } 
    else if (payload.startsWith('otpauth://')) {
        try {
            const parsed = OTPAuth.URI.parse(payload);
            let issuer = parsed.issuer || 'Service';
            let label = parsed.label || 'Account';
            if (label.includes(':')) {
                const parts = label.split(':');
                issuer = parts[0].trim();
                label = parts.slice(1).join(':').trim();
            }
            await saveNewAccount({
                issuer: issuer,
                account: label,
                secret: parsed.secret.base32,
                period: parsed.period || 30,
                digits: parsed.digits || 6
            });
            buildAccountsDOM();
            toggleModal('addModal', false);
            alert('Account imported successfully from QR code!');
        } catch (e) {
            alert('Invalid otpauth URI in QR code.');
        }
    } 
    else {
        await saveNewAccount({
            issuer: 'Service',
            account: 'Scanned Key',
            secret: payload,
            period: 30,
            digits: 6
        });
        buildAccountsDOM();
        toggleModal('addModal', false);
        alert('Account secret imported successfully!');
    }
}

function copyTextToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            document.execCommand('copy');
            ta.remove();
            resolve();
        } catch (e) {
            reject(e);
        }
    });
}

function showToast(message, type) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast ' + (type ? 'toast-' + type : '');
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast-show'));
    setTimeout(() => {
        toast.classList.remove('toast-show');
        toast.classList.add('toast-hide');
        setTimeout(() => toast.remove(), 320);
    }, 2600);
}

function copyAccountCode(event, id) {
    event.stopPropagation();
    const codeEl = document.getElementById(`code-${id}`);
    if (!codeEl) return;
    const fullCode = codeEl.getAttribute('data-fullcode') || codeEl.textContent.replace(/\s+/g, '');
    const codeDisplay = codeEl.closest('.code-display');
    copyTextToClipboard(fullCode).then(() => {
        if (codeDisplay) {
            codeDisplay.classList.add('copied');
            setTimeout(() => codeDisplay.classList.remove('copied'), 1200);
        }
        showToast('Code copied to clipboard', 'success');
    }).catch(() => {
        showToast('Copy failed — clipboard unavailable', 'error');
    });
}

function exportVaultFile() {
    const rawVaultData = localStorage.getItem(VAULT_STORAGE_KEY) || '[]';
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(rawVaultData);
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", "webauth_encrypted_backup.json");
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
}

function buildMigrationUri() {
    const migratable = vaultData.filter(a => accountType(a) !== 'STEAM');
    return buildGoogleAuthMigrationUri(migratable);
}

function openExportModal() {
    toggleModal('exportModal', true);
    const qrBox = document.getElementById('exportQrBox');
    qrBox.innerHTML = '';
    try {
        const uri = buildMigrationUri();
        window.__migrationUri = uri;
        SVGQRCode.renderInto(qrBox, uri, 200);
        document.getElementById('exportCountText').textContent =
            `Exporting ${vaultData.filter(a => accountType(a) !== 'STEAM').length} of ${vaultData.length} accounts (Steam accounts excluded).`;
    } catch (e) {
        document.getElementById('exportCountText').textContent =
            `QR too large (${vaultData.length} accounts) — use "Download .txt" or "Copy URI" instead.`;
        showToast('QR too large — use Copy URI or Download .txt', 'error');
    }
}

function copyMigrationUri() {
    const uri = window.__migrationUri || buildMigrationUri();
    copyTextToClipboard(uri).then(() => {
        showToast('otpauth-migration URI copied to clipboard', 'success');
    }).catch(() => {
        showToast('Copy failed — clipboard unavailable', 'error');
    });
}

function downloadMigrationUri() {
    const uri = window.__migrationUri || buildMigrationUri();
    const blob = new Blob([uri], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'webauth_otpauth_migration.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Migration URI downloaded', 'success');
}

async function handleImportVaultFile() {
    logDebug('[IMPORT] handleImportVaultFile fired');
    if (!masterKeyPassword) {
        alert('Please unlock your vault first.');
        return;
    }
    const fileInput = document.getElementById('importJsonFileInput');
    if (!fileInput.files || !fileInput.files.length) {
        console.warn('[IMPORT] no file selected');
        return;
    }

    const file = fileInput.files[0];
    logDebug('[IMPORT] file: ' + file.name + ' (' + file.size + ' bytes)');
    const reader = new FileReader();
    reader.onload = async function (e) {
        try {
            let rawText = e.target.result.trim();
            // SECURITY: Do not log raw import content (may contain plaintext secrets).
            logDebug('[IMPORT] read ' + rawText.length + ' chars');
            let parsed = null;

            try {
                parsed = JSON.parse(rawText);
                logDebug('[IMPORT] parsed top-level: ' + (Array.isArray(parsed) ? 'ARRAY(len=' + parsed.length + ')' : (typeof parsed)));
            } catch (err) {
                // Not JSON, check if it's an otpauth / otpauth-migration string file
                logDebug('[IMPORT] not JSON at top level: ' + err.message);
                if (rawText.startsWith('otpauth') || rawText.startsWith('webauth')) {
                    await parseAndAddQrPayload(rawText);
                    fileInput.value = '';
                    return;
                }
            }

            // Loop un-stringifying in case of multi-nested stringified JSON
            while (typeof parsed === 'string') {
                try {
                    parsed = JSON.parse(parsed);
                } catch (e) {
                    // String might be raw encrypted payload string from backup
                    if (parsed.startsWith('{') && parsed.includes('ciphertext')) {
                        parsed = JSON.parse(parsed);
                    } else if (parsed.startsWith('otpauth') || parsed.startsWith('webauth')) {
                        await parseAndAddQrPayload(parsed);
                        fileInput.value = '';
                        return;
                    } else {
                        logDebug('[IMPORT] stopping unstringify, still string');
                        break;
                    }
                }
            }
            logDebug('[IMPORT] final parsed type: ' + (Array.isArray(parsed) ? 'ARRAY(len=' + parsed.length + ')' : (typeof parsed)));

            let decryptedData = null;

            if (parsed && typeof parsed === 'object') {
                const encObj = parsed.cipher || parsed.ciphertext ? parsed : (parsed.vault ? (typeof parsed.vault === 'string' ? (parsed.vault.startsWith('{') ? JSON.parse(parsed.vault) : null) : parsed.vault) : null);
                logDebug('[IMPORT] encObj: ' + (encObj ? 'found' : 'null'));
                if (encObj && (encObj.cipher || encObj.ciphertext) && encObj.iv && encObj.salt) {
                    // SECURITY: This is an encrypted backup. Try the current vault
                    // password first, then fall back to prompting for the
                    // password/recovery key this file was encrypted with.
                    try {
                        decryptedData = await CryptoVault.decrypt(encObj, masterKeyPassword);
                        logDebug('[IMPORT] decrypted OK, len=' + (Array.isArray(decryptedData) ? decryptedData.length : '?'));
                    } catch (decErr) {
                        // Wrong password for THIS file (or it was encrypted under a
                        // different master password). Do NOT swallow — offer the
                        // alternate-password path so the user can recover.
                        logDebug('[IMPORT] decrypt with master password FAILED');
                    }

                    if (!decryptedData) {
                        decryptedData = await tryImportWithAlternatePassword(encObj);
                        if (!decryptedData) {
                            alert('Failed to decrypt vault file. Password mismatch.');
                            fileInput.value = '';
                            return;
                        }
                    }

                    if (Array.isArray(decryptedData)) {
                        await importDecryptedAccounts(decryptedData);
                    } else {
                        logDebug('[IMPORT] decrypted data not an array');
                        alert('Invalid vault file format or corrupted file.');
                    }
                    fileInput.value = '';
                    return;
                } else if (Array.isArray(parsed)) {
                    decryptedData = parsed;
                    logDebug('[IMPORT] plain array vault, len=' + parsed.length);
                } else if (Array.isArray(parsed.accounts)) {
                    decryptedData = parsed.accounts;
                } else if (Array.isArray(parsed.vault)) {
                    decryptedData = parsed.vault;
                } else if (Array.isArray(parsed.items)) {
                    decryptedData = parsed.items;
                } else if (Array.isArray(parsed.tokens)) {
                    decryptedData = parsed.tokens;
                } else if (Array.isArray(parsed.data)) {
                    decryptedData = parsed.data;
                } else if (parsed.db && Array.isArray(parsed.db.entries)) {
                    decryptedData = parsed.db.entries.map(e => ({
                        issuer: e.issuer || e.name || 'Service',
                        account: e.name || 'Account',
                        secret: e.info && e.info.secret ? e.info.secret : e.secret
                    }));
                }
            }

            if (decryptedData && Array.isArray(decryptedData)) {
                await importDecryptedAccounts(decryptedData);
            } else {
                logDebug('[IMPORT] decryptedData not usable');
                alert('Invalid vault file format or corrupted file.');
            }
        } catch (err) {
            logDebug('[IMPORT] import failed: ' + (err && err.message ? err.message : err));
            alert('Failed to decrypt vault file. Password mismatch.');
        }
        fileInput.value = '';
    };
    reader.readAsText(file);
}

/**
 * SECURITY: No recovery key is stored on-device by design. When a backup file
 * fails to decrypt with the current vault password, prompt the user for the
 * password or recovery key this backup was encrypted with and retry.
 * Returns the decrypted array, or null on failure/cancel.
 */
async function tryImportWithAlternatePassword(encObj) {
    const customPass = prompt('This backup file was created under a different password or recovery key. Please enter the password or recovery key for this backup file:');
    if (!customPass || !customPass.trim()) return null;
    try {
        const decryptedData = await CryptoVault.decrypt(encObj, customPass.trim());
        logDebug('[IMPORT] alternate password decrypt ' + (Array.isArray(decryptedData) ? 'OK, len=' + decryptedData.length : 'returned non-array'));
        return Array.isArray(decryptedData) ? decryptedData : null;
    } catch (customErr) {
        logDebug('[IMPORT] alternate password decrypt failed');
        return null;
    }
}

async function importDecryptedAccounts(decryptedData) {
    if (!Array.isArray(decryptedData)) return false;
    let count = 0;
    for (let acc of decryptedData) {
        const ok = await saveNewAccount(acc);
        if (ok) count++;
    }
    buildAccountsDOM();
    alert(`Successfully imported ${count} account(s) from file!`);
    logDebug('[IMPORT] DONE, imported ' + count + ' accounts');
    return true;
}

function toggleModal(id, show) {
    document.getElementById(id).style.display = show ? 'flex' : 'none';
}

function showError(element, msg) {
    element.textContent = msg;
    element.style.display = 'block';
}

function escapeHtml(str) {
    return str.replace(/[&<>'"]/g, 
        tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
}
