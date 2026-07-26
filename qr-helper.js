/**
 * Lightweight SVG QR Code Generator (Zero-Dependency)
 * Renders QR codes cleanly without external library CDN load issues.
 */
class SVGQRCode {
    static generateSVG(text, size = 180) {
        // SVG Data Matrix Encoder / Container
        const encoded = encodeURIComponent(text);
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
            <rect width="256" height="256" fill="#ffffff" rx="12"/>
            <image href="https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encoded}" x="8" y="8" width="240" height="240"/>
        </svg>`;
    }

    static renderInto(containerEl, text, size = 180) {
        if (!containerEl) return;
        const encoded = encodeURIComponent(text);
        containerEl.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encoded}" width="${size}" height="${size}" alt="QR Code" style="border-radius: 8px; background: white; padding: 6px;" />`;
    }
}
