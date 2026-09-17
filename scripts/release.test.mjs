import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ASSET_NAMES, ghJson, latestPublished, matchingDraft, missingReleaseAssets, prepare,
  releaseNotes, suggestPatch, uploadReleaseAsset, validateVersion, verifyArtifacts, verifyPrepared,
  verifyReleaseAssets, verifyVersions, writeChecksums,
} from './release-lib.mjs';

const temporary = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacks-release-')); temporary.push(dir); return dir; }
function run(cwd, command, args) { return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim(); }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function repository() {
  const root = temp();
  run(root, 'git', ['init', '-b', 'main']); run(root, 'git', ['config', 'user.email', 'test@example.com']); run(root, 'git', ['config', 'user.name', 'Release Test']);
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
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(response).replaceAll("'", "'\\''")}'\n`); fs.chmodSync(bin, 0o755); return bin;
}
function artifacts(root, version = '1.2.4') {
  const out = path.join(root, 'release-artifacts', `v${version}`); fs.mkdirSync(out, { recursive: true });
  for (const name of ASSET_NAMES.slice(0, -2)) fs.writeFileSync(path.join(out, name), `${name} contents`);
  fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify({ version, platforms: { 'darwin-aarch64': { signature: 'Stacks.app.tar.gz.sig contents', url: `https://github.com/richcorbs/stacks/releases/download/v${version}/Stacks.app.tar.gz` } } }));
  writeChecksums(out); return out;
}

describe('release version discovery and validation', () => {
  it('discovers only the latest published stable GitHub release and suggests its next patch', () => {
    const root = temp(); const gh = fakeGh(root, { tag_name: 'v2.7.9', draft: false, prerelease: false });
    expect(latestPublished({ gh })).toBe('2.7.9'); expect(suggestPatch('2.7.9')).toBe('2.7.10');
  });
  it('rejects non-Stacks SemVer and non-published latest responses', () => {
    for (const value of ['v1.2.3', '1.2', '01.2.3', '1.2.3-beta']) expect(() => validateVersion(value)).toThrow();
    const root = temp(); const gh = fakeGh(root, { tag_name: 'v1.2.3', draft: true, prerelease: false });
    expect(() => latestPublished({ gh })).toThrow(/published stable/);
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
