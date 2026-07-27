/**
 * Application Logic & TOTP Generator with IndexedDB & Auto File Backup
 */
let masterKeyPassword = null;
let vaultData = [];
let cameraStream = null;
let cameraAnimationId = null;
let timerInterval = null;
let activeDetailAccountId = null;

const VAULT_STORAGE_KEY = 'webauth_encrypted_vault';
const RECOVERY_KEY_STORAGE = 'webauth_recovery_key';
const BACKUP_AUTOSAVE_KEY = 'webauth_auto_backup_vault';
const SESSION_CACHE_KEY = 'webauth_session_pass';

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

function logDebug(msg) {
    console.log("[DEBUG]", msg);
}

document.addEventListener('DOMContentLoaded', () => {
    initAuthScreen();
    setupEventListeners();
});

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

        const cachedPass = sessionStorage.getItem(SESSION_CACHE_KEY);
        if (existingVault && cachedPass) {
            try {
                const encryptedPayload = JSON.parse(existingVault);
                vaultData = await CryptoVault.decrypt(encryptedPayload, cachedPass);
                masterKeyPassword = cachedPass;
                logDebug(`Auto-unlocked session from browser storage. Loaded ${vaultData.length} accounts.`);
                showDashboard();
                return;
            } catch (err) {
                sessionStorage.removeItem(SESSION_CACHE_KEY);
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
        } else {
            authTitle.textContent = 'Unlock Vault';
            authSubtitle.textContent = 'Enter your master password or Recovery Key to decrypt your 2FA keys.';
            confirmGroup.style.display = 'none';
            recoveryNotice.style.display = 'none';
            submitBtn.textContent = 'Unlock';
        }
    } catch (e) {
        console.error("Initialization error:", e);
    }
}

function generateRandomRecoveryKey() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let key = 'RECOVER-';
    for (let i = 0; i < 16; i++) {
        if (i > 0 && i % 4 === 0) key += '-';
        key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return key;
}

