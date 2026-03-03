# Bug Report: Four Issues in Adwaita Colors Home Extension

## Overview
This document identifies four bugs in the Adwaita Colors Home GNOME Shell extension and provides implementation plans for fixing each issue.

---

## Issue 1: Typo in Icon Paths

### Description
There's a typo in the `ICON_PATHS` constant that causes the extension to check an incorrect system directory path.

### Location
- `extension.js` line 48
- `prefs.js` line 38

### Current Code
```javascript
const ICON_PATHS = [
    GLib.get_home_dir() + '/.local/share/icons',
    GLib.get_home_dir() + '/.icons',
    '/usr/local/share/icons',
    '/var/usrlocal/share/icons',  // ❌ Missing slash
    '/usr/share/icons',
];
```

### Expected Code
```javascript
'/var/usr/local/share/icons',  // ✅ Correct path
```

### Impact
- Low severity
- Themes installed in `/var/usr/local/share/icons` (atomic distros) won't be detected
- Users on Fedora Silverblue/Kinoite could be affected

### Fix Plan
1. Update `ICON_PATHS` in `extension.js` line 48
2. Update `ICON_PATHS` in `prefs.js` line 38  
3. Update `MOREWAITA_PATHS` in `prefs.js` line 46 (same typo)
4. Test theme detection on all paths

**Files to modify:**
- `extension.js`
- `prefs.js`

---

## Issue 2: Memory Leak in Update Check

### Description
The `_maybeCheckForUpdates()` method creates a Soup session that can complete its async callback after the extension is disabled, potentially accessing null references or causing memory leaks.

### Location
`extension.js` lines 252-278

### Problem Code
```javascript
_maybeCheckForUpdates() {
    // ...
    this._soupSession = new Soup.Session();
    const msg = Soup.Message.new('GET', GITHUB_API_URL);
    
    this._soupSession.send_and_read_async(msg, GLib.PRIORITY_LOW, null, (session, result) => {
        // This callback can fire AFTER disable() is called
        // At that point, this._settings and this._soupSession are null
        try {
            const bytes = session.send_and_read_finish(result);
            const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
            this._settings.set_int64('last-update-check', ...);  // ❌ Could be null
            // ...
        } catch (_) {}
        this._soupSession = null;  // ❌ Already null from disable()
    });
}
```

### Impact
- Medium severity
- Potential crash if callback executes after `disable()`
- Silent failures in error handling

### Fix Plan

**Option A: Guard the callback**
```javascript
this._soupSession.send_and_read_async(msg, GLib.PRIORITY_LOW, null, (session, result) => {
    // Check if extension is still enabled
    if (!this._settings || !this._soupSession)
        return;
    
    try {
        const bytes = session.send_and_read_finish(result);
        const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        this._settings.set_int64('last-update-check', Math.floor(Date.now() / 1000));
        // ... rest of logic
    } catch (_) {}
});
```

**Option B: Use Gio.Cancellable**
```javascript
_maybeCheckForUpdates() {
    // ...
    this._updateCancellable = new Gio.Cancellable();
    this._soupSession = new Soup.Session();
    const msg = Soup.Message.new('GET', GITHUB_API_URL);
    
    this._soupSession.send_and_read_async(msg, GLib.PRIORITY_LOW, this._updateCancellable, 
        (session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                // ... rest of logic
            } catch (_) {}
        });
}

disable() {
    // ...
    if (this._updateCancellable) {
        this._updateCancellable.cancel();
        this._updateCancellable = null;
    }
    
    if (this._soupSession) {
        this._soupSession.abort();
        this._soupSession = null;
    }
    // ...
}
```

**Recommended: Option B** - More robust, properly cancels pending operations

**Files to modify:**
- `extension.js`

---

## Issue 3: Missing Brown Color in Accent Mapping

### Description
The `ACCENT_TO_THEME` mapping object doesn't include `brown`, even though it's listed in `ALL_COLORS` and `COLOR_META`. This creates an inconsistency where brown can be manually selected but isn't mapped from the system accent color.

### Location
`extension.js` lines 31-42

### Current Code
```javascript
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
    // ❌ brown is missing
};
```

### Impact
- Low severity
- Brown accent color from GNOME settings won't map to brown icon theme
- Inconsistency in supported colors vs mappings

### Fix Plan

**Investigation needed:**
1. Check if GNOME 47+ actually supports `accent-color: 'brown'`
2. Verify `Adwaita-brown` theme exists in Adwaita Colors package

**If brown is a valid accent color:**
```javascript
const ACCENT_TO_THEME = {
    blue:    'Adwaita-blue',
    brown:   'Adwaita-brown',  // ✅ Add this
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
```

**If brown is NOT a valid GNOME accent color:**
- Document this limitation in comments
- Consider removing brown from manual picker or adding UI note

