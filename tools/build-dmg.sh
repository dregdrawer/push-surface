#!/bin/bash
# Builds Push-Surface.dmg (Apple Silicon) on Linux: cross-compiles the native app with Zig, bundles the
# engine with macOS arm64 node modules, ad-hoc signs everything, and packs an HFS+ disk image.
#
# Needs: zig (pip install ziglang), rcodesign, and newfs_hfs (hfsprogs) + hfsplus/dmg (libdmg-hfsplus).
# Usage: RCODESIGN=… NEWFS_HFS=… HFSPLUS=… DMG=… tools/build-dmg.sh [outDir]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist}"
VERSION="$(node -p "require('$ROOT/package.json').version")"
WORK="$(mktemp -d)"
APP="$WORK/Push Surface.app"
mkdir -p "$OUT"

echo "• compiling native app (arm64)"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"
python3 -m ziglang cc -target aarch64-macos.12.0 -O2 -o "$APP/Contents/MacOS/Push Surface" "$ROOT/mac/main.c"

echo "• bundle"
sed "s/1\.2\.0/$VERSION/g" "$ROOT/mac/Info.plist" > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
cp "$ROOT/mac/AppIcon.icns" "$ROOT/ui/window.html" "$APP/Contents/Resources/"
A="$APP/Contents/Resources/app"
cp -R "$ROOT/src" "$ROOT/config.json" "$A/"
node -e "
const p = require('$ROOT/package.json');
require('fs').writeFileSync('$A/package.json', JSON.stringify({ name: 'push-surface', version: p.version, private: true, type: 'module', dependencies: p.dependencies }, null, 2));"
cp "$ROOT/package-lock.json" "$A/"

echo "• macOS arm64 node modules"
(cd "$A" && npm ci --omit=dev --os=darwin --cpu=arm64 --ignore-scripts --no-audit --no-fund --loglevel=error)
rm -f "$A/package-lock.json"
# keep only the macOS arm64 prebuilt binaries
find "$A/node_modules" -type d -path '*/prebuilds/*' -prune ! -name '*darwin-arm64*' -exec rm -rf {} +
find "$A/node_modules" -type f \( -name '*.md' -o -name '*.map' -o -name '*.d.ts' \) -delete

echo "• signing (ad-hoc)"
find "$A/node_modules" -type f -name '*.node' -print0 | while IFS= read -r -d '' f; do "$RCODESIGN" sign "$f" >/dev/null; done
"$RCODESIGN" sign --binary-identifier "com.gregdalmata.pushsurface" "$APP" >/dev/null

echo "• disk image"
STAGE="$WORK/dmg"; mkdir -p "$STAGE"
mv "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/Read me first.txt" <<'TXT'
Push Surface — Push 2 for disting NT

1. Drag "Push Surface" onto "Applications".
2. Open it from Applications. The first time, macOS says it can't verify the app
   (it isn't notarised by Apple): click Done, then open System Settings →
   Privacy & Security, scroll down, and click "Open Anyway" next to Push Surface.
   You only do this once.

Needs Node.js 20 or newer (brew install node).
Settings: ~/Library/Application Support/Push Surface/config.json
Log:      ~/Library/Logs/Push Surface.log
TXT
SIZE_MB=$(( $(du -sm "$STAGE" | cut -f1) + 20 ))
IMG="$WORK/pushsurface.hfs"
dd if=/dev/zero of="$IMG" bs=1M count="$SIZE_MB" status=none
"$NEWFS_HFS" -v "Push Surface" "$IMG" >/dev/null
"$HFSPLUS" "$IMG" addall "$STAGE" --symlinks clone_link >/dev/null
"$HFSPLUS" "$IMG" chmod 755 "/Push Surface.app/Contents/MacOS/Push Surface"
rm -f "$OUT/Push-Surface.dmg"
"$DMG" build "$IMG" "$OUT/Push-Surface.dmg" >/dev/null
rm -rf "$WORK"
ls -la "$OUT/Push-Surface.dmg"
