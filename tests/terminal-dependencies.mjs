// Real xterm 6 + all addons, in Chromium and WebKit. No Tauri/PTY transport.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${server.resolvedUrls.local[0]}tests/terminal-dependencies.html`);
      await page.waitForFunction(() => !!window.terminalTest);
      await page.evaluate(async () => {
        await window.terminalTest.write(0, 'héllo 世界\r\nhttps://example.com\r\n');
        await window.terminalTest.write(1, 'second pane');
      });
      const result = await page.evaluate(() => {
        const { sessions } = window.terminalTest;
        const { terminal, fit, search } = sessions[0];
        const originalCols = terminal.cols;
        const found = search.findNext('世界');
        const selection = terminal.getSelection();
        document.getElementById('first').style.width = '70%';
        document.getElementById('second').style.width = '30%';
        sessions.forEach(session => session.fit.fit());
        const resizedCols = terminal.cols;
        terminal.focus(); // Standalone library harness, not app session focus.
        const focused = document.activeElement === terminal.textarea;
        const element = terminal.element;
        document.getElementById('second').append(element);
        fit.fit();
        const retained = terminal.buffer.active.getLine(0).translateToString(true);
        const second = sessions[1].terminal.buffer.active.getLine(0).translateToString(true);
        const unicode = terminal.unicode.activeVersion;
        sessions.forEach(session => session.terminal.dispose());
        return { originalCols, resizedCols, found, selection, focused, retained, second, unicode };
      });
      assert(result.resizedCols > result.originalCols);
      assert.equal(result.found, true);
      assert.equal(result.selection, '世界');
      assert.equal(result.focused, true);
      assert.equal(result.retained, 'héllo 世界');
      assert.equal(result.second, 'second pane');
      assert.equal(result.unicode, '11');
      assert.deepEqual(errors, []);
      console.log(`PASS ${engine.name()}: terminal rendering, Unicode, search, focus, split sizing, remount, disposal`);
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
