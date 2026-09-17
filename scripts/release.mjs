#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  ASSET_NAMES, artifactDir, clean, fail, findRelease, ghJson, git, latestPublished, matchingDraft,
  missingReleaseAssets, prepare, releaseNotes, run, setVersions, sourceRevision, suggestPatch,
  tagFor, uploadReleaseAsset, validateVersion, verifyArtifacts, verifyPrepared, verifyReleaseAssets,
  verifyVersions, writeChecksums,
} from './release-lib.mjs';

function args(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) result._.push(argv[i]);
    else { const key = argv[i].slice(2); if (!argv[i + 1] || argv[i + 1].startsWith('--')) result[key] = true; else result[key] = argv[++i]; }
  }
  return result;
}
const options = args(process.argv.slice(2));
const command = options._[0];
const root = path.resolve(options.root || process.env.STACKS_RELEASE_PROJECT_PATH || path.join(import.meta.dirname, '..'));
const version = options.version || process.env.STACKS_RELEASE_VERSION;
const previous = options.previous || process.env.STACKS_RELEASE_PREVIOUS_VERSION;
const source = options.source || sourceRevision();
const notesFile = options.notes || process.env.STACKS_RELEASE_NOTES_FILE;
const branch = options.branch || process.env.STACKS_RELEASE_TARGET_BRANCH;
const ghOptions = { cwd: root, gh: options.gh };

