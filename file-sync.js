/**
 * Direct File System Sync Module for WebAuth Vault
 * Uses native browser File System Access API (showSaveFilePicker / showOpenFilePicker)
 * Persists FileSystemFileHandle in IndexedDB for seamless auto-save sync across sessions.
 */

window.FileSync = (function () {
    const DB_NAME = 'WebAuthFileHandleDB';
    const DB_VERSION = 1;
    const STORE_NAME = 'handles';
    const HANDLE_KEY = 'vault_file_handle';

    let savedFileHandle = null;

    function openDB() {
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

    async function saveHandleToDB(handle) {
        try {
            const db = await openDB();
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
            return tx.complete;
        } catch (e) {
            console.error('Failed to save file handle to IndexedDB:', e);
        }
    }

    async function loadHandleFromDB() {
        try {
            const db = await openDB();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const req = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        } catch (e) {
            console.error('Failed to load file handle from IndexedDB:', e);
            return null;
        }
    }

    async function init() {
        if (!savedFileHandle) {
            savedFileHandle = await loadHandleFromDB();
        }
        return !!savedFileHandle;
    }

    async function verifyPermission(handle, readWrite = true) {
        if (!handle) return false;
        const options = { mode: readWrite ? 'readwrite' : 'read' };
        if ((await handle.queryPermission(options)) === 'granted') {
            return true;
        }
        if ((await handle.requestPermission(options)) === 'granted') {
            return true;
        }
        return false;
    }

    async function selectSaveFile() {
        if (!('showSaveFilePicker' in window)) {
            alert('File System Access API is not supported in this browser. Please use Chrome, Edge, or Opera.');
            return false;
        }
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: 'webauth_vault.json',
                types: [{
                    description: 'WebAuth Encrypted Vault File',
                    accept: { 'application/json': ['.json'] }
                }]
            });
            savedFileHandle = handle;
            await saveHandleToDB(handle);
            return true;
        } catch (e) {
            if (e.name !== 'AbortError') {
                console.error('Error selecting save file:', e);
            }
            return false;
        }
    }

    async function selectOpenFile() {
        if (!('showOpenFilePicker' in window)) {
            alert('File System Access API is not supported in this browser.');
            return null;
        }
        try {
            const [handle] = await window.showOpenFilePicker({
                types: [{
                    description: 'WebAuth Encrypted Vault File',
                    accept: { 'application/json': ['.json'] }
                }]
            });
            savedFileHandle = handle;
            await saveHandleToDB(handle);
            const fileData = await readVaultFromFile(handle);
            return fileData;
        } catch (e) {
            if (e.name !== 'AbortError') {
                console.error('Error opening file:', e);
            }
            return null;
        }
    }

    async function writeVaultToFile(encryptedPayloadStr) {
        if (!savedFileHandle) return false;
        try {
            const hasAccess = await verifyPermission(savedFileHandle, true);
            if (!hasAccess) return false;

            const writable = await savedFileHandle.createWritable();
            await writable.write(encryptedPayloadStr);
            await writable.close();
            return true;
        } catch (e) {
            console.error('Failed to write vault to file:', e);
            return false;
        }
    }

    async function readVaultFromFile(handleToUse = savedFileHandle) {
        if (!handleToUse) return null;
        try {
            const hasAccess = await verifyPermission(handleToUse, false);
            if (!hasAccess) return null;

            const file = await handleToUse.getFile();
            const text = await file.text();
            return text;
        } catch (e) {
            console.error('Failed to read vault from file:', e);
            return null;
        }
    }

    function getFileName() {
        return savedFileHandle ? savedFileHandle.name : null;
    }

    async function disconnect() {
        savedFileHandle = null;
        try {
            const db = await openDB();
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(HANDLE_KEY);
        } catch (e) {}
    }

    return {
        init,
        selectSaveFile,
        selectOpenFile,
        writeVaultToFile,
        readVaultFromFile,
        getFileName,
        disconnect,
        hasFile: () => !!savedFileHandle
    };
})();