function setupEventListeners() {
    document.getElementById('authForm').addEventListener('submit', handleAuthSubmit);
    document.getElementById('lockBtn').addEventListener('click', lockVault);
    
    const copyRecBtn = document.getElementById('copyRecoveryKeyBtn');
    if (copyRecBtn) {
        copyRecBtn.addEventListener('click', () => {
            const keyVal = document.getElementById('generatedRecoveryKey').value;
            navigator.clipboard.writeText(keyVal);
            alert('Emergency Recovery Key copied to clipboard!');
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

    const joinP2pBtn = document.getElementById('joinP2pSyncBtn');
    if (joinP2pBtn) joinP2pBtn.addEventListener('click', handleJoinP2pSync);
    const leaveP2pBtn = document.getElementById('leaveP2pSyncBtn');
    if (leaveP2pBtn) leaveP2pBtn.addEventListener('click', handleLeaveP2pSync);

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

async function syncWithLinkedFile() {
    if (!window.FileSync || !FileSync.hasFile() || !masterKeyPassword) return;

    try {
        const fileContents = await FileSync.readVaultFromFile();
        if (fileContents && fileContents.trim()) {
            try {
                const parsedPayload = JSON.parse(fileContents);
                const decryptedData = await CryptoVault.decrypt(parsedPayload, masterKeyPassword);
                if (decryptedData && Array.isArray(decryptedData)) {
                    const existingSecrets = new Set(vaultData.map(a => a.secret));
                    let mergedCount = 0;
                    for (let remoteAcc of decryptedData) {
                        if (!existingSecrets.has(remoteAcc.secret)) {
                            vaultData.push(remoteAcc);
                            existingSecrets.add(remoteAcc.secret);
                            mergedCount++;
                        }
                    }
                    if (mergedCount > 0) {
                        buildAccountsDOM();
                        logDebug(`Linked file sync applied: merged ${mergedCount} new account(s).`);
                    }
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
    }
}

function updateP2pStatusUI() {
    const statusEl = document.getElementById('p2pSyncStatusText');
    if (!statusEl) return;

    if (!window.TrysteroSync || !TrysteroSync.isConnected()) {
        statusEl.textContent = 'Disconnected';
        statusEl.className = 'p2p-status-badge badge-disconnected';
        return;
    }

    const peerCount = TrysteroSync.getPeerCount();
    if (peerCount > 0) {
        statusEl.textContent = `Connected (${peerCount} device(s) online)`;
        statusEl.className = 'p2p-status-badge badge-connected';
    } else {
        statusEl.textContent = 'Waiting for peer...';
        statusEl.className = 'p2p-status-badge badge-connecting';
    }
}

function openP2pSyncModal() {
    toggleModal('p2pSyncModal', true);
    updateP2pStatusUI();
}

async function handleJoinP2pSync() {
    if (!window.TrysteroSync) {
        alert('P2P Sync module is unavailable.');
        return;
    }
    if (!masterKeyPassword) return;
    setupTrysteroListeners();
    const joined = await TrysteroSync.join(masterKeyPassword);
    updateP2pStatusUI();
    if (joined) {
        if (vaultData.length > 0 && masterKeyPassword) {
            const encryptedPayload = await CryptoVault.encrypt(vaultData, masterKeyPassword);
            TrysteroSync.broadcast(JSON.stringify(encryptedPayload));
        }
    }
}

function handleLeaveP2pSync() {
    if (!window.TrysteroSync) return;
    TrysteroSync.leave();
    updateP2pStatusUI();
}

let trysteroListenersWired = false;
function setupTrysteroListeners() {
    if (!window.TrysteroSync || trysteroListenersWired) return;
    trysteroListenersWired = true;

    TrysteroSync.onPeerChange(async (peerCount, peerId, action) => {
        updateP2pStatusUI();
        if (action === 'join' && masterKeyPassword && vaultData.length > 0) {
            try {
                const encryptedPayload = await CryptoVault.encrypt(vaultData, masterKeyPassword);
                TrysteroSync.broadcast(JSON.stringify(encryptedPayload));
                logDebug(`Symmetric P2P broadcast sent to newly joined peer (${peerId || 'peer'})`);
            } catch (err) {
                console.error('Error broadcasting on peer join:', err);
            }
        }
    });

    TrysteroSync.onReceive(async (payload) => {
        if (!masterKeyPassword) return;
        try {
            const encryptedPayload = typeof payload === 'string' ? JSON.parse(payload) : payload;
            const decryptedData = await CryptoVault.decrypt(encryptedPayload, masterKeyPassword);
            if (decryptedData && Array.isArray(decryptedData)) {
                const existingSecrets = new Set(vaultData.map(a => a.secret));
                let mergedCount = 0;
                for (let remoteAcc of decryptedData) {
                    if (!existingSecrets.has(remoteAcc.secret)) {
                        vaultData.push(remoteAcc);
                        existingSecrets.add(remoteAcc.secret);
                        mergedCount++;
                    }
                }
                if (mergedCount > 0) {
                    buildAccountsDOM();
                    const encryptedPayload = await CryptoVault.encrypt(vaultData, masterKeyPassword);
                    const serializedPayload = JSON.stringify(encryptedPayload);
                    localStorage.setItem(VAULT_STORAGE_KEY, serializedPayload);
                    await saveToIndexedDB(VAULT_STORAGE_KEY, serializedPayload);
                    logDebug(`Remote Trystero P2P sync applied: merged ${mergedCount} new account(s).`);
                }
            }
        } catch (err) {
            console.warn('Trystero P2P payload decrypt ignored (mismatched master password or invalid data)');
        }
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
        if (pass.length < 6) {
            showError(errorEl, 'Master password must be at least 6 characters.');
            return;
        }
        if (pass !== confirmPass) {
            showError(errorEl, 'Passwords do not match.');
            return;
        }
        masterKeyPassword = pass;
        vaultData = [];
        
        const recKey = document.getElementById('generatedRecoveryKey').value;
        localStorage.setItem(RECOVERY_KEY_STORAGE, recKey);
        await saveToIndexedDB(RECOVERY_KEY_STORAGE, recKey);

        try {
            await saveVault();
            sessionStorage.setItem(SESSION_CACHE_KEY, pass);
            showDashboard();
        } catch (vaultErr) {
            showError(errorEl, vaultErr.message || 'Failed to initialize vault.');
            return;
        }
    } else {
        let storedRecKey = localStorage.getItem(RECOVERY_KEY_STORAGE);
        if (!storedRecKey) {
            storedRecKey = await loadFromIndexedDB(RECOVERY_KEY_STORAGE);
        }
        
        try {
            const encryptedPayload = JSON.parse(existingVault);
            vaultData = await CryptoVault.decrypt(encryptedPayload, pass);
            masterKeyPassword = pass;
            sessionStorage.setItem(SESSION_CACHE_KEY, pass);
            logDebug(`Vault unlocked with password. Loaded ${vaultData.length} accounts.`);
            showDashboard();
            return;
        } catch (err) {}

        if (storedRecKey && pass === storedRecKey) {
            try {
                let backupPayloadStr = localStorage.getItem(BACKUP_AUTOSAVE_KEY);
                if (!backupPayloadStr) {
                    backupPayloadStr = await loadFromIndexedDB(BACKUP_AUTOSAVE_KEY);
                }
                if (backupPayloadStr) {
                    const encryptedPayload = JSON.parse(backupPayloadStr);
                    vaultData = await CryptoVault.decrypt(encryptedPayload, storedRecKey);
                    masterKeyPassword = storedRecKey;
                    sessionStorage.setItem(SESSION_CACHE_KEY, storedRecKey);
                    logDebug(`Vault unlocked via Emergency Recovery Key!`);
                    showDashboard();
                    return;
                }
            } catch (err) {}
        }

        showError(errorEl, 'Incorrect master password or recovery key.');
    }
}

async function saveVault() {
    if (!masterKeyPassword) return;
    
    const encryptedPayload = await CryptoVault.encrypt(vaultData, masterKeyPassword);
    const serializedPayload = JSON.stringify(encryptedPayload);
    
    // Save to primary localStorage AND persistent IndexedDB
    localStorage.setItem(VAULT_STORAGE_KEY, serializedPayload);
    await saveToIndexedDB(VAULT_STORAGE_KEY, serializedPayload);

    let storedRecKey = localStorage.getItem(RECOVERY_KEY_STORAGE);
    if (!storedRecKey) storedRecKey = await loadFromIndexedDB(RECOVERY_KEY_STORAGE);

    if (storedRecKey) {
        const backupEncryptedPayload = await CryptoVault.encrypt(vaultData, storedRecKey);
        const serializedBackup = JSON.stringify(backupEncryptedPayload);
        localStorage.setItem(BACKUP_AUTOSAVE_KEY, serializedBackup);
        await saveToIndexedDB(BACKUP_AUTOSAVE_KEY, serializedBackup);
    }

    logDebug(`Saved vault & auto backups to localStorage & IndexedDB. Total accounts: ${vaultData.length}`);

    if (window.FileSync && FileSync.hasFile()) {
        await syncWithLinkedFile();
    }

    if (window.TrysteroSync && TrysteroSync.isConnected()) {
        TrysteroSync.broadcast(serializedPayload);
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

    if (window.TrysteroSync && TrysteroSync.isActive() && masterKeyPassword) {
        setupTrysteroListeners();
        await TrysteroSync.join(masterKeyPassword);
    }
}

function lockVault() {
    masterKeyPassword = null;
    vaultData = [];
    sessionStorage.removeItem(SESSION_CACHE_KEY);
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

    vaultData.forEach(acc => {
        const card = document.createElement('div');
        card.className = 'account-card';
        card.setAttribute('data-id', acc.id);
        card.setAttribute('data-issuer', (acc.issuer || '').toLowerCase());
        card.setAttribute('data-account', (acc.account || '').toLowerCase());
        
        card.addEventListener('click', (e) => {
            if (e.target.closest('.btn-danger') || e.target.closest('.code-display')) {
                return;
            }
            openAccountDetailModal(acc.id);
        });

        card.innerHTML = `
            <div class="account-header-row">
                <div class="account-info">
                    <h4>${escapeHtml(acc.issuer)}</h4>
                    <p>${escapeHtml(acc.account)}</p>
                </div>
                <button class="btn btn-danger btn-sm" onclick="deleteAccountDirect(event, '${acc.id}')">Delete</button>
            </div>
            <div class="code-display" onclick="copyAccountCode(event, '${acc.id}')">
                <span class="code-number" id="code-${acc.id}">------</span>
                <span class="timer-circle" id="timer-${acc.id}">--s</span>
            </div>
        `;
        grid.appendChild(card);
    });

    updateTotpCodes();
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

    document.getElementById('detailType').textContent = acc.type || 'TOTP';
    document.getElementById('detailAlgorithm').textContent = acc.algorithm || 'SHA1';
    document.getElementById('detailDigits').textContent = acc.digits || '6';
    document.getElementById('detailPeriod').textContent = `${acc.period || 30}s`;

    const container = document.getElementById('detailQrCanvas');
    const cleanIssuer = encodeURIComponent(acc.issuer.trim());
    const cleanAccount = encodeURIComponent(acc.account.trim());
    const otpUri = `otpauth://totp/${cleanIssuer}:${cleanAccount}?secret=${acc.secret.replace(/\s+/g, '')}&issuer=${cleanIssuer}&period=${acc.period || 30}&digits=${acc.digits || 6}`;
    
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
    if (activeDetailAccountId && confirm('Are you sure you want to delete this account?')) {
        vaultData = vaultData.filter(a => a.id !== activeDetailAccountId);
        await saveVault();
        toggleModal('detailModal', false);
        buildAccountsDOM();
    }
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

function updateTotpCodes() {
    const epoch = Math.floor(Date.now() / 1000);
    vaultData.forEach(acc => {
        const codeEl = document.getElementById(`code-${acc.id}`);
        const timerEl = document.getElementById(`timer-${acc.id}`);
        if (!codeEl || !timerEl) return;

            try {
                const cleanSecret = acc.secret.replace(/\s+/g, '');
                if (!cleanSecret || cleanSecret.length < 16 || cleanSecret.length > 64) {
                    throw new Error('Invalid secret length');
                }
                
                const totp = new OTPAuth.TOTP({
                    issuer: acc.issuer || 'Service',
                    label: acc.account || 'Account',
                    algorithm: acc.algorithm || "SHA1",
                    digits: acc.digits || 6,
                    period: acc.period || 30,
                    secret: OTPAuth.Secret.fromBase32(cleanSecret)
                });
                const tokenCode = totp.generate();
                const period = acc.period || 30;
                const remaining = period - (epoch % period);
                
                codeEl.textContent = `${tokenCode.slice(0, 3)} ${tokenCode.slice(3)}`;
                timerEl.textContent = `${remaining}s`;
                codeEl.setAttribute('data-fullcode', tokenCode);
            } catch (e) {
                codeEl.textContent = 'INVALID';
                timerEl.textContent = '--s';
                console.debug(`TOTP error for ${acc.issuer || 'Unknown'} (${acc.account || 'Unknown'}):`, e.message);
            }
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

    if (inputSecret.startsWith('otpauth://')) {
        try {
            const parsed = OTPAuth.URI.parse(inputSecret);
            issuer = parsed.issuer || issuer || 'Unknown';
            account = parsed.label || account || 'Account';
            secret = parsed.secret.base32;
            period = parsed.period || period;
            digits = parsed.digits || digits;
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

    await saveNewAccount({ issuer, account, secret, period, digits });
    toggleModal('addModal', false);
    document.getElementById('addAccountForm').reset();
    buildAccountsDOM();
}

async function saveNewAccount(acc) {
    const cleanSecret = acc.secret.toUpperCase().replace(/\s+/g, '');
    const cleanIssuer = (acc.issuer || 'Service').trim();
    const cleanAccount = (acc.account || 'Account').trim();

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
            type: acc.type || 'TOTP'
        };
    } else {
        logDebug(`Adding new account: "${cleanIssuer} (${cleanAccount})"`);
        const newAccount = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 4),
            issuer: cleanIssuer,
            account: cleanAccount,
            secret: cleanSecret,
            period: acc.period || 30,
            digits: acc.digits || 6,
            algorithm: acc.algorithm || 'SHA1',
            type: acc.type || 'TOTP'
        };
        vaultData.push(newAccount);
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

    if (video.readyState === video.HAVE_ENOUGH_DATA) {
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
    logDebug(`Parsing QR payload prefix: ${payload.substring(0, 30)}...`);

    let cleanPayload = payload.trim();
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

function copyAccountCode(event, id) {
    event.stopPropagation();
    const codeEl = document.getElementById(`code-${id}`);
    if (codeEl) {
        const fullCode = codeEl.getAttribute('data-fullcode') || codeEl.textContent.replace(/\s+/g, '');
        navigator.clipboard.writeText(fullCode);
        alert('Code copied to clipboard!');
    }
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

async function handleImportVaultFile() {
    if (!masterKeyPassword) {
        alert('Please unlock your vault first.');
        return;
    }
    const fileInput = document.getElementById('importJsonFileInput');
    if (!fileInput.files || !fileInput.files.length) return;

    const file = fileInput.files[0];
    const reader = new FileReader();
    reader.onload = async function (e) {
        try {
            let rawText = e.target.result.trim();
            let parsed = null;

            try {
                parsed = JSON.parse(rawText);
            } catch (err) {
                // Not JSON, check if it's an otpauth / otpauth-migration string file
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
                        break;
                    }
                }
            }

            let decryptedData = null;

            if (parsed && typeof parsed === 'object') {
                const encObj = parsed.cipher || parsed.ciphertext ? parsed : (parsed.vault ? (typeof parsed.vault === 'string' ? JSON.parse(parsed.vault) : parsed.vault) : null);
                if (encObj && (encObj.cipher || encObj.ciphertext) && encObj.iv && encObj.salt) {
                    decryptedData = await CryptoVault.decrypt(encObj, masterKeyPassword);
                } else if (Array.isArray(parsed)) {
                    decryptedData = parsed;
                }
            }

            if (decryptedData && Array.isArray(decryptedData)) {
                let count = 0;
                for (let acc of decryptedData) {
                    await saveNewAccount(acc);
                    count++;
                }
                buildAccountsDOM();
                alert(`Successfully imported ${count} account(s) from file!`);
            } else {
                alert('Invalid vault file format or corrupted file.');
            }
        } catch (err) {
            console.error('Import error with master password, trying recovery key:', err);
            
            // Try decrypting with stored Recovery Key if available
            let storedRecKey = localStorage.getItem(RECOVERY_KEY_STORAGE);
            if (!storedRecKey) storedRecKey = await loadFromIndexedDB(RECOVERY_KEY_STORAGE);

            if (storedRecKey) {
                try {
                    let rawText = e.target.result.trim();
                    let parsed = JSON.parse(rawText);
                    while (typeof parsed === 'string') parsed = JSON.parse(parsed);
                    const encObj = parsed.cipher || parsed.ciphertext ? parsed : (parsed.vault ? (typeof parsed.vault === 'string' ? JSON.parse(parsed.vault) : parsed.vault) : null);
                    if (encObj && (encObj.cipher || encObj.ciphertext) && encObj.iv && encObj.salt) {
                        const decryptedData = await CryptoVault.decrypt(encObj, storedRecKey);
                        if (decryptedData && Array.isArray(decryptedData)) {
                            let count = 0;
                            for (let acc of decryptedData) {
                                await saveNewAccount(acc);
                                count++;
                            }
                            buildAccountsDOM();
                            alert(`Successfully imported ${count} account(s) using Emergency Recovery Key!`);
                            fileInput.value = '';
                            return;
                        }
                    }
                } catch (recErr) {
                    console.error('Recovery key import failed:', recErr);
                }
            }

            // If master password and stored recovery key fail, prompt user to enter the password/recovery key used when creating the backup
            const customPass = prompt('This backup file was created under a different password or recovery key. Please enter the password or recovery key for this backup file:');
            if (customPass && customPass.trim().length > 0) {
                try {
                    let rawText = e.target.result.trim();
                    let parsed = JSON.parse(rawText);
                    while (typeof parsed === 'string') parsed = JSON.parse(parsed);
                    const encObj = parsed.cipher || parsed.ciphertext ? parsed : (parsed.vault ? (typeof parsed.vault === 'string' ? JSON.parse(parsed.vault) : parsed.vault) : null);
                    if (encObj && (encObj.cipher || encObj.ciphertext) && encObj.iv && encObj.salt) {
                        const decryptedData = await CryptoVault.decrypt(encObj, customPass.trim());
                        if (decryptedData && Array.isArray(decryptedData)) {
                            let count = 0;
                            for (let acc of decryptedData) {
                                await saveNewAccount(acc);
                                count++;
                            }
                            buildAccountsDOM();
                            alert(`Successfully imported ${count} account(s) from backup file!`);
                            fileInput.value = '';
                            return;
                        }
                    }
                } catch (customErr) {
                    console.error('Custom password import failed:', customErr);
                }
            }

            alert('Failed to decrypt vault file. Password mismatch.');
        }
        fileInput.value = '';
    };
    reader.readAsText(file);
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
