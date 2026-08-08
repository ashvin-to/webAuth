/**
 * SecretStore — encrypts app secrets at rest using Web Crypto AES-GCM.
 *
 * Protects convenience values that previously lived in plaintext:
 *   - webauth_session_pass        (master password, sessionStorage)
 *   - webauth_trystero_custom_pass (P2P sync credential, localStorage)
 *
 * Both must be readable by the app WITHOUT the user retyping them, so they
 * cannot be hashed. Instead they are AES-GCM encrypted with a per-origin
 * random key stored as a NON-EXTRACTABLE CryptoKey in IndexedDB:
 *   - storage dumps / devtools / profile theft see only ciphertext
 *   - the key cannot be exported or moved to another browser
 *   - it is never persisted in localStorage/sessionStorage
 *
 * SECURITY NOTES:
 *   - Requires HTTPS or localhost (Web Crypto API).
 *   - The CryptoJS AES-CBC fallback has been removed because AES-CBC does not
 *     provide authenticated encryption. If crypto.subtle is unavailable, the
 *     webcrypto-fallback.js guard will have already blocked the page.
 *   - This module cannot protect against malicious JavaScript executing in the
 *     same origin. It protects against offline storage theft only.
 *
 * Legacy plaintext values (written before this module existed) are detected
 * by the missing "v1:" prefix and returned as-is for one transition, after
 * which they are re-sealed on the next save.
 */
const SecretStore = (() => {
    'use strict';

    const DB_NAME = 'webauth_secret_store';
    const DB_VERSION = 1;
    const STORE = 'keys';
    const KEY_ID = 'aes-key';
    const PREFIX = 'v1:';

    let dbPromise = null;
    let keyPromise = null;

    function openDB() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return dbPromise;
    }

    function getFromDB() {
        return openDB().then((db) => new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const getReq = tx.objectStore(STORE).get(KEY_ID);
            getReq.onsuccess = () => resolve(getReq.result || null);
            getReq.onerror = () => reject(getReq.error);
        }));
    }

    function putInDB(value) {
        return openDB().then((db) => new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(value, KEY_ID);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        }));
    }

    /**
     * Generate or retrieve the per-origin AES-GCM encryption key.
     * SECURITY: Key is non-extractable — it cannot be read back from IndexedDB.
     */
    async function ensureKey() {
        if (keyPromise) return keyPromise;
        keyPromise = (async () => {
            const existing = await getFromDB();
            // SECURITY: Only accept 'native' type keys. Legacy 'cryptojs' keys
            // from the removed fallback are ignored — a new key will be generated,
            // and old sealed values will fail to open (acceptable: they were
            // encrypted with unauthenticated AES-CBC and should not be trusted).
            if (existing && existing.type === 'native') return existing;

            const key = await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 },
                false, // non-extractable
                ['encrypt', 'decrypt']
            );
            const record = { type: 'native', key };
            await putInDB(record);
            return record;
        })();
        return keyPromise;
    }

    function bytesToBase64(bytes) {
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }

    function base64ToBytes(b64) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    async function seal(plaintext) {
        if (!plaintext) return '';
        const keyRec = await ensureKey();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const data = new TextEncoder().encode(plaintext);
        const cipher = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            keyRec.key,
            data
        );
        const combined = new Uint8Array(iv.length + cipher.byteLength);
        combined.set(iv, 0);
        combined.set(new Uint8Array(cipher), iv.length);
        return PREFIX + bytesToBase64(combined);
    }

    async function open(encoded) {
        if (!encoded) return null;
        if (typeof encoded !== 'string' || !encoded.startsWith(PREFIX)) {
            return encoded; // legacy plaintext value — one-time migration path
        }

        const keyRec = await ensureKey();
        const combined = base64ToBytes(encoded.slice(PREFIX.length));

        try {
            const iv = combined.slice(0, 12);
            const cipher = combined.slice(12);
            const data = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv },
                keyRec.key,
                cipher
            );
            return new TextDecoder().decode(data);
        } catch (e) {
            // SECURITY: Do not log the encoded value or decryption error details.
            // Failure is expected for values encrypted with the removed CryptoJS
            // fallback or with a different origin's key.
            return null;
        }
    }

    return { seal, open };
})();

// SECURITY: Expose SecretStore on window only because existing app modules
// (app.js, p2p-sync-trystero.js) reference it as window.SecretStore.
// This does NOT protect against same-origin JavaScript — IndexedDB
// non-extractable keys protect against offline storage theft only.
if (typeof window !== 'undefined') {
    window.SecretStore = SecretStore;
}
