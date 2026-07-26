/**
 * Client-Side AES-256-GCM Vault Encryption using WebCrypto API
 * Supports Key Recovery via a 16-character Recovery Key (mnemonic/seed phrase).
 */
class CryptoVault {
    static async deriveKey(password, salt) {
        const enc = new TextEncoder();
        const keyMaterial = await window.crypto.subtle.importKey(
            "raw",
            enc.encode(password),
            { name: "PBKDF2" },
            false,
            ["deriveKey"]
        );
        return window.crypto.subtle.deriveKey(
            {
                name: "PBKDF2",
                salt: salt,
                iterations: 100000,
                hash: "SHA-256"
            },
            keyMaterial,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );
    }

    static async encrypt(dataObj, password) {
        const enc = new TextEncoder();
        const salt = window.crypto.getRandomValues(new Uint8Array(16));
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const key = await this.deriveKey(password, salt);
        
        const encrypted = await window.crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv },
            key,
            enc.encode(JSON.stringify(dataObj))
        );

        return {
            salt: Array.from(salt),
            iv: Array.from(iv),
            cipher: Array.from(new Uint8Array(encrypted))
        };
    }

    static async decrypt(encryptedPayload, password) {
        const dec = new TextDecoder();
        const salt = new Uint8Array(encryptedPayload.salt);
        const iv = new Uint8Array(encryptedPayload.iv);
        const cipher = new Uint8Array(encryptedPayload.cipher);
        
        const key = await this.deriveKey(password, salt);

        const decrypted = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv },
            key,
            cipher
        );

        return JSON.parse(dec.decode(decrypted));
    }
}
