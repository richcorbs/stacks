#!/usr/bin/env node
/**
 * Card #319 host-side smoke test.
 *
 * Plays the role of the Tauri IPC bridge without launching Stacks: binds the
 * socket, spawns the native terminal helper, drives the global-terminal command
 * vocabulary, and asserts the lifecycle events. This verifies process launch,
 * socket handshake, show/hide, tab/split/search command routing, and clean quit
 * on a real desktop session. Pixels, typing, and clipboard need the manual
 * checklist in `docs/native-global-terminal-319.md`.
 *
 * Usage:
 *   node scripts/smoke-native-terminal.mjs [path-to-helper]
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const helper = [
  process.argv[2],
  process.env.STACKS_NATIVE_GLOBAL_TERMINAL_BIN,
  join(root, 'spikes/gpui-terminal/target/release/stacks-gpui-terminal-spike'),
  join(root, 'spikes/gpui-terminal/target/debug/stacks-gpui-terminal-spike'),
].filter(Boolean).find((candidate) => existsSync(candidate));
if (!helper) {
  console.error('No helper binary found. Run `npm run native-terminal:build` first.');
  process.exit(1);
}

const socketPath = join(tmpdir(), `stacks-native-terminal-smoke-${process.pid}.sock`);
rmSync(socketPath, { force: true });

const events = [];
const failures = [];
const waiters = [];
let child;
let connection;

function fail(message) {
  failures.push(message);
  console.error(`FAIL ${message}`);
}

function expect(condition, message) {
  if (condition) console.log(`PASS ${message}`);
  else fail(message);
}

function waitFor(predicate, label, timeout = 10000) {
  if (events.some(predicate)) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const waiter = { predicate, resolve: resolvePromise };
    waiters.push(waiter);
    setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) {
        waiters.splice(index, 1);
        resolvePromise(false);
      }
    }, timeout);
  }).then((ok) => {
    if (!ok) fail(`timeout waiting for ${label}`);
    return ok;
  });
}

function send(command, index) {
  const payload = index === undefined ? { command } : { command, index };
  console.log(`-> ${JSON.stringify(payload)}`);
  connection.write(`${JSON.stringify(payload)}\n`);
}

const server = createServer((stream) => {
  connection = stream;
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        fail(`unparsable event ${line}: ${error.message}`);
        continue;
      }
      events.push(event);
      console.log(`<- ${line}`);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(event)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(true);
        }
      }
    }
  });
  stream.on('error', (error) => fail(`socket error: ${error.message}`));
  void run();
});

function waitForExit(timeout = 5000) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), timeout);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise(true);
    });
  });
}

async function run() {
  console.log(`helper: ${helper}`);
  expect(await waitFor((event) => event.event === 'ready', 'ready'), 'helper reports ready');

  send('show');
  expect(await waitFor((event) => event.event === 'visibility' && event.visible === true, 'show'), 'show reports visibility:true');

  const titlesBefore = events.filter((event) => event.event === 'title').length;
  send('new-tab');
  expect(
    await waitFor(
      () => events.filter((event) => event.event === 'title').length > titlesBefore,
      'second title',
    ),
    'new tab publishes a title',
  );

  send('split-right');
  send('split-down');
  send('next-pane');
  send('new-tab');
  send('previous-tab');
  send('select-tab', 1);
  send('search');
  await new Promise((done) => setTimeout(done, 1200));

  send('hide');
  expect(await waitFor((event) => event.event === 'visibility' && event.visible === false, 'hide'), 'hide reports visibility:false');

  send('quit');
  expect(await waitForExit(), 'helper exits after quit');
  expect(!failures.length, 'no protocol or lifecycle failures');
  server.close();
  rmSync(socketPath, { force: true });
  process.exit(failures.length ? 1 : 0);
}

server.listen(socketPath, () => {
  child = spawn(helper, [], {
    env: { ...process.env, STACKS_NATIVE_TERMINAL_SOCKET: socketPath },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) fail(`helper exited with ${code ?? signal}`);
  });
});

setTimeout(() => {
  fail('smoke test timed out');
  child?.kill();
  server.close();
  process.exit(1);
}, 60000);
