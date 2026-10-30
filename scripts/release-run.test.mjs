import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseReleaseArgs, runRelease } from './release-run.mjs';
const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacks-release-run-')); dirs.push(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(root, 'file'), 'test'); git('add', '.'); git('commit', '-m', 'initial');
  const calls = []; const output = [];
  const execute = (stage, args = []) => { calls.push([stage, args]); if (stage === 'current') return '1.2.3'; if (stage === 'notes') return '# Notes\n'; return ''; };
  return { root, mode: 'draft', version: '1.2.4', execute, approve: async () => true, log: (text) => output.push(text), calls, output };
}
describe('terminal release entry point', () => {
  it('accepts the explicit or environment version, rejects malformed input and modes', () => {
    expect(parseReleaseArgs(['draft'], { STACKS_RELEASE_VERSION: '1.2.4' })).toEqual({ mode: 'draft', version: '1.2.4' });
    expect(parseReleaseArgs(['publish', '--version', '2.0.0'], {})).toEqual({ mode: 'publish', version: '2.0.0' });
    for (const args of [['draft', '--version', '1.2.3; touch /tmp/no'], ['publish', '--yes'], ['delete']]) expect(() => parseReleaseArgs(args, {})).toThrow();
  });
  it('creates only a draft with clear phase output and documented next steps', async () => {
    const f = fixture(); await runRelease(f);
    expect(f.calls.map(([stage]) => stage)).toEqual(['current', 'validate', 'notes', 'preflight', 'preflight', 'prepare', 'verify-prepare', 'verify-build', 'verify-build', 'draft', 'verify-draft']);
    expect(f.output.join('\n')).toContain('Nothing was published as latest');
    expect(f.output.join('\n')).toContain('Push release commit/tag');
    expect(f.output.join('\n')).toContain('publish --version 1.2.4');
    expect(fs.existsSync(path.join(f.root, '.git/stacks-release.lock'))).toBe(false);
  });
  it('streams validation/build through the helper if signed artifacts are not yet valid', async () => {
    const f = fixture(); const execute = f.execute; let first = true;
    f.execute = (stage, args, capture) => { if (stage === 'verify-build' && first) { first = false; throw new Error('not built'); } return execute(stage, args, capture); };
    await runRelease(f);
    expect(f.calls.map(([stage]) => stage)).toContain('build');
    expect(f.output.join('\n')).toContain('Test, validate, build and sign updater artifacts');
  });
  it('stops on failure, reports the phase and removes its lock without publishing', async () => {
    const f = fixture(); const execute = f.execute;
    f.execute = (stage, args) => { if (stage === 'draft') throw new Error('Upload failed'); return execute(stage, args); };
    await expect(runRelease(f)).rejects.toThrow('Upload failed');
    expect(f.output.join('\n')).toContain('FAILED during Push release commit/tag');
    expect(f.calls.map(([stage]) => stage)).not.toContain('publish');
    expect(fs.existsSync(path.join(f.root, '.git/stacks-release.lock'))).toBe(false);
  });
  it('requires explicit approval before invoking publication and retains exact-CI helper gate', async () => {
    const f = fixture(); await runRelease(f); f.calls.length = 0; f.mode = 'publish'; f.approve = async () => false;
    await expect(runRelease(f)).rejects.toThrow('cancelled'); expect(f.calls).toEqual([]);
    f.approve = async () => true; await runRelease(f);
    expect(f.calls.map(([stage]) => stage)).toEqual(['verify-prepare', 'verify-build', 'verify-draft', 'publish', 'verify-publish']);
    expect(f.calls.find(([stage]) => stage === 'publish')[1]).toContain('.github/workflows/ci.yml');
    expect(f.output.join('\n')).toContain('published and verified as latest');
  });
  it('blocks concurrent CLI/app releases without removing another runner’s lock', async () => {
    const f = fixture(); const lock = path.join(f.root, '.git/stacks-release.lock'); fs.mkdirSync(lock);
    await expect(runRelease(f)).rejects.toThrow('Another release may be running');
    expect(f.calls).toEqual([]); expect(fs.existsSync(lock)).toBe(true);
  });
});
