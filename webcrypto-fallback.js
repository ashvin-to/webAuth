/**
 * WebCrypto Availability Guard — Fail-Closed
 *
 * SECURITY: This module previously contained an AES-CBC fallback using CryptoJS
 * that silently downgraded encryption from authenticated AES-GCM to
 * unauthenticated AES-CBC when Web Crypto was unavailable (e.g. plain HTTP).
 *
 * AES-CBC does NOT provide authenticated encryption and is unacceptable for a
 * vault application. The fallback has been removed entirely.
 *
 * The application now REQUIRES:
 *   - A secure context (HTTPS or localhost)
 *   - Native Web Crypto API (crypto.subtle)
 *
 * If these requirements are not met, the application will display a clear error
 * and refuse to operate, rather than silently weakening cryptographic security.
 */
(function () {
    'use strict';

    const isSecure = window.isSecureContext ||
                     location.protocol === 'https:' ||
                     location.hostname === 'localhost' ||
                     location.hostname === '127.0.0.1' ||
                     location.hostname === '::1';

    const hasSubtle = !!(window.crypto && window.crypto.subtle &&
                         typeof window.crypto.subtle.importKey === 'function' &&
                         typeof window.crypto.subtle.encrypt === 'function');

    if (!hasSubtle) {
        const msg = isSecure
            ? 'WebAuth Vault requires a browser with Web Crypto API support. Please use a modern browser (Chrome, Firefox, Safari, Edge).'
            : 'WebAuth Vault requires HTTPS or localhost. Encryption is unavailable over plain HTTP. Please access this application via HTTPS.';

        // Block the page with a visible error. The vault MUST NOT operate
        // without authenticated encryption.
        document.addEventListener('DOMContentLoaded', function () {
            document.body.innerHTML =
                '<div style="max-width:500px;margin:80px auto;padding:32px;background:#1e1e2e;color:#f87171;' +
                'border-radius:12px;font-family:system-ui,sans-serif;text-align:center;border:2px solid #f87171;">' +
                '<h1 style="font-size:1.4rem;margin-bottom:16px;">&#x1F6AB; Secure Environment Required</h1>' +
                '<p style="font-size:0.95rem;line-height:1.6;color:#e2e8f0;">' + msg + '</p></div>';
        });

        // Prevent further script execution by throwing. CryptoVault.getCrypto()
        // also throws independently, but this catches the problem earlier.
        throw new Error('[SECURITY] Web Crypto API unavailable — vault cannot operate without authenticated encryption (AES-GCM).');
    }
})();