**Files to modify:**
- `extension.js` (potentially)
- Add documentation comment explaining the limitation

---

## Issue 4: Race Condition on Enable

### Description
When the extension is enabled, `_syncIconTheme()` is called before checking if themes are installed, then the panel indicator is created. If themes aren't installed, the sync silently fails but the indicator still displays, showing a color that doesn't match the actual active theme.

### Location
`extension.js` lines 165-168

### Problem Flow
```javascript
enable() {
    // ... setup signals ...
    
    this._syncIconTheme();  // Line 165: Silently fails if themes not installed
    
    if (this._settings.get_boolean('show-panel-indicator'))
        this._createIndicator();  // Line 168: Shows indicator anyway
    
    this._checkConflicts();
    this._maybeCheckForUpdates();
}

_syncIconTheme() {
    // ...
    this._applyTheme(themeName);  // Calls _applyTheme
}

_applyTheme(themeName) {
    if (!this._isThemeInstalled(themeName))
        return;  // ❌ Silent early return - indicator doesn't know
    // ...
}
```

### Impact
- Medium severity
- Misleading UI: indicator shows wrong color
- No user feedback about missing themes
- Can confuse users about why colors aren't changing

### Fix Plan

**Option A: Check installation in enable()**
```javascript
enable() {
    this._settings = this.getSettings();
    this._desktopSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
    this._hasAccentColor = this._desktopSettings.settings_schema.has_key('accent-color');
    
    // Check if any themes are installed
    const anyInstalled = ALL_COLORS.some(color => 
        this._isThemeInstalled(`Adwaita-${color}`)
    );
    
    if (!anyInstalled) {
        Main.notify('Adwaita Colors Home',
            'No Adwaita Colors themes detected. Please install them from Settings.');
    }
    
    // ... rest of enable() ...
}
```

**Option B: Return status from _applyTheme()**
```javascript
_applyTheme(themeName) {
    if (!this._isThemeInstalled(themeName)) {
        log(`[Adwaita Colors Home] Theme not installed: ${themeName}`);
        return false;
    }
    // ... rest of logic ...
    return true;
}

_syncIconTheme() {
    let themeName;
    if (this._settings.get_boolean('auto-sync')) {
        // ...
        themeName = ACCENT_TO_THEME[accent] ?? 'Adwaita-blue';
    } else {
        themeName = 'Adwaita-' + this._settings.get_string('manual-color');
    }
    
    const success = this._applyTheme(themeName);
    if (!success && this._indicator) {
        // Could add visual indication that theme is missing
    }
}
```

**Option C: Lazy indicator creation**
```javascript
_createIndicator() {
    if (this._indicator)
        return;
    
    // Only create if at least one theme is installed
    const currentColor = this.getCurrentColor();
    if (!this._isThemeInstalled(`Adwaita-${currentColor}`)) {
        log('[Adwaita Colors Home] Skipping indicator creation - themes not installed');
        return;
    }
    
    this._indicator = new PanelIndicator(this);
    Main.panel.addToStatusArea('adwaita-colors-home', this._indicator);
}
```

**Recommended: Combination of A + B**
- Notify user on enable if no themes found
- Log warnings when themes are missing
- Ensures indicator reflects actual state

**Files to modify:**
- `extension.js`

---

## Testing Plan

### Test 1: Path Typo Fix
1. Create dummy `index.theme` files in all icon paths including `/var/usr/local/share/icons`
2. Verify extension detects themes in corrected path
3. Test on atomic distro if available

### Test 2: Memory Leak Fix
1. Enable extension and wait a few seconds for update check to start
2. Immediately disable extension before callback completes
3. Check for errors in `journalctl -f -o cat /usr/bin/gnome-shell`
4. Repeat 10 times to ensure no crashes

### Test 3: Brown Color
1. Check GNOME Settings accent color options
2. Verify brown theme exists in Adwaita Colors
3. Test manual brown selection works
4. Document findings

### Test 4: Race Condition Fix
1. Uninstall all Adwaita Colors themes
2. Enable extension with panel indicator enabled
3. Verify user notification appears
4. Check indicator doesn't show wrong color
5. Install themes and verify normal operation resumes

---

## Priority Ranking

1. **High Priority**: Issue 2 (Memory Leak) - Can cause crashes
2. **Medium Priority**: Issue 4 (Race Condition) - Bad UX, misleading UI
3. **Low Priority**: Issue 1 (Path Typo) - Only affects specific distros
4. **Low Priority**: Issue 3 (Brown Color) - Minor inconsistency, needs investigation

---

## Additional Notes

- All fixes should maintain backwards compatibility with GNOME Shell 47-50
- Changes should be tested with both auto-sync enabled and disabled
- Consider adding debug logging for troubleshooting
- Update README.md if any user-facing behavior changes
