/**
 * Client-Side AES-256-GCM Vault Encryption using WebCrypto API
 */
class CryptoVault {
    // PBKDF2-SHA256 iteration count for NEW payloads (OWASP 2023 recommendation).
    // Each payload records its own iteration count so older vaults/backups
    // (encrypted with the legacy 100k) keep working and upgrade on next save.
    static get PBKDF2_ITERATIONS() { return 600000; }
    static get PBKDF2_LEGACY_ITERATIONS() { return 100000; }
    static get PBKDF2_MAX_ITERATIONS() { return 10000000; }
    static get PBKDF2_MIN_ITERATIONS() { return 1000; }
    static get P2P_PROTOCOL() { return 'webauth-p2p'; }
    static get P2P_VERSION() { return 2; }
    static get P2P_SUPPORTED_VERSIONS() { return new Set([2]); }
    static get P2P_MESSAGE_TYPES() { return new Set(['snapshot', 'request', 'delta']); }
    static get MAX_P2P_PAYLOAD_BYTES() { return 512 * 1024; }

    static isArrayLikeNumberList(value) {
        return Array.isArray(value) || ArrayBuffer.isView(value);
    }

    static toUint8Array(value) {
        if (value == null) return null;
        if (value instanceof Uint8Array) return value;
        if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        if (Array.isArray(value)) return new Uint8Array(value.map(n => Number(n)));
        return null;
    }

    static normalizeP2pEnvelope(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new Error('invalid-payload');
        }

        const protocol = payload.protocol;
        const version = payload.version;
        const messageType = payload.messageType;
        const keyId = payload.keyId;
        const salt = payload.salt;
        const iv = payload.iv;
        const ciphertext = payload.ciphertext !== undefined ? payload.ciphertext : payload.cipher;

        if (typeof protocol !== 'string' || protocol !== CryptoVault.P2P_PROTOCOL) {
            throw new Error('unsupported-protocol');
        }
        if (!CryptoVault.P2P_SUPPORTED_VERSIONS.has(Number(version))) {
            throw new Error('unsupported-protocol');
        }
        if (typeof messageType !== 'string' || !CryptoVault.P2P_MESSAGE_TYPES.has(messageType)) {
            throw new Error('invalid-payload');
        }
        if (typeof keyId !== 'string' || !keyId.trim()) {
            throw new Error('invalid-payload');
        }

        const saltBytes = CryptoVault.toUint8Array(salt);
        const ivBytes = CryptoVault.toUint8Array(iv);
        const cipherBytes = CryptoVault.toUint8Array(ciphertext);

        if (!saltBytes || saltBytes.length < 16 || !ivBytes || ivBytes.length !== 12 || !cipherBytes || cipherBytes.length === 0) {
            throw new Error('invalid-payload');
        }
        if (cipherBytes.length > CryptoVault.MAX_P2P_PAYLOAD_BYTES) {
            throw new Error('invalid-payload');
        }

        return {
            ...payload,
            salt: Array.from(saltBytes),
            iv: Array.from(ivBytes),
            ciphertext: Array.from(cipherBytes),
            keyId: keyId.trim(),
            messageType
        };
    }

    static async encryptP2p(dataObj, password, messageType = 'snapshot', keyId = 'default') {
        const cryptoObj = this.getCrypto();
        const enc = new TextEncoder();
        const iterations = CryptoVault.PBKDF2_ITERATIONS;
        const salt = cryptoObj.getRandomValues(new Uint8Array(16));
        const iv = cryptoObj.getRandomValues(new Uint8Array(12));
        const key = await this.deriveKey(password, salt, iterations);
        const encrypted = await cryptoObj.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            enc.encode(JSON.stringify(dataObj))
        );

        return {
            protocol: CryptoVault.P2P_PROTOCOL,
            version: CryptoVault.P2P_VERSION,
            messageType,
            keyId: String(keyId || 'default'),
            iterations,
            salt: Array.from(salt),
            iv: Array.from(iv),
            ciphertext: Array.from(new Uint8Array(encrypted))
        };
    }

    static async decryptP2p(encryptedPayload, password) {
        let payload = encryptedPayload;
        if (typeof encryptedPayload === 'string') {
            try {
                payload = JSON.parse(encryptedPayload);
            } catch (e) {
                throw new Error('invalid-payload');
            }
        }

        try {
            payload = CryptoVault.normalizeP2pEnvelope(payload);
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            if (msg === 'unsupported-protocol') throw new Error('unsupported-protocol');
            throw new Error('invalid-payload');
        }

        try {
            const cryptoObj = this.getCrypto();
            const dec = new TextDecoder();
            const iterations = CryptoVault.resolveIterations(payload);
            const salt = new Uint8Array(payload.salt);
            const iv = new Uint8Array(payload.iv);
            const rawCipher = payload.ciphertext || payload.cipher;
            const cipher = new Uint8Array(rawCipher);
            const key = await this.deriveKey(password, salt, iterations);

            const decrypted = await cryptoObj.subtle.decrypt(
                { name: 'AES-GCM', iv },
                key,
                cipher
            );

            return JSON.parse(dec.decode(decrypted));
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            if (/invalid-payload|unsupported-protocol/.test(msg)) {
                throw e;
            }
            if (/The operation failed|Authentication|decrypt|OperationError/.test(msg)) {
                throw new Error('wrong-key-or-password');
            }
            throw new Error('authentication-failed');
        }
    }

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
        if (encryptedPayload && encryptedPayload.protocol === CryptoVault.P2P_PROTOCOL) {
            return this.decryptP2p(encryptedPayload, password);
        }

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
