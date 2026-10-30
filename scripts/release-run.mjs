#!/usr/bin/env node
// Repository-owned release workflow. The app only provides a version and a PTY.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { git, validateVersion } from './release-lib.mjs';

export function parseReleaseArgs(argv, env = process.env) {
  const mode = argv[0] || 'draft';
  if (!['draft', 'publish'].includes(mode)) throw new Error('Usage: node scripts/release-run.mjs <draft|publish> [--version X.Y.Z]');
  if (argv.length > 1 && (argv.length !== 3 || argv[1] !== '--version')) throw new Error('Expected --version X.Y.Z (or STACKS_RELEASE_VERSION)');
  return { mode, version: validateVersion(argv[2] || env.STACKS_RELEASE_VERSION) };
}

export async function runRelease({ mode, version, root, execute, approve, log = console.log }) {
  validateVersion(version);
  const started = Date.now();
  let phase = 'preflight';
  let lock;
  let contextPath;
  const step = (label, fn) => {
    phase = label;
    log(`\n━━ ${label} ━━`);
    const result = fn();
    log(`✓ ${label}`);
    return result;
  };
  try {
    log(`Stacks v${version} — ${mode === 'draft' ? 'CREATE VERIFIED DRAFT (does not publish)' : 'PUBLISH EXISTING VERIFIED DRAFT'}`);
    log(`Checkout: ${root}`);
    const top = fs.realpathSync(git(root, 'rev-parse', '--show-toplevel'));
    const common = fs.realpathSync(path.resolve(root, git(root, 'rev-parse', '--git-common-dir')));
    const local = fs.realpathSync(git(root, 'rev-parse', '--absolute-git-dir'));
    if (top !== fs.realpathSync(root) || common !== local) throw new Error('Run releases from the primary repository root, not a linked worktree');
    const lockPath = path.join(common, 'stacks-release.lock');
    try { fs.mkdirSync(lockPath); lock = lockPath; }
    catch { throw new Error(`Another release may be running. Lock: ${lockPath}. If a prior run was interrupted, verify its processes have stopped before manually removing this lock.`); }
    const stateDir = path.join(common, 'stacks-releases', `v${version}`);
    contextPath = path.join(stateDir, 'context.json');
    let context;
    if (fs.existsSync(contextPath)) {
      phase = 'Read saved release context';
      context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
      if (context.version !== version) throw new Error('Saved release context has a different version');
      log(`Resuming saved release context: ${contextPath}`);
    } else {
      if (mode === 'publish') throw new Error('No saved draft context. Run draft first.');
      const previous = step('Discover latest published version', () => execute('current', [], true).trim());
      step('Validate selected version', () => execute('validate', ['--version', version, '--previous', previous]));
      phase = 'Capture source revision and release notes';
      const source = git(root, 'rev-parse', 'HEAD');
      const branch = 'main'; // Stacks publication policy is repository-owned.
      const notes = step('Generate release notes', () => execute('notes', ['--previous', previous, '--source', source], true));
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const notesFile = path.join(stateDir, 'notes.md');
      fs.writeFileSync(notesFile, notes, { mode: 0o600 });
      context = { version, previous, source, branch, notesFile, ciWorkflow: '.github/workflows/ci.yml' };
      // Validate before persisting a resumable context or modifying the checkout.
      step('Validate primary checkout', () => execute('preflight', contextArgs(context)));
      fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), { mode: 0o600 });
    }
    log(`\nRelease: ${context.previous} → ${version}`);
    log(`Target: ${context.branch} | Source: ${context.source}`);
    log(`Release notes: ${context.notesFile}`);
    phase = 'Validate target branch';
    if (git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD') !== context.branch) throw new Error(`Target branch ${context.branch} must be checked out`);
    const args = contextArgs(context);
    if (mode === 'draft') {
      const head = git(root, 'rev-parse', 'HEAD');
      if (head === context.source) {
        step('Validate clean checkout and selected version', () => execute('preflight', args));
        step('Synchronize versions and commit release notes', () => execute('prepare', args));
      }
      step('Verify exact release commit', () => execute('verify-prepare', args));
      // A failed upload can resume without rebuilding verified signed artifacts.
      let artifactsValid = false;
      try { execute('verify-build', args, true); artifactsValid = true; } catch {}
      if (!artifactsValid) step('Test, validate, build and sign updater artifacts', () => execute('build', args));
      else log('\n✓ Reusing verified signed artifacts');
      step('Verify updater manifest, signatures and checksums', () => execute('verify-build', args));
      step('Push release commit/tag and upload GitHub draft', () => execute('draft', args));
      step('Verify GitHub draft and uploaded assets', () => execute('verify-draft', args));
      log(`\nSUCCESS: Stacks v${version} draft is ready. Nothing was published as latest.`);
      log(`Next: smoke-test the signed draft, wait for CI, then run:\n  node scripts/release-run.mjs publish --version ${version}`);
    } else {
      phase = 'publication confirmation';
      log('\nPublication makes this draft the latest public release and enables updater downloads.');
      if (!await approve(version)) throw new Error('Publication cancelled; draft remains unchanged');
      step('Verify exact release commit', () => execute('verify-prepare', args));
      step('Verify signed artifacts and existing draft', () => { execute('verify-build', args); execute('verify-draft', args); });
      step('Require exact-commit CI and publish verified draft', () => execute('publish', args));
      step('Verify latest published release', () => execute('verify-publish', args));
      log(`\nSUCCESS: Stacks v${version} is published and verified as latest.`);
    }
    log(`Elapsed: ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (error) {
    log(`\nFAILED during ${phase}: ${error.message}`);
    log('Stopped; no automatic rollback, force push, or asset overwrite was attempted.');
    if (contextPath) log(`Inspect saved context/artifacts and remote state before retrying: ${contextPath}`);
    throw error;
  } finally {
    if (lock) fs.rmdirSync(lock);
  }
}
function contextArgs(c) {
  return ['--version', c.version, '--previous', c.previous, '--source', c.source, '--branch', c.branch, '--notes', c.notesFile, '--ci-workflow', c.ciWorkflow];
}
async function confirmPublication(version) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Publishing requires an interactive terminal and explicit smoke-test confirmation');
  console.log('Smoke-test the signed draft before publishing. Confirmation available in 2 seconds…');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return await prompt.question(`Type PUBLISH v${version} to confirm smoke testing and publish: `) === `PUBLISH v${version}`; }
  finally { prompt.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseReleaseArgs(process.argv.slice(2));
    const root = fs.realpathSync(process.env.STACKS_RELEASE_PROJECT_PATH || path.join(import.meta.dirname, '..'));
    const helper = path.join(root, 'scripts/release.mjs');
    const execute = (stage, args, capture = false) => {
      const child = spawnSync(process.execPath, [helper, stage, '--root', root, ...args], { cwd: root, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' });
      if (child.error || child.status !== 0) throw new Error(`${stage} failed${child.signal ? ` (${child.signal})` : ` (exit ${child.status})`}${child.error ? `: ${child.error.message}` : ''}${capture && child.stderr ? `: ${child.stderr.trim()}` : ''}`);
      return child.stdout || '';
    };
    await runRelease({ ...options, root, execute, approve: confirmPublication });
  } catch (error) { console.error(`Release command failed: ${error.message}`); process.exitCode = 1; }
}
