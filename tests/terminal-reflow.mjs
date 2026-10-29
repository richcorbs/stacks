// Deterministic VT fixtures, not a substitute for native shell/TUI smoke tests.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const command = '$ printf %s ' + 'abcdefghijklmnop'.repeat(12);
const unicode = '$ echo ' + '世界🙂e\u0301'.repeat(30);
const history = Array.from({ length: 70 }, (_, i) => `history-${i}: ${'abcdef'.repeat(20)}`);
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      async function run(option, text, exercise) {
        const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        try {
          await page.goto(`${server.resolvedUrls.local[0]}tests/terminal-reflow.html`);
          await page.waitForFunction(() => !!window.reflowTest);
          assert.equal(await page.evaluate(() => window.reflowTest.defaultValue), false);
          await page.evaluate(value => window.reflowTest.configure(value), option);
          await page.evaluate(text => window.reflowTest.write(text), text);
          return await exercise(page);
        } finally {
          await page.evaluate(() => window.reflowTest.dispose());
          await page.close();
          assert.deepEqual(errors, []);
        }
      }
      const resize = (page, width) => page.evaluate(width => window.reflowTest.resize(width), width);
      const snap = page => page.evaluate(() => window.reflowTest.snapshot());
      const write = (page, text) => page.evaluate(text => window.reflowTest.write(text), text);
      const results = [];
      for (const option of [undefined, false, true]) {
        const active = [];
        for (const text of [command, unicode]) {
          active.push(await run(option, text, async page => {
            const before = await snap(page);
            const wide = await resize(page, 1000); // maximize
            const narrow = await resize(page, 300); // split resize
            const restored = await resize(page, 500); // restore
            assert.equal(await page.evaluate(() => window.reflowTest.focus(1)), true);
            assert.equal(await page.evaluate(() => window.reflowTest.focus(0)), true);
            assert.equal(await page.evaluate(() => window.reflowTest.remount()), true);
            assert.deepEqual((await snap(page)).logical, restored.logical);
            if (option === true) {
              assert.equal(wide.logical.join(''), text);
              assert.equal(narrow.logical.join(''), text);
              assert.equal(restored.logical.join(''), text);
              assert(wide.cursorY < before.cursorY, 'enabled reflow should consolidate cursor line');
            } else {
              assert.equal(wide.cursorY, before.cursorY, 'shell owns active-line redraw by default');
            }
            return { before, wide, narrow, restored };
          }));
        }
        const scrollback = await run(option, history.join('\r\n') + '\r\n$', async page => {
          // Let initial-fit bottom-pinning callbacks/window expire before entering reader mode.
          await page.waitForTimeout(800);
          await page.evaluate(() => window.reflowTest.scrollBack());
          for (const width of [1000, 300, 500]) {
            const state = await resize(page, width);
            await page.waitForTimeout(30);
            assert.deepEqual(state.logical, [...history, '$']);
            const settled = await snap(page);
            assert(settled.viewportY < settled.baseY, 'reader must remain in scrollback');
          }
          return (await snap(page)).logical;
        });
        const alternate = await run(option, 'normal buffer\r\n$', async page => {
          // vim/less-style alternate screen with absolute positioning and explicit redraw.
          await write(page, '\x1b[?1049h\x1b[2J\x1b[HEDITOR 世界🙂\x1b[5;1Hstatus');
          for (const width of [1000, 300, 500]) {
            await resize(page, width);
            await write(page, '\x1b[2J\x1b[HEDITOR 世界🙂\x1b[5;1Hstatus');
            const state = await snap(page);
            assert.equal(state.type, 'alternate');
            assert.equal(state.physical[0], 'EDITOR 世界🙂');
            assert.equal(state.physical[4], 'status');
            assert.equal(state.cursorY, 4);
          }
          await write(page, '\x1b[?1049l');
          const state = await snap(page);
          assert.equal(state.type, 'normal');
          assert.deepEqual(state.logical, ['normal buffer', '$']);
          return state.logical;
        });
        results.push({ active, scrollback, alternate });
      }
      assert.deepEqual(results[0], results[1], 'unset and explicit false must agree');
      assert.deepEqual(results[1].scrollback, results[2].scrollback);
      assert.deepEqual(results[1].alternate, results[2].alternate);
      console.log(`PASS ${engine.name()}: default=false; active command/Unicode reflow differs; history, alternate-screen redraw, split/maximize/restore, focus and cached remount pass in all modes`);
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