function requireValue(value, name) { if (!value) fail(`Missing --${name} (or corresponding STACKS_RELEASE_* environment variable)`); return value; }
function releaseList() { return ghJson(['api', 'repos/{owner}/{repo}/releases?per_page=100'], ghOptions); }
function releaseById(id) { return ghJson(['api', `repos/{owner}/{repo}/releases/${id}`], ghOptions); }
function matchingRelease(tag) {
  const matches = findRelease(releaseList(), tag);
  if (matches.length > 1) fail(`Multiple GitHub releases exist for ${tag}`);
  return matches[0];
}
function prepared() { return verifyPrepared(root, { version: requireValue(version, 'version'), notesFile: requireValue(notesFile, 'notes'), source: requireValue(source, 'source') }); }
function remoteRef(ref) { return run('git', ['ls-remote', '--refs', 'origin', ref], { cwd: root }).split(/\s+/)[0] || ''; }
function assertTagRevision(tag, revision) {
  let local = '';
  try { local = git(root, 'rev-parse', '--verify', `refs/tags/${tag}^{commit}`); } catch {}
  if (local && local !== revision) fail(`Existing local tag ${tag} points to ${local}, expected ${revision}`);
  const remote = remoteRef(`refs/tags/${tag}`);
  if (remote && remote !== revision) fail(`Existing remote tag ${tag} points to ${remote}, expected ${revision}`);
}
function verifyRemoteRevision(tag, revision) {
  const targetBranch = requireValue(branch, 'branch');
  assertTagRevision(tag, revision);
  const remoteBranch = remoteRef(`refs/heads/${targetBranch}`);
  const remoteTag = remoteRef(`refs/tags/${tag}`);
  if (remoteBranch !== revision || remoteTag !== revision) fail(`Remote branch ${targetBranch} and tag ${tag} do not both point to release revision ${revision}`);
}
function validateDraft(release, revision) {
  const tag = tagFor(version);
  if (!release) fail(`No draft release exists for ${tag}`);
  if (!release.draft) fail(`Release ${tag} is already published; refusing draft operation`);
  if (release.prerelease) fail(`Release ${tag} is unexpectedly marked prerelease`);
  if (release.name !== `Stacks ${tag}`) fail(`Draft ${tag} has conflicting title ${JSON.stringify(release.name)}`);
  if (release.target_commitish !== revision) fail(`Draft ${tag} targets ${release.target_commitish}, expected ${revision}`);
  const approved = fs.readFileSync(notesFile, 'utf8');
  if ((release.body || '') !== approved) fail(`Draft ${tag} notes differ from approved release notes`);
  verifyReleaseAssets(release, verifyArtifacts(root, version));
  return release;
}
function createOrResumeDraft() {
  const revision = prepared(); const tag = tagFor(version); const out = verifyArtifacts(root, version); const targetBranch = requireValue(branch, 'branch');
  assertTagRevision(tag, revision);
  const approvedNotes = fs.readFileSync(notesFile, 'utf8');
  let release = matchingDraft(releaseList(), { tag, revision, title: `Stacks ${tag}`, body: approvedNotes });
  let uploadNames = missingReleaseAssets(release, out);
  let hasLocalTag = true;
  try { git(root, 'show-ref', '--verify', '--quiet', `refs/tags/${tag}`); } catch { hasLocalTag = false; }
  if (!hasLocalTag) git(root, 'tag', tag, revision);
  const remoteBranch = remoteRef(`refs/heads/${targetBranch}`);
  if (remoteBranch !== revision) run('git', ['push', 'origin', `${revision}:refs/heads/${targetBranch}`], { cwd: root, capture: false });
  if (remoteRef(`refs/tags/${tag}`) !== revision) run('git', ['push', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], { cwd: root, capture: false });
  if (!release) {
    release = ghJson(['api', '--method', 'POST', 'repos/{owner}/{repo}/releases', '-f', `tag_name=${tag}`, '-f', `target_commitish=${revision}`, '-f', `name=Stacks ${tag}`, '-F', 'draft=true', '-F', 'prerelease=false', '--raw-field', `body=${approvedNotes}`], ghOptions);
    uploadNames = missingReleaseAssets(release, out);
  }
  for (const name of uploadNames) {
    console.log(`Uploading ${name}…`);
    uploadReleaseAsset(tag, path.join(out, name), ghOptions);
  }
  release = releaseById(release.id);
  validateDraft(release, revision);
  console.log(`Draft verified: ${release.html_url}`);
}
function verifyDraft() {
  const revision = prepared(); const tag = tagFor(version); verifyRemoteRevision(tag, revision);
  const release = validateDraft(matchingRelease(tag), revision);
  console.log(`Draft ready for smoke testing: ${release.html_url}`);
}
function publish() {
  const revision = prepared(); const tag = tagFor(version); verifyRemoteRevision(tag, revision); const release = validateDraft(matchingRelease(tag), revision);
  const published = ghJson(['api', '--method', 'PATCH', `repos/{owner}/{repo}/releases/${release.id}`, '-F', 'draft=false', '-F', 'prerelease=false', '-f', 'make_latest=true'], ghOptions);
  console.log(`Published ${tagFor(version)}: ${published.html_url}`);
}
function verifyPublished() {
  const revision = prepared(); const tag = tagFor(version); verifyRemoteRevision(tag, revision); const release = matchingRelease(tag);
  if (!release || release.draft || release.prerelease) fail(`${tag} is not a published stable release`);
  if (release.target_commitish !== revision) fail(`Published release targets ${release.target_commitish}, expected ${revision}`);
  verifyReleaseAssets(release, verifyArtifacts(root, version));
  const latest = ghJson(['api', 'repos/{owner}/{repo}/releases/latest'], ghOptions);
  if (latest.id !== release.id || latest.tag_name !== tag) fail(`GitHub latest release is ${latest.tag_name}, expected ${tag}`);
  console.log(`Verified latest release: ${release.html_url}`);
}
function preflight() {
  requireValue(version, 'version'); requireValue(previous, 'previous'); requireValue(source, 'source'); requireValue(notesFile, 'notes'); requireValue(branch, 'branch');
  validateVersion(version); validateVersion(previous);
  if (suggestPatch(previous) !== version) fail(`Stacks releases must be the next patch after ${previous}: expected ${suggestPatch(previous)}`);
  if (!fs.existsSync(notesFile) || !fs.readFileSync(notesFile, 'utf8').trim()) fail('Approved release notes are empty or missing');
  if (git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD') !== branch) fail(`Target branch ${branch} is not checked out`);
  if (!clean(root)) fail('Working tree must be clean');
  if (git(root, 'rev-parse', `${source}^{commit}`) !== git(root, 'rev-parse', 'HEAD')) fail('Captured source revision is not HEAD');
}
function build() {
  verifyPrepared(root, { version, notesFile, source });
  for (const [cmd, cmdArgs] of [['npm', ['run', 'test']], ['npm', ['run', 'build']], ['cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml']], ['cargo', ['check', '--manifest-path', 'src-tauri/Cargo.toml']]]) run(cmd, cmdArgs, { cwd: root, capture: false });
  const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: fs.readFileSync(path.join(process.env.HOME, '.tauri/stacks-updater.key'), 'utf8').trim(), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: fs.readFileSync(path.join(process.env.HOME, '.tauri/stacks-updater.password'), 'utf8').trim() };
  run('npx', ['tauri', 'build', '--bundles', 'app'], { cwd: root, env, capture: false });
  const out = artifactDir(root, version); fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  const bundle = path.join(root, 'src-tauri/target/release/bundle/macos');
  run('ditto', ['-c', '-k', '--keepParent', path.join(bundle, 'Stacks.app'), path.join(out, 'Stacks-arm64.zip')], { cwd: root });
  for (const name of ['Stacks.app.tar.gz', 'Stacks.app.tar.gz.sig']) fs.copyFileSync(path.join(bundle, name), path.join(out, name));
  const pubDate = git(root, 'show', '-s', '--format=%cI', source);
  run('node', ['scripts/create-update-manifest.mjs', path.join(out, 'Stacks.app.tar.gz'), path.join(out, 'Stacks.app.tar.gz.sig'), path.join(out, 'latest.json'), '--version', version, '--pub-date', pubDate], { cwd: root });
  writeChecksums(out); verifyArtifacts(root, version); console.log(`Verified release artifacts in ${out}`);
}

