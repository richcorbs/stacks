#!/usr/bin/env node
// Assemble a minimal one-bundle .app for the GPUI shell spike.
//
// A GPUI app is a single binary, so there is no nested helper, no inner/outer
// signing order, and no updater payload split. The bundle still has to be
// signed for distribution; this script only does the ad-hoc signing the repo's
// current Tauri builds use. Developer ID + notarization remain a release task.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, 'target');
const binary = path.join(targetDir, 'release/stacks-gpui');
const bundle = path.join(repoRoot, 'dist-gpui/Stacks GPUI Shell.app');
const executable = 'StacksGpuiShell';

if (!fs.existsSync(binary)) {
  console.error(`missing ${binary}; run: cargo build --release -p stacks-gpui`);
  process.exit(1);
}

fs.rmSync(path.join(repoRoot, 'dist-gpui'), { recursive: true, force: true });
fs.mkdirSync(path.join(bundle, 'Contents/MacOS'), { recursive: true });
fs.copyFileSync(binary, path.join(bundle, 'Contents/MacOS', executable));
fs.chmodSync(path.join(bundle, 'Contents/MacOS', executable), 0o755);

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Stacks GPUI Shell</string>
  <key>CFBundleDisplayName</key><string>Stacks GPUI Shell</string>
  <key>CFBundleExecutable</key><string>${executable}</string>
  <key>CFBundleIdentifier</key><string>com.richcorbs.stacks.gpui-spike</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
`;
fs.writeFileSync(path.join(bundle, 'Contents/Info.plist'), infoPlist);

const identity = process.env.STACKS_CODESIGN_IDENTITY || '-';
execFileSync('codesign', ['--force', '--deep', '--sign', identity, bundle], {
  stdio: 'inherit',
});
execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], {
  stdio: 'inherit',
});

const sizeMb = (target) => {
  const output = execFileSync('du', ['-sk', target], { encoding: 'utf8' });
  return Number(output.trim().split(/\s+/)[0]) / 1024;
};

console.log(
  JSON.stringify(
    {
      bundle,
      executable_mb: fs.statSync(path.join(bundle, 'Contents/MacOS', executable)).size / (1024 * 1024),
      bundle_mb: sizeMb(bundle),
      signing_identity: identity,
    },
    null,
    2,
  ),
);
