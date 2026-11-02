import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ASSET_NAMES, writeChecksums } from './release-lib.mjs';
import { installDraftForTesting } from './release-local-test.mjs';
const dirs = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacks-local-test-')); dirs.push(root);
  const destination = path.join(root, 'Applications'); fs.mkdirSync(destination);
  const target = path.join(destination, 'Stacks.app'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'old'), 'old app');
  const out = path.join(root, 'release-artifacts/v1.2.4'); fs.mkdirSync(out, { recursive: true });
  const signature = Buffer.from('untrusted comment: test\nplaceholder\ntrusted comment: version:1.2.4\nplaceholder\n').toString('base64');
  for (const name of ASSET_NAMES.slice(0, -1)) fs.writeFileSync(path.join(out, name), name);
  fs.writeFileSync(path.join(out, 'Stacks.app.tar.gz.sig'), signature);
  fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify({ version: '1.2.4', platforms: { 'darwin-aarch64': { signature, url: 'https://github.com/richcorbs/stacks/releases/download/v1.2.4/Stacks.app.tar.gz' } } }));
  writeChecksums(out);
  const execute = vi.fn((command, args) => {
    if (command === 'tar') {
      const app = path.join(args[args.indexOf('-C') + 1], 'Stacks.app');
      fs.mkdirSync(path.join(app, 'Contents'), { recursive: true }); fs.writeFileSync(path.join(app, 'new'), 'new app');
    }
    if (command === '/usr/libexec/PlistBuddy') return args[1].includes('Version') ? '1.2.4' : 'com.richcorbs.stacks';
    return '';
  });
  return { root, destination, target, out, execute };
}
describe('optional signed draft installation', () => {
  it('authenticates the exact archive/version, stages and installs without stopping or opening the app', () => {
    const f = fixture(); installDraftForTesting(f.root, '1.2.4', f);
    expect(f.execute.mock.calls[0]).toEqual(['cargo', expect.arrayContaining(['local_release_artifact']), expect.objectContaining({ env: expect.objectContaining({ STACKS_TEST_RELEASE_VERSION: '1.2.4', STACKS_TEST_UPDATER_ARCHIVE: path.join(f.out, 'Stacks.app.tar.gz') }) })]);
    expect(f.execute.mock.calls.map(([command]) => command)).toEqual(['cargo', 'tar', '/usr/libexec/PlistBuddy', '/usr/libexec/PlistBuddy', 'codesign', '/usr/libexec/PlistBuddy']);
    expect(fs.readFileSync(path.join(f.target, 'new'), 'utf8')).toBe('new app');
    expect(fs.readdirSync(f.destination)).toEqual(['Stacks.app']);
  });
  it('does not modify the installed app if authentication, codesign, or version verification fails', () => {
    for (const failure of ['cargo', 'codesign', 'version']) {
      const f = fixture(); const original = f.execute.getMockImplementation();
      f.execute.mockImplementation((command, args, options) => {
        if (command === failure) throw new Error('verification failed');
        if (failure === 'version' && command === '/usr/libexec/PlistBuddy' && args[1].includes('Version')) return '9.0.0';
        return original(command, args, options);
      });
      expect(() => installDraftForTesting(f.root, '1.2.4', f)).toThrow();
      expect(fs.readFileSync(path.join(f.target, 'old'), 'utf8')).toBe('old app');
      expect(fs.readdirSync(f.destination)).toEqual(['Stacks.app']);
    }
  });
  it('rolls back bundle replacement if the final rename fails', () => {
    const f = fixture(); const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).includes('.stacks-draft-') && String(from).endsWith('/Stacks.app')) throw new Error('rename failed');
      rename(from, to);
    });
    expect(() => installDraftForTesting(f.root, '1.2.4', f)).toThrow('rename failed');
    expect(fs.readFileSync(path.join(f.target, 'old'), 'utf8')).toBe('old app');
  });
});
