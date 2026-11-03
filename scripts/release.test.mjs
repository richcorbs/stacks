import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ASSET_NAMES, ciRunInfo, formatDuration, ghJson, latestPublished, matchingDraft, missingReleaseAssets,
  pollForCiSuccess, prepare, reconcileRelease, releaseNotes, reportCiStatus, requiredCiRun, suggestPatch, uploadReleaseAsset,
  validateReleaseVersion, validateVersion, verifyArtifacts, verifyPrepared, verifyReleaseAssets, verifyReleaseRevision,
  verifySignatureVersion, verifyVersions, writeChecksums, releaseState,
} from './release-lib.mjs';

const temporary = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacks-release-')); temporary.push(dir); return dir; }
function run(cwd, command, args) { return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim(); }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function repository() {
  const root = temp();
  run(root, 'git', ['init', '-b', 'main']); run(root, 'git', ['config', 'user.email', 'test@example.com']); run(root, 'git', ['config', 'user.name', 'Release Test']);
  fs.writeFileSync(path.join(root, '.gitignore'), 'release-artifacts/\n');
  writeJson(path.join(root, 'package.json'), { name: 'stacks', version: '1.2.3' });
  writeJson(path.join(root, 'package-lock.json'), { name: 'stacks', version: '1.2.3', packages: { '': { name: 'stacks', version: '1.2.3' } } });
  writeJson(path.join(root, 'src-tauri/tauri.conf.json'), { version: '1.2.3' });
  fs.writeFileSync(path.join(root, 'src-tauri/Cargo.toml'), '[package]\nname = "stacks"\nversion = "1.2.3"\n');
  fs.writeFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'version = 4\n\n[[package]]\nname = "stacks"\nversion = "1.2.3"\n');
  run(root, 'git', ['add', '.']); run(root, 'git', ['commit', '-m', 'Initial release']); run(root, 'git', ['tag', 'v1.2.3']);
  return root;
}
function fakeGh(root, response) {
  const bin = path.join(root, 'gh');
  fs.writeFileSync(bin, `#!/bin/sh\nif [ -n "$CALLS" ]; then printf '%s\\n' "$@" > "$CALLS"; fi\nprintf '%s\\n' '${JSON.stringify(response).replaceAll("'", "'\\''")}'\n`); fs.chmodSync(bin, 0o755); return bin;
}
function fakeGhResponses(root, responses) {
  const stateFile = path.join(root, 'gh-state');
  fs.writeFileSync(stateFile, '0');
  const bin = path.join(root, 'gh');
  const script = `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst stateFile = ${JSON.stringify(stateFile)};\nconst responses = ${JSON.stringify(responses)};\nlet index = Number(fs.readFileSync(stateFile, 'utf8'));\nfs.writeFileSync(stateFile, String(index + 1));\nprocess.stdout.write(JSON.stringify(responses[Math.min(index, responses.length - 1)]) + '\\n');\n`;
  fs.writeFileSync(bin, script); fs.chmodSync(bin, 0o755); return bin;
}
function artifacts(root, version = '1.2.4') {
  const out = path.join(root, 'release-artifacts', `v${version}`); fs.mkdirSync(out, { recursive: true });
  for (const name of ASSET_NAMES.slice(0, -2)) fs.writeFileSync(path.join(out, name), `${name} contents`);
  const signature = signatureWithComment(`timestamp:1\tfile:Stacks.app.tar.gz\tversion:${version}`);
  fs.writeFileSync(path.join(out, 'Stacks.app.tar.gz.sig'), signature);
  fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify({ version, platforms: { 'darwin-aarch64': { signature, url: `https://github.com/richcorbs/stacks/releases/download/v${version}/Stacks.app.tar.gz` } } }));
  writeChecksums(out); return out;
}

// Deliberately non-cryptographic fixtures: native Rust tests cover authentication.
function signatureWithComment(comment) {
  return Buffer.from(`untrusted comment: test\nplaceholder\ntrusted comment: ${comment}\nplaceholder\n`).toString('base64');
}

