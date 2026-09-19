import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const ASSET_NAMES = ['Stacks-arm64.zip', 'Stacks.app.tar.gz', 'Stacks.app.tar.gz.sig', 'latest.json', 'SHA256SUMS'];
export const VERSION_FILES = ['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json'];

export function fail(message) { throw new Error(message); }
export function validateVersion(version) {
  if (!VERSION_RE.test(version || '')) fail(`Invalid Stacks version ${JSON.stringify(version)}; expected SemVer X.Y.Z without prefixes or prerelease/build metadata`);
  return version;
}
export function compareVersions(left, right) {
  validateVersion(left); validateVersion(right);
  const leftParts = left.split('.').map(BigInt);
  const rightParts = right.split('.').map(BigInt);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}
export function validateReleaseVersion(version, previousVersion) {
  validateVersion(version); validateVersion(previousVersion);
  if (compareVersions(version, previousVersion) <= 0) fail(`Release version ${version} must be greater than the latest published version ${previousVersion}`);
  return version;
}
export function tagFor(version) { return `v${validateVersion(version)}`; }
export function suggestPatch(version) {
  validateVersion(version);
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
}
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env || process.env, encoding: 'utf8', stdio: options.capture === false ? 'inherit' : 'pipe' });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  return (result.stdout || '').trim();
}
export function git(root, ...args) { return run('git', args, { cwd: root }); }
export function ghJson(args, options = {}) {
  const output = run(options.gh || 'gh', args, { cwd: options.cwd, env: options.env });
  try { return JSON.parse(output); } catch { fail(`gh returned invalid JSON for: gh ${args.join(' ')}`); }
}
export function uploadReleaseAsset(tag, file, options = {}) {
  return run(options.gh || 'gh', ['release', 'upload', tag, file], { cwd: options.cwd, env: options.env });
}
export function latestPublished(options = {}) {
  const release = ghJson(['api', 'repos/{owner}/{repo}/releases/latest'], options);
  if (!release || release.draft || release.prerelease || typeof release.tag_name !== 'string') fail('GitHub latest release is not a published stable release');
  if (!release.tag_name.startsWith('v')) fail(`Latest release tag ${release.tag_name} does not use the required vX.Y.Z form`);
  return validateVersion(release.tag_name.slice(1));
}
export function releaseNotes(root, previousVersion, sourceRevision) {
  const previousTag = tagFor(previousVersion);
  if (!sourceRevision) fail('A source revision is required');
  git(root, 'rev-parse', '--verify', `${previousTag}^{commit}`);
  const source = git(root, 'rev-parse', '--verify', `${sourceRevision}^{commit}`);
  run('git', ['merge-base', '--is-ancestor', `${previousTag}^{commit}`, source], { cwd: root });
  const subjects = git(root, 'log', '--reverse', '--no-merges', '--format=%s', `${previousTag}..${source}`).split('\n').filter(Boolean);
  const lines = [`## Changes since ${previousTag}`, ''];
  lines.push(...(subjects.length ? subjects.map(subject => `- ${subject}`) : ['- No user-facing changes.']));
  return `${lines.join('\n')}\n`;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
export function versions(root) {
  const packageJson = readJson(path.join(root, 'package.json'));
  const packageLock = readJson(path.join(root, 'package-lock.json'));
  const tauri = readJson(path.join(root, 'src-tauri/tauri.conf.json'));
  const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8').match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
  const cargoLock = fs.readFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'utf8').match(/^\[\[package\]\]\nname = "stacks"\nversion = "([^"]+)"/m)?.[1];
  return { package: packageJson.version, packageLock: packageLock.packages?.['']?.version, tauri: tauri.version, cargo, cargoLock };
}
export function verifyVersions(root, expected) {
  validateVersion(expected);
  const found = versions(root);
  if (Object.values(found).some(value => value !== expected)) fail(`Version mismatch; expected ${expected}: ${JSON.stringify(found)}`);
}
export function setVersions(root, version) {
  validateVersion(version);
  for (const relative of ['package.json', 'package-lock.json']) {
    const file = path.join(root, relative); const json = readJson(file); json.version = version;
    if (json.packages?.['']) json.packages[''].version = version;
    writeJson(file, json);
  }
  const tauriFile = path.join(root, 'src-tauri/tauri.conf.json'); const tauri = readJson(tauriFile); tauri.version = version; writeJson(tauriFile, tauri);
  for (const relative of ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
    const file = path.join(root, relative); const original = fs.readFileSync(file, 'utf8');
    const pattern = relative.endsWith('Cargo.toml') ? /(^\[package\][\s\S]*?^version\s*=\s*")[^"]+("$)/m : /(^\[\[package\]\]\nname = "stacks"\nversion = ")[^"]+(")/m;
    const updated = original.replace(pattern, `$1${version}$2`);
    if (updated === original && !original.includes(`version = "${version}"`)) fail(`Could not update ${relative}`);
    fs.writeFileSync(file, updated);
  }
}
export function clean(root) { return git(root, 'status', '--porcelain', '--untracked-files=all') === ''; }
export function sourceRevision(env = process.env) { return env.STACKS_RELEASE_SOURCE_REVISION || env.STACKS_RELEASE_INITIAL_REVISION || ''; }
export function prepare(root, { version, notesFile, source }) {
  const tag = tagFor(version); const notesTarget = path.join(root, 'releases', `${tag}.md`);
  if (!source || !notesFile) fail('Prepare requires a source revision and approved notes file');
  const resolvedSource = git(root, 'rev-parse', '--verify', `${source}^{commit}`);
  const head = git(root, 'rev-parse', 'HEAD');
  if (head !== resolvedSource) { verifyPrepared(root, { version, notesFile, source: resolvedSource }); return; }
  if (!clean(root)) fail('Working tree must be clean before prepare');
  setVersions(root, version);
  fs.mkdirSync(path.dirname(notesTarget), { recursive: true });
  fs.copyFileSync(notesFile, notesTarget);
  git(root, 'add', ...VERSION_FILES, path.relative(root, notesTarget));
  git(root, 'commit', '-m', `Release Stacks ${tag}`);
  verifyPrepared(root, { version, notesFile, source: resolvedSource });
}
export function verifyPrepared(root, { version, notesFile, source }) {
  const tag = tagFor(version); const head = git(root, 'rev-parse', 'HEAD');
  if (!clean(root)) fail('Prepared checkout is not clean');
  verifyVersions(root, version);
  const notesTarget = path.join(root, 'releases', `${tag}.md`);
  if (!fs.existsSync(notesTarget) || !fs.existsSync(notesFile) || !fs.readFileSync(notesTarget).equals(fs.readFileSync(notesFile))) fail(`Release notes do not match approved notes: releases/${tag}.md`);
  if (git(root, 'show', '-s', '--format=%s', head) !== `Release Stacks ${tag}`) fail(`HEAD is not the intended release commit for ${tag}`);
  if (git(root, 'rev-parse', `${head}^`) !== git(root, 'rev-parse', `${source}^{commit}`)) fail('Release commit does not directly follow the captured source revision');
  const allowed = new Set([...VERSION_FILES, `releases/${tag}.md`]);
  const changed = git(root, 'diff', '--name-only', source, head).split('\n').filter(Boolean);
  const unexpected = changed.filter(file => !allowed.has(file));
  if (unexpected.length) fail(`Release commit contains unexpected paths: ${unexpected.join(', ')}`);
  return head;
}
export function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
export function artifactDir(root, version) { return path.join(root, 'release-artifacts', tagFor(version)); }
export function writeChecksums(out) {
  const names = ASSET_NAMES.slice(0, -1);
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), names.map(name => `${sha256(path.join(out, name))}  ${name}`).join('\n') + '\n');
}
export function verifyArtifacts(root, version) {
  const out = artifactDir(root, version); const entries = fs.readdirSync(out, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name).sort();
  const expected = [...ASSET_NAMES].sort();
  if (JSON.stringify(entries) !== JSON.stringify(expected)) fail(`Artifact set mismatch; expected ${expected.join(', ')}, found ${entries.join(', ')}`);
  for (const name of ASSET_NAMES) if (fs.statSync(path.join(out, name)).size === 0) fail(`Artifact is empty: ${name}`);
  const expectedSums = ASSET_NAMES.slice(0, -1).map(name => `${sha256(path.join(out, name))}  ${name}`).join('\n') + '\n';
  if (fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8') !== expectedSums) fail('SHA256SUMS does not exactly match release artifacts');
  const manifest = readJson(path.join(out, 'latest.json'));
  if (manifest.version !== version || manifest.platforms?.['darwin-aarch64']?.url !== `https://github.com/richcorbs/stacks/releases/download/v${version}/Stacks.app.tar.gz`) fail('Updater manifest does not match the requested release');
  if (manifest.platforms['darwin-aarch64'].signature !== fs.readFileSync(path.join(out, 'Stacks.app.tar.gz.sig'), 'utf8').trim()) fail('Updater manifest signature does not match the signature artifact');
  return out;
}
export function findRelease(releases, tag) { return releases.filter(release => release.tag_name === tag); }
export function matchingDraft(releases, { tag, revision, title, body }) {
  const matches = findRelease(releases, tag);
  if (matches.length > 1) fail(`Multiple GitHub releases exist for ${tag}`);
  const release = matches[0];
  if (!release) return undefined;
  if (!release.draft) fail(`A published release already exists for ${tag}`);
  if (release.prerelease || release.name !== title || release.target_commitish !== revision || (release.body || '') !== body) fail(`Existing draft ${tag} conflicts with this release operation`);
  return release;
}
export function missingReleaseAssets(release, out) {
  if (!release) return [...ASSET_NAMES];
  const assets = release.assets || [];
  const extras = assets.filter(asset => !ASSET_NAMES.includes(asset.name));
  if (extras.length) fail(`Draft has unexpected assets: ${extras.map(asset => asset.name).join(', ')}`);
  const existing = new Map(assets.map(asset => [asset.name, asset]));
  if (!existing.has(ASSET_NAMES[0]) && existing.size > 0) fail(`Cannot preserve first-upload requirement: draft has assets but is missing ${ASSET_NAMES[0]}`);
  for (const [name, asset] of existing) {
    const file = path.join(out, name);
    if (asset.size !== fs.statSync(file).size) fail(`Conflicting existing asset ${name}`);
    if (asset.digest && asset.digest !== `sha256:${sha256(file)}`) fail(`Conflicting existing asset digest ${name}`);
  }
  return ASSET_NAMES.filter(name => !existing.has(name));
}
export function verifyReleaseAssets(release, out) {
  const assets = release.assets || []; const names = assets.map(asset => asset.name);
  if (JSON.stringify([...names].sort()) !== JSON.stringify([...ASSET_NAMES].sort())) fail(`Release assets mismatch; expected exactly ${ASSET_NAMES.join(', ')}, found ${names.join(', ')}`);
  for (const asset of assets) {
    const file = path.join(out, asset.name); const size = fs.statSync(file).size;
    if (asset.size !== size) fail(`Conflicting asset ${asset.name}: GitHub size ${asset.size}, local size ${size}`);
    if (asset.digest && asset.digest !== `sha256:${sha256(file)}`) fail(`Conflicting asset digest: ${asset.name}`);
  }
  const first = [...assets].sort((a, b) => a.id - b.id)[0]?.name;
  if (first !== ASSET_NAMES[0]) fail(`${ASSET_NAMES[0]} was not uploaded first`);
}

function resolveOptional(root, ref) {
  try { return git(root, 'rev-parse', '--verify', `${ref}^{commit}`); } catch { return null; }
}
function artifactEvidence(root, version) {
  try {
    const out = verifyArtifacts(root, version);
    return { valid: true, directory: out, assets: ASSET_NAMES.map(name => ({ name, size: fs.statSync(path.join(out, name)).size, digest: `sha256:${sha256(path.join(out, name))}` })) };
  } catch (error) { return { valid: false, directory: artifactDir(root, version), assets: [], error: error.message }; }
}
function remoteTagRevision(remoteRefs, tag) {
  const peeled = remoteRefs[`refs/tags/${tag}^{}`];
  return peeled || remoteRefs[`refs/tags/${tag}`] || null;
}
export function reconcileRelease(root, { version, previousVersion, source, notes, branch, releases, latest, remoteRefs = {} }) {
  validateVersion(version); validateVersion(previousVersion);
  const tag = tagFor(version); const title = `Stacks ${tag}`; const expectedNotes = notes;
  const head = git(root, 'rev-parse', 'HEAD');
  const localTagRevision = resolveOptional(root, `refs/tags/${tag}`);
  const remoteTag = remoteTagRevision(remoteRefs, tag);
  const matching = findRelease(releases, tag);
  const release = matching[0];
  const issues = [];
  if (matching.length > 1) issues.push(`Multiple GitHub releases claim ${tag}.`);
  let preparedRevision = null; let preparedParent = null; let preparedValid = false;
  try { preparedRevision = verifyPrepared(root, { version, notesFile: notes.file, source }); preparedParent = git(root, 'rev-parse', `${preparedRevision}^`); preparedValid = true; } catch (error) {
    const manifestPrepared = Object.values(versions(root)).every(value => value === version) || fs.existsSync(path.join(root, 'releases', `${tag}.md`));
    if (manifestPrepared || git(root, 'show', '-s', '--format=%s', head) === `Release Stacks ${tag}`) issues.push(`Prepared release state is not safely resumable: ${error.message}`);
  }
  const intendedRevision = preparedRevision || (release ? (remoteTag || localTagRevision) : source);
  if (!preparedRevision && release && intendedRevision && resolveOptional(root, intendedRevision)) {
    preparedRevision = intendedRevision;
    try { preparedParent = git(root, 'rev-parse', `${intendedRevision}^`); } catch {}
  }
  const actualSource = preparedParent || source;
  if (localTagRevision && localTagRevision !== intendedRevision) issues.push(`Local tag ${tag} resolves to ${localTagRevision}, expected ${intendedRevision}. Existing tags are never moved.`);
  if (remoteTag && remoteTag !== intendedRevision) issues.push(`Remote tag ${tag} resolves to ${remoteTag}, expected ${intendedRevision}. Remove the conflicting remote release/tag manually, then refresh reconciliation.`);
  const artifact = artifactEvidence(root, version);
  let releaseIdentityValid = true; let missingAssets = [...ASSET_NAMES]; let extraAssets = []; let conflictingAssets = [];
  if (release) {
    if (release.name !== title) { issues.push(`GitHub release title is ${JSON.stringify(release.name)}, expected ${JSON.stringify(title)}.`); releaseIdentityValid = false; }
    if (release.target_commitish !== intendedRevision) { issues.push(`GitHub release target is ${JSON.stringify(release.target_commitish)}, expected immutable revision ${intendedRevision}.`); releaseIdentityValid = false; }
    if ((release.body || '') !== expectedNotes.text) { issues.push('GitHub release notes differ from the approved notes.'); releaseIdentityValid = false; }
    if (release.prerelease) { issues.push('GitHub release is marked prerelease.'); releaseIdentityValid = false; }
    if (!remoteTag) { issues.push(`GitHub release ${tag} has no resolvable advertised remote tag.`); releaseIdentityValid = false; }
    if (release.target_commitish && remoteTag && resolveOptional(root, remoteTag) && remoteTag !== intendedRevision) releaseIdentityValid = false;
    const existing = new Map((release.assets || []).map(asset => [asset.name, asset]));
    missingAssets = ASSET_NAMES.filter(name => !existing.has(name));
    extraAssets = [...existing.keys()].filter(name => !ASSET_NAMES.includes(name));
    if (artifact.valid) for (const [name, asset] of existing) {
      const local = artifact.assets.find(item => item.name === name);
      if (!local || local.size !== asset.size || (asset.digest && asset.digest !== local.digest)) conflictingAssets.push(name);
    }
    if (existing.size > 0 && !existing.has(ASSET_NAMES[0])) issues.push(`Draft cannot preserve required upload order because ${ASSET_NAMES[0]} is missing while later assets exist.`);
    if (!release.draft && missingAssets.length) issues.push(`Published release is missing required assets: ${missingAssets.join(', ')}.`);
    if (extraAssets.length) issues.push(`GitHub release has unexpected assets: ${extraAssets.join(', ')}.`);
    if (conflictingAssets.length) issues.push(`GitHub release assets conflict with verified local files: ${conflictingAssets.join(', ')}.`);
  }
  let disposition = 'available'; let permittedActions = ['start'];
  if (issues.length) { disposition = preparedRevision && !release && !remoteTag ? 'recoveryRequired' : 'conflict'; permittedActions = disposition === 'recoveryRequired' ? ['recover', 'refresh'] : ['refresh']; }
  else if (release && !release.draft) { disposition = 'published'; permittedActions = ['complete', 'refresh']; }
  else if (release) {
    if (!releaseIdentityValid) { disposition = 'conflict'; permittedActions = ['refresh']; }
    else if (!artifact.valid || conflictingAssets.length || extraAssets.length) { disposition = 'recoveryRequired'; permittedActions = ['refresh']; issues.push(`Local artifacts cannot safely resume this draft: ${artifact.error || 'asset evidence differs'}. Restore the exact release-artifacts/${tag} set; historical rebuilding from current HEAD is not allowed.`); }
    else { disposition = 'resumableDraft'; permittedActions = missingAssets.length ? ['resume', 'refresh'] : ['approve', 'resume', 'refresh']; }
  } else if (preparedValid) { disposition = artifact.valid ? 'resumablePrepared' : 'resumablePrepared'; permittedActions = ['resume', 'recover', 'refresh']; }
  else if (localTagRevision || remoteTag) { disposition = 'conflict'; permittedActions = ['refresh']; issues.push(`${tag} is already reserved by ${remoteTag ? 'a remote' : 'a local'} tag.`); }
  return {
    protocolVersion: 1, disposition, requestedVersion: version, latestPublishedVersion: latest,
    manifestVersions: versions(root), sourceRevision: actualSource, headRevision: head, preparedRevision, preparedParent,
    approvedPaths: [...VERSION_FILES, `releases/${tag}.md`], localTagRevision, remoteTagRevision: remoteTag,
    release: release ? { id: release.id, tag: release.tag_name, revision: remoteTag, title: release.name, notes: release.body || '', target: release.target_commitish || '', draft: !!release.draft, prerelease: !!release.prerelease, url: release.html_url || null } : null,
    expectedAssets: ASSET_NAMES, existingAssets: (release?.assets || []).map(asset => ({ name: asset.name, size: asset.size, digest: asset.digest || null })),
    missingAssets, extraAssets, conflictingAssets, artifact, identity: { tag, revision: intendedRevision, title, notes: expectedNotes.text, targetBranch: branch, prerelease: false, draft: true },
    issues, permittedActions,
    provenStages: [(preparedValid || (release && releaseIdentityValid)) && 'prepare', artifact.valid && (preparedValid || (release && releaseIdentityValid)) && 'build', release && releaseIdentityValid && artifact.valid && missingAssets.length === 0 && !extraAssets.length && !conflictingAssets.length && 'draft', release && !release.draft && releaseIdentityValid && 'publish'].filter(Boolean),
  };
}
