/**
 * Adwaita Colors Home — extension.js
 *
 * Main GNOME Shell extension entry point. Handles:
 *  1. Auto-sync of icon theme with GNOME accent color (GNOME 47+)
 *  2. Panel indicator (optional)
 *  3. Periodic update checks (max once per 24 h)
 *  4. Conflict detection with the legacy auto-adwaita-colors@celiopy extension
 *
 * GNOME Shell 47+ ESM-style extension.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** All Adwaita Colors variants that exist in the theme pack. */
const ALL_COLORS = [
    'blue', 'brown', 'green', 'orange', 'pink',
    'purple', 'red', 'slate', 'teal', 'yellow',
];

/** Human-readable labels and CSS hex values for each color. */
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

/** Maps GNOME accent-color values → Adwaita Colors theme name. */
const ACCENT_TO_THEME = {
    blue:    'Adwaita-blue',
    teal:    'Adwaita-teal',
    green:   'Adwaita-green',
    yellow:  'Adwaita-yellow',
    orange:  'Adwaita-orange',
    red:     'Adwaita-red',
    pink:    'Adwaita-pink',
    purple:  'Adwaita-purple',
    slate:   'Adwaita-slate',
    default: 'Adwaita-blue', // GNOME "default" accent is blue
};

/** Icon directories searched in order, most specific first. */
const ICON_PATHS = [
    GLib.get_home_dir() + '/.local/share/icons',
    GLib.get_home_dir() + '/.icons',
    '/usr/local/share/icons',
    '/var/usrlocal/share/icons', // Persistent path on atomic/ostree desktops
    '/usr/share/icons',
];

/** Update check interval in seconds (24 hours). */
const UPDATE_CHECK_INTERVAL = 86400;

/** GitHub API endpoint for latest release. */
const GITHUB_API_URL =
    'https://api.github.com/repos/dpejoh/Adwaita-colors/releases/latest';

// ─── Panel Indicator ─────────────────────────────────────────────────────────

/**
 * PanelIndicator — a top-bar button showing a colored circle.
 * Clicking it opens a popover grid of color swatches for instant switching.
 */
const PanelIndicator = GObject.registerClass(
class PanelIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Adwaita Colors');
        this._extension = extension;

        // Wrap the drawing area in a box so it fills the panel button area
        // and stays vertically centered. Without this, St.DrawingArea floats
        // to the top of the button at zero height.
        const box = new St.BoxLayout({
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'padding: 0 2px;',
        });

        this._dot = new St.DrawingArea({
            width: 14,
            height: 14,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            style: 'margin: 1px;',
        });
        this._dot.connect('repaint', this._repaintDot.bind(this));

        box.add_child(this._dot);
        this.add_child(box);

        this._buildMenu();
    }

    /**
     * Draw a filled circle with the current accent color using Cairo.
     */
    _repaintDot(area) {
        const cr = area.get_context();
        const color = this._extension.getCurrentColor();
        const hex = COLOR_META[color]?.hex ?? '#3584e4';

        // Parse hex color
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;

        cr.arc(7, 7, 6, 0, 2 * Math.PI);
        cr.setSourceRGB(r, g, b);
        cr.fillPreserve();
        cr.setSourceRGBA(0, 0, 0, 0.3);
        cr.setLineWidth(1);
        cr.stroke();
        cr.$dispose();
    }

    /**
     * Build the popover menu with a color swatch grid plus "Open Settings".
     */
    _buildMenu() {
        // Color grid — 5 columns × 2 rows
        const box = new St.BoxLayout({ vertical: true, style_class: 'adwaita-colors-popup' });

        const grid = new St.Widget({ layout_manager: new Clutter.GridLayout() });
        const layout = grid.layout_manager;
        let col = 0, row = 0;

        for (const color of ALL_COLORS) {
            const meta = COLOR_META[color];
            const btn = new St.Button({
                style: `background-color: ${meta.hex}; width: 28px; height: 28px; border-radius: 14px; margin: 3px;`,
                can_focus: true,
                reactive: true,
            });
            btn.connect('clicked', () => {
                this._extension.setManualColor(color);
                this.menu.close();
            });
            // Tooltip-style label (accessible name)
            btn.accessible_name = meta.label;

            layout.attach(btn, col, row, 1, 1);
            col++;
            if (col >= 5) { col = 0; row++; }
        }

        box.add_child(grid);

        // Separator + settings link
        const sep = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(sep);

        const settingsItem = new PopupMenu.PopupMenuItem('Open Settings');
        settingsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(settingsItem);

        // Embed the grid in a custom menu item
        const gridItem = new PopupMenu.PopupBaseMenuItem({ can_focus: false, reactive: false });
        gridItem.add_child(box);
        this.menu.addMenuItem(gridItem, 0);
    }

    /**
     * Redraw the dot (call when the color changes).
     */
    refresh() {
        this._dot.queue_repaint();
    }
});

// ─── Main Extension Class ─────────────────────────────────────────────────────