describe('release tab state discovery', () => {
  const draft = (version) => ({ tag_name: `v${version}`, draft: true, prerelease: false, assets: ASSET_NAMES.map(name => ({ name, state: 'uploaded' })) });
  it('discovers the newest stable draft, or checks the explicitly selected version', () => {
    const releases = [draft('1.2.9'), draft('1.2.10'), { ...draft('9.0.0'), prerelease: true }];
    expect(releaseState(releases)).toEqual({ version: '1.2.10', draftReady: true, published: false });
    expect(releaseState(releases, '1.2.9').draftReady).toBe(true);
    expect(releaseState(releases, '1.2.11')).toEqual({ version: '1.2.11', draftReady: false, published: false });
    expect(releaseState([])).toEqual({ version: null, draftReady: false, published: false });
    expect(releaseState([{ ...draft('1.2.9'), draft: false }], '1.2.9')).toEqual({ version: '1.2.9', draftReady: false, published: true });
  });
  it('does not offer publishing for incomplete, duplicate, prerelease, or uploading drafts', () => {
    const ready = draft('1.2.4');
    for (const changed of [
      { ...ready, assets: ready.assets.slice(1) },
      { ...ready, assets: [...ready.assets, { name: 'extra' }] },
      { ...ready, assets: ready.assets.map((a, i) => i ? a : { ...a, state: 'uploading' }) },
      { ...ready, prerelease: true },
    ]) expect(releaseState([changed], '1.2.4').draftReady).toBe(false);
    expect(() => releaseState([ready, ready], '1.2.4')).toThrow(/Multiple/);
    expect(() => releaseState([], 'invalid')).toThrow();
  });
});

describe('signed updater version packaging gate', () => {
  it('accepts matching metadata and rejects missing, mismatched, duplicate, or malformed metadata', () => {
    expect(() => verifySignatureVersion(signatureWithComment('timestamp:1\tversion:1.2.4'), '1.2.4')).not.toThrow();
    for (const comment of ['timestamp:1', 'version:1.2.3', 'file:version:1.2.4', 'version:1.2.4\tversion:1.2.4']) {
      expect(() => verifySignatureVersion(signatureWithComment(comment), '1.2.4')).toThrow(/exactly one/);
    }
    expect(() => verifySignatureVersion('invalid', '1.2.4')).toThrow(/Malformed/);
  });
  it('rejects an incompatible release even with regenerated checksums and matching manifest/signature files', () => {
    const root = temp(); const out = artifacts(root);
    for (const comment of ['timestamp:1', 'version:1.2.3']) {
      const signature = signatureWithComment(comment);
      fs.writeFileSync(path.join(out, 'Stacks.app.tar.gz.sig'), signature);
      const manifest = JSON.parse(fs.readFileSync(path.join(out, 'latest.json'), 'utf8'));
      manifest.platforms['darwin-aarch64'].signature = signature;
      writeJson(path.join(out, 'latest.json'), manifest); writeChecksums(out);
      expect(() => verifyArtifacts(root, '1.2.4')).toThrow(/exactly one/);
      expect(() => run(root, 'node', [path.resolve('scripts/create-update-manifest.mjs'), path.join(out, 'Stacks.app.tar.gz'), path.join(out, 'Stacks.app.tar.gz.sig'), path.join(out, 'generated.json'), '--version', '1.2.4'])).toThrow();
      expect(fs.existsSync(path.join(out, 'generated.json'))).toBe(false);
    }
  });
});

describe('release version discovery and validation', () => {
  it('discovers only the latest published stable GitHub release and suggests its next patch', () => {
    const root = temp(); const gh = fakeGh(root, { tag_name: 'v2.7.9', draft: false, prerelease: false });
    expect(latestPublished({ gh })).toBe('2.7.9'); expect(suggestPatch('2.7.9')).toBe('2.7.10');
  });
  it('accepts any higher stable SemVer for patch, minor, major, or skipped releases', () => {
    for (const value of ['0.5.10', '0.6.0', '1.0.0', '4.12.37']) expect(validateReleaseVersion(value, '0.5.9')).toBe(value);
  });
  it('rejects equal, older, malformed, and non-published versions', () => {
    for (const value of ['0.5.9', '0.5.8', '0.4.99']) expect(() => validateReleaseVersion(value, '0.5.9')).toThrow(/must be greater/);
    for (const value of ['v1.2.3', '1.2', '01.2.3', '1.2.3-beta']) expect(() => validateVersion(value)).toThrow();
    const root = temp(); const gh = fakeGh(root, { tag_name: 'v1.2.3', draft: true, prerelease: false });
    expect(() => latestPublished({ gh })).toThrow(/published stable/);
  });
});

