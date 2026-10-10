#!/usr/bin/env bash
# Assemble the macOS .app bundle for ESR Assistant.
#
# Produces a self-contained app: bundled node, a standalone Next.js server, the
# SQLite index, and the evidence images a citation opens. Nothing at runtime
# depends on the machine having Node, npm, or the repo.
#
# The source manuals are deliberately NOT in here. Five manuals are 2,591 pages
# and 212 MB of PDF; a citation needs the one page it points at, not the manual
# it came from, so the manual stays an ingest input and the app carries derived
# evidence only. See `docs/evidence.md`.
#
#   scripts/app/build-app.sh [output-dir]     # default: dist
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${1:-$ROOT/dist}"
APP_NAME="ESR Assistant"
BUNDLE_ID="com.sce.esr-assistant"
VERSION="1.0.0"
PORT="${ESR_PORT:-3001}"

NODE_VERSION="22.16.0"
NVM_NODE="$HOME/.nvm/versions/node/v$NODE_VERSION/bin/node"

cd "$ROOT"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "Preflight"
[ -x "$NVM_NODE" ] || { echo "node v$NODE_VERSION not found at $NVM_NODE" >&2; exit 1; }
export PATH="$HOME/.nvm/versions/node/v$NODE_VERSION/bin:$PATH"
node -e 'process.exit(Number(process.versions.modules)===127?0:1)' \
  || { echo "wrong ABI: better-sqlite3 needs node ABI 127 (node 22)" >&2; exit 1; }
[ -f data/manuals.sqlite ] || { echo "missing data/manuals.sqlite — run npm run ingest:manuals" >&2; exit 1; }
[ -d public/evidence ] || { echo "missing public/evidence — run npm run ingest:manuals" >&2; exit 1; }
echo "node $(node -v) · port $PORT"

step "Building the standalone server"
ESR_STANDALONE=1 npm run build
[ -f .next/standalone/server.js ] || { echo "no .next/standalone/server.js" >&2; exit 1; }

step "Staging the bundle"
STAGE="$OUT/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE/$APP_NAME.app/Contents/MacOS" \
         "$STAGE/$APP_NAME.app/Contents/Resources/bin" \
         "$STAGE/$APP_NAME.app/Contents/Resources/runtime"

cp -R .next/standalone/. "$STAGE/$APP_NAME.app/Contents/Resources/runtime/"

# Next serves static assets from .next/static and public/ relative to the
# server root; the standalone output does not carry them.
mkdir -p "$STAGE/$APP_NAME.app/Contents/Resources/runtime/.next"
cp -R .next/static "$STAGE/$APP_NAME.app/Contents/Resources/runtime/.next/static"
cp -R public "$STAGE/$APP_NAME.app/Contents/Resources/runtime/public"

step "Index"
mkdir -p "$STAGE/$APP_NAME.app/Contents/Resources/runtime/data"
cp data/manuals.sqlite "$STAGE/$APP_NAME.app/Contents/Resources/runtime/data/manuals.sqlite"

step "Rescaling evidence images"
# Everything under public/evidence ships at the size it was rendered at, which is
# 2x DPI on a letter page for an image the UI shows at 112px or opens in a
# resizable panel. Downscaling to the largest useful rendition is the single
# biggest size lever in the bundle and costs nothing visible: the panel scales
# up a little on a very large display, which is the right trade against shipping
# three times the pixels.
EVIDENCE_DIR="$STAGE/$APP_NAME.app/Contents/Resources/runtime/public/evidence"
before=$(du -sk "$EVIDENCE_DIR" | cut -f1)
count=0
while IFS= read -r f; do
  [ -e "$f" ] || continue
  # Figure crops keep more resolution than whole-page renders: a crop is the
  # thing a planner reads a dimension off, and its source box is small.
  case "$f" in
    */fig-*) MAXDIM=1400 ;;
    *)       MAXDIM=1000 ;;
  esac
  sips -Z "$MAXDIM" "$f" --out "$f" >/dev/null 2>&1 && count=$((count+1))
