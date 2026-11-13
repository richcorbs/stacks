import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const spikeDir = path.resolve(here, '..');
const root = path.resolve(spikeDir, '../..');
const casesPath = path.join(here, 'paste-cases.json');
const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
const known = JSON.parse(fs.readFileSync(path.join(here, 'known-divergences.json'), 'utf8'));
const ghostty = JSON.parse(execFileSync('cargo', ['run', '--quiet', '--bin', 'paste_parity', '--', casesPath], { cwd: spikeDir, encoding: 'utf8' }));

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
    const data = await page.evaluate(async (testCase) => {
      window.parity.init(20, 4);
      if (testCase.bracketed) await window.parity.write('\x1b[?2004h');
      return window.parity.paste(testCase.text);
    }, testCase);
    xterm.push({ name: testCase.name, base64: Buffer.from(data, 'utf8').toString('base64'), display: data });
  }
} finally {
  if (browser) await browser.close();
  await server.close();
}

const differences = [];
const allowed = [];
for (const ghost of ghostty) {
  const term = xterm.find((candidate) => candidate.name === ghost.name);
  if (!term || term.base64 !== ghost.base64) {
    const knownEntry = (known.pasteAllow || []).find((entry) => entry.name === ghost.name);
    if (knownEntry) allowed.push({ name: ghost.name, reason: knownEntry.reason });
    else differences.push({ name: ghost.name, ghostty: ghost.base64, xterm: term?.base64, xtermDisplay: term?.display });
  }
}
fs.writeFileSync(path.join(here, 'paste-report.json'), JSON.stringify({ cases: cases.length, differences, allowed }, null, 2));
console.log(`paste parity: ${cases.length} cases, ${differences.length} unknown differences, ${allowed.length} recorded divergences`);
for (const difference of differences) console.log(difference);
if (differences.length) process.exitCode = 1;