try {
  switch (command) {
    case 'current': console.log(latestPublished(ghOptions)); break;
    case 'suggest': console.log(suggestPatch(requireValue(previous, 'previous'))); break;
    case 'validate': validateVersion(requireValue(version, 'version')); if (previous && suggestPatch(previous) !== version) fail(`Expected next patch ${suggestPatch(previous)}, got ${version}`); console.log(`Valid Stacks release version: ${version}`); break;
    case 'notes': process.stdout.write(releaseNotes(root, requireValue(previous, 'previous'), requireValue(source, 'source'))); break;
    case 'preflight': preflight(); console.log('Release preflight passed.'); break;
    case 'prepare': prepare(root, { version, notesFile, source }); console.log(`Prepared ${tagFor(version)} release commit.`); break;
    case 'verify-prepare': prepared(); console.log(`Verified ${tagFor(version)} release commit.`); break;
    case 'build': build(); break;
    case 'verify-build': verifyPrepared(root, { version, notesFile, source }); verifyArtifacts(root, version); console.log(`Verified ${tagFor(version)} artifacts.`); break;
    case 'draft': createOrResumeDraft(); break;
    case 'verify-draft': verifyDraft(); break;
    case 'publish': publish(); break;
    case 'verify-publish': verifyPublished(); break;
    case 'set-version': setVersions(root, requireValue(version || options._[1], 'version')); break;
    case 'check-version': verifyVersions(root, version || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version); console.log('Stacks versions are consistent.'); break;
    default: fail('Usage: release.mjs <current|suggest|validate|notes|preflight|prepare|verify-prepare|build|verify-build|draft|verify-draft|publish|verify-publish> [--version X.Y.Z --previous X.Y.Z --source REV --notes FILE --branch NAME --root PATH]');
  }
} catch (error) { console.error(`error: ${error.message}`); process.exit(1); }
