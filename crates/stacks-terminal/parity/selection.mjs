import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const spikeDir = path.resolve(here, '..');
const root = path.resolve(spikeDir, '../..');
const casesPath = path.join(here, 'selection-cases.json');
const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
const ghostty = JSON.parse(execFileSync('cargo', ['run', '--quiet', '--bin', 'selection_parity', '--', casesPath], { cwd: spikeDir, encoding: 'utf8' }));

const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
let browser;
const xterm = [];
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('pageerror', (error) => console.error('PAGE ERROR', error));
  await page.goto(`${server.resolvedUrls.local[0]}crates/stacks-terminal/parity/harness.html`);
  await page.waitForFunction(() => !!window.parity);
  for (const testCase of cases) {
    const text = await page.evaluate(async (testCase) => {
      window.parity.init(testCase.cols, testCase.rows);
      await window.parity.write(testCase.text);
      return window.parity.select(testCase.start[0], testCase.start[1], testCase.end[0], testCase.end[1]);
    }, testCase);
    // Stacks' copy-on-select applies this same trim after xterm.getSelection().
    xterm.push({ name: testCase.name, text: text.replace(/[^\S\r\n]+$/gm, '') });
  }
} finally {
  if (browser) await browser.close();
  await server.close();
}

const differences = [];
for (const ghost of ghostty) {
  const term = xterm.find((candidate) => candidate.name === ghost.name);
  if (!term || term.text !== ghost.text) differences.push({ name: ghost.name, ghostty: ghost.text, xterm: term?.text });
}
fs.writeFileSync(path.join(here, 'selection-report.json'), JSON.stringify({ cases: cases.length, differences }, null, 2));
console.log(`selection parity: ${cases.length} cases, ${differences.length} differences`);
for (const difference of differences) console.log(difference);
if (differences.length) process.exitCode = 1;
