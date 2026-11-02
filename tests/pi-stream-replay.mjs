// node tests/pi-stream-replay.mjs [baseline-git-ref]
// Real Chromium React/Markdown replay, with mocked process transport only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const baseline = execFileSync('git', ['show', `${process.argv[2] ?? 'HEAD'}:src/pi/sessionController.ts`], { encoding: 'utf8' });
const browser = await chromium.launch();
try {
  for (const mode of ['baseline', 'batched']) {
    const server = await createServer({
      plugins: [{ name: 'replay-baseline', enforce: 'pre', load(id) {
        if (mode === 'baseline' && id.endsWith('/src/pi/sessionController.ts')) return baseline;
      } }],
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    await server.listen();
    try {
      for (const agents of [1, 4]) {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.goto(`${server.resolvedUrls.local[0]}tests/pi-stream-replay.html`);
        await page.waitForFunction(() => typeof window.replay === 'function');
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Performance.enable');
        const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]));
        const before = await metrics();
        let finished = false;
        const replay = page.evaluate(agents => window.replay(agents), agents).finally(() => { finished = true; });
        const input = page.getByRole('textbox');
        await input.waitFor();
        await input.focus();
        const latencies = [];
        while (!finished) {
          const start = performance.now();
          await page.keyboard.type('x');
          // Verify that the controlled React input committed the key, not just
          // that the browser accepted an input protocol command.
          const value = await input.inputValue();
          assert(value.endsWith('x'));
          latencies.push(performance.now() - start);
          await page.waitForTimeout(25);
        }
        const result = await replay;
        const after = await metrics();
        latencies.sort((a, b) => a - b);
        assert(result.exact);
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ mode, ...result, mainThreadTaskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000), inputSamples: latencies.length, inputRoundTripP50Ms: Math.round(latencies[Math.floor(latencies.length * 0.5)]), inputRoundTripP95Ms: Math.round(latencies[Math.floor(latencies.length * 0.95)]) }));
        await page.close();
      }
    } finally { await server.close(); }
  }
} finally { await browser.close(); }