describe('exact-commit release CI gate', () => {
  const revision = 'ce556e35cef9ffcb7352ba3d48d5db42937bcdeb';
  it('queries GitHub by workflow filename for a configured path and exact commit', () => {
    const root = temp(); const calls = path.join(root, 'calls');
    const gh = fakeGh(root, { workflow_runs: [
      { head_sha: 'other', status: 'completed', conclusion: 'success', run_number: 9 },
      { head_sha: revision, status: 'completed', conclusion: 'success', run_number: 8 },
    ] });
    expect(requiredCiRun('.github/workflows/ci.yml', revision, { gh, env: { ...process.env, CALLS: calls } }).head_sha).toBe(revision);
    expect(fs.readFileSync(calls, 'utf8')).toBe(`api\nrepos/{owner}/{repo}/actions/workflows/ci.yml/runs?head_sha=${revision}&per_page=100\n`);
    expect(requiredCiRun('ci.yml', revision, { gh }).conclusion).toBe('success');
  });
  it('fails closed on missing or invalid workflow configuration and non-successful latest exact-SHA runs', () => {
    const root = temp();
    expect(() => requiredCiRun('', revision)).toThrow(/not configured/);
    for (const value of ['.github/workflows/', 'other/ci.yml', '.github/workflows/../ci.yml'])
      expect(() => requiredCiRun(value, revision)).toThrow(/Invalid required CI workflow path/);
    const gh = fakeGh(root, { workflow_runs: [
      { head_sha: revision, status: 'completed', conclusion: 'success', run_number: 1 },
      { head_sha: revision, status: 'in_progress', conclusion: null, run_number: 2 },
    ] });
    expect(() => requiredCiRun('.github/workflows/ci.yml', revision, { gh })).toThrow(/not successful: status in_progress/);
    expect(() => requiredCiRun('ci.yml', 'other', { gh })).toThrow(/no run found/);
  });
});

