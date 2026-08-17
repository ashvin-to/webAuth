/* ==========================================================================
 * ui-shell.js — visual shell only.
 * Drives the 4-screen workspace (Overview / Devices / Sync / Security),
 * the stat strip, the device list and the sync-health panel. It never
 * touches vault crypto, storage, P2P payloads or the account lifecycle —
 * those live in app.js / p2p-sync-trystero.js and are unchanged.
 * ========================================================================== */
(function () {
    'use strict';

    function el(id) { return document.getElementById(id); }

    var navBtns = Array.prototype.slice.call(document.querySelectorAll('.nav [data-go]'));
    var screens = Array.prototype.slice.call(document.querySelectorAll('.screen'));

    function currentScreen() {
        var active = screens.filter(function (s) { return s.classList.contains('active'); });
        return active.length ? active[0].id : 'overview';
    }

    function fmtDeviceId(raw) {
        var hex = String(raw || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase().slice(0, 12);
        if (hex.length < 8) return raw && String(raw).trim() ? String(raw).trim().slice(0, 12).toUpperCase() : '—';
        return 'HKEY-' + hex.slice(0, 4) + '-' + hex.slice(4, 8);
    }

    function fmtAgo(ts) {
        var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        if (s < 5) return 'just now';
        if (s < 60) return s + 's ago';
        var m = Math.floor(s / 60);
        if (m < 60) return m + 'm ago';
        var h = Math.floor(m / 60);
        if (h < 24) return h + 'h ago';
        return new Date(ts).toLocaleDateString();
    }

    function p2p() {
        return (typeof window !== 'undefined' && window.TrysteroSync) ? window.TrysteroSync : null;
    }

    function accountCount() {
        try { return (typeof vaultData !== 'undefined' && Array.isArray(vaultData)) ? vaultData.length : 0; } catch (e) { return 0; }
    }

    function getLastSyncAt() {
        try { return (typeof lastSyncAt !== 'undefined') ? lastSyncAt : 0; } catch (e) { return 0; }
    }

    /* --- Screen switching --- */
    function go(id) {
        screens.forEach(function (s) { s.classList.toggle('active', s.id === id); });
        navBtns.forEach(function (n) { n.classList.toggle('active', n.dataset.go === id); });
        try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) {}
        refreshForScreen(id);
    }

    navBtns.forEach(function (n) {
        n.addEventListener('click', function () { go(n.dataset.go); });
    });

    /* --- Mobile nav dropdown (hamburger toggle) --- */
    var side = document.querySelector('.side');
    var navToggle = el('navToggle');
    function setNavOpen(open) {
        if (!side) return;
        side.classList.toggle('nav-open', open);
        if (navToggle) navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (side && navToggle) {
        navToggle.addEventListener('click', function () {
            setNavOpen(!side.classList.contains('nav-open'));
        });
        navBtns.forEach(function (n) {
            n.addEventListener('click', function () { setNavOpen(false); });
        });
        document.addEventListener('click', function (e) {
            if (!side.classList.contains('nav-open')) return;
            if (e.target.closest('.side')) return;
            setNavOpen(false);
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') setNavOpen(false);
        });
    }

    /* --- Overview stat strip --- */
    function updateStats() {
        var acc = el('statAccounts');
        var dev = el('statDevices');
        var sync = el('statSync');
        if (!acc && !dev && !sync) return;
        if (acc) acc.textContent = String(accountCount()).padStart(2, '0');
        if (dev) {
            var n = 1;
            var ts = p2p();
            if (ts) n += ts.getTrustedPeers ? ts.getTrustedPeers().size : 0;
            dev.textContent = String(n).padStart(2, '0');
        }
        if (sync) sync.textContent = getLastSyncAt() ? fmtAgo(getLastSyncAt()) : 'Never';
    }

    /* --- Devices screen --- */
    function deviceCard(icon, title, small, online) {
        var badge = online
            ? '<span class="connected">● Connected</span>'
            : '<span class="connected" style="color:var(--soft)">○ Offline</span>';
        return '<div class="device"><div class="device-top"><div class="device-icon">' + icon + '</div>' +
            badge + '</div><h3>' + title + '</h3><small>' + small + '</small></div>';
    }

    function setDeviceIdentity() {
        var target = el('deviceId');
        if (!target) return;
        var ts = p2p();
        target.textContent = ts && ts.getDeviceId ? fmtDeviceId(ts.getDeviceId()) : '—';
    }

    function renderDevices() {
        var grid = el('deviceGrid');
        if (!grid) return;
        var ts = p2p();
        var curId = (ts && ts.getDeviceId) ? ts.getDeviceId() : null;
        var connected = !!(ts && ts.isConnected && ts.isConnected());
        var trusted = (ts && ts.getTrustedPeers) ? ts.getTrustedPeers() : new Set();

        var html = deviceCard(
            '⌘',
            curId ? fmtDeviceId(curId) : 'This device',
            'Current device<br>Vault authority: local',
            true
        );

        var others = 0;
        trusted.forEach(function (pid) {
            if (curId && pid === curId) return;
            others++;
            html += deviceCard(
                connected ? '▣' : '▤',
                fmtDeviceId(pid),
                connected
                    ? 'Connected<br>Encrypted snapshots: on'
                    : 'Approved · offline<br>Syncs when it reconnects',
                connected
            );
        });

        if (others === 0 && !curId) {
            grid.innerHTML = '<div class="device" style="grid-column:1/-1;border-style:dashed">' +
                '<h3>No paired devices yet</h3>' +
                '<small>Open the Sync screen and start P2P auto-sync, then pair another device.</small></div>';
            return;
        }
        grid.innerHTML = html;
    }

    var copyBtn = el('copyDeviceIdBtn');
    if (copyBtn) {
        copyBtn.addEventListener('click', function () {
            var ts = p2p();
            var id = (ts && ts.getDeviceId) ? ts.getDeviceId() : '';
            if (!id) return;
            var done = function (ok) {
                if (window.showToast) showToast(ok ? 'Device ID copied to clipboard' : 'Copy failed — clipboard unavailable', ok ? 'success' : 'error');
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(id).then(function () { done(true); }, function () { done(false); });
            } else {
                done(false);
            }
        });
    }

    /* --- Sync screen health --- */
    function updateSyncHealth() {
        var ts = p2p();
        var state = ts && ts.getConnectionState ? ts.getConnectionState() : 'idle';
        var active = !!(ts && ts.isActive && ts.isActive());
        var pc = (ts && ts.getPeerCount) ? ts.getPeerCount() : 0;

        var net = el('syncNetStatus');
        if (net) {
            if (!active) {
                net.textContent = 'Not configured';
                net.style.color = '';
            } else if (state === 'connected') {
                net.textContent = pc > 0 ? 'Connected · ' + pc + ' usable peer' + (pc > 1 ? 's' : '') : 'Connected · waiting for peers';
                net.style.color = '';
            } else if (state === 'failed') {
                net.textContent = 'Connection failed';
                net.style.color = 'var(--red)';
            } else {
                net.textContent = 'Connecting…';
                net.style.color = 'var(--warn)';
            }
        }

        var sig = el('hSignaling');
        if (sig) {
            var sigOn = active && (state === 'connected' || state === 'connecting' || state === 'signaling');
            sig.textContent = active ? 'Available' : 'Idle';
            sig.style.color = sigOn ? 'var(--mint)' : 'var(--soft)';
        }

        var webrtc = el('hWebrtc');
        if (webrtc) {
            webrtc.textContent = state === 'connected' ? 'Connected' : (active ? state : '—');
            webrtc.style.color = state === 'connected' ? 'var(--mint)' : 'var(--soft)';
        }

        var last = el('hLast');
        if (last) last.textContent = getLastSyncAt() ? fmtAgo(getLastSyncAt()) : 'Never';
    }

    /* --- Refresh the currently visible screen --- */
    function refreshForScreen(id) {
        if (id === 'overview') updateStats();
        else if (id === 'devices') { setDeviceIdentity(); renderDevices(); }
        else if (id === 'sync') updateSyncHealth();
    }

    /* --- Screen action buttons --- */
    Array.prototype.forEach.call(document.querySelectorAll('[data-open-p2p]'), function (b) {
        b.addEventListener('click', function () { if (window.openP2pSyncModal) openP2pSyncModal(); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-open-folder]'), function (b) {
        b.addEventListener('click', function () { if (window.openFolderSyncModal) openFolderSyncModal(); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-open-changepass]'), function (b) {
        b.addEventListener('click', function () { if (window.openChangePassModal) openChangePassModal(); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-lock]'), function (b) {
        b.addEventListener('click', function () { if (window.lockVault) lockVault(); });
    });

    /* --- Keep the shell in sync with P2P lifecycle (adds a listener only) --- */
    var ts = p2p();
    if (ts && ts.onStateChange) {
        ts.onStateChange(function () { refreshForScreen(currentScreen()); });
    }

    /* --- Refresh after unlock (dashboardSection becomes visible) --- */
    var dash = el('dashboardSection');
    if (dash && window.MutationObserver) {
        var obs = new MutationObserver(function () {
            if (dash.style.display !== 'none') refreshForScreen(currentScreen());
        });
        obs.observe(dash, { attributes: true, attributeFilter: ['style'] });
    }

    /* --- Live "Last sync" — re-evaluate relative timestamps every second
       so the stat keeps incrementing without needing a page visit. --- */
    setInterval(function () {
        if (!dash || dash.style.display === 'none') return;
        var id = currentScreen();
        if (id === 'overview') {
            var sync = el('statSync');
            if (sync) sync.textContent = getLastSyncAt() ? fmtAgo(getLastSyncAt()) : 'Never';
        } else if (id === 'sync') {
            var last = el('hLast');
            if (last) last.textContent = getLastSyncAt() ? fmtAgo(getLastSyncAt()) : 'Never';
        }
    }, 1000);

    /* --- Initialize --- */
    document.addEventListener('DOMContentLoaded', function () {
        if (!screens.length) return;
        go(currentScreen());
    });
})();