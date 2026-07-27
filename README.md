# WebAuth Vault 🔐

A lightweight, zero-knowledge, client-side 2FA authenticator web application designed for seamless local use across laptops and mobile devices without hosting a server.

---

## 🌟 Key Features

- **Zero-Knowledge Encryption**: Uses PBKDF2 (100,000 iterations) + AES-256-GCM client-side encryption. Your master password and 2FA secrets never leave your browser.
- **Universal 2FA Compatibility**: Supports Google Authenticator, Microsoft Authenticator, Authy, Aegis, Bitwarden, 2FAS, GitHub, Amazon, Steam, and all standard TOTP services.
- **Offline PWA Support**: Can be saved directly to your phone's Home Screen as a native app interface.
- **Google Authenticator Import**: Directly parses Google Authenticator export QR codes (`otpauth-migration://`) containing multiple accounts.
- **Device Sync (No Hosted Server Needed)**: Instantly transfer all 2FA accounts between laptop and phone via high-density single QR code scanning.
- **Direct File Sync (Google Drive / Cloud)**: Seamlessly sync zero-knowledge encrypted vault data across devices by linking a file in your local Google Drive, Dropbox, or OneDrive folder with zero Client IDs or OAuth setup.
- **Multi-Layer Data Protection**: Automatically backs up your encrypted vault across both `localStorage` and `IndexedDB`.
- **Emergency Recovery Key System**: Generates a 16-character recovery key to prevent data loss if a password is forgotten.
- **QR Code & Image Scanner**: Integrated live camera scanner + drag-and-drop QR screenshot parser.
- **Clean Mobile UI**: Compact, touch-friendly dark mode interface tailored for phone browsers.

---

## 🌐 Hosting Guide (Free & Private)

Since WebAuth is **100% client-side JavaScript**, your master password and decrypted keys remain inside your browser. Hosting it online only serves the static HTML/JS files, keeping your secrets 100% safe.

### Method 1: GitHub Pages (Recommended)
1. Push your `mauth-web` directory to a GitHub repository:
   ```bash
   git init
   git add .
   git commit -m "Initial WebAuth commit"
   git remote add origin https://github.com/YOUR_USERNAME/mauth-web.git
   git push -u origin main
   ```
2. Go to your repository on GitHub $\rightarrow$ **Settings** $\rightarrow$ **Pages**.
3. Under **Build and deployment** $\rightarrow$ **Branch**, select `main` (root) and click **Save**.
4. Access your vault on any phone or laptop at: `https://YOUR_USERNAME.github.io/mauth-web/`

---

### Method 2: Vercel (One-Click Deploy)
1. Install Vercel CLI or connect your GitHub account at [vercel.com](https://vercel.com).
2. Run in terminal:
   ```bash
   npx vercel
   ```
3. Your app will be live at `https://mauth-web.vercel.app`.

---

### Method 3: Cloudflare Pages / Netlify
- **Netlify**: Drag and drop the `mauth-web` folder onto [app.netlify.com/drop](https://app.netlify.com/drop).
- **Cloudflare Pages**: Connect your repository to Cloudflare Pages dashboard.

---

### Method 4: Local Server (No Internet Needed)
To run locally on your laptop without any internet connection:

```bash
cd /path/to/mauth-web
python3 -m http.server 8080
```
Then open `http://localhost:8080` in your browser.

---

## 📱 How to Install on Your Phone (PWA)

1. Open your hosted URL (e.g. `https://YOUR_USERNAME.github.io/mauth-web/`) on your phone browser.
2. **iOS (Safari)**: Tap the **Share** button $\rightarrow$ **Add to Home Screen**.
3. **Android (Chrome)**: Tap the **3-dots menu** $\rightarrow$ **Add to Home screen** / **Install app**.
4. WebAuth will launch like a native mobile app without browser address bars!

---

## 🔄 Syncing Accounts Between Laptop & Phone

1. On your **Laptop**, click **Sync Phone** in the header.
2. On your **Phone**, tap **Scan QR** and point your camera at the laptop screen.
3. All accounts will automatically import and update on your phone!

---

## 🛡️ Security Architecture

| Feature | Specification |
| :--- | :--- |
| **Encryption Algorithm** | AES-256-GCM |
| **Key Derivation** | PBKDF2 with SHA-256 (100,000 rounds) |
| **Storage Engine** | Dual Layer (`localStorage` + `IndexedDB`) |
| **Protobuf Parser** | Zero-dependency binary stream parser |
| **Password Managers** | Built-in `data-bwignore` flags to prevent Bitwarden conflicts |

---

## 📜 License
[MIT License](LICENSE) © 2026 WebAuth Vault