describe('exact-commit CI status and publish polling', () => {
  const revision = 'ce556e35cef9ffcb7352ba3d48d5db42937bcdeb';
  it('classifies CI runs into success, failed, pending, and missing states', () => {
    expect(ciRunInfo(null)).toMatchObject({ state: 'missing', summary: 'no run found', success: false, failed: false });
    expect(ciRunInfo({ status: 'completed', conclusion: 'success' })).toMatchObject({ state: 'success', success: true });
    expect(ciRunInfo({ status: 'completed', conclusion: 'failure' })).toMatchObject({ state: 'failed', failed: true });
    expect(ciRunInfo({ status: 'completed', conclusion: 'cancelled' })).toMatchObject({ state: 'failed', failed: true });
    expect(ciRunInfo({ status: 'in_progress', conclusion: null })).toMatchObject({ state: 'pending', pending: true });
    expect(formatDuration(0)).toBe('0m 00s');
    expect(formatDuration(15 * 60 * 1000)).toBe('15m 00s');
    expect(formatDuration(880000)).toBe('14m 40s');
  });
  it('reports exact-commit CI status and run link after draft verification without blocking it', () => {
    const root = temp();
    const run = { head_sha: revision, status: 'completed', conclusion: 'failure', html_url: 'https://github.com/richcorbs/stacks/actions/runs/42' };
    const logs = [];
    const info = reportCiStatus('ci.yml', revision, { gh: fakeGh(root, { workflow_runs: [run] }), log: (message) => logs.push(message) });
    expect(info.state).toBe('failed');
    expect(logs.join('\n')).toContain('FAILED');
    expect(logs.join('\n')).toContain('https://github.com/richcorbs/stacks/actions/runs/42');
    logs.length = 0;
    reportCiStatus('ci.yml', revision, { gh: fakeGh(root, { workflow_runs: [{ ...run, status: 'completed', conclusion: 'success' }] }), log: (message) => logs.push(message) });
    expect(logs[0]).toContain('passed');
    logs.length = 0;
    reportCiStatus('ci.yml', revision, { gh: fakeGh(root, { workflow_runs: [{ ...run, status: 'in_progress', conclusion: null }] }), log: (message) => logs.push(message) });
    expect(logs[0]).toContain('pending');
    logs.length = 0;
    reportCiStatus('ci.yml', 'other', { gh: fakeGh(root, { workflow_runs: [run] }), log: (message) => logs.push(message) });
    expect(logs[0]).toContain('no run found');
    logs.length = 0;
    reportCiStatus('', revision, { gh: fakeGh(root, { workflow_runs: [run] }), log: (message) => logs.push(message) });
    expect(logs[0]).toContain('could not determine status');
  });
  it('publishes immediately when exact-commit CI already passed', async () => {
    const root = temp(); const logs = [];
    const gh = fakeGh(root, { workflow_runs: [{ head_sha: revision, status: 'completed', conclusion: 'success', html_url: 'https://example.test/runs/ok' }] });
    const run = await pollForCiSuccess('ci.yml', revision, { gh, now: () => 0, sleep: async () => {}, log: (message) => logs.push(message) });
    expect(run.conclusion).toBe('success');
    expect(logs.join('\n')).toContain('passed');
  });
  it('fails fast with the run link when exact-commit CI has already failed', async () => {
    const root = temp();
    const gh = fakeGh(root, { workflow_runs: [{ head_sha: revision, status: 'completed', conclusion: 'failure', html_url: 'https://example.test/runs/fail' }] });
    await expect(pollForCiSuccess('ci.yml', revision, { gh, now: () => 0, sleep: async () => {} })).rejects.toThrow(/failed: status completed, conclusion failure/);
  });
  it('polls a pending run, prints live status, and publishes as soon as it passes', async () => {
    const root = temp();
    const run = { head_sha: revision, status: 'in_progress', conclusion: null, html_url: 'https://example.test/runs/live', run_number: 1 };
    const gh = fakeGhResponses(root, [
      { workflow_runs: [run] },
      { workflow_runs: [run] },
      { workflow_runs: [{ ...run, status: 'completed', conclusion: 'success' }] },
    ]);
    let currentTime = 0; const sleeps = []; const logs = [];
    const result = await pollForCiSuccess('ci.yml', revision, {
      gh, now: () => currentTime, sleep: async (ms) => { sleeps.push(ms); currentTime += ms; }, log: (message) => logs.push(message), intervalMs: 20_000,
    });
    expect(result.conclusion).toBe('success');
    expect(sleeps).toEqual([20_000, 20_000]);
    expect(logs).toHaveLength(3);
    expect(logs[0]).toContain('15m 00s');
    expect(logs[1]).toContain('14m 40s');
    expect(logs[2]).toContain('passed');
  });
  it('fails after the polling bound with a still-in-progress message and run link', async () => {
    const root = temp();
    const run = { head_sha: revision, status: 'in_progress', conclusion: null, html_url: 'https://example.test/runs/stuck', run_number: 1 };
    const gh = fakeGhResponses(root, [{ workflow_runs: [run] }]);
    let currentTime = 0; const sleeps = []; const logs = [];
    await expect(pollForCiSuccess('ci.yml', revision, {
      gh, now: () => currentTime, sleep: async (ms) => { sleeps.push(ms); currentTime += ms; }, log: (message) => logs.push(message), timeoutMs: 60_000, intervalMs: 20_000,
    })).rejects.toThrow(/still in progress after 1m 00s.*https:\/\/example\.test\/runs\/stuck/);
    expect(sleeps).toEqual([20_000, 20_000, 20_000]);
    expect(logs).toHaveLength(3);
  });
});

