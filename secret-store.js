/**
 * SecretStore — encrypts app secrets at rest.
 *
 * Protects two convenience values that previously lived in plaintext:
 *   - webauth_session_pass        (master password, sessionStorage)
 *   - webauth_trystero_custom_pass (P2P sync passphrase, localStorage)
 *
 * Both must be readable by the app WITHOUT the user retyping them, so they
 * cannot be hashed. Instead they are AES-GCM encrypted with a per-origin
 * random key that is stored as a NON-EXTRACTABLE CryptoKey in IndexedDB:
 *   - storage dumps / devtools / profile theft see only ciphertext
 *   - the key cannot be exported or moved to another browser
 *   - it is never persisted in localStorage/sessionStorage
 *
 * Legacy plaintext values (written before this module existed) are detected
 * by the missing "v1:" prefix and returned as-is for one transition, after
 * which they are re-sealed on the next save.
 *
 * Over HTTP / IP addresses (where WebCrypto subtle is unavailable and the
 * CryptoJS fallback in webcrypto-fallback.js is active) a random 256-bit key
 * is used with CryptoJS AES instead. This environment is already a degraded
 * non-HTTPS context, so the key bytes are stored raw in IndexedDB there.
 */
const SecretStore = (() => {
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

    function usesNativeSubtle() {
        return !!(window.crypto && window.crypto.subtle &&
                  typeof window.crypto.subtle.generateKey === 'function');
    }

    async function ensureKey() {
        if (keyPromise) return keyPromise;
        keyPromise = (async () => {
            const existing = await getFromDB();
            if (existing) return existing;

            let record;
            if (usesNativeSubtle()) {
                const key = await crypto.subtle.generateKey(
                    { name: 'AES-GCM', length: 256 },
                    false, // non-extractable
                    ['encrypt', 'decrypt']
                );
                record = { type: 'native', key };
            } else {
                const raw = CryptoJS.lib.WordArray.random(32);
                record = { type: 'cryptojs', raw: raw.toString(CryptoJS.enc.Base64) };
            }
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

    function wordArrayToBytes(wa) {
        const l = wa.sigBytes;
        const words = wa.words;
        const out = new Uint8Array(l);
        for (let i = 0; i < l; i++) {
            out[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
        }
        return out;
    }

    async function seal(plaintext) {
        if (!plaintext) return '';
        const keyRec = await ensureKey();

        if (keyRec.type === 'native') {
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

        const iv = CryptoJS.lib.WordArray.random(16);
        const key = CryptoJS.enc.Base64.parse(keyRec.raw);
        const encrypted = CryptoJS.AES.encrypt(plaintext, key, { iv });
        const ivBytes = wordArrayToBytes(iv);
        const cipherBytes = base64ToBytes(encrypted.ciphertext.toString(CryptoJS.enc.Base64));
        const combined = new Uint8Array(ivBytes.length + cipherBytes.length);
        combined.set(ivBytes, 0);
        combined.set(cipherBytes, ivBytes.length);
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
            if (keyRec.type === 'native') {
                const iv = combined.slice(0, 12);
                const cipher = combined.slice(12);
                const data = await crypto.subtle.decrypt(
                    { name: 'AES-GCM', iv },
                    keyRec.key,
                    cipher
                );
                return new TextDecoder().decode(data);
            }

            const ivBytes = combined.slice(0, 16);
            const cipherBytes = combined.slice(16);
            const iv = CryptoJS.lib.WordArray.create(
                Array.from(ivBytes).map((b, i) => {
                    const w = (b << 24) | (ivBytes[i + 1] << 16) | (ivBytes[i + 2] << 8) | ivBytes[i + 3];
                    return w >>> 0;
                }).filter((_, i) => i % 4 === 0)
            );
            const cipherWordArray = CryptoJS.lib.WordArray.create(
                Array.from(cipherBytes).reduce((acc, b, i) => {
                    const j = i % 4;
                    if (j === 0) acc.push(b << 24);
                    acc[acc.length - 1] = (acc[acc.length - 1] | (b << (24 - j * 8))) >>> 0;
                    return acc;
                }, []),
                cipherBytes.length
            );
            const decrypted = CryptoJS.AES.decrypt(
                { ciphertext: cipherWordArray },
                CryptoJS.enc.Base64.parse(keyRec.raw),
                { iv }
            );
            return decrypted.toString(CryptoJS.enc.Utf8);
        } catch (e) {
            console.warn('[SecretStore] open failed:', e);
            return null;
        }
    }

    return { seal, open };
})();

if (typeof window !== 'undefined') {
    window.SecretStore = SecretStore;
}