export default class AdwaitaColorsHome extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._desktopSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });

        // Check if the accent-color key exists (GNOME 47+)
        this._hasAccentColor = this._desktopSettings
            .settings_schema.has_key('accent-color');

        // Watch for accent-color changes
        if (this._hasAccentColor) {
            this._accentChangedId = this._desktopSettings.connect(
                'changed::accent-color',
                this._onAccentChanged.bind(this),
            );
        }

        // Watch for auto-sync setting changes (so manual-color takes effect immediately)
        this._autoSyncChangedId = this._settings.connect(
            'changed::auto-sync',
            this._onSettingsChanged.bind(this),
        );
        this._manualColorChangedId = this._settings.connect(
            'changed::manual-color',
            this._onSettingsChanged.bind(this),
        );
        this._showIndicatorChangedId = this._settings.connect(
            'changed::show-panel-indicator',
            this._onIndicatorSettingChanged.bind(this),
        );

        // Apply sync on startup
        this._syncIconTheme();

        // Panel indicator
        if (this._settings.get_boolean('show-panel-indicator')) {
            this._createIndicator();
        }

        // Warn if the old conflicting extension is running
        this._checkConflicts();

        // Update check (throttled to once per 24 h)
        this._maybeCheckForUpdates();
    }

    disable() {
        // Disconnect all signals
        if (this._accentChangedId) {
            this._desktopSettings.disconnect(this._accentChangedId);
            this._accentChangedId = null;
        }
        if (this._autoSyncChangedId) {
            this._settings.disconnect(this._autoSyncChangedId);
            this._autoSyncChangedId = null;
        }
        if (this._manualColorChangedId) {
            this._settings.disconnect(this._manualColorChangedId);
            this._manualColorChangedId = null;
        }
        if (this._showIndicatorChangedId) {
            this._settings.disconnect(this._showIndicatorChangedId);
            this._showIndicatorChangedId = null;
        }

        // Destroy panel indicator
        this._destroyIndicator();

        // Cancel any in-flight Soup session
        if (this._soupSession) {
            this._soupSession.abort();
            this._soupSession = null;
        }

        this._settings = null;
        this._desktopSettings = null;
    }

    // ── Public helpers used by the panel indicator and prefs ─────────────────

    /**
     * Returns the currently active Adwaita color name (e.g. 'blue').
     * Falls back to the manual-color setting when auto-sync is off.
     */
    getCurrentColor() {
        if (this._settings.get_boolean('auto-sync') && this._hasAccentColor) {
            const accent = this._desktopSettings.get_string('accent-color');
            return accent === 'default' ? 'blue' : accent;
        }
        return this._settings.get_string('manual-color');
    }

    /**
     * Manually set a specific color variant and apply it immediately.
     * Also disables auto-sync so the manual choice is respected.
     */
    setManualColor(color) {
        this._settings.set_boolean('auto-sync', false);
        this._settings.set_string('manual-color', color);
        this._applyTheme('Adwaita-' + color);
    }

    /** Open the extension preferences window. */
    openPreferences() {
        super.openPreferences();
    }

    // ── Icon Theme Sync ───────────────────────────────────────────────────────

    /**
     * Decide which theme to apply based on current settings, then apply it.
     */
    _syncIconTheme() {
        if (this._settings.get_boolean('auto-sync')) {
            if (!this._hasAccentColor) {
                // GNOME < 47 — auto-sync unavailable, fall through to manual
                log('[AdwaitaColorsHome] GNOME < 47 detected; accent-color key missing. Auto-sync unavailable.');
                return;
            }
            const accent = this._desktopSettings.get_string('accent-color');
            const themeName = ACCENT_TO_THEME[accent] ?? 'Adwaita-blue';
            this._applyTheme(themeName);
        } else {
            const color = this._settings.get_string('manual-color');
            this._applyTheme('Adwaita-' + color);
        }
    }

    /**
     * Apply a specific Adwaita Colors theme if it is installed.
     * Respects the "don't override an unrelated theme" UX guideline:
     * only switches if the current theme is already an Adwaita-* variant
     * OR if the user explicitly asked via manual-color / auto-sync.
     */
    _applyTheme(themeName) {
        if (!this._isThemeInstalled(themeName)) {
            log(`[AdwaitaColorsHome] Theme "${themeName}" is not installed — skipping.`);
            return;
        }

        const currentTheme = this._desktopSettings.get_string('icon-theme');

        // Guard: only auto-switch if the user is already using an Adwaita-* theme
        // or if the call comes from a manual override (checked by the caller).
        // For startup auto-sync, don't stomp on unrelated themes.
        const isAdwaitaTheme = currentTheme.startsWith('Adwaita');
        if (!isAdwaitaTheme && this._settings.get_boolean('auto-sync')) {
            log(`[AdwaitaColorsHome] Current theme "${currentTheme}" is not Adwaita-based. Not overriding on startup.`);
            return;
        }

        if (currentTheme !== themeName) {
            this._desktopSettings.set_string('icon-theme', themeName);
            log(`[AdwaitaColorsHome] Icon theme set to "${themeName}".`);

            // Refresh panel indicator dot
            if (this._indicator) this._indicator.refresh();
        }
    }

    /**
     * Returns true if a given theme directory (with index.theme) exists
     * in any of the standard icon search paths.
     */
    _isThemeInstalled(themeName) {
        for (const base of ICON_PATHS) {
            const indexPath = `${base}/${themeName}/index.theme`;
            if (GLib.file_test(indexPath, GLib.FileTest.EXISTS)) return true;
        }
        return false;
    }

    // ── Signal Handlers ───────────────────────────────────────────────────────

    _onAccentChanged() {
        this._syncIconTheme();
    }

    _onSettingsChanged() {
        this._syncIconTheme();
        if (this._indicator) this._indicator.refresh();
    }

    _onIndicatorSettingChanged() {
        if (this._settings.get_boolean('show-panel-indicator')) {
            this._createIndicator();
        } else {
            this._destroyIndicator();
        }
    }

    // ── Panel Indicator Lifecycle ─────────────────────────────────────────────

    _createIndicator() {
        if (this._indicator) return; // Already exists
        this._indicator = new PanelIndicator(this);
        Main.panel.addToStatusArea('adwaita-colors-home', this._indicator);
    }

    _destroyIndicator() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    // ── Update Checker ────────────────────────────────────────────────────────

    /**
     * Check for updates at most once every 24 hours.
     * Reads/writes `last-update-check` (Unix timestamp) from GSettings.
     */
    _maybeCheckForUpdates() {
        const now = Math.floor(Date.now() / 1000);
        const lastCheck = Number(this._settings.get_int64('last-update-check'));

        if (now - lastCheck < UPDATE_CHECK_INTERVAL) {
            log('[AdwaitaColorsHome] Update check skipped (checked recently).');
            return;
        }

        this._fetchLatestVersion()
            .then(tag => {
                this._settings.set_int64('last-update-check', now);
                const installed = this._settings.get_string('installed-version');
                const skipped  = this._settings.get_string('skipped-version');

                if (!tag) return;

                if (installed && skipped !== tag && this._isNewerVersion(tag, installed)) {
                    log(`[AdwaitaColorsHome] Update available: ${tag} (installed: ${installed})`);
                    // The prefs UI reads this on open; we could also show a notification.
                    // For now we rely on the prefs UI status row.
                }
            })
            .catch(err => {
                log(`[AdwaitaColorsHome] Update check failed: ${err}`);
            });
    }

    /**
     * Fetch the latest release tag from GitHub API asynchronously.
     * Returns a Promise<string|null>.
     */
    _fetchLatestVersion() {
        return new Promise((resolve, reject) => {
            try {
                this._soupSession = new Soup.Session();
                const msg = Soup.Message.new('GET', GITHUB_API_URL);
                msg.request_headers.append('User-Agent', 'adwaita-colors-home-extension/1');

                this._soupSession.send_and_read_async(
                    msg,
                    GLib.PRIORITY_LOW,
                    null,
                    (session, result) => {
                        try {
                            const bytes = session.send_and_read_finish(result);
                            const text  = new TextDecoder().decode(bytes.get_data());
                            const json  = JSON.parse(text);
                            resolve(json.tag_name ?? null);
                        } catch (e) {
                            reject(e);
                        } finally {
                            this._soupSession = null;
                        }
                    },
                );
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * Compare two semver strings numerically.
     * Returns true if `candidate` is strictly newer than `installed`.
     * Handles tags like "v2.4.0" or "2.4.0".
     */
    _isNewerVersion(candidate, installed) {
        const parse = v => v.replace(/^v/, '').split('.').map(Number);
        const [ca, cb, cc] = parse(candidate);
        const [ia, ib, ic] = parse(installed);

        if (ca !== ia) return ca > ia;
        if (cb !== ib) return cb > ib;
        return cc > ic;
    }

    // ── Conflict Detection ────────────────────────────────────────────────────

    /**
     * Warn in the log if the legacy auto-adwaita-colors@celiopy extension is
     * also enabled — both would fight over the icon-theme GSettings key.
     */
    _checkConflicts() {
        const manager = Main.extensionManager;
        if (!manager) return;

        const legacy = manager.lookup('auto-adwaita-colors@celiopy');
        if (legacy && legacy.state === 1 /* ENABLED */) {
            const msg =
                '[AdwaitaColorsHome] WARNING: "auto-adwaita-colors@celiopy" is also enabled. ' +
                'Both extensions write to org.gnome.desktop.interface icon-theme. ' +
                'Please disable the legacy extension to avoid conflicts.';
            log(msg);
            // Surface the warning in Main.notify so the user sees it on screen.
            Main.notify(
                'Adwaita Colors Home',
                'Conflict detected: please disable "auto-adwaita-colors" extension to avoid icon-theme conflicts.',
            );
        }
    }
}
