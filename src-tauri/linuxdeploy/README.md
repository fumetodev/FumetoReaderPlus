# Vendored linuxdeploy GTK plugin

`linuxdeploy-plugin-gtk.sh` is the helper the Tauri bundler runs while it
packs the Linux AppImage. It copies GTK's themes, schemas and modules into
the AppDir and writes a small start-up hook that points GTK at them.

## Why it is vendored

The bundler only downloads the plugin when `~/.cache/tauri/` does not already
hold one, and it downloads whatever the upstream `master` branch serves that
day. Two things follow:

- A release could silently change behaviour between two builds of the same
  commit, because the script came from a moving branch. The copy here pins
  one reviewed revision (recorded in the file's header).
- The upstream hook forces `GDK_BACKEND=x11`, so the AppImage always runs as
  an X11 (XWayland) client and a user who sets `GDK_BACKEND=wayland` is
  overridden. The copy here keeps x11 as the default but leaves an explicit
  choice alone. That is the only difference from upstream; Wayland remains an
  unsupported opt-in.

## How it is used

The bundler looks for the plugin in its cache directory, so the copy has to
be put there before `tauri build` runs:

```bash
mkdir -p ~/.cache/tauri
cp src-tauri/linuxdeploy/linuxdeploy-plugin-gtk.sh ~/.cache/tauri/
```

The Linux release script and the CI job both do this step. When the cache
already holds the file, the bundler logs no download for it, and the
extracted AppImage's `apprun-hooks/linuxdeploy-plugin-gtk.sh` contains the
`${GDK_BACKEND:-x11}` line.

## Updating

Fetch the current upstream script, diff it against this copy, re-apply the
one-line `GDK_BACKEND` change, and update the commit and date in the header.
Keep the file executable.
