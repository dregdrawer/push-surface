#!/bin/bash
# Builds Push-Surface-Windows-x64.zip on Linux or macOS: an Electron window (win/) plus the engine (src/) with
# Windows x64 node modules and a bundled node.exe that runs it.
#
# Needs: the Electron win32-x64 zip and node.exe for Windows x64, downloaded and checked against their SHASUMS256.
# Usage: ELECTRON_ZIP=…/electron-v45.0.0-win32-x64.zip NODE_EXE=…/node.exe tools/build-win.sh [outDir]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist}"
VERSION="$(node -p "require('$ROOT/package.json').version")"
WORK="$(mktemp -d)"
APP="$WORK/Push Surface"
mkdir -p "$OUT"

echo "• electron"
mkdir -p "$APP" && (cd "$APP" && unzip -q "$ELECTRON_ZIP")
mv "$APP/electron.exe" "$APP/Push Surface.exe"
rm -f "$APP/resources/default_app.asar"
find "$APP/locales" -type f ! -name 'en-US.pak' -delete

echo "• app"
A="$APP/resources/app"
mkdir -p "$A/win" "$A/runtime"
cp -R "$ROOT/src" "$ROOT/ui" "$ROOT/config.json" "$A/"
cp "$ROOT/win/main.mjs" "$ROOT/win/preload.cjs" "$ROOT/win/AppIcon.ico" "$A/win/"
cp "$NODE_EXE" "$A/runtime/node.exe"
node -e "
const p = require('$ROOT/package.json');
require('fs').writeFileSync('$A/package.json', JSON.stringify({ name: 'push-surface', productName: 'Push Surface', version: p.version,
  description: p.description, private: true, type: 'module', main: 'win/main.mjs', dependencies: p.dependencies }, null, 2));"
cp "$ROOT/package-lock.json" "$A/"

echo "• Windows x64 node modules"
(cd "$A" && npm ci --omit=dev --os=win32 --cpu=x64 --ignore-scripts --no-audit --no-fund --loglevel=error)
rm -f "$A/package-lock.json"
find "$A/node_modules" -type d -path '*/prebuilds/*' -prune ! -name '*win32-x64*' -exec rm -rf {} +
find "$A/node_modules" -type f \( -name '*.md' -o -name '*.map' -o -name '*.d.ts' \) -delete

echo "• exe icon and version"
RE="$WORK/resedit"; mkdir -p "$RE"
(cd "$RE" && npm init -y >/dev/null && npm i resedit@2 pe-library@1 --no-audit --no-fund --loglevel=error >/dev/null)
cat > "$RE/stamp.mjs" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import * as PE from 'pe-library';
import * as ResEdit from 'resedit';
const [exe, ico, version] = process.argv.slice(2);
const pe = PE.NtExecutable.from(readFileSync(exe), { ignoreCert: true });
const r = ResEdit.NtExecutableResource.from(pe);
const icon = ResEdit.Data.IconFile.from(readFileSync(ico));
for (const g of ResEdit.Resource.IconGroupEntry.fromEntries(r.entries)) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(r.entries, g.id, g.lang, icon.icons.map((i) => i.data));
const vi = ResEdit.Resource.VersionInfo.fromEntries(r.entries)[0];
const [a, b, c] = version.split('.').map(Number);
vi.setFileVersion(a, b, c, 0, 1033); vi.setProductVersion(a, b, c, 0, 1033);
vi.setStringValues({ lang: 1033, codepage: 1200 }, {
  FileDescription: 'Push Surface', ProductName: 'Push Surface', InternalName: 'Push Surface', OriginalFilename: 'Push Surface.exe',
  CompanyName: 'gregdalmata', LegalCopyright: 'MIT licence', FileVersion: version, ProductVersion: version,
});
vi.outputToResourceEntries(r.entries);
r.outputResource(pe);
writeFileSync(exe, Buffer.from(pe.generate()));
JS
node "$RE/stamp.mjs" "$APP/Push Surface.exe" "$ROOT/win/AppIcon.ico" "$VERSION"
rm -rf "$RE"

cat > "$APP/Read me first.txt" <<'TXT'
Push Surface — Push 2 for disting NT (Windows x64)

1. Keep this whole folder together (e.g. move it to C:\Program Files or your Documents).
2. Double-click "Push Surface.exe". The first time, Windows SmartScreen may say it
   protected your PC (the app isn't signed): click "More info", then "Run anyway".
3. The Push screen needs the Push 2 display driver, which comes with Ableton Live.
   Without Live, install WinUSB for "Ableton Push 2" (interface 0) with Zadig.
4. Close Ableton Live first, or set its Push 2 control surface to None
   (the Manual tab in the app explains how).

Nothing else to install: the app brings its own runtime.
Settings: %APPDATA%\Push Surface\config.json
Log:      %APPDATA%\Push Surface\push-surface.log
TXT

echo "• zip"
rm -f "$OUT/Push-Surface-Windows-x64.zip"
(cd "$WORK" && zip -qr -9 "$OUT/Push-Surface-Windows-x64.zip" "Push Surface")
rm -rf "$WORK"
ls -la "$OUT/Push-Surface-Windows-x64.zip"
