// npm run test:composer-resize (first run: npx playwright install chromium webkit)
// Regression coverage for the focused-composer restyle path. The real
// PiGuiView and textarea layout run in Chromium and WebKit while only the Pi
// session transport and Tauri IPC are mocked.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
let browser;
let checks = 0;
try {
  for (const engine of [chromium, webkit]) {
    browser = await engine.launch();
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error));
    await page.route('**/src/pi/usePiSession.ts', route => route.fulfill({
      contentType: 'application/javascript',
      body: 'export { usePiSession } from "/tests/pi-chat-scroll-session.ts";',
    }));
    await page.goto(`${server.resolvedUrls.local[0]}tests/pi-composer-resize.html`);
    const textarea = page.locator('.piComposer textarea');
    await textarea.waitFor();
    await page.waitForTimeout(150);

    // Spy only on the real composer's inline style, not the off-screen mirror.
    await page.evaluate(() => {
      const input = document.querySelector('.piComposer textarea');
      const target = input.style;
      const writes = [];
      const proxy = new Proxy(target, {
        get(object, property) {
          const value = Reflect.get(object, property, object);
          return typeof value === 'function' ? value.bind(object) : value;
        },
        set(object, property, value) {
          if (property === 'height' || property === 'maxHeight' || property === 'overflowY') {
            writes.push({ property, value: String(value) });
          }
          return Reflect.set(object, property, value, object);
        },
      });
      Object.defineProperty(input, 'style', { configurable: true, get: () => proxy });
      window.composerWrites = () => writes.splice(0);
      window.composerHeight = () => input.offsetHeight;
      window.composerOverflow = () => input.style.overflowY;
      window.setComposerValue = (value, isComposing) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', isComposing }));
      };
      window.composeStart = () => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      window.composeEnd = () => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    const writes = () => page.evaluate(() => window.composerWrites());
    const height = () => page.evaluate(() => window.composerHeight());
    const overflow = () => page.evaluate(() => window.composerOverflow());
    const label = (name) => `${engine.name()} ${name}`;

    // Typing inside a line that already fits must not write style at all.
    await textarea.click();
    await page.keyboard.type('copy', { delay: 80 });
    await page.waitForTimeout(150);
    assert.deepEqual(await writes(), [], `${label('typing inside a fitting line')}: style writes`);
    checks++;

    // A long value grows once, then a short value shrinks once.
    const fittingHeight = await height();
    await textarea.fill('A paragraph that wraps across the composer. '.repeat(20));
    await page.waitForTimeout(150);
    const grownHeight = await height();
    const growthWrites = await writes();
    assert(grownHeight > fittingHeight, `${label('growth')}: ${fittingHeight} -> ${grownHeight}`);
    assert.equal(growthWrites.filter(write => write.property === 'height').length, 1,
      `${label('growth')}: expected one height write, got ${JSON.stringify(growthWrites)}`);
    assert.equal(await overflow(), 'auto', `${label('growth')}: overflowY`);
    checks++;

    await textarea.fill('one line again');
    await page.waitForTimeout(150);
    const shrunkHeight = await height();
    const shrinkWrites = await writes();
    assert(shrunkHeight < grownHeight, `${label('shrink')}: ${grownHeight} -> ${shrunkHeight}`);
    assert.equal(shrinkWrites.filter(write => write.property === 'height').length, 1,
      `${label('shrink')}: expected one height write, got ${JSON.stringify(shrinkWrites)}`);
    assert.equal(await overflow(), 'hidden', `${label('shrink')}: overflowY`);
    checks++;

    // Font-size changes still force a restyle even with unchanged text.
    await page.evaluate(() => window.composerTest.setFontSize(17));
    await page.waitForTimeout(150);
    const fontWrites = await writes();
    assert((await height()) > shrunkHeight, `${label('font size')}: height did not grow`);
    assert(fontWrites.some(write => write.property === 'height'),
      `${label('font size')}: expected a height write, got ${JSON.stringify(fontWrites)}`);
    checks++;

    // IME composition defers the restyle, then the settled value restyles once.
    await page.evaluate(() => window.composerTest.setFontSize(13));
    await page.waitForTimeout(150);
    await textarea.fill('short');
    await page.waitForTimeout(150);
    await writes();
    const beforeComposition = await height();
    await page.evaluate(() => {
      window.composeStart();
      window.setComposerValue('A composition that wraps across several lines. '.repeat(20), true);
    });
    await page.waitForTimeout(150);
    assert.deepEqual(await writes(), [], `${label('IME composing')}: style writes`);
    assert.equal(await height(), beforeComposition, `${label('IME composing')}: height changed`);
    await page.evaluate(() => window.composeEnd());
    await page.waitForTimeout(150);
    const compositionWrites = await writes();
    assert((await height()) > beforeComposition, `${label('IME settled')}: height did not grow`);
    assert(compositionWrites.some(write => write.property === 'height'),
      `${label('IME settled')}: expected a height write, got ${JSON.stringify(compositionWrites)}`);
    checks++;

    assert.deepEqual(errors, []);
    await browser.close();
    browser = undefined;
  }
  console.log(`PASS ${checks} composer resize checks`);
} finally {
  await browser?.close();
  await server.close();
}
