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
    default: 'Adwaita-blue',
};

const ICON_PATHS = [
    GLib.get_home_dir() + '/.local/share/icons',
    GLib.get_home_dir() + '/.icons',
    '/usr/local/share/icons',
    '/var/usr/local/share/icons',
    '/usr/share/icons',
];

const GITHUB_API_URL = 'https://api.github.com/repos/dpejoh/Adwaita-colors/releases/latest';
const UPDATE_CHECK_INTERVAL = 86400;

const PanelIndicator = GObject.registerClass(
class PanelIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Adwaita Colors');
        this._extension = extension;

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

    _repaintDot(area) {
        const cr = area.get_context();
        const hex = COLOR_META[this._extension.getCurrentColor()]?.hex ?? '#3584e4';
        cr.arc(7, 7, 6, 0, 2 * Math.PI);
        cr.setSourceRGB(
            parseInt(hex.slice(1, 3), 16) / 255,
            parseInt(hex.slice(3, 5), 16) / 255,
            parseInt(hex.slice(5, 7), 16) / 255
        );
        cr.fillPreserve();
        cr.setSourceRGBA(0, 0, 0, 0.3);
        cr.setLineWidth(1);
        cr.stroke();
        cr.$dispose();
    }

    _buildMenu() {
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
            btn.accessible_name = meta.label;
            layout.attach(btn, col, row, 1, 1);
            col++;
            if (col >= 5) { col = 0; row++; }
        }

        box.add_child(grid);

        const gridItem = new PopupMenu.PopupBaseMenuItem({ can_focus: false, reactive: false });
        gridItem.add_child(box);
        this.menu.addMenuItem(gridItem, 0);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settingsItem = new PopupMenu.PopupMenuItem('Open Settings');
        settingsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(settingsItem);
    }

    refresh() {
        this._dot.queue_repaint();
    }
});

export default class AdwaitaColorsHome extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._desktopSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._hasAccentColor = this._desktopSettings.settings_schema.has_key('accent-color');

        if (this._hasAccentColor) {
            this._accentChangedId = this._desktopSettings.connect(
                'changed::accent-color', () => this._syncIconTheme());
        }

        this._autoSyncChangedId = this._settings.connect(
            'changed::auto-sync', () => this._syncIconTheme());
        this._manualColorChangedId = this._settings.connect(
            'changed::manual-color', () => {
                this._syncIconTheme();
                this._indicator?.refresh();
            });
        this._showIndicatorChangedId = this._settings.connect(
            'changed::show-panel-indicator', () => {
                if (this._settings.get_boolean('show-panel-indicator'))
                    this._createIndicator();
                else
                    this._destroyIndicator();
            });

        this._syncIconTheme();

        if (this._settings.get_boolean('show-panel-indicator'))
            this._createIndicator();

        this._checkConflicts();
        this._maybeCheckForUpdates();
    }

    disable() {
        if (this._accentChangedId) {
            this._desktopSettings.disconnect(this._accentChangedId);
            this._accentChangedId = null;
        }

        this._settings.disconnect(this._autoSyncChangedId);
        this._settings.disconnect(this._manualColorChangedId);
        this._settings.disconnect(this._showIndicatorChangedId);

        this._destroyIndicator();

        if (this._soupSession) {
            this._soupSession.abort();
            this._soupSession = null;
        }

        this._settings = null;
        this._desktopSettings = null;
    }

    getCurrentColor() {
        if (this._settings.get_boolean('auto-sync') && this._hasAccentColor) {
            const accent = this._desktopSettings.get_string('accent-color');
            return accent === 'default' ? 'blue' : accent;
        }
        return this._settings.get_string('manual-color');
    }

    setManualColor(color) {
        this._settings.set_boolean('auto-sync', false);
        this._settings.set_string('manual-color', color);
        this._applyTheme('Adwaita-' + color);
    }

    _syncIconTheme() {
        if (this._settings.get_boolean('auto-sync')) {
            if (!this._hasAccentColor)
                return;
            const accent = this._desktopSettings.get_string('accent-color');
            this._applyTheme(ACCENT_TO_THEME[accent] ?? 'Adwaita-blue');
        } else {
            this._applyTheme('Adwaita-' + this._settings.get_string('manual-color'));
        }
    }

    _applyTheme(themeName) {
        if (!this._isThemeInstalled(themeName))
            return;

        const current = this._desktopSettings.get_string('icon-theme');

        if (!current.startsWith('Adwaita') && this._settings.get_boolean('auto-sync'))
            return;

        if (current !== themeName) {
            this._desktopSettings.set_string('icon-theme', themeName);
            this._indicator?.refresh();
        }
    }

    _isThemeInstalled(themeName) {
        return ICON_PATHS.some(base =>
            GLib.file_test(`${base}/${themeName}/index.theme`, GLib.FileTest.EXISTS));
    }

    _createIndicator() {
        if (this._indicator)
            return;
        this._indicator = new PanelIndicator(this);
        Main.panel.addToStatusArea('adwaita-colors-home', this._indicator);
    }

    _destroyIndicator() {
        this._indicator?.destroy();
        this._indicator = null;
    }

    _maybeCheckForUpdates() {
        const now = Math.floor(Date.now() / 1000);
        const lastCheck = Number(this._settings.get_int64('last-update-check'));

        if (now - lastCheck < UPDATE_CHECK_INTERVAL)
            return;

        this._soupSession = new Soup.Session();
        const msg = Soup.Message.new('GET', GITHUB_API_URL);
        msg.request_headers.append('User-Agent', 'adwaita-colors-home/1');

        this._soupSession.send_and_read_async(msg, GLib.PRIORITY_LOW, null, (session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                this._settings.set_int64('last-update-check', Math.floor(Date.now() / 1000));

                const installed = this._settings.get_string('installed-version');
                const skipped = this._settings.get_string('skipped-version');
                if (installed && json.tag_name && skipped !== json.tag_name &&
                    this._isNewerVersion(json.tag_name, installed)) {
                    // update available, surfaced in prefs status row
                }
            } catch (_) {}
            this._soupSession = null;
        });
    }

    _isNewerVersion(candidate, installed) {
        const parse = v => v.replace(/^v/, '').split('.').map(Number);
        const [ca, cb, cc] = parse(candidate);
        const [ia, ib, ic] = parse(installed);
        if (ca !== ia) return ca > ia;
        if (cb !== ib) return cb > ib;
        return cc > ic;
    }

    _checkConflicts() {
        const legacy = Main.extensionManager?.lookup('auto-adwaita-colors@celiopy');
        if (legacy?.state === 1) {
            Main.notify('Adwaita Colors Home',
                'Please disable "auto-adwaita-colors" to avoid icon theme conflicts.');
        }
    }
}
