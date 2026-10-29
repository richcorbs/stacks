// Opt-in Unix integration: real bash/readline and vim over a disposable PTY.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';

const shell = process.env.REFLOW_TEST_SHELL || 'bash';
const bashVersion = execFileSync(shell, ['--noprofile', '--norc', '-c', 'printf %s "$BASH_VERSION"'], { encoding: 'utf8' });
assert(Number.parseInt(bashVersion, 10) >= 5, `This comparison fixture requires Bash 5+; got ${bashVersion}. Set REFLOW_TEST_SHELL to a modern Bash path.`);
console.log(`PTY comparison: ${shell} ${bashVersion}`);

const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const outcomes = [];
      for (const enabled of [false, true]) {
        const page = await browser.newPage();
        const child = spawn('python3', ['tests/terminal-reflow-pty.py'], { stdio: ['pipe', 'pipe', 'inherit'] });
        const lines = createInterface({ input: child.stdout });
        const iterator = lines[Symbol.asyncIterator]();
        const exited = once(child, 'exit');
        async function request(message) {
          child.stdin.write(JSON.stringify(message) + '\n');
          const response = await iterator.next();
          assert(!response.done, 'PTY helper exited unexpectedly');
          const { output } = JSON.parse(response.value);
          await page.evaluate(text => window.reflowTest.write(text), output);
        }
        const snap = () => page.evaluate(() => window.reflowTest.snapshot());
        async function resize(width) {
          const size = await page.evaluate(width => window.reflowTest.resize(width), width);
          await request({ action: 'resize', cols: size.cols, rows: size.rows });
          return snap();
        }
        try {
          await page.goto(`${server.resolvedUrls.local[0]}tests/terminal-reflow.html`);
          await page.waitForFunction(() => !!window.reflowTest);
          await page.evaluate(value => window.reflowTest.configure(value), enabled);
          const size = await snap();
          await request({ action: 'start', cols: size.cols, rows: size.rows });
          assert((await snap()).logical.some(line => line.includes('REFLOW>')));
          const commands = [
            'echo ' + 'abcdefghijklmnop'.repeat(12),
            'echo ' + '世界🙂e\u0301'.repeat(30),
          ];
          const commandsAfterResize = [];
          for (const command of commands) {
            await request({ action: 'write', text: command });
            for (const width of [1000, 300, 500]) {
              await resize(width);
              if (width < 1000) assert.equal(await page.evaluate(() => window.reflowTest.focus(1)), true);
              else assert.equal(await page.evaluate(() => window.reflowTest.focus(1)), false);
              assert.equal(await page.evaluate(() => window.reflowTest.focus(0)), true);
              assert.equal(await page.evaluate(() => window.reflowTest.remount()), true);
            }
            const settled = await snap();
            const current = settled.logical.filter(line => line.includes('REFLOW>')).at(-1);
            assert.equal(current?.replaceAll(' ', ''), ('REFLOW> ' + command).replaceAll(' ', ''), 'input survives shell SIGWINCH redraw without Ctrl-L');
            if (command === commands[1]) {
              const retainedPreviousCommand = settled.logical.some(line => line.includes(commands[0]) && line.endsWith('^C'));
              assert.equal(retainedPreviousCommand, !enabled, 'comparison sentinel: enabling reflow loses the preceding cancelled command during readline redraw');
              console.log(`${engine.name()} reflow=${enabled}: preceding cancelled command retained=${retainedPreviousCommand}`);
            }
            // Readline Ctrl-L forces a complete redraw from the shell's authoritative input.
            await request({ action: 'write', text: '\x0c' });
            const state = await snap();
            const rendered = state.logical.filter(line => line.includes('REFLOW>')).at(-1);
            // Readline may emit a padding space before a wide glyph at the right margin.
            const normalize = text => text?.replaceAll(' ', '');
            assert.equal(normalize(rendered), normalize('REFLOW> ' + command));
            commandsAfterResize.push(normalize(rendered));
            await request({ action: 'write', text: '\x03' });
          }
          await request({ action: 'write', text: "printf 'history-%s abcdefghijklmnopqrstuvwxyz0123456789\\n' {1..80}\r" });
          await page.waitForTimeout(800);
          await page.evaluate(() => window.reflowTest.scrollBack());
          for (const width of [1000, 300, 500]) {
            const state = await resize(width);
            assert(state.logical.some(line => line.includes('history-80 ')));
            assert(state.viewportY < state.baseY);
          }
          await request({ action: 'write', text: 'vim -Nu NONE -n -i NONE\r' });
          assert.equal((await snap()).type, 'alternate', 'vim must enter alternate screen');
          await request({ action: 'write', text: 'iEDITOR 世界🙂\x1b' });
          for (const width of [1000, 300, 500]) {
            await resize(width);
            await request({ action: 'write', text: '\x0c' });
            const state = await snap();
            assert.equal(state.type, 'alternate');
            assert.equal(state.physical[0], 'EDITOR 世界🙂');
          }
          await request({ action: 'write', text: ':q!\r' });
          assert.equal((await snap()).type, 'normal');
          assert((await snap()).logical.some(line => line.includes('history-80 ')));
          outcomes.push(commandsAfterResize);
          console.log(`PASS ${engine.name()} reflowCursorLine=${enabled}: real bash/readline ASCII+Unicode, scrollback, vim, layout/focus/remount`);
        } finally {
          child.stdin.end(JSON.stringify({ action: 'stop' }) + '\n');
          await exited;
          lines.close();
          await page.evaluate(() => window.reflowTest.dispose());
          await page.close();
        }
      }
      assert.deepEqual(outcomes[0], outcomes[1], 'enabled reflow provides no input benefit after shell redraw');
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
