/**
 * Client-Side AES-256-GCM Vault Encryption using WebCrypto API
 * Supports Key Recovery via a 16-character Recovery Key (mnemonic/seed phrase).
 */
class CryptoVault {
    // PBKDF2-SHA256 iteration count for NEW payloads (OWASP 2023 recommendation).
    // Each payload records its own iteration count so older vaults/backups
    // (encrypted with the legacy 100k) keep working and upgrade on next save.
    static get PBKDF2_ITERATIONS() { return 600000; }
    static get PBKDF2_LEGACY_ITERATIONS() { return 100000; }
    static get PBKDF2_MAX_ITERATIONS() { return 10000000; }
    static get PBKDF2_MIN_ITERATIONS() { return 1000; }

    static getCrypto() {
        const c = window.crypto || window.msCrypto;
        if (!c || !c.subtle) {
            throw new Error('WebCrypto API is not supported in this environment or requires an HTTPS / localhost connection.');
        }
        return c;
    }

    static resolveIterations(payload) {
        const iter = payload && payload.iterations;
        if (typeof iter === 'number' && iter >= CryptoVault.PBKDF2_MIN_ITERATIONS) {
            return Math.min(iter, CryptoVault.PBKDF2_MAX_ITERATIONS);
        }
        return CryptoVault.PBKDF2_LEGACY_ITERATIONS;
    }

    static async deriveKey(password, salt, iterations) {
        const cryptoObj = this.getCrypto();
        const enc = new TextEncoder();
        const keyMaterial = await cryptoObj.subtle.importKey(
            "raw",
            enc.encode(password),
            { name: "PBKDF2" },
            false,
            ["deriveKey"]
        );
        return cryptoObj.subtle.deriveKey(
            {
                name: "PBKDF2",
                salt: salt,
                iterations: iterations,
                hash: "SHA-256"
            },
            keyMaterial,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );
    }

    static async encrypt(dataObj, password) {
        const cryptoObj = this.getCrypto();
        const enc = new TextEncoder();
        const iterations = CryptoVault.PBKDF2_ITERATIONS;
        const salt = cryptoObj.getRandomValues(new Uint8Array(16));
        const iv = cryptoObj.getRandomValues(new Uint8Array(12));
        const key = await this.deriveKey(password, salt, iterations);

        const encrypted = await cryptoObj.subtle.encrypt(
            { name: "AES-GCM", iv: iv },
            key,
            enc.encode(JSON.stringify(dataObj))
        );

        return {
            iterations: iterations,
            salt: Array.from(salt),
            iv: Array.from(iv),
            cipher: Array.from(new Uint8Array(encrypted))
        };
    }

    static async decrypt(encryptedPayload, password) {
        const cryptoObj = this.getCrypto();
        const dec = new TextDecoder();
        const iterations = CryptoVault.resolveIterations(encryptedPayload);
        const salt = new Uint8Array(encryptedPayload.salt);
        const iv = new Uint8Array(encryptedPayload.iv);
        const rawCipher = encryptedPayload.cipher || encryptedPayload.ciphertext;
        const cipher = new Uint8Array(rawCipher);

        const key = await this.deriveKey(password, salt, iterations);

        const decrypted = await cryptoObj.subtle.decrypt(
            { name: "AES-GCM", iv: iv },
            key,
            cipher
        );

        return JSON.parse(dec.decode(decrypted));
    }
}
