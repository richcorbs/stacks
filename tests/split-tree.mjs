// npm run test:split-tree (first run: npx playwright install chromium webkit)
// Measures the split-tree contract the shared module must preserve: layout DOM,
// focus outcomes, session disposal and the Pi composer focus path. The golden file
// is generated from the pre-extraction behaviour and must not change.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';

const GOLDEN = new URL('./fixtures/split-tree-golden.json', import.meta.url);
const updateGolden = process.env.UPDATE_SPLIT_TREE_GOLDEN === '1';

const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
let browser;
const measured = {};
let checks = 0;
try {
  for (const engine of [chromium, webkit]) {
    browser = await engine.launch();
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error));
    await page.route('**/src/pi/usePiSession.ts', (route) => route.fulfill({
      contentType: 'application/javascript',
      body: 'export { usePiSession } from "/tests/pi-chat-scroll-session.ts";',
    }));
    await page.goto(`${server.resolvedUrls.local[0]}tests/split-tree.html`);
    await page.locator('[data-pi-pane-id]').first().waitFor();

    const transcript = await page.evaluate(() => window.splitTreeTest.transcript());
    // The transcript ends with the last pane closed, so mount a fresh contract page.
    await page.reload();
    await page.locator('[data-pi-pane-id]').first().waitFor();
    const composer = await page.evaluate(() => window.splitTreeTest.composerFocusAcrossSplit());
    assert.deepEqual(errors, [], `${engine.name()}: page errors`);
    measured[engine.name()] = { transcript, composer };

    // Invariants are asserted here as well as in the golden file so a failed
    // comparison names the rule that broke rather than only a JSON offset.
    const byStep = Object.fromEntries(transcript.map(({ step, snapshot }) => [step, snapshot]));
    const initial = byStep.initial;
    assert.deepEqual(initial.panes.map((pane) => pane.id), ['pane:one', 'pane:two', 'pane:three'], 'visual order');
    assert.deepEqual(initial.controller.paneIds, ['pane:one', 'pane:two', 'pane:three'], 'controller order');
    for (const [step, snapshot] of Object.entries(byStep)) {
      const leaves = flattenLeaves(snapshot.controller.tree);
      assert.ok(snapshot.controller.focusedPaneId === null || leaves.includes(snapshot.controller.focusedPaneId), `${step}: focus is a leaf`);
      assert.ok(snapshot.controller.maximizedPaneId === null || leaves.includes(snapshot.controller.maximizedPaneId), `${step}: maximize is a leaf`);
      assert.deepEqual(leaves, snapshot.controller.paneIds, `${step}: pane ids match the tree`);
      assert.equal(new Set(leaves).size, leaves.length, `${step}: no duplicate leaves`);
    }
    assert.equal(byStep['maximize'].controller.maximizedPaneId, 'pane:new-2', 'maximize follows focus');
    assert.equal(byStep['navigate forward while maximized'].controller.maximizedPaneId, 'pane:three', 'maximize follows navigation');
    assert.equal(byStep['restore'].controller.maximizedPaneId, null, 'restore clears maximize');
    assert.equal(byStep['close focused pane'].controller.focusedPaneId, 'pane:one', 'close selects the previous visual pane');
    assert.equal(byStep['close previous pane'].controller.focusedPaneId, 'pane:three', 'closing the first visual pane wraps to the previous visual pane');
    assert.deepEqual(new Set(byStep['close remaining panes'].disposed), new Set(['pane:one', 'pane:two', 'pane:new-1', 'pane:new-2', 'pane:three']), 'every closed pane is disposed once');
    assert.equal(byStep['resize first (manual)'].controller.tree.second.kind, 'split', 'manual resize keeps the tree');
    assert.equal(byStep['close focused pane'].controller.tree.kind, 'split', 'automatic siblings stay split after a close');
    const compositor = Object.fromEntries(composer.map(({ step, snapshot }) => [step, snapshot]));
    assert.equal(compositor['focused composer before split'].composerFocused, true, 'composer takes focus');
    assert.equal(compositor['focus new composer'].focusedPaneInDom, compositor['focus new composer'].controller.focusedPaneId, 'new pane composer is focusable');
    for (const step of ['incoming message', 'stream update', 'stream complete']) {
      assert.equal(compositor[step].composerFocused, true, `${step}: composer keeps focus`);
      assert.equal(compositor[step].focusedPaneInDom, compositor['focus new composer'].focusedPaneInDom, `${step}: the same composer keeps focus`);
    }
    checks += 3;
    console.log(`PASS ${engine.name()} split tree + composer focus`);
    await browser.close();
    browser = undefined;
  }
} finally {
  await browser?.close();
  await server.close();
}

const golden = JSON.stringify(measured);
if (updateGolden) {
  fs.writeFileSync(GOLDEN, golden + '\n');
  console.log(`Wrote ${GOLDEN.pathname}`);
} else {
  assert.equal(golden, fs.readFileSync(GOLDEN, 'utf8').trimEnd(), 'split-tree contract changed; if that is intentional, rerun with UPDATE_SPLIT_TREE_GOLDEN=1 and explain the difference');
}
console.log(`split tree contract: ${checks} checks`);

function flattenLeaves(tree) {
  if (tree.kind === 'leaf') return [tree.terminalId];
  if (tree.kind === 'split') return [...flattenLeaves(tree.first), ...flattenLeaves(tree.second)];
  return [];
}
