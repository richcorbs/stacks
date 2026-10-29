// npm run test:chat-scroll (first run: npx playwright install chromium webkit)
// A real PiGuiView/CardChatView, with only the Pi session transport mocked.
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
    await page.addInitScript(() => {
      const nativeFrame = window.requestAnimationFrame.bind(window);
      const pending = new Map();
      let held = false;
      let id = 0;
      const deliver = key => nativeFrame(time => {
        const callback = pending.get(key);
        if (!callback || held) return;
        pending.delete(key);
        callback(time);
      });
      window.requestAnimationFrame = callback => {
        pending.set(++id, callback);
        if (!held) deliver(id);
        return id;
      };
      window.cancelAnimationFrame = key => pending.delete(key);
      window.holdChatFrames = value => {
        held = value;
        if (!held) for (const key of pending.keys()) deliver(key);
      };
    });
    await page.route('**/src/pi/usePiSession.ts', route => route.fulfill({
      contentType: 'application/javascript',
      body: 'export { usePiSession } from "/tests/pi-chat-scroll-session.ts";',
    }));
    await page.goto(`${server.resolvedUrls.local[0]}tests/pi-chat-scroll.html`);
    await page.locator('textarea').waitFor();
    const update = patch => page.evaluate(patch => window.chatTest.updateSession(patch), patch);
    const hold = value => page.evaluate(value => window.holdChatFrames(value), value);
    const settle = () => page.waitForTimeout(100);
    const bottom = async label => {
      // Timer polling deliberately does not depend on the animation frames that
      // an inactive WKWebView can withhold. Inspect the actual clipping chain,
      // not just scrollHeight or the inner scrollport's rectangle.
      await page.waitForFunction(() => {
        const viewport = document.querySelector('.piGuiConversation');
        return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 1;
      }, null, { polling: 25, timeout: 2000 });
      const geometry = await page.locator('.piGuiConversation').evaluate(viewport => {
        const message = viewport.querySelector('.piGuiTranscript').lastElementChild;
        const time = message.querySelector('time');
        const bottom = (time ?? message).getBoundingClientRect().bottom;
        const clips = [];
        for (let parent = viewport; parent; parent = parent.parentElement) {
          if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
            const rect = parent.getBoundingClientRect();
            clips.push({ name: parent.className, bottom: rect.top + parent.clientTop + parent.clientHeight });
          }
        }
        return { bottom, clips };
      });
      for (const clip of geometry.clips) assert(geometry.bottom <= clip.bottom + 1,
        `${label}: bottom ${geometry.bottom} clipped by ${clip.name} at ${clip.bottom}`);
      checks++;
    };
    const pause = async (top = 100) => {
      await page.locator('.piGuiConversation').evaluate((viewport, top) => {
        viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
        viewport.scrollTop = top;
      }, top);
      await settle();
    };
    for (const card of [false, true]) {
      await hold(false);
      await page.evaluate(card => window.chatTest.mount(card), card);
      await page.locator('textarea').waitFor();
      for (const suspended of [false, true]) {
        for (const [kind, content] of Object.entries({
          reported: '1.\n2.\n3.\n4.\n5.',
          multiline: 'A plain line  \n'.repeat(50),
          wrapping: 'A long paragraph that wraps as the viewport narrows. '.repeat(120),
          markdown: '# Heading\n\n' + '**Markdown** with a paragraph.\n\n'.repeat(30),
          code: '```ts\n' + 'const value = "a line long enough to wrap inside a narrow chat pane";\n'.repeat(50) + '```',
        })) {
          const label = `${engine.name()} ${card ? 'card' : 'workspace'} ${suspended ? 'inactive' : 'active'} ${kind}`;
          await hold(false);
          await update({ messages: [{ role: 'user', content: 'Earlier history\n\n'.repeat(35), timestamp: Date.now() }], streamingText: '', isStreaming: false });
          await page.locator('textarea').fill(content);
          await settle();
          await pause(); // Sending restores following from older history.
          await hold(suspended);
          await page.locator('textarea').press('Enter');
          await settle();
          await bottom(`${label} submit/composer collapse`);
          const messages = await page.evaluate(() => [...document.querySelectorAll('.piGuiTranscript > .piMessage')].length);
          assert.equal(messages, 2);
          await update({ isStreaming: true, isStreamingText: true, streamingText: content });
          await bottom(`${label} stream start`);
          await update({ streamingText: content.repeat(3) });
          await bottom(`${label} stream growth`);
          await pause();
          const readingTop = await page.locator('.piGuiConversation').evaluate(viewport => viewport.scrollTop);
          await update({ streamingText: content.repeat(4) });
          await settle();
          assert.equal(await page.locator('.piGuiConversation').evaluate(viewport => viewport.scrollTop), readingTop,
            `${label}: streaming pulled the reader down`);
          await page.locator('.piGuiConversation').evaluate(viewport => { viewport.scrollTop = viewport.scrollHeight; });
          await settle();
          await update({ streamingText: content.repeat(5) });
          await bottom(`${label} return to bottom`);
          // Complete the stream and insert its timestamp in a later commit.
          const history = [{ role: 'user', content: 'Earlier history\n\n'.repeat(35), timestamp: Date.now() },
            { role: 'user', content, timestamp: Date.now() }];
          const assistant = { role: 'assistant', content: [{ type: 'text', text: content.repeat(5) }] };
          await update({ messages: [...history, assistant], streamingText: '', isStreamingText: false, isStreaming: false });
          await bottom(`${label} completion`);
          await update({ messages: [...history, { ...assistant, timestamp: Date.now() }] });
          await bottom(`${label} delayed timestamp, unchanged message count`);
          // Content-only growth (no session update), then wrapping/viewport resize.
          await page.locator('.piGuiTranscript').evaluate(transcript => {
            const paragraph = document.createElement('p');
            paragraph.textContent = 'Delayed rendered content. '.repeat(80);
            transcript.lastElementChild.querySelector('.piMessageText').append(paragraph);
          });
          await bottom(`${label} delayed layout`);
          await page.setViewportSize({ width: 700, height: 600 });
          await page.locator('#fixture').evaluate(fixture => { fixture.style.width = '340px'; fixture.style.height = '400px'; });
          await bottom(`${label} viewport and wrapping`);
          await page.setViewportSize({ width: 1100, height: 800 });
          await page.locator('#fixture').evaluate(fixture => { fixture.style.width = '520px'; fixture.style.height = '500px'; });
          await bottom(`${label} viewport restored`);
          console.log(`PASS ${label}`);
        }
        await page.evaluate(card => window.chatTest.mount(card), card);
        await page.locator('textarea').waitFor();
        await hold(suspended);
        const history = Array.from({ length: 85 }, (_, index) => ({ role: 'user', content: `Older message ${index}\n\nwith another paragraph`, timestamp: Date.now() }));
        await update({ messages: history });
        await pause(0);
        const before = await page.locator('.piGuiConversation').evaluate(viewport => ({ height: viewport.scrollHeight, top: viewport.scrollTop }));
        await page.getByRole('button', { name: 'Load older messages' }).dispatchEvent('click');
        await settle();
        await page.locator('.piGuiConversation').evaluate((viewport, before) => {
          const expected = before.top + viewport.scrollHeight - before.height;
          if (Math.abs(viewport.scrollTop - expected) > 1) throw new Error(`History jumped: ${viewport.scrollTop} != ${expected}`);
        }, before);
        const top = await page.locator('.piGuiConversation').evaluate(viewport => viewport.scrollTop);
        await update({ messages: [...history, { role: 'assistant', content: [{ type: 'text', text: 'Later text\n\n'.repeat(30) }], timestamp: Date.now() }] });
        await settle();
        assert.equal(await page.locator('.piGuiConversation').evaluate(viewport => viewport.scrollTop), top, 'History loading must keep following paused');
      }
    }
    assert.deepEqual(errors, []);
    await browser.close();
    browser = undefined;
  }
  console.log(`PASS ${checks} rendered bottom/timestamp checks, plus reader pause and history anchoring`);
} finally {
  await browser?.close();
  await server.close();
}
