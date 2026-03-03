/**
 * Adwaita Colors Home — prefs.js
 *
 * Full libadwaita preferences UI with three pages:
 *   • General      — auto-sync toggle, manual color picker, status rows
 *   • Installation — install/update/uninstall actions with progress UI
 *   • About        — credits, version info, manual update check
 *
 * All network and filesystem operations are async; the UI never blocks.
 *
 * Fixes vs v1:
 *  - Adw.Banner now added via window.add_banner() (not inside a group)
 *  - "Install Now" button correctly navigates to the Installation page
 *  - Extraction uses Python 3's zipfile module (always present on Fedora/GNOME)
 *    instead of `unzip` which is not installed by default
 *  - Extracted directory is discovered dynamically (not hardcoded)
 *  - subprocess uses wait_check_async — non-zero exits surface as real errors
 *  - Gdk removed; URLs opened via Gio.AppInfo.launch_default_for_uri_async
 *  - _findDownloader bug fixed (double call removed)
 */

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Soup from 'gi://Soup';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_COLORS = [
    'blue', 'brown', 'green', 'orange', 'pink',
    'purple', 'red', 'slate', 'teal', 'yellow',
];

const COLOR_META = {
    blue:   { label: 'Blue',   hex: '#3584e4' },
    brown:  { label: 'Brown',  hex: '#986a44' },
    green:  { label: 'Green',  hex: '#3a944a' },
    orange: { label: 'Orange', hex: '#e66100' },
    pink:   { label: 'Pink',   hex: '#d56199' },
    purple: { label: 'Purple', hex: '#9141ac' },
    red:    { label: 'Red',    hex: '#e01b24' },
    slate:  { label: 'Slate',  hex: '#6f8396' },
    teal:   { label: 'Teal',   hex: '#2190a4' },
    yellow: { label: 'Yellow', hex: '#e5a50a' },
};

const ACCENT_TO_COLOR = {
    blue: 'blue', teal: 'teal', green: 'green', yellow: 'yellow',
    orange: 'orange', red: 'red', pink: 'pink', purple: 'purple',
    slate: 'slate', default: 'blue',
};

const ICON_PATHS = [
    GLib.get_home_dir() + '/.local/share/icons',
    GLib.get_home_dir() + '/.icons',
    '/usr/local/share/icons',
    '/var/usrlocal/share/icons',
    '/usr/share/icons',
];

const GITHUB_API_URL =
    'https://api.github.com/repos/dpejoh/Adwaita-colors/releases/latest';
const GITHUB_RELEASES_URL =
    'https://github.com/dpejoh/Adwaita-colors/releases/latest';
const GITHUB_PAGE_URL =
    'https://github.com/dpejoh/Adwaita-colors';
const GITHUB_ISSUES_URL =
    'https://github.com/dpejoh/Adwaita-colors/issues';

// ─── Utilities ────────────────────────────────────────────────────────────────

function detectInstallation() {
    const installedColors = [];
    let firstPath = null;

    for (const base of ICON_PATHS) {
        for (const color of ALL_COLORS) {
            const idx = `${base}/Adwaita-${color}/index.theme`;
            if (GLib.file_test(idx, GLib.FileTest.EXISTS)) {
                if (!firstPath) firstPath = base;
                if (!installedColors.includes(color)) installedColors.push(color);
            }
        }
    }

    return {
        installed: installedColors.length > 0,
        path: firstPath,
        installedColors,
    };
}

function detectDistroType() {
    if (GLib.file_test('/run/ostree-booted', GLib.FileTest.EXISTS)) return 'atomic';

    try {
        const [, data] = GLib.file_get_contents('/etc/os-release');
        const text = new TextDecoder().decode(data);
        if (/VARIANT_ID=(silverblue|kinoite|sericea|onyx)/i.test(text)) return 'atomic';
    } catch (_) { /* non-fatal */ }

    return 'standard';
}

function resolveInstallPath(scope, distroType) {
    if (scope === 'user') return GLib.get_home_dir() + '/.local/share/icons';
    return distroType === 'atomic' ? '/var/usrlocal/share/icons' : '/usr/share/icons';
}

