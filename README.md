# Adwaita Colors Home

Official companion GNOME Shell extension for the [Adwaita Colors](https://github.com/dpejoh/Adwaita-colors) icon theme. Watches your GNOME accent color setting and switches the active icon theme variant (`Adwaita-blue`, `Adwaita-teal`, etc.) to match.

[![Screenshot 1](https://raw.githubusercontent.com/dpejoh/Adwaita-Colors-Home/main/Screenshots/01.png)](https://github.com/dpejoh/Adwaita-Colors-Home/blob/main/Screenshots/01.png)
[![Screenshot 2](https://raw.githubusercontent.com/dpejoh/Adwaita-Colors-Home/main/Screenshots/02.png)](https://github.com/dpejoh/Adwaita-Colors-Home/blob/main/Screenshots/02.png)

---

## Features

- **Auto-sync**: icon theme follows your GNOME accent color instantly (GNOME 47+)
- **Manual picker**: choose any of the 10 color variants when auto-sync is off
- **Install / Update**: download and install Adwaita Colors directly from GitHub, no terminal needed
- **Panel indicator**: optional colored dot in the top bar with a one-click color switcher
- **MoreWaita integration**: patch and unpatch `index.theme` files to insert MoreWaita into the inheritance chain

---

## Requirements

- GNOME Shell 47 or newer
- [Adwaita Colors](https://github.com/dpejoh/Adwaita-colors) icon theme (the extension can install it for you)

---

## Installation

Search for **Adwaita Colors Home** on [extensions.gnome.org](https://extensions.gnome.org), or install manually:

```bash
git clone https://github.com/dpejoh/Adwaita-Colors-Home
cp -r adwaita-colors-home@dpejoh ~/.local/share/gnome-shell/extensions/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/adwaita-colors-home@dpejoh/schemas/
gnome-extensions enable adwaita-colors-home@dpejoh
```

On Wayland, log out and back in after enabling.

---

## MoreWaita Integration

If [MoreWaita](https://github.com/somepaulo/MoreWaita) is installed, the **Installation** tab shows a section for patching. It inserts MoreWaita at the front of the inheritance chain in every Adwaita Colors `index.theme` file:

```
# Before
Inherits=Adwaita,AdwaitaLegacy,hicolor

# After
Inherits=MoreWaita,Adwaita,AdwaitaLegacy,hicolor
```

This means icons not covered by Adwaita Colors fall through to MoreWaita before reaching stock Adwaita. The patch is reversible from the same section. For themes installed under `/usr/share/icons` or `/var/usrlocal/share/icons`, the extension invokes `pkexec` automatically so you are not prompted to use a terminal.

If MoreWaita is not installed, the section shows a link to its repository instead.

---

## Conflict with `auto-adwaita-colors`

Running `auto-adwaita-colors@celiopy` alongside this extension causes both to write `org.gnome.desktop.interface icon-theme` on every accent color change, with unpredictable results. The extension detects this on startup and shows a notification. Disable the legacy extension to fix it.

---

## License

GPL-3.0-or-later

**Icon theme**: [Adwaita Colors](https://github.com/dpejoh/Adwaita-colors) by dpejoh