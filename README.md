# WebAuth Vault 🔐

A lightweight, fully client-side 2FA (TOTP) authenticator web application designed for zero-knowledge local security with flexible opt-in sync options across devices.

---

## 🌟 Key Features

- **Zero-Knowledge Architecture**: All encryption and decryption occur locally inside your browser using **AES-256-GCM** (WebCrypto API) and **PBKDF2 key derivation** with **100,000 iterations** of SHA-256. No unencrypted vault data or master passwords ever leave your machine.
- **Universal TOTP Compatibility**: Supports Google Authenticator, Microsoft Authenticator, Authy, Aegis, Bitwarden, 2FAS, GitHub, Amazon, Steam, and all standard 2FA services.
- **Google Authenticator Migration**: Directly parses Google Authenticator export QR codes (`otpauth-migration://`) containing multiple accounts.
- **In-App Password Management**: Change your master password anytime with full automatic re-encryption across `localStorage`, `IndexedDB`, linked folder sync, and active P2P sync rooms.
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
- **What it does**: Links your vault directly to a `webauth_vault.json` file inside a folder managed by a desktop sync client (e.g., Google Drive for Desktop, Dropbox, OneDrive, or Syncthing). The app automatically performs a **pull-merge-on-unlock** when you open the vault and a **push-on-save** whenever accounts are modified (including automatically bridging accounts received via P2P sync).
- **Requirements**: Requires the native **File System Access API** (supported in desktop Chrome, Edge, and Opera). Linux users typically pair this with Syncthing, rclone, or a mounted cloud path.
- **Trade-offs**: Desktop-only. Sync is event-based (unlock, save, and P2P merge), not background real-time polling.

### 3. Real-Time P2P Sync (Trystero WebRTC)
- **What it does**: Connects two or more online devices (desktop or mobile) over direct WebRTC peer-to-peer data channels. Devices unlocked with the **same master password** automatically derive identical room IDs and connect in real-time without typing or scanning pairing codes. Newly joining peers automatically receive an initial symmetric sync.
- **Conflict Resolution (Last-Write-Wins)**: Every account carries an `updatedAt` timestamp. Concurrent edits on different devices converge to the most recently modified version instead of silently dropping changes.
- **Delete Propagation (Tombstones)**: Deleted accounts leave an encrypted tombstone (`webauth_tombstones` in `localStorage`/`IndexedDB`), so deletions propagate to all devices and deleted accounts do not resurrect from older broadcasts.
- **Efficient Delta Sync**: Account saves broadcast only the changed accounts (deltas) instead of re-encrypting and sending the entire vault. Full encrypted snapshots are exchanged on peer join, tab refocus, or when explicitly requested via the **Sync Now** button, which also asks connected peers to resend their vaults.
- **Sync Status Feedback**: The P2P modal shows connection state and the **last-synced** timestamp.
- **Peer Approval Gate**: Unrecognized devices are assigned a persistent 8-character fingerprint (`deviceId`). Incoming broadcasts from unapproved devices trigger an explicit **Approve / Ignore** prompt before any accounts are merged.
- **Custom Sync Passphrase**: Supports an optional custom sync passphrase (decoupled from the master login password) to isolate P2P rooms across device subsets.
- **Weekly Room ID Rotation**: Room IDs rotate automatically based on UTC week numbers (`SHA-256(passphrase + salt + '-week-' + weekNum)`). Dual-room joining provides a seamless 7-day overlap window across weekly rotation boundaries.
- **Signaling & ICE/TURN Fallback**:
  - Trystero dynamically loads from `https://esm.sh/trystero@0.19.0/...` and uses public signaling for peer discovery.
  - **Multi-Strategy Redundancy**: The app joins the same room across **three independent signaling strategies simultaneously** — BitTorrent trackers (`/torrent`), Nostr relays (`/nostr`), and MQTT brokers (`/mqtt`). Peers only need a single shared strategy to connect, so a blocked or flaky tracker/relay no longer breaks sync.
  - **ICE/TURN**: Configured with Cloudflare, Google, and STUN protocols STUN servers plus free-tier TURN relay servers (Open Relay Project) as a fallback for restrictive NATs/firewalls.
  - Signaling services see connection metadata (IP addresses and hashed room IDs) but **never see vault contents or secrets**.
  - All transmitted vault payloads are AES-256-GCM encrypted with your master password before broadcasting over WebRTC.

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
