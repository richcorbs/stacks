#!/usr/bin/env node
// Measure the GPUI shell against the shipped Tauri app (card #321).
//
// GPUI side is instrumented: `STACKS_GPUI_METRICS=1` prints process-start to
// first-render and first-PTY-spawn timings on stderr. The Tauri side is only
// measurable from the outside, so its number is process-launch latency, not
// first paint; the report labels that asymmetry.
//
// Caveat: Stacks owns a fixed automation socket. If a dogfood instance is
// already running, `open -n` launches a process that immediately activates the
// existing app and exits (`rss_after_3s_mb: null`). Stop the dogfood app in a
// throwaway profile before relying on the Tauri numbers.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(repoRoot, 'target');
const defaultBinary = path.join(targetDir, 'release/stacks-gpui');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const runs = Number(flag('--runs', '3'));
const binary = path.resolve(flag('--binary', process.env.STACKS_GPUI_BIN || defaultBinary));
const tauriApp = flag('--tauri-app', null);
const jsonOut = flag('--json', null);
const cardsDb = flag('--cards-db', null);
const startView = flag('--start-view', 'list');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rssMb(pid) {
  try {
    const output = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    return Number(output) / 1024;
  } catch {
    return null;
  }
}

function sizeMb(file) {
  try {
    return fs.statSync(file).size / (1024 * 1024);
  } catch {
    return null;
  }
}

async function measureGpui() {
  if (!fs.existsSync(binary)) {
    throw new Error(`missing binary: ${binary} (build with: npm run gpui-shell:build)`);
  }
  const samples = [];
  for (let run = 0; run < runs; run += 1) {
    // GPUI stops painting an occluded/asleep display, which would skip the
    // first-list-frame instrumentation. Wake the display before each launch; a
    // locked display also stops painting.
    try {
      execFileSync('caffeinate', ['-u', '-t', '2']);
    } catch {
      // not macOS or caffeinate unavailable
    }
    await sleep(250);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacks-gpui-measure-'));
    const child = spawn(binary, [], {
      env: {
        ...process.env,
        STACKS_GPUI_METRICS: '1',
        STACKS_GPUI_DATA_DIR: dataDir,
        STACKS_GPUI_START_VIEW: startView,
        ...(cardsDb ? { STACKS_GPUI_CARDS_DB: path.resolve(cardsDb) } : {}),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const metrics = {};
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      for (const match of stderr.matchAll(/STACKS_GPUI_METRIC ([^\n]+)/g)) {
        for (const field of match[1].trim().split(/\s+/)) {
          const [key, value] = field.split('=');
          if (key && value !== undefined && Number.isFinite(Number(value))) {
            metrics[key] = Number(value);
          }
        }
      }
      if (
        startView === 'list'
          ? metrics.list_visible_rows !== undefined
          : metrics.first_frame_ms !== undefined
      ) {
        break;
      }
      if (child.exitCode !== null) break;
      await sleep(20);
    }
    if (metrics.first_frame_ms === undefined) {
      child.kill('SIGKILL');
      throw new Error(`no first_frame_ms metric; stderr:\n${stderr}`);
    }
    // Let the shell prompt and first paint settle before sampling memory.
    await sleep(1200);
    const rss = rssMb(child.pid);
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    samples.push({
      first_frame_ms: metrics.first_frame_ms,
      first_list_frame_ms: metrics.first_list_frame_ms ?? null,
      list_load_ms: metrics.list_load_ms ?? null,
      list_flatten_us: metrics.list_flatten_us ?? null,
      list_cards: metrics.list_cards ?? null,
      list_rows: metrics.list_rows ?? null,
      list_visible_rows: metrics.list_visible_rows ?? null,
      first_pty_spawn_ms: metrics.first_pty_spawn_ms ?? null,
      rss_mb: rss,
      data_dir_written: fs.existsSync(path.join(dataDir, 'shell-state.json')),
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  const median = (values) => {
    const sorted = values.filter((value) => typeof value === 'number').sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  };
  return {
    binary,
    binary_mb: sizeMb(binary),
    samples,
    median_first_frame_ms: median(samples.map((sample) => sample.first_frame_ms)),
    median_first_list_frame_ms: median(samples.map((sample) => sample.first_list_frame_ms)),
    median_list_load_ms: median(samples.map((sample) => sample.list_load_ms)),
    median_list_flatten_us: median(samples.map((sample) => sample.list_flatten_us)),
    median_list_visible_rows: median(samples.map((sample) => sample.list_visible_rows)),
    median_first_pty_spawn_ms: median(samples.map((sample) => sample.first_pty_spawn_ms)),
    median_rss_mb: median(samples.map((sample) => sample.rss_mb)),
    cards_db: cardsDb ? path.resolve(cardsDb) : null,
    start_view: startView,
  };
}

function listAppPids(appPath) {
  try {
    const exe = execFileSync(
      'defaults',
      ['read', path.join(appPath, 'Contents/Info'), 'CFBundleExecutable'],
      { encoding: 'utf8' },
    ).trim();
    const output = execFileSync('pgrep', ['-f', path.join(appPath, 'Contents/MacOS', exe)], {
      encoding: 'utf8',
    });
    return new Set(output.trim().split(/\s+/).filter(Boolean).map(Number));
  } catch {
    return new Set();
  }
}

async function measureTauri(appPath) {
  const resolved = path.resolve(appPath.replace(/^~/, os.homedir()));
  if (!fs.existsSync(resolved)) throw new Error(`missing app: ${resolved}`);
  const before = listAppPids(resolved);
  const started = performance.now();
  execFileSync('open', ['-n', resolved]);
  let pid = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const after = listAppPids(resolved);
    const fresh = [...after].find((candidate) => !before.has(candidate));
    if (fresh) {
      pid = fresh;
      break;
    }
    await sleep(20);
  }
  if (!pid) throw new Error('Tauri app did not launch');
  const process_launch_ms = performance.now() - started;
  await sleep(3000);
  const rss = rssMb(pid);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already gone
  }
  const bundleMb = (() => {
    try {
      return (
        Number(
          execFileSync('du', ['-sk', resolved], { encoding: 'utf8' }).trim().split(/\s+/)[0],
        ) / 1024
      );
    } catch {
      return null;
    }
  })();
  return {
    app: resolved,
    process_launch_ms,
    rss_after_3s_mb: rss,
    bundle_mb: bundleMb,
  };
}

try {
  const result = { gpui: await measureGpui() };
  if (tauriApp) result.tauri = await measureTauri(tauriApp);
  const text = JSON.stringify(result, null, 2);
  if (jsonOut) fs.writeFileSync(jsonOut, `${text}\n`);
  console.log(text);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
