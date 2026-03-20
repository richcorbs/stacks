#!/bin/bash
set -e

# Gracefully quit first (triggers applicationWillTerminate), then force kill if needed
osascript -e 'quit app "stacks"' 2>/dev/null || true
sleep 1
pkill -9 -f stacks 2>/dev/null || true

APP_DIR="$HOME/Applications/Stacks.app"
CONTENTS="$APP_DIR/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"

# Build
echo "Building..."
cd "$(dirname "$0")/.."
zig build

# Create app bundle structure
mkdir -p "$MACOS" "$RESOURCES"

# Copy binary
cp zig-out/bin/stacks "$MACOS/stacks"

# Bundle libvterm so the app is self-contained
FRAMEWORKS="$CONTENTS/Frameworks"
mkdir -p "$FRAMEWORKS"
chmod u+w "$FRAMEWORKS/libvterm.0.dylib" 2>/dev/null || true
cp /opt/homebrew/opt/libvterm/lib/libvterm.0.dylib "$FRAMEWORKS/"
install_name_tool -change /opt/homebrew/opt/libvterm/lib/libvterm.0.dylib \
  @executable_path/../Frameworks/libvterm.0.dylib "$MACOS/stacks"

# Copy resources
cp resources/Info.plist "$CONTENTS/Info.plist"
cp resources/AppIcon.icns "$RESOURCES/AppIcon.icns"

# Clear icon cache so updates show
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP_DIR" 2>/dev/null || true

echo "Installed to $APP_DIR"
echo "Run: open $APP_DIR"
