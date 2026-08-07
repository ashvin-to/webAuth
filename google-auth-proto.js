/**
 * Google Authenticator Migration Protobuf Decoder & Base32 Utility
 * Fixes missing GitHub accounts by handling field string parsing and case matching.
 */

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32EncodeBuffer(uint8Array) {
    let bits = 0;
    let value = 0;
    let output = "";

    for (let i = 0; i < uint8Array.length; i++) {
        value = (value << 8) | uint8Array[i];
        bits += 8;

        while (bits >= 5) {
            output += BASE32_CHARS[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }

    if (bits > 0) {
        output += BASE32_CHARS[(value << (5 - bits)) & 31];
    }

    return output;
}

function base32DecodeString(str) {
    const clean = String(str || '').toUpperCase().replace(/\s+/g, '').replace(/=+$/, '');
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
        const idx = BASE32_CHARS.indexOf(ch);
        if (idx === -1) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return new Uint8Array(out);
}

function encodeVarint(val) {
    const out = [];
    let v = Number(val) >>> 0;
    while (v >= 0x80) {
        out.push((v & 0x7f) | 0x80);
        v >>>= 7;
    }
    out.push(v);
    return out;
}

function protobufBytesField(fieldNum, bytes) {
    return [...encodeVarint((fieldNum << 3) | 2), ...encodeVarint(bytes.length), ...bytes];
}

function protobufStringField(fieldNum, str) {
    return protobufBytesField(fieldNum, Array.from(new TextEncoder().encode(String(str))));
}

function protobufVarintField(fieldNum, val) {
    return [...encodeVarint(fieldNum << 3), ...encodeVarint(val)];
}

/**
 * Builds a Google Authenticator otpauth-migration:// URI from vault accounts.
 * `secret` field holds the RAW secret bytes; name/label = field 2, issuer = field 3,
 * algorithm enum (1=SHA1,2=SHA256,3=SHA512), digits enum (1=6,2=8), type enum (1=HOTP,2=TOTP).
 */
function buildGoogleAuthMigrationUri(accounts) {
    const payload = [];
    for (const acc of accounts || []) {
        const inner = [
            ...protobufBytesField(1, base32DecodeString(acc.secret || '')),
            ...protobufStringField(2, acc.account || 'Account'),
            ...protobufStringField(3, acc.issuer || 'Service')
        ];
        const alg = String(acc.algorithm || 'SHA1').toUpperCase();
        inner.push(...protobufVarintField(4, alg === 'SHA256' ? 2 : alg === 'SHA512' ? 3 : 1));
        inner.push(...protobufVarintField(5, (acc.digits || 6) === 8 ? 2 : 1));
        inner.push(...protobufVarintField(6, String(acc.type || 'TOTP').toUpperCase() === 'HOTP' ? 1 : 2));
        if (acc.counter != null) inner.push(...protobufVarintField(7, acc.counter));
        payload.push(...protobufBytesField(1, inner));
    }
    payload.push(...protobufVarintField(2, 1)); // version
    payload.push(...protobufVarintField(3, 1)); // batch_size

    const bytes = new Uint8Array(payload);
    let binary = '';
    bytes.forEach(b => { binary += String.fromCharCode(b); });
    const b64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return 'otpauth-migration://offline?data=' + b64;
}

/**
 * Protobuf parser for Google Authenticator Migration payloads.
 */
function parseGoogleAuthMigrationUri(uriString) {
    try {
        logDebug("Parsing migration payload string...");
        let dataB64 = '';
        if (uriString.startsWith('otpauth-migration://')) {
            const url = new URL(uriString);
            dataB64 = url.searchParams.get('data');
        } else {
            dataB64 = uriString;
        }

        if (!dataB64) {
            logDebug("No data payload parameter found.");
            return null;
        }

        // Base64 decode URL safe
        dataB64 = dataB64.replace(/-/g, '+').replace(/_/g, '/');
        while (dataB64.length % 4) dataB64 += '=';

        const binaryStr = atob(dataB64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
        }

        let pos = 0;
        const len = bytes.length;

        function readVarint() {
            let res = 0;
            let shift = 0;
            while (pos < len) {
                const b = bytes[pos++];
                res |= (b & 0x7f) << shift;
                if ((b & 0x80) === 0) break;
                shift += 7;
            }
            return res;
        }

        const accounts = [];

        while (pos < len) {
            const tag = readVarint();
            const fieldNum = tag >> 3;
            const wireType = tag & 0x07;

            if (fieldNum === 1 && wireType === 2) {
                const messageLength = readVarint();
                const endPos = pos + messageLength;

                let secret = "";
                let name = "";
                let issuer = "";
                let digits = 6;
                let algorithm = "SHA1";
                let type = "TOTP";
                let counter = 0;

                while (pos < endPos) {
                    const subTag = readVarint();
                    const subField = subTag >> 3;
                    const subWire = subTag & 0x07;

                    if (subField === 1 && subWire === 2) { // Secret
                        const l = readVarint();
                        const secBytes = bytes.subarray(pos, pos + l);
                        pos += l;
                        secret = base32EncodeBuffer(secBytes);
                    } else if (subField === 2 && subWire === 2) { // Name / Label
                        const l = readVarint();
                        const strBytes = bytes.subarray(pos, pos + l);
                        pos += l;
                        name = new TextDecoder().decode(strBytes);
                    } else if (subField === 3 && subWire === 2) { // Issuer
                        const l = readVarint();
                        const strBytes = bytes.subarray(pos, pos + l);
                        pos += l;
                        issuer = new TextDecoder().decode(strBytes);
                    } else if (subField === 4 && subWire === 0) { // Algorithm
                        const algVal = readVarint();
                        if (algVal === 2) algorithm = "SHA256";
                        else if (algVal === 3) algorithm = "SHA512";
                    } else if (subField === 5 && subWire === 0) { // Digits
                        const digVal = readVarint();
                        if (digVal === 2) digits = 8;
                    } else if (subField === 6 && subWire === 0) { // Type
                        const typeVal = readVarint();
                        if (typeVal === 1) type = "HOTP";
                    } else if (subField === 7 && subWire === 0) { // Counter (HOTP)
                        counter = readVarint();
                    } else {
                        if (subWire === 0) readVarint();
                        else if (subWire === 2) {
                            const l = readVarint();
                            pos += l;
                        } else if (subWire === 1) pos += 8;
                        else if (subWire === 5) pos += 4;
                    }
                }

                // Standardize GitHub label formats (e.g., GitHub:username, GitHub (user), GitHub)
                if (!issuer && name.includes(':')) {
                    const parts = name.split(':');
                    issuer = parts[0].trim();
                    name = parts.slice(1).join(':').trim();
                }

                if (!issuer && name.toLowerCase().includes('github')) {
                    issuer = 'GitHub';
                }

                logDebug(`Extracted Account -> Issuer: "${issuer || 'Service'}", Name: "${name || 'Account'}", Secret length: ${secret.length}`);

                if (secret) {
                    accounts.push({
                        issuer: issuer || 'Service',
                        account: name || 'Account',
                        secret: secret,
                        period: 30,
                        digits: digits,
                        algorithm: algorithm,
                        type: type,
                        counter: type === 'HOTP' ? counter : 0
                    });
                }
            } else {
                if (wireType === 0) readVarint();
                else if (wireType === 2) {
                    const l = readVarint();
                    pos += l;
                } else if (wireType === 1) pos += 8;
                else if (wireType === 5) pos += 4;
            }
        }

        logDebug(`Total Parsed Accounts from Payload: ${accounts.length}`);
        return accounts.length > 0 ? accounts : null;
    } catch (e) {
        logDebug(`Error decoding migration payload: ${e.message}`);
        console.error("Failed to decode Google Authenticator Migration payload:", e);
        return null;
    }
}
