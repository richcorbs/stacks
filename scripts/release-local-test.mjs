import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, validateVersion, verifyArtifacts } from './release-lib.mjs';

// Install the exact draft, not a fresh build of a potentially newer checkout.
// Atomic bundle replacement leaves the running app alive until an explicit restart.
export function installDraftForTesting(root, version, { destination = path.join(os.homedir(), 'Applications'), execute = run } = {}) {
  validateVersion(version);
  const out = verifyArtifacts(root, version);
  const archive = path.join(out, 'Stacks.app.tar.gz');
  execute('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--test', 'updater_signatures', 'local_release_artifact', '--', '--ignored'], {
    cwd: root, capture: false,
    env: { ...process.env, STACKS_TEST_UPDATER_ARCHIVE: archive, STACKS_TEST_RELEASE_VERSION: version },
  });
  fs.mkdirSync(destination, { recursive: true });
  const staging = fs.mkdtempSync(path.join(destination, '.stacks-draft-'));
  const target = path.join(destination, 'Stacks.app');
  const staged = path.join(staging, 'Stacks.app');
  const backup = path.join(staging, 'previous.app');
  let movedPrevious = false;
  try {
    execute('tar', ['-xzf', archive, '-C', staging], { cwd: root });
    const info = path.join(staged, 'Contents', 'Info.plist');
    const bundleVersion = execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', info], { cwd: root }).trim();
    const bundleId = execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', info], { cwd: root }).trim();
    if (bundleVersion !== version || bundleId !== 'com.richcorbs.stacks') throw new Error('Draft app identity/version does not match the selected Stacks release');
    execute('codesign', ['--verify', '--deep', '--strict', staged], { cwd: root });
    if (fs.existsSync(target)) {
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Refusing to replace a symlinked Stacks.app');
      const currentId = execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(target, 'Contents', 'Info.plist')], { cwd: root }).trim();
      if (currentId !== bundleId) throw new Error('Existing installation is not Stacks; refusing to replace it');
      fs.renameSync(target, backup); movedPrevious = true;
    }
    try { fs.renameSync(staged, target); }
    catch (error) { if (movedPrevious) fs.renameSync(backup, target); throw error; }
    console.log(`Installed signed draft: ${target}\nThe running app was not stopped. Use RESTART TO TEST in Stacks when ready.`);
  } finally {
    // Preserve the previous bundle for recovery if rollback itself failed.
    if (!fs.existsSync(target) && movedPrevious) console.error(`Previous installation retained at ${backup}`);
    else fs.rmSync(staging, { recursive: true, force: true });
  }
}