function parseSemver(v) {
    return (v ?? '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
}

function isNewer(candidate, installed) {
    const [ca, cb, cc] = parseSemver(candidate);
    const [ia, ib, ic] = parseSemver(installed);
    if (ca !== ia) return ca > ia;
    if (cb !== ib) return cb > ib;
    return cc > ic;
}

/** Open a URI with the system default handler — no Gdk import needed. */
function openUri(uri) {
    Gio.AppInfo.launch_default_for_uri_async(uri, null, null, null);
}

/** Small circular color swatch as a Gtk.DrawingArea. */
function makeColorDot(hex, size = 16) {
    const area = new Gtk.DrawingArea({ width_request: size, height_request: size });
    area.set_draw_func((_w, cr) => {
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        cr.arc(size / 2, size / 2, size / 2 - 1, 0, 2 * Math.PI);
        cr.setSourceRGB(r, g, b);
        cr.fillPreserve();
        cr.setSourceRGBA(0, 0, 0, 0.25);
        cr.setLineWidth(1);
        cr.stroke();
    });
    return area;
}

// ─── Main Preferences Class ───────────────────────────────────────────────────

export default class AdwaitaColorsPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        this._settings        = this.getSettings();
        this._desktopSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._window          = window;
        this._distroType      = detectDistroType();
        this._installation    = detectInstallation();
        this._hasAccentColor  = this._desktopSettings
            .settings_schema.has_key('accent-color');

        window.set_default_size(680, 680);
        window.set_title('Adwaita Colors Home');

        // Build pages — _installPage must exist before the banner callback runs
        const generalPage     = this._buildGeneralPage();
        this._installPage     = this._buildInstallationPage();
        const aboutPage       = this._buildAboutPage();

        window.add(generalPage);
        window.add(this._installPage);
        window.add(aboutPage);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PAGE 1 — General
    // ─────────────────────────────────────────────────────────────────────────

    _buildGeneralPage() {
        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });

        // ── Not-installed notice (compatible with all GNOME 47+ builds) ───────
        if (!this._installation.installed) {
            const notInstalledGroup = new Adw.PreferencesGroup();
            const bannerRow = new Adw.ActionRow({
                title: 'Adwaita Colors is not installed',
                subtitle: 'Open the Installation tab to download and install it.',
                css_classes: ['warning'],
            });
            bannerRow.add_prefix(new Gtk.Image({
                icon_name: 'dialog-warning-symbolic',
                pixel_size: 32,
            }));
            const installBtn = new Gtk.Button({
                label: 'Install Now',
                css_classes: ['suggested-action'],
                valign: Gtk.Align.CENTER,
            });
            installBtn.connect('clicked', () => {
                if (this._installPage)
                    this._window.set_visible_page(this._installPage);
            });
            bannerRow.add_suffix(installBtn);
            notInstalledGroup.add(bannerRow);
            page.add(notInstalledGroup);
        }

        // ── Group: Icon Theme ──────────────────────────────────────────────
        const themeGroup = new Adw.PreferencesGroup({
            title: 'Icon Theme',
            description: 'Control how Adwaita Colors syncs with your desktop accent color.',
        });

        // Active variant indicator row
        const activeRow = new Adw.ActionRow({ title: 'Active Variant' });
        this._activeColorDot   = makeColorDot('#3584e4', 18);
        this._activeColorLabel = new Gtk.Label({ label: 'Blue' });
        const activeBox = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER });
        activeBox.append(this._activeColorDot);
        activeBox.append(this._activeColorLabel);
        activeRow.add_suffix(activeBox);
        themeGroup.add(activeRow);

        // GNOME < 47 warning
        if (!this._hasAccentColor) {
            const noAccentRow = new Adw.ActionRow({
                title: 'Auto-sync unavailable',
                subtitle: 'GNOME 47 or newer is required for accent color support.',
            });
            noAccentRow.add_prefix(
                new Gtk.Image({ icon_name: 'dialog-warning-symbolic' }));
            themeGroup.add(noAccentRow);
        }

        // Auto-sync switch
        const syncRow = new Adw.SwitchRow({
            title: 'Auto-sync with GNOME Accent Color',
            subtitle: 'Automatically switch the icon theme when you change your accent color.',
            sensitive: this._hasAccentColor,
        });
        this._settings.bind('auto-sync', syncRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        themeGroup.add(syncRow);

        // Manual color combo (disabled when auto-sync is on)
        const colorRow = new Adw.ComboRow({
            title: 'Icon Color',
            subtitle: 'Only active when auto-sync is off.',
        });
        const colorModel = new Gtk.StringList();
        ALL_COLORS.forEach(c => colorModel.append(COLOR_META[c].label));
        colorRow.model = colorModel;

        const syncSelection = () => {
            const color = this._settings.get_string('manual-color');
            const idx   = ALL_COLORS.indexOf(color);
            if (idx >= 0 && colorRow.selected !== idx) colorRow.selected = idx;
        };
        syncSelection();

        colorRow.connect('notify::selected', () => {
            const color = ALL_COLORS[colorRow.selected];
            if (color) this._settings.set_string('manual-color', color);
        });

        const updateSensitivity = () => {
            colorRow.sensitive = !this._settings.get_boolean('auto-sync');
            this._refreshActiveColorRow();
        };
        this._settings.connect('changed::auto-sync',    updateSensitivity);
        this._settings.connect('changed::manual-color', () => {
            syncSelection();
            this._refreshActiveColorRow();
        });
        updateSensitivity();
        themeGroup.add(colorRow);

        // Panel indicator toggle
        const indicatorRow = new Adw.SwitchRow({
            title: 'Show Panel Color Indicator',
            subtitle: 'Display a colored circle in the top bar for quick color switching.',
        });
        this._settings.bind(
            'show-panel-indicator', indicatorRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        themeGroup.add(indicatorRow);

        page.add(themeGroup);

        // ── Group: Status ──────────────────────────────────────────────────
        const statusGroup = new Adw.PreferencesGroup({ title: 'Status' });

        const installRow = new Adw.ActionRow({ title: 'Installation' });
        if (this._installation.installed) {
            const version = this._settings.get_string('installed-version') || 'unknown';
            installRow.subtitle =
                `Installed at ${this._installation.path} · ` +
                `${this._installation.installedColors.length} variants · version ${version}`;
            installRow.add_prefix(
                new Gtk.Image({ icon_name: 'emblem-ok-symbolic', css_classes: ['success'] }));
        } else {
            installRow.subtitle = 'Not installed — go to the Installation tab.';
            installRow.add_prefix(
                new Gtk.Image({ icon_name: 'dialog-warning-symbolic', css_classes: ['warning'] }));
        }
        statusGroup.add(installRow);

        // Update status row — populated asynchronously
        this._updateStatusRow = new Adw.ActionRow({
            title: 'Updates',
            subtitle: 'Checking…',
        });
        this._updateStatusRow.add_prefix(
            new Gtk.Image({ icon_name: 'software-update-available-symbolic' }));
        statusGroup.add(this._updateStatusRow);
        page.add(statusGroup);

        // Kick off async tasks after the widget tree is ready
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._refreshUpdateStatusRow();
            return GLib.SOURCE_REMOVE;
        });
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._refreshActiveColorRow();
            return GLib.SOURCE_REMOVE;
        });

        return page;
    }

    _refreshActiveColorRow() {
        let color;
        if (this._settings.get_boolean('auto-sync') && this._hasAccentColor) {
            const accent = this._desktopSettings.get_string('accent-color');
            color = ACCENT_TO_COLOR[accent] ?? 'blue';
        } else {
            color = this._settings.get_string('manual-color');
        }
        const meta = COLOR_META[color] ?? COLOR_META.blue;
        this._activeColorLabel.label = meta.label;

        // Swap out the dot with a freshly colored one
        const parent = this._activeColorDot?.get_parent();
        if (parent) {
            const newDot = makeColorDot(meta.hex, 18);
            parent.remove(this._activeColorDot);
            parent.prepend(newDot);
            this._activeColorDot = newDot;
        }
    }

    _refreshUpdateStatusRow() {
        const installed = this._settings.get_string('installed-version');
        const session   = new Soup.Session();
        const msg       = Soup.Message.new('GET', GITHUB_API_URL);
        msg.request_headers.append('User-Agent', 'adwaita-colors-home-prefs/1');

        session.send_and_read_async(msg, GLib.PRIORITY_LOW, null, (sess, result) => {
            try {
                const bytes  = sess.send_and_read_finish(result);
                const json   = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                const latest = json.tag_name;

                if (!installed) {
                    this._updateStatusRow.subtitle =
                        `Latest release: ${latest} (not tracked — install via the Installation tab)`;
                    return;
                }

                if (isNewer(latest, installed)) {
                    this._updateStatusRow.subtitle =
                        `Update available: ${latest} (installed: ${installed})`;
                    const btn = new Gtk.Button({
                        label: `Update to ${latest}`,
                        css_classes: ['suggested-action'],
                        valign: Gtk.Align.CENTER,
                    });
                    btn.connect('clicked', () => {
                        this._startInstall(
                            this._settings.get_string('install-scope'), latest);
                        this._window.set_visible_page(this._installPage);
                    });
                    this._updateStatusRow.add_suffix(btn);
                } else {
                    this._updateStatusRow.subtitle = `Up to date (${installed})`;
                }
            } catch (_) {
                this._updateStatusRow.subtitle =
                    'Could not check for updates (network unavailable)';
            }
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PAGE 2 — Installation
    // ─────────────────────────────────────────────────────────────────────────

    _buildInstallationPage() {
        const page = new Adw.PreferencesPage({
            name: 'installation',
            title: 'Installation',
            icon_name: 'system-software-install-symbolic',
        });

        const isAtomic = this._distroType === 'atomic';

        // ── Group: Install Location ────────────────────────────────────────
        const locationGroup = new Adw.PreferencesGroup({
            title: 'Install Location',
            description: isAtomic
                ? 'Running on an atomic/ostree desktop. System installs use ' +
                  '/var/usrlocal/share/icons (persists across OS updates). User installs are recommended.'
                : 'System installs require an administrator password (pkexec). ' +
                  'User installs are always available without extra permissions.',
        });

        if (this._installation.installed) {
            const locRow = new Adw.ActionRow({
                title: 'Detected Install Location',
                subtitle: this._installation.path ?? 'Unknown',
            });
            locRow.add_prefix(new Gtk.Image({ icon_name: 'folder-symbolic' }));
            locationGroup.add(locRow);
        }

        const scopeRow = new Adw.ComboRow({ title: 'Default Install Scope' });
        const scopeModel = new Gtk.StringList();
        scopeModel.append('User  (~/.local/share/icons)');
        scopeModel.append(isAtomic
            ? 'System  (/var/usrlocal/share/icons)'
            : 'System  (/usr/share/icons — needs sudo)');
        scopeRow.model = scopeModel;
        scopeRow.selected = this._settings.get_string('install-scope') === 'system' ? 1 : 0;
        scopeRow.connect('notify::selected', () => {
            this._settings.set_string(
                'install-scope', scopeRow.selected === 1 ? 'system' : 'user');
        });
        locationGroup.add(scopeRow);
        page.add(locationGroup);

        // ── Group: Actions ─────────────────────────────────────────────────
        const actionsGroup = new Adw.PreferencesGroup({ title: 'Actions' });

        // Progress row — hidden until an install starts
        this._progressRow = new Adw.ActionRow({ title: 'Progress', visible: false });
        this._progressBar = new Gtk.ProgressBar({
            valign: Gtk.Align.CENTER,
            hexpand: true,
            show_text: true,
        });
        this._progressRow.add_suffix(this._progressBar);
        actionsGroup.add(this._progressRow);

        // Status row
        this._installStatusRow = new Adw.ActionRow({
            title: 'Status',
            subtitle: this._installation.installed
                ? 'Adwaita Colors is installed.'
                : 'Not installed.',
        });
        actionsGroup.add(this._installStatusRow);

        // Install / Reinstall button
        const installBtn = new Gtk.Button({
            label: this._installation.installed ? 'Reinstall' : 'Install for me',
            css_classes: ['suggested-action'],
            valign: Gtk.Align.CENTER,
        });
        installBtn.connect('clicked', () => {
            this._startInstall(this._settings.get_string('install-scope'), null);
        });
        const installBtnRow = new Adw.ActionRow({ title: 'Install / Reinstall Adwaita Colors' });
        installBtnRow.add_suffix(installBtn);
        actionsGroup.add(installBtnRow);

        // Open GitHub button
        const githubBtn = new Gtk.Button({ label: 'Open on GitHub', valign: Gtk.Align.CENTER });
        githubBtn.connect('clicked', () => openUri(GITHUB_PAGE_URL));
        const githubRow = new Adw.ActionRow({ title: 'Manual Download' });
        githubRow.add_suffix(githubBtn);
        actionsGroup.add(githubRow);

        // Uninstall button — always visible, disabled when nothing is installed
        const uninstallBtn = new Gtk.Button({
            label: 'Uninstall',
            css_classes: ['destructive-action'],
            valign: Gtk.Align.CENTER,
            sensitive: this._installation.installed,
        });
        uninstallBtn.connect('clicked', () => this._confirmUninstall());
        const uninstallRow = new Adw.ActionRow({ title: 'Remove Adwaita Colors' });
        uninstallRow.add_suffix(uninstallBtn);
        actionsGroup.add(uninstallRow);

        page.add(actionsGroup);

        // ── Group: MoreWaita Integration ───────────────────────────────────
        const mwPaths = [
            `${GLib.get_home_dir()}/.local/share/icons/MoreWaita/index.theme`,
            '/usr/share/icons/MoreWaita/index.theme',
        ];
        if (mwPaths.some(p => GLib.file_test(p, GLib.FileTest.EXISTS))) {
            const mwGroup = new Adw.PreferencesGroup({
                title: 'MoreWaita Integration',
                description:
                    'MoreWaita is installed. Patching the Adwaita Colors index.theme files ' +
                    'adds MoreWaita to the icon inheritance chain for broader icon coverage.',
            });
            const mwBtn = new Gtk.Button({
                label: 'Patch index.theme files',
                valign: Gtk.Align.CENTER,
            });
            mwBtn.connect('clicked', () => this._applyMoreWaitaPatch());
            const mwRow = new Adw.ActionRow({
                title: 'Add MoreWaita to Inherits chain',
                subtitle: 'Result: Inherits=MoreWaita,Adwaita,AdwaitaLegacy,hicolor',
            });
            mwRow.add_suffix(mwBtn);
            mwGroup.add(mwRow);
            page.add(mwGroup);
        }

        return page;
    }

    // ── Install Flow ──────────────────────────────────────────────────────────

    _startInstall(scope, versionOverride) {
        this._progressRow.visible = true;
        this._progressBar.set_fraction(0);
        this._progressBar.set_text('Fetching release info…');
        this._setInstallStatus('Fetching latest release info from GitHub…');

        const session = new Soup.Session();
        const msg     = Soup.Message.new('GET', GITHUB_API_URL);
        msg.request_headers.append('User-Agent', 'adwaita-colors-home-prefs/1');

        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
            let zipUrl, tag;
            try {
                const bytes = sess.send_and_read_finish(result);
                const json  = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                tag = versionOverride ?? json.tag_name;

                // Prefer a zip asset on the release; fall back to GitHub's source archive
                const asset = json.assets?.find(a =>
                    a.name.endsWith('.zip') ||
                    a.name.endsWith('.tar.gz') ||
                    a.name.endsWith('.tar.xz'));
                zipUrl = asset?.browser_download_url
                    ?? `https://github.com/dpejoh/Adwaita-colors/archive/refs/tags/${tag}.zip`;
            } catch (e) {
                this._setInstallStatus(`Error fetching release info: ${e.message}`);
                this._progressRow.visible = false;
                return;
            }

            this._progressBar.set_fraction(0.1);
            this._setInstallStatus(`Downloading Adwaita Colors ${tag}…`);
            this._downloadAndInstall(zipUrl, tag, scope);
        });
    }

    _downloadAndInstall(url, tag, scope) {
        const tmpDir      = GLib.Dir.make_tmp('adwaita-colors-XXXXXX');
        const archivePath = `${tmpDir}/archive.zip`;
        const installPath = resolveInstallPath(scope, this._distroType);

        const downloader = this._findDownloader();
        if (!downloader) {
            this._setInstallStatus(
                'Error: neither curl nor wget found. ' +
                'Install one with: sudo dnf install curl');
            this._progressRow.visible = false;
            return;
        }

        const downloadArgs = downloader === 'curl'
            ? ['curl', '-L', '--fail', '-o', archivePath, url]
            : ['wget', '-q', '-O', archivePath, url];

        // Step 1 — Download
        this._runSubprocess(downloadArgs, 'Downloading…', 0.1, 0.4)
            .then(() => {
                this._progressBar.set_fraction(0.42);
                this._setInstallStatus('Extracting archive…');

                // Step 2 — Extract
                // Use Python 3's zipfile module so we don't need the `unzip` package
                // (which is not installed by default on Fedora).
                // For .tar.gz/.tar.xz release assets, fall back to tar.
                let extractArgs;
                if (url.endsWith('.tar.gz') || url.endsWith('.tar.xz')) {
                    extractArgs = ['tar', '-xf', archivePath, '-C', tmpDir];
                } else {
                    extractArgs = [
                        'python3', '-c',
                        `import zipfile, sys\nwith zipfile.ZipFile(sys.argv[1]) as z:\n    z.extractall(sys.argv[2])`,
                        archivePath, tmpDir,
                    ];
                }
                return this._runSubprocess(extractArgs, 'Extracting…', 0.42, 0.65);
            })
            .then(() => {
                this._progressBar.set_fraction(0.67);
                this._setInstallStatus('Installing theme directories…');

                // Step 3 — Find the extracted root directory dynamically.
                // GitHub source zips extract to a folder like "Adwaita-colors-2.5/"
                // or "Adwaita-colors-main/". We discover it by scanning tmpDir for
                // the first subdirectory that contains Adwaita-* subfolders.
                const findScript = `
import os, sys
tmp = sys.argv[1]
for entry in os.scandir(tmp):
    if entry.is_dir():
        children = os.listdir(entry.path)
        if any(c.startswith('Adwaita-') for c in children):
            print(entry.path)
            sys.exit(0)
# Fallback: themes may be directly in tmp
print(tmp)
`;
                return this._runSubprocessWithOutput(
                    ['python3', '-c', findScript, tmpDir]
                );
            })
            .then(extractedBase => {
                extractedBase = extractedBase.trim();

                // Combine mkdir + copy + cache into ONE script so pkexec only
                // prompts for the password a single time.
                const installScript = `
import os, shutil, subprocess, sys
src_base = sys.argv[1]
dst_base = sys.argv[2]

# 1. Create destination directory
os.makedirs(dst_base, exist_ok=True)

# 2. Copy each Adwaita-<color> folder
for entry in os.scandir(src_base):
    if not (entry.is_dir() and entry.name.startswith('Adwaita-')):
        continue
    if not os.path.exists(os.path.join(entry.path, 'index.theme')):
        continue
    dst = os.path.join(dst_base, entry.name)
    if os.path.exists(dst):
        shutil.rmtree(dst)
    shutil.copytree(entry.path, dst)
    print(f'Installed {entry.name}')

# 3. Update icon cache for every installed variant
for entry in os.scandir(dst_base):
    if entry.is_dir() and entry.name.startswith('Adwaita-'):
        subprocess.run(
            ['gtk-update-icon-cache', '-f', '-t', entry.path],
            capture_output=True)
        print(f'Cache updated: {entry.name}')
`;
                const installArgs = this._escalate(
                    ['python3', '-c', installScript, extractedBase, installPath],
                    installPath,
                );
                return this._runSubprocess(installArgs, 'Installing…', 0.65, 0.99);
            })
            .then(() => {
                GLib.spawn_command_line_async(`rm -rf ${tmpDir}`);
                this._progressBar.set_fraction(1.0);
                this._progressBar.set_text('Done!');
                this._settings.set_string('installed-version', tag);
                this._setInstallStatus(`✓ Adwaita Colors ${tag} installed at ${installPath}`);
                this._installation = detectInstallation();

                // Dismiss the not-installed banner
                if (this._banner) this._banner.revealed = false;

                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
                    this._progressRow.visible = false;
                    return GLib.SOURCE_REMOVE;
                });
            })
            .catch(err => {
                GLib.spawn_command_line_async(`rm -rf ${tmpDir}`);
                this._setInstallStatus(`Installation failed: ${err.message ?? err}`);
                this._progressRow.visible = false;
                log(`[AdwaitaColorsHome] Install error: ${err}`);
            });
    }

    /**
     * Returns true when the target path requires root to write to.
     */
    _needsPrivileges(path) {
        return path.startsWith('/usr/') ||
               path.startsWith('/var/usrlocal/') ||
               path.startsWith('/usr/local/');
    }

    /**
     * Wrap argv with pkexec when `targetPath` is a system directory.
     *
     * pkexec requires the *absolute path* of the binary — it refuses to run
     * bare command names. We resolve the path with GLib.find_program_in_path.
     *
     * Examples:
     *   ['bash', '-c', '...']   → ['pkexec', '/bin/bash', '-c', '...']
     *   ['cp', '-r', src, dst]  → ['pkexec', '/usr/bin/cp', '-r', src, dst]
     */
    _escalate(argv, targetPath) {
        if (!this._needsPrivileges(targetPath)) return argv;

        const bin = GLib.find_program_in_path(argv[0]);
        if (!bin) {
            log(`[AdwaitaColorsHome] Warning: could not resolve path for ${argv[0]}`);
            return argv; // let it fail naturally with a clear error
        }

        return ['pkexec', bin, ...argv.slice(1)];
    }

    /**
     * Run a subprocess; resolves on exit 0, rejects with a helpful error otherwise.
     * Uses wait_check_async so non-zero exits are surfaced as real thrown errors.
     */
    _runSubprocess(argv, label, fromFraction, toFraction) {
        return new Promise((resolve, reject) => {
            let proc;
            try {
                proc = new Gio.Subprocess({
                    argv,
                    flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                });
                proc.init(null);
            } catch (e) {
                reject(new Error(`Failed to start ${argv[0]}: ${e.message}`));
                return;
            }

            // Animate the progress bar while the process runs
            let frac = fromFraction;
            const step = (toFraction - fromFraction) * 0.08;
            const pulseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                frac = Math.min(frac + step, toFraction - 0.01);
                this._progressBar.set_fraction(frac);
                this._progressBar.set_text(label);
                return GLib.SOURCE_CONTINUE;
            });

            proc.wait_check_async(null, (_proc, asyncResult) => {
                GLib.source_remove(pulseId);
                try {
                    proc.wait_check_finish(asyncResult);
                    this._progressBar.set_fraction(toFraction);
                    resolve();
                } catch (e) {
                    reject(new Error(`${argv[0]} failed: ${e.message}`));
                }
            });
        });
    }

    /**
     * Run a subprocess and return a Promise<string> of its stdout.
     */
    _runSubprocessWithOutput(argv) {
        return new Promise((resolve, reject) => {
            let proc;
            try {
                proc = new Gio.Subprocess({
                    argv,
                    flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                });
                proc.init(null);
            } catch (e) {
                reject(e);
                return;
            }

            proc.communicate_utf8_async(null, null, (_proc, result) => {
                try {
                    const [, stdout] = proc.communicate_utf8_finish(result);
                    if (!proc.get_if_exited() || proc.get_exit_status() !== 0) {
                        reject(new Error(`${argv[0]} failed`));
                    } else {
                        resolve(stdout ?? '');
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /** Find 'curl' or 'wget' on PATH. Returns the command name or null. */
    _findDownloader() {
        for (const tool of ['curl', 'wget']) {
            if (GLib.find_program_in_path(tool)) return tool;
        }
        return null;
    }

    _setInstallStatus(msg) {
        if (this._installStatusRow) this._installStatusRow.subtitle = msg;
    }

    // ── Uninstall ─────────────────────────────────────────────────────────────

    _confirmUninstall() {
        const dialog = new Adw.MessageDialog({
            transient_for: this._window,
            heading: 'Uninstall Adwaita Colors?',
            body: `This will remove all Adwaita-* directories from ${this._installation.path}.`,
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('uninstall', 'Uninstall');
        dialog.set_response_appearance('uninstall', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_d, id) => {
            if (id === 'uninstall') this._performUninstall();
        });
        dialog.present();
    }

    _performUninstall() {
        const base = this._installation.path;
        if (!base) return;

        this._progressRow.visible = true;

        // Use Python so we can escalate a single binary (pkexec needs abs path,
        // and bash globs don't work cleanly with pkexec).
        const rmScript = `
import os, shutil, sys
base = sys.argv[1]
for entry in os.scandir(base):
    if entry.is_dir() and entry.name.startswith('Adwaita-'):
        shutil.rmtree(entry.path)
        print(f'Removed {entry.name}')
`;
        const args = this._escalate(['python3', '-c', rmScript, base], base);
        this._runSubprocess(args, 'Removing…', 0, 1)
            .then(() => {
                this._settings.set_string('installed-version', '');
                this._installation = detectInstallation();

                // Reset the icon theme to the default Adwaita so the user
                // isn't left with a broken/missing theme reference.
                const currentTheme = this._desktopSettings.get_string('icon-theme');
                if (currentTheme.startsWith('Adwaita-')) {
                    this._desktopSettings.set_string('icon-theme', 'Adwaita');
                }

                this._setInstallStatus('Adwaita Colors removed. Icon theme reset to Adwaita.');
                this._progressRow.visible = false;
            })
            .catch(err => {
                this._setInstallStatus(`Uninstall failed: ${err}`);
                this._progressRow.visible = false;
            });
    }

    // ── MoreWaita Patch ───────────────────────────────────────────────────────

    _applyMoreWaitaPatch() {
        const base = this._installation.path;
        if (!base) {
            this._setInstallStatus('Cannot patch: Adwaita Colors is not installed.');
            return;
        }

        let patched = 0;
        for (const color of ALL_COLORS) {
            const indexPath = `${base}/Adwaita-${color}/index.theme`;
            if (!GLib.file_test(indexPath, GLib.FileTest.EXISTS)) continue;

            try {
                const [, data] = GLib.file_get_contents(indexPath);
                let text = new TextDecoder().decode(data);
                if (text.includes('MoreWaita')) continue;

                text = text.replace(/^Inherits=(.*)$/m, 'Inherits=MoreWaita,$1');
                GLib.file_set_contents(indexPath, new TextEncoder().encode(text));
                patched++;
            } catch (e) {
                log(`[AdwaitaColorsHome] MoreWaita patch failed for Adwaita-${color}: ${e}`);
            }
        }

        this._setInstallStatus(
            patched > 0
                ? `MoreWaita patch applied to ${patched} variant(s).`
                : 'All variants were already patched.');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PAGE 3 — About
    // ─────────────────────────────────────────────────────────────────────────

    _buildAboutPage() {
        const page = new Adw.PreferencesPage({
            title: 'About',
            icon_name: 'help-about-symbolic',
        });

        // ── Extension info ─────────────────────────────────────────────────
        const infoGroup = new Adw.PreferencesGroup({ title: 'Adwaita Colors Home' });

        infoGroup.add(new Adw.ActionRow({ title: 'Extension Version', subtitle: '1.0' }));
        infoGroup.add(new Adw.ActionRow({ title: 'GNOME Shell Compatibility', subtitle: '47, 48' }));

        const accentRow = new Adw.ActionRow({
            title: 'Accent Color Support',
            subtitle: this._hasAccentColor
                ? 'Available (GNOME 47+)'
                : 'Unavailable — upgrade to GNOME 47 or newer',
        });
        accentRow.add_prefix(new Gtk.Image({
            icon_name: this._hasAccentColor ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic',
            css_classes: [this._hasAccentColor ? 'success' : 'warning'],
        }));
        infoGroup.add(accentRow);
        page.add(infoGroup);

        // ── Links ──────────────────────────────────────────────────────────
        const linksGroup = new Adw.PreferencesGroup({ title: 'Links' });
        for (const { title, url } of [
            { title: 'Adwaita Colors on GitHub', url: GITHUB_PAGE_URL },
            { title: 'Report an Issue',          url: GITHUB_ISSUES_URL },
            { title: 'Latest Release',           url: GITHUB_RELEASES_URL },
        ]) {
            const row = new Adw.ActionRow({ title, activatable: true });
            row.add_suffix(new Gtk.Image({ icon_name: 'adw-external-link-symbolic' }));
            row.connect('activated', () => openUri(url));
            linksGroup.add(row);
        }
        page.add(linksGroup);

        // ── Manual update check ────────────────────────────────────────────
        const updateGroup = new Adw.PreferencesGroup({ title: 'Updates' });
        this._manualCheckLabel = new Gtk.Label({ label: '', valign: Gtk.Align.CENTER });
        const checkBtn = new Gtk.Button({ label: 'Check Now', valign: Gtk.Align.CENTER });
        checkBtn.connect('clicked', () => this._manualUpdateCheck());
        const checkRow = new Adw.ActionRow({ title: 'Check for Updates Manually' });
        checkRow.add_suffix(this._manualCheckLabel);
        checkRow.add_suffix(checkBtn);
        updateGroup.add(checkRow);
        page.add(updateGroup);

        // ── Credits ────────────────────────────────────────────────────────
        const creditsGroup = new Adw.PreferencesGroup({ title: 'Credits' });
        for (const [title, subtitle] of [
            ['Icon Theme', 'Adwaita Colors by dpejoh'],
            ['Extension',  'Adwaita Colors Home — official companion extension'],
            ['License',    'GPL-3.0-or-later'],
        ]) {
            creditsGroup.add(new Adw.ActionRow({ title, subtitle }));
        }
        page.add(creditsGroup);

        return page;
    }

    _manualUpdateCheck() {
        this._manualCheckLabel.label = 'Checking…';
        const session = new Soup.Session();
        const msg     = Soup.Message.new('GET', GITHUB_API_URL);
        msg.request_headers.append('User-Agent', 'adwaita-colors-home-prefs/1');

        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
            try {
                const bytes     = sess.send_and_read_finish(result);
                const json      = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                const latest    = json.tag_name;
                const installed = this._settings.get_string('installed-version');

                if (!installed) {
                    this._manualCheckLabel.label = `Latest: ${latest}`;
                } else if (isNewer(latest, installed)) {
                    this._manualCheckLabel.label = `Update available: ${latest}`;
                } else {
                    this._manualCheckLabel.label = `Up to date (${installed})`;
                }

                this._settings.set_int64(
                    'last-update-check', Math.floor(Date.now() / 1000));
            } catch (_) {
                this._manualCheckLabel.label = 'Network error';
            }
        });
    }
}
