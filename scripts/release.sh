#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(cat VERSION | tr -d '[:space:]')
ARCH=$(uname -m)

# Map architecture names
if [ "$ARCH" = "arm64" ]; then
    ZIP_NAME="Stacks-arm64.zip"
elif [ "$ARCH" = "x86_64" ]; then
    ZIP_NAME="Stacks-x86_64.zip"
else
    echo "Unknown architecture: $ARCH"
    exit 1
fi

echo "Building Stacks v${VERSION} for ${ARCH}..."

# Build
zig build

# Create .app bundle in dist/
APP_DIR="dist/Stacks.app/Contents/MacOS"
RESOURCES_DIR="dist/Stacks.app/Contents/Resources"
mkdir -p "$APP_DIR" "$RESOURCES_DIR"

# Copy binary
cp zig-out/bin/stacks "$APP_DIR/stacks"

# Copy icon
cp resources/AppIcon.icns "$RESOURCES_DIR/AppIcon.icns"

# Write Info.plist
cat > "dist/Stacks.app/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>stacks</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleIdentifier</key>
    <string>com.richcorbs.stacks</string>
    <key>CFBundleName</key>
    <string>Stacks</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSMinimumSystemVersion</key>
    <string>11.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSUIElement</key>
    <false/>
</dict>
</plist>
PLIST

# Zip it
cd dist
rm -f "${ZIP_NAME}"
zip -qr "${ZIP_NAME}" Stacks.app
rm -rf Stacks.app
cd ..

echo "Built dist/${ZIP_NAME} (v${VERSION})"
ls -lh "dist/${ZIP_NAME}"
