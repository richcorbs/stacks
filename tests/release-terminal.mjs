// npm run test:release-terminal (requires npx playwright install chromium webkit)
// Actual release rendering path, harmless streaming output, no native release.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${server.resolvedUrls.local[0]}tests/release-terminal.html`);
      await page.waitForFunction(() => window.releaseTerminalTest?.session.term.buffer.active.baseY > 20);
      async function checkCorners(label, color, expected = [true, true]) {
        await page.waitForTimeout(180); // border color transition + resize debounce
        const terminal = page.locator('.releaseTerminal > .terminal');
        const png = await terminal.screenshot(process.env.RELEASE_TERMINAL_SCREENSHOTS ? {
          path: `${process.env.RELEASE_TERMINAL_SCREENSHOTS}/${engine.name()}-${label.replaceAll(' ', '-')}.png`,
        } : {});
        // Test painted pixels, not just CSS/DOM geometry: find a connected blue
        // path from each vertical side to the bottom edge through its corner.
        const connected = await page.evaluate(async ({ png, color }) => {
          const image = new Image();
          image.src = `data:image/png;base64,${png}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width; canvas.height = image.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(image, 0, 0);
          const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
          return [false, true].map(right => {
            const size = 24;
            const blue = (x, y) => {
              const px = right ? canvas.width - 1 - x : x;
              const py = canvas.height - size + y;
              const i = (py * canvas.width + px) * 4;
              // Rounded 1px strokes are antialiased: accept a partial blend
              // with the terminal background, but not the gray dialog border.
              const background = [15, 20, 27];
              const alpha = (data[i + 2] - background[2]) / (color[2] - background[2]);
              return alpha > 0.25 && alpha < 1.15 && color.every((c, channel) =>
                Math.abs(data[i + channel] - (background[channel] + alpha * (c - background[channel]))) < 15);
            };
            const queue = [];
            const seen = new Set();
            for (let x = 0; x < 3; x++) if (blue(x, 0)) queue.push([x, 0]);
            while (queue.length) {
              const [x, y] = queue.pop();
              const key = y * size + x;
              if (seen.has(key)) continue;
              seen.add(key);
              if (x === size - 1 && y >= size - 3) return true;
              for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                const nx = x + dx, ny = y + dy;
                if (nx >= 0 && nx < size && ny >= 0 && ny < size && blue(nx, ny)) queue.push([nx, ny]);
              }
            }
            return false;
          });
        }, { png: png.toString('base64'), color });
        assert.deepEqual(connected, expected, `${engine.name()} ${label}: left/right bottom border connectivity`);
        const geometry = await terminal.evaluate(element => {
          const rect = element.getBoundingClientRect();
          const parent = element.parentElement.getBoundingClientRect();
          return { contained: rect.bottom <= parent.bottom && rect.right <= parent.right, padding: getComputedStyle(element.querySelector('.terminalHostFrame')).padding };
        });
        assert.equal(geometry.contained, true);
        assert.equal(geometry.padding, '6px 0px 4px 6px');
        console.log(`PASS ${engine.name()} ${label}: bottom corner connectivity ${connected}; padding preserved`);
      }
      // Negative control: prove this painted-pixel assertion catches the
      // original ancestor clipping, and that the fix does not resize content.
      const original = await page.addStyleTag({ content: '.releaseTerminal > .terminal { border-radius: 0; }' });
      const originalSize = await page.locator('.terminalHost').boundingBox();
      await checkCorners('original square border clips', [59, 130, 246], [false, false]);
      await original.evaluate(element => element.remove());
      assert.deepEqual(await page.locator('.terminalHost').boundingBox(), originalSize);
      await checkCorners('streaming', [59, 130, 246]);
      await page.locator('.releaseTerminal .xterm-screen').hover();
      await page.mouse.wheel(0, -500);
      await page.waitForFunction(() => {
        const buffer = window.releaseTerminalTest.session.term.buffer.active;
        return buffer.viewportY < buffer.baseY;
      });
      await checkCorners('scrolled back', [59, 130, 246]);
      await page.setViewportSize({ width: 843, height: 631 });
      await checkCorners('resized', [59, 130, 246]);
      await page.getByRole('button', { name: 'Other tab', exact: true }).click();
      await page.waitForTimeout(100);
      await page.getByRole('button', { name: 'RELEASE', exact: true }).first().click();
      await checkCorners('tab restored', [59, 130, 246]);
      await page.evaluate(() => document.body.classList.add('appWindowInactive'));
      await checkCorners('window inactive', [41, 80, 129]);
      await page.evaluate(() => document.body.classList.remove('appWindowInactive'));
      await checkCorners('window active again', [59, 130, 246]);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
