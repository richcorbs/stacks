#!/usr/bin/env node
/**
 * Build the card #319 native global terminal helper and assemble it as a
 * nested app bundle inside Stacks' resources.
 *
 * The helper lives in `spikes/gpui-terminal` and links libghostty-vt through
 * `ghostty-vt-sys`, which builds Ghostty's VT library with Zig. That build is
 * deliberately not part of the normal Stacks build: flag-off builds must not
 * pay for it, and the spike must stay removable.
 *
 * Usage:
 *   node scripts/build-native-terminal.mjs [--debug] [--no-sign]
 *
 * Environment:
 *   STACKS_CODESIGN_IDENTITY   codesign identity for the nested app (default "-",
 *                              ad-hoc). Distribution builds must use the same
 *                              Developer ID as Stacks so notarization accepts it.
 *   CARGO_TARGET_DIR           respected; defaults to the workspace target/.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spikeDir = join(root, 'spikes/gpui-terminal');
const executable = 'StacksNativeTerminal';
const bundleName = `${executable}.app`;
const resourcesDir = join(root, 'src-tauri/resources/native-terminal');
const appBundle = join(resourcesDir, bundleName);
const debug = process.argv.includes('--debug');
const sign = !process.argv.includes('--no-sign');
const profile = debug ? 'debug' : 'release';
const cargoTarget = process.env.CARGO_TARGET_DIR
  ? resolve(root, process.env.CARGO_TARGET_DIR)
  : join(root, 'target');
const binary = join(cargoTarget, profile, 'stacks-gpui-terminal-spike');
const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`);
  return execFileSync(command, args, { stdio: 'inherit', ...options });
}

if (process.platform !== 'darwin') {
  console.error('The native global terminal helper is macOS-only in this spike.');
  process.exit(1);
}
if (!existsSync(join(spikeDir, 'Cargo.toml'))) {
  console.error(`Missing spike crate at ${spikeDir}`);
  process.exit(1);
}

console.log(`Building native terminal helper (${profile})…`);
run('cargo', ['build', '--manifest-path', join(spikeDir, 'Cargo.toml'), ...(debug ? [] : ['--release'])]);
if (!existsSync(binary)) {
  console.error(`Expected helper binary at ${binary}`);
  process.exit(1);
}

rmSync(appBundle, { recursive: true, force: true });
mkdirSync(join(appBundle, 'Contents/MacOS'), { recursive: true });
copyFileSync(binary, join(appBundle, 'Contents/MacOS', executable));

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>${executable}</string>
  <key>CFBundleIdentifier</key><string>com.richcorbs.stacks.native-terminal</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Stacks Native Terminal</string>
  <key>CFBundleDisplayName</key><string>Stacks Native Terminal</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${packageVersion}</string>
  <key>CFBundleVersion</key><string>${packageVersion}</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
`;
writeFileSync(join(appBundle, 'Contents/Info.plist'), infoPlist);
writeFileSync(
  join(appBundle, 'Contents/PkgInfo'),
  'APPL????',
);

if (sign) {
  const identity = process.env.STACKS_CODESIGN_IDENTITY ?? '-';
  console.log(`Signing nested helper app with identity "${identity}"…`);
  try {
    run('codesign', ['--force', '--sign', identity, '--timestamp=none', appBundle]);
    run('codesign', ['--verify', '--deep', '--strict', appBundle]);
  } catch (error) {
    console.error('codesign failed. The helper will not launch from a signed build.');
    throw error;
  }
}

console.log(`\nHelper bundle ready: ${appBundle}`);
console.log('Next: build Stacks with the native terminal config overlay:');
console.log('  npm run release:build:native-terminal');
console.log('or for a dev run:');
console.log('  STACKS_NATIVE_GLOBAL_TERMINAL=1 npm run tauri dev');
