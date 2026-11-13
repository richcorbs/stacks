import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const spikeDir = path.resolve(here, '..');
const root = path.resolve(spikeDir, '../..');
const cases = JSON.parse(fs.readFileSync(path.join(here, 'key-cases.json'), 'utf8'));
const ghostty = JSON.parse(execFileSync('cargo', ['run', '--quiet', '--bin', 'key_parity', '--', path.join(here, 'key-cases.json')], { cwd: spikeDir, encoding: 'utf8' }));

const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
let browser;
const xterm = [];
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('pageerror', (error) => console.error('PAGE ERROR', error));
  await page.goto(`${server.resolvedUrls.local[0]}spikes/gpui-terminal/parity/harness.html`);
  await page.waitForFunction(() => !!window.parity);
  for (const testCase of cases) {
    await page.evaluate(async (testCase) => {
      window.parity.init(80, 24);
      if (testCase.setup) await window.parity.write(testCase.setup);
      window.parity.resetKeys();
    }, testCase);
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.press(testCase.playwright);
    await page.waitForTimeout(30);
    const keys = await page.evaluate(() => window.parity.keys());
    xterm.push({ name: testCase.name, base64: Buffer.from(keys.join(''), 'utf8').toString('base64'), display: keys.join('') });
  }
} finally {
  if (browser) await browser.close();
  await server.close();
}

const differences = [];
for (const ghost of ghostty) {
  const term = xterm.find((candidate) => candidate.name === ghost.name);
  if (!term || term.base64 !== ghost.base64) {
    differences.push({ name: ghost.name, ghostty: ghost.base64, xterm: term?.base64, xtermDisplay: term?.display });
  }
}
const report = { cases: cases.length, differences };
fs.writeFileSync(path.join(here, 'key-report.json'), JSON.stringify(report, null, 2));
console.log(`key parity: ${cases.length} keys, ${differences.length} differences`);
for (const difference of differences) console.log(difference);
if (differences.length) process.exitCode = 1;
