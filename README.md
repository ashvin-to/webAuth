# WebAuth Vault 🔐

A lightweight, fully client-side 2FA (TOTP) authenticator web application designed for zero-knowledge local security with flexible opt-in sync options across devices.

---

## 🌟 Key Features

- **Zero-Knowledge Architecture**: All encryption and decryption occur locally inside your browser using **AES-256-GCM** (WebCrypto API) and **PBKDF2 key derivation** with **100,000 iterations** of SHA-256. No unencrypted vault data or master passwords ever leave your machine.
- **Universal TOTP Compatibility**: Supports Google Authenticator, Microsoft Authenticator, Authy, Aegis, Bitwarden, 2FAS, GitHub, Amazon, Steam, and all standard 2FA services.
- **Google Authenticator Migration**: Directly parses Google Authenticator export QR codes (`otpauth-migration://`) containing multiple accounts.
- **Multi-Layer Data Protection**: Vault data and emergency auto-backups are persisted locally across both `localStorage` and `IndexedDB`.
- **Emergency Recovery Key System**: Automatically generates a 16-character recovery key to decrypt your vault if you forget your master password.
- **Offline Local QR Encoder**: High-density QR generation (`qr-helper.js`) built completely in-house without external third-party image API calls.
- **Integrated QR & Camera Scanner**: Built-in camera scanner and drag-and-drop QR image parser.

---

## 🔄 Synchronization Options

WebAuth Vault provides three independent, opt-in synchronization mechanisms. None are required, and none replace another.

### 1. Manual Backup Export / Import (File-Based)
- **What it does**: Allows you to export your encrypted vault as a JSON file or import a previously exported backup file.
- **Requirements**: None. Works on all platforms, browsers, and offline environments.
- **Trade-offs**: Fully manual process. You control transport and storage.

### 2. Linked Folder Sync (Drive / Dropbox / Syncthing)
- **What it does**: Links your vault directly to a `webauth_vault.json` file inside a folder managed by a desktop sync client (e.g., Google Drive for Desktop, Dropbox, OneDrive, or Syncthing). The app automatically performs a **pull-merge-on-unlock** when you open the vault and a **push-on-save** whenever accounts are modified.
- **Requirements**: Requires the native **File System Access API** (supported in desktop Chrome, Edge, and Opera). Linux users typically pair this with Syncthing, rclone, or a mounted cloud path.
- **Trade-offs**: Desktop-only. Sync is event-based (unlock and save), not background real-time polling.

### 3. Real-Time P2P Sync (Trystero WebRTC)
- **What it does**: Connects two or more online devices (desktop or mobile) over direct WebRTC peer-to-peer data channels using a shared pairing room code. When connected, changes sync in real-time between devices, and newly joining peers automatically receive an initial symmetric sync.
- **Requirements**: Both devices must be online simultaneously with P2P Sync joined.
- **Signaling & Privacy Notice**:
  - Trystero dynamically loads from `https://esm.sh/trystero@0.19.0/torrent` and uses public BitTorrent trackers for WebRTC signaling (connection establishment).
  - Signaling trackers see connection metadata (IP addresses and room IDs) but **never see vault contents or secrets**.
  - All transmitted vault payloads are AES-256-GCM encrypted with your master password before broadcasting over WebRTC.
- **Security & Access Control**: The room pairing code acts as the sole access key to the WebRTC room. Treat it like a password (keep it long, random, and do not share publicly). Accounts received from a peer sharing your master password are merged automatically based on unique secret keys.

---

## 🛡️ Security Architecture

| Feature | Specification |
| :--- | :--- |
| **Encryption Algorithm** | AES-256-GCM (256-bit key) |
| **Key Derivation** | PBKDF2 with SHA-256 (100,000 iterations) |
| **Local Storage** | Dual Layer (`localStorage` + `IndexedDB`) |
| **QR Code Generation** | Local zero-dependency SVG QR matrix encoder |
| **Protobuf Parser** | Zero-dependency binary stream parser for Google Auth migration |

---

## 🌐 Hosting & Local Development

WebAuth Vault is built using static HTML5, CSS3, and vanilla JavaScript without any build steps or bundlers.

> [!IMPORTANT]
> Because WebCrypto, File System Access API, and ES module imports require a secure context or HTTP(S) origin, you must serve the application over HTTP/HTTPS (e.g., `http://localhost`) rather than opening `file://` directly in your browser.

### Local Development Server

```bash
cd mauth-web
python3 -m http.server 8080
```
Then visit `http://localhost:8080` in your browser.

### Free Hosting Options
- **GitHub Pages**: Push to a GitHub repository and enable Pages under Repository Settings $\rightarrow$ Pages.
- **Vercel / Netlify**: Deploy as a static site repository.

---

## 📜 License
[MIT License](LICENSE) © 2026 WebAuth Vault