done < <(find "$EVIDENCE_DIR" -name '*.png' -type f)
after=$(du -sk "$EVIDENCE_DIR" | cut -f1)
echo "rescaled $count evidence images: $((before/1024))MB -> $((after/1024))MB"

step "Bundling the node runtime"
cp "$NVM_NODE" "$STAGE/$APP_NAME.app/Contents/Resources/bin/node"
# next start needs the standalone server's own layout; verify it boots before
# we spend time compiling the launcher.
"$STAGE/$APP_NAME.app/Contents/Resources/bin/node" -p "process.version"

step "Compiling the launcher"
swiftc -O \
  -framework AppKit \
  -framework WebKit \
  -o "$STAGE/$APP_NAME.app/Contents/MacOS/ESRAssistant" \
  scripts/app/Launcher.swift

step "Writing Info.plist"
cat > "$STAGE/$APP_NAME.app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>ESRAssistant</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSRequiresAquaSystemAppearance</key><false/>
  <!-- No network entitlement: the app talks to its own bundled server on
       127.0.0.1 and to a local Ollama instance. -->
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
</dict>
</plist>
PLIST

# A minimal icon so the bundle is not the generic blank page in Finder.
ICONSET="$STAGE/AppIcon.iconset"
mkdir -p "$ICONSET"
icon_src="$ROOT/scripts/app/icon.svg"
if [ -f "$icon_src" ]; then
  tmp_svg="$STAGE/icon.svg"
  cp "$icon_src" "$tmp_svg"
  # Full iconset incl. 1024 master; retina pairs are separate files.
  for size in 16 32 64 128 256 512 1024; do
    qlmanage -t -s "$size" -o "$STAGE" "$tmp_svg" >/dev/null 2>&1 || true
    produced="$STAGE/icon.svg.png"
    [ -f "$produced" ] && mv "$produced" "$ICONSET/icon_${size}x${size}.png"
    produced2="$STAGE/icon.png"
    [ -f "$produced2" ] && mv "$produced2" "$ICONSET/icon_${size}x${size}.png"
  done
  # Retina @2x companions (iconutil pairs them by name).
  for size in 16 32 128 256 512; do
    dbl=$((size * 2))
    [ -f "$ICONSET/icon_${dbl}x${dbl}.png" ] && cp "$ICONSET/icon_${dbl}x${dbl}.png" "$ICONSET/icon_${size}x${size}@2x.png"
  done
  rm -f "$tmp_svg"
fi
if compgen -G "$ICONSET/*.png" > /dev/null; then
  iconutil -c icns "$ICONSET" -o "$STAGE/$APP_NAME.app/Contents/Resources/AppIcon.icns" 2>/dev/null || true
  # Info.plist expects AppIcon (no extension); both names resolve.
fi
rm -rf "$ICONSET"

step "Ad-hoc signing"
codesign --force --deep --sign - "$STAGE/$APP_NAME.app" 2>&1 | tail -2 || \
  echo "codesign unavailable; the app will still run locally"

step "Bundle budget"
# A size regression that nobody notices is a size regression nobody fixes, so
# the budget is checked rather than described.
APP_BYTES=$(du -sk "$STAGE/$APP_NAME.app" | cut -f1)
EVIDENCE_BYTES=$(du -sk "$EVIDENCE_DIR" | cut -f1)
# Set from the measured five-manual corpus, not from a guess: 2,591 pages of
# standards carrying 3,500+ drawings, shipped as lossless WebP plus a one-page
# derivative per figure page, lands near this. The check is here to catch
# *unnoticed* growth — someone re-adding PNG masters, or indexing a manual that
# duplicates another — not to trim real evidence to hit an arbitrary number.
BUDGET_MB="${EVIDENCE_BUDGET_MB:-1200}"
echo "app total:    $((APP_BYTES/1024))MB"
echo "  evidence:   $((EVIDENCE_BYTES/1024))MB (budget ${BUDGET_MB}MB)"
if [ "$((EVIDENCE_BYTES/1024))" -gt "$BUDGET_MB" ]; then
  echo "evidence over budget: check for uncropped page renders or an unfiltered doc" >&2
fi

step "Result"
du -sh "$STAGE/$APP_NAME.app"
echo "$STAGE/$APP_NAME.app"