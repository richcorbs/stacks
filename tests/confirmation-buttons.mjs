// Real layout regression: node tests/confirmation-buttons.mjs
// Requires: npx playwright install chromium webkit
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';

const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
await server.listen();
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [900, 320]) for (const scale of [0, 8]) for (const multiple of [false, true]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.clock.install();
        await page.goto(`${server.resolvedUrls.local[0]}tests/confirmation-buttons.html?scale=${scale}${multiple ? '&multiple' : ''}`);
        await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
        const bounds = () => page.locator('button').evaluateAll(buttons => buttons.map(button => {
          const { x, y, width, height } = button.getBoundingClientRect();
          return { x, y, width, height };
        }));
        const assertCentered = async () => {
          const offsets = await page.locator('button:has(.confirmationButtonLabel)').evaluateAll(buttons => buttons.map(button => {
            const label = button.querySelector('.confirmationButtonText').getBoundingClientRect();
            const suffixNode = button.querySelector('.confirmationButtonSuffix');
            const suffix = suffixNode.textContent ? suffixNode.getBoundingClientRect() : label;
            const visibleCenter = (Math.min(label.left, suffix.left) + Math.max(label.right, suffix.right)) / 2;
            const box = button.getBoundingClientRect();
            return Math.abs(visibleCenter - (box.left + box.right) / 2);
          }));
          assert(offsets.every(offset => offset < 1), `visible content centered: ${offsets}`);
        };
        const initial = await bounds();
        await assertCentered();
        if (width === 900 && scale === 0 && multiple) await page.screenshot({ path: `/tmp/confirmation-buttons-${engine.name()}-2.png` });
        assert(await page.locator('button').nth(1).isDisabled());
        for (const step of [1, 0]) {
          await page.clock.runFor(1000);
          assert.deepEqual(await bounds(), initial, `${engine.name()} width=${width} scale=${scale} multiple=${multiple} remaining=${step}`);
          assert.equal(await page.locator('button').nth(1).isDisabled(), step > 0);
          await assertCentered();
          if (width === 900 && scale === 0 && multiple) await page.screenshot({ path: `/tmp/confirmation-buttons-${engine.name()}-${step}.png` });
        }
        assert.equal(await page.locator('.confirmationButtonSizer:not([aria-hidden="true"])').count(), 0);
        if (multiple) {
          assert.equal(await page.locator('#action-icon').count(), 1);
          assert.equal(await page.locator('#action-label').count(), 1);
          assert(initial[2].width > initial[1].width, 'different labels retain different widths');
        }
        const overflow = await page.locator('button').evaluateAll(buttons => buttons.some(button => button.scrollWidth > button.clientWidth || button.getBoundingClientRect().right > innerWidth));
        assert.equal(overflow, false, 'no button clipping or viewport overflow');
        assert.deepEqual(errors, []);
        if (width === 320 && scale === 8 && multiple) await page.screenshot({ path: `/tmp/confirmation-buttons-${engine.name()}.png` });
        await page.close();
      }
      console.log(`PASS ${engine.name()}: stable countdown bounds/action positions, centered visible content, intrinsic widths, markup, narrow dialogs, text scaling`);
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