describe('deterministic release notes', () => {
  it('uses the fixed previous-tag-to-source range, oldest first, excluding merges', () => {
    const root = repository(); fs.writeFileSync(path.join(root, 'a'), 'a'); run(root, 'git', ['add', '.']); run(root, 'git', ['commit', '-m', 'Add alpha']);
    fs.writeFileSync(path.join(root, 'b'), 'b'); run(root, 'git', ['add', '.']); run(root, 'git', ['commit', '-m', 'Fix beta']); const source = run(root, 'git', ['rev-parse', 'HEAD']);
    expect(releaseNotes(root, '1.2.3', source)).toBe('## Changes since v1.2.3\n\n- Add alpha\n- Fix beta\n');
    fs.writeFileSync(path.join(root, 'c'), 'c'); run(root, 'git', ['add', '.']); run(root, 'git', ['commit', '-m', 'Later change']);
    expect(releaseNotes(root, '1.2.3', source)).not.toContain('Later change');
  });
});

describe('prepare and artifact postconditions', () => {
  it('prepares once, verifies exact state, and safely recognizes a retry', () => {
    const root = repository(); const source = run(root, 'git', ['rev-parse', 'HEAD']); const notes = path.join(temp(), 'notes.md'); fs.writeFileSync(notes, '# Approved\n');
    prepare(root, { version: '1.2.4', notesFile: notes, source }); const prepared = run(root, 'git', ['rev-parse', 'HEAD']);
    verifyPrepared(root, { version: '1.2.4', notesFile: notes, source }); verifyVersions(root, '1.2.4');
    prepare(root, { version: '1.2.4', notesFile: notes, source }); expect(run(root, 'git', ['rev-parse', 'HEAD'])).toBe(prepared); expect(run(root, 'git', ['status', '--porcelain'])).toBe('');
  });
  it('verifies a pinned historical release independently of newer manifest versions', () => {
    const root = repository(); const source = run(root, 'git', ['rev-parse', 'HEAD']);
    const notesFile = path.join(temp(), 'notes.md'); fs.writeFileSync(notesFile, '# Approved\n');
    prepare(root, { version: '1.2.4', notesFile, source });
    const revision = run(root, 'git', ['rev-parse', 'HEAD']); run(root, 'git', ['tag', 'v1.2.4']);
    const laterNotes = path.join(temp(), 'notes.md'); fs.writeFileSync(laterNotes, '# Later\n');
    prepare(root, { version: '1.2.5', notesFile: laterNotes, source: revision });
    const head = run(root, 'git', ['rev-parse', 'HEAD']);
    expect(verifyReleaseRevision(root, { version: '1.2.4', notesFile, source, revision })).toBe(revision);
    artifacts(root);
    const helper = path.resolve('scripts/release.mjs');
    const args = ['--root', root, '--version', '1.2.4', '--notes', notesFile, '--source', source, '--revision', revision];
    expect(run(root, 'node', [helper, 'verify-prepare', ...args])).toContain('Verified v1.2.4 release commit');
    expect(run(root, 'node', [helper, 'verify-build', ...args])).toContain('Verified v1.2.4 artifacts');
    const remote = temp(); run(root, 'git', ['init', '--bare', remote]);
    run(root, 'git', ['remote', 'add', 'origin', remote]);
    run(root, 'git', ['push', 'origin', 'HEAD', 'refs/tags/v1.2.4']);
    run(remote, 'git', ['update-ref', 'refs/tags/v1.2.4', head]);
    expect(() => run(root, 'node', [helper, 'verify-draft', ...args])).toThrow(/Existing remote tag.*expected/);
    expect(() => verifyPrepared(root, { version: '1.2.4', notesFile, source })).toThrow(/Version mismatch/);
    expect(() => verifyReleaseRevision(root, { version: '1.2.4', notesFile, source: revision, revision })).toThrow(/captured source/);
    fs.writeFileSync(notesFile, '# Different\n');
    expect(() => verifyReleaseRevision(root, { version: '1.2.4', notesFile, source, revision })).toThrow(/notes differ/);
    expect(run(root, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    expect(run(root, 'git', ['status', '--porcelain'])).toBe('');
    run(root, 'git', ['tag', '-f', 'v1.2.4', head]);
    expect(() => verifyReleaseRevision(root, { version: '1.2.4', notesFile, source, revision })).toThrow(/conflicts with pinned/);
  });
  it('rejects historical release commits with wrong versions, unexpected changes, or outside main history', () => {
    for (const corruption of ['versions', 'paths', 'ancestry']) {
      const root = repository(); const source = run(root, 'git', ['rev-parse', 'HEAD']);
      const notesFile = path.join(temp(), 'notes.md'); fs.writeFileSync(notesFile, '# Approved\n');
      prepare(root, { version: '1.2.4', notesFile, source });
      if (corruption === 'versions') writeJson(path.join(root, 'package-lock.json'), { version: '9.0.0', packages: { '': { version: '1.2.4' } } });
      if (corruption === 'paths') fs.writeFileSync(path.join(root, 'unexpected'), 'change');
      if (corruption !== 'ancestry') { run(root, 'git', ['add', '.']); run(root, 'git', ['commit', '--amend', '--no-edit']); }
      const revision = run(root, 'git', ['rev-parse', 'HEAD']);
      if (corruption === 'ancestry') run(root, 'git', ['checkout', '--detach', source]);
      else run(root, 'git', ['commit', '--allow-empty', '-m', 'Later development']);
      expect(() => verifyReleaseRevision(root, { version: '1.2.4', notesFile, source, revision })).toThrow(
        corruption === 'versions' ? /versions differ/ : corruption === 'paths' ? /unexpected paths/ : /not an ancestor/,
      );
    }
  });
  it('verifies the exact artifacts, checksums, updater fields, asset sizes, and upload order', () => {
    const root = temp(); const out = artifacts(root); expect(verifyArtifacts(root, '1.2.4')).toBe(out);
    const assets = ASSET_NAMES.map((name, index) => ({ id: index + 1, name, size: fs.statSync(path.join(out, name)).size }));
    expect(() => verifyReleaseAssets({ assets }, out)).not.toThrow();
    expect(() => verifyReleaseAssets({ assets: [...assets, { id: 9, name: 'extra', size: 1 }] }, out)).toThrow(/exactly/);
    expect(() => verifyReleaseAssets({ assets: assets.map((asset, index) => ({ ...asset, id: index === 0 ? 99 : index })) }, out)).toThrow(/uploaded first/);
    fs.appendFileSync(path.join(out, 'Stacks-arm64.zip'), 'changed'); expect(() => verifyArtifacts(root, '1.2.4')).toThrow(/SHA256SUMS/);
  });
  it('plans ZIP-first uploads for a new draft and missing-only uploads when resumed', () => {
    const root = temp(); const out = artifacts(root); const size = name => fs.statSync(path.join(out, name)).size;
    expect(missingReleaseAssets(undefined, out)).toEqual(ASSET_NAMES);
    const partial = { assets: [{ id: 1, name: 'Stacks-arm64.zip', size: size('Stacks-arm64.zip') }, { id: 2, name: 'Stacks.app.tar.gz', size: size('Stacks.app.tar.gz') }] };
    expect(missingReleaseAssets(partial, out)).toEqual(['Stacks.app.tar.gz.sig', 'latest.json', 'SHA256SUMS']);
    const complete = { assets: ASSET_NAMES.map((name, id) => ({ id, name, size: size(name) })) };
    expect(missingReleaseAssets(complete, out)).toEqual([]);
    expect(() => missingReleaseAssets({ assets: [{ id: 1, name: 'latest.json', size: size('latest.json') }] }, out)).toThrow(/first-upload/);
    expect(() => missingReleaseAssets({ assets: [...partial.assets, { id: 3, name: 'surprise.dmg', size: 1 }] }, out)).toThrow(/unexpected/);
  });
});

describe('structured release reconciliation', () => {
  it('distinguishes available, prepared, complete draft, published, and conflicting identity', () => {
    const root = repository(); const source = run(root, 'git', ['rev-parse', 'HEAD']); const notes = path.join(temp(), 'notes.md'); fs.writeFileSync(notes, '# Approved\n');
    const input = { version: '1.2.4', previousVersion: '1.2.3', source, notes: { file: notes, text: '# Approved\n' }, branch: 'main', releases: [], latest: '1.2.3', remoteRefs: {} };
    expect(reconcileRelease(root, input).disposition).toBe('available');
    prepare(root, { version: '1.2.4', notesFile: notes, source }); const revision = run(root, 'git', ['rev-parse', 'HEAD']);
    expect(reconcileRelease(root, input)).toMatchObject({ disposition: 'resumablePrepared', preparedRevision: revision, preparedParent: source, provenStages: ['prepare'] });
    const out = artifacts(root); const assets = ASSET_NAMES.map((name, id) => ({ id: id + 1, name, size: fs.statSync(path.join(out, name)).size, digest: `sha256:${run(root, 'shasum', ['-a', '256', path.join(out, name)]).split(' ')[0]}` }));
    const draft = { id: 7, tag_name: 'v1.2.4', target_commitish: revision, name: 'Stacks v1.2.4', body: '# Approved\n', draft: true, prerelease: false, html_url: 'https://example.test/draft', assets };
    const remoteRefs = { 'refs/tags/v1.2.4': revision };
    expect(reconcileRelease(root, { ...input, releases: [draft], remoteRefs })).toMatchObject({ disposition: 'resumableDraft', missingAssets: [], provenStages: ['prepare', 'build', 'draft'] });
    run(root, 'git', ['tag', 'v1.2.4', revision]);
    fs.writeFileSync(path.join(root, 'later'), 'new work'); run(root, 'git', ['add', 'later']); run(root, 'git', ['commit', '-m', 'Later change']);
    const laterHead = run(root, 'git', ['rev-parse', 'HEAD']);
    expect(reconcileRelease(root, { ...input, source: laterHead, releases: [draft], remoteRefs })).toMatchObject({ disposition: 'resumableDraft', sourceRevision: source, headRevision: laterHead, preparedRevision: revision, missingAssets: [], provenStages: ['prepare', 'build', 'draft'] });
    expect(reconcileRelease(root, { ...input, source: laterHead, releases: [{ ...draft, body: '# Altered\n' }], remoteRefs })).toMatchObject({ disposition: 'conflict', permittedActions: ['refresh'] });
    expect(reconcileRelease(root, { ...input, source: laterHead, notes: { ...input.notes, text: '# Altered\n' }, releases: [draft], remoteRefs })).toMatchObject({ disposition: 'conflict', permittedActions: ['refresh'] });
    expect(reconcileRelease(root, { ...input, source: laterHead, releases: [{ ...draft, draft: false }], remoteRefs }).disposition).toBe('published');
    expect(reconcileRelease(root, { ...input, source: laterHead, releases: [{ ...draft, name: 'Wrong title' }], remoteRefs })).toMatchObject({ disposition: 'conflict', permittedActions: ['refresh'] });
  });
});

describe('mocked GitHub safety cases', () => {
  const identity = { tag: 'v1.2.4', revision: 'abc123', title: 'Stacks v1.2.4', body: '# Notes\n' };
  it('distinguishes no draft, a matching draft, and a conflicting published release', () => {
    expect(matchingDraft([], identity)).toBeUndefined();
    const draft = { tag_name: identity.tag, target_commitish: identity.revision, name: identity.title, body: identity.body, draft: true, prerelease: false };
    expect(matchingDraft([draft], identity)).toBe(draft);
    expect(() => matchingDraft([{ ...draft, draft: false }], identity)).toThrow(/published/);
    expect(() => matchingDraft([{ ...draft, body: 'different' }], identity)).toThrow(/conflicts/);
  });
  it('uploads release assets through gh release upload and surfaces failures', () => {
    const root = temp(); const gh = path.join(root, 'gh'); const calls = path.join(root, 'calls');
    fs.writeFileSync(gh, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CALLS"\n'); fs.chmodSync(gh, 0o755);
    uploadReleaseAsset('v1.2.4', '/tmp/Stacks-arm64.zip', { gh, env: { ...process.env, CALLS: calls } });
    expect(fs.readFileSync(calls, 'utf8')).toBe('release\nupload\nv1.2.4\n/tmp/Stacks-arm64.zip\n');
    fs.writeFileSync(gh, '#!/bin/sh\necho upload failed >&2\nexit 17\n');
    expect(() => uploadReleaseAsset('v1.2.4', '/tmp/Stacks-arm64.zip', { gh })).toThrow(/upload failed/);
  });
});
