// npm run test:card-detail-alignment (first run: npx playwright install chromium webkit)
// Real geometry against src/styles.css, with no CSS-source parsing.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';

// 1100px is the default card width (the card stops at 1000px); 640px crosses the
// 700px breakpoint where .kanbanDetail > footer used to collapse to 14px.
const viewports = [
  { label: 'default width', width: 1100, height: 900, overviewPadding: { left: '20px', right: '14px' } },
  { label: 'narrow width (<700px)', width: 640, height: 900, overviewPadding: { left: '14px', right: '14px' } },
];

const measureAgent = (page) => page.evaluate(() => {
  const box = (element) => {
    const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
    return { left, right, top, bottom, width, height };
  };
  const card = document.querySelector('#alignment-card');
  const composer = card.querySelector('.cardChat .piComposer');
  const buttons = [...card.querySelectorAll(':scope > footer [data-card-action]')].map((button) => ({
    action: button.dataset.cardAction,
    label: button.textContent.trim(),
    group: button.closest('.cardFooterActionGroupRight') ? 'right' : 'left',
    ...box(button),
  }));
  const centerY = (button) => (button.top + button.bottom) / 2;
  const rows = [];
  for (const button of [...buttons].sort((a, b) => centerY(a) - centerY(b))) {
    const row = rows.find((candidate) => Math.abs(centerY(candidate[0]) - centerY(button)) <= 10);
    if (row) row.push(button); else rows.push([button]);
  }
  const leftMost = rows[0].reduce((left, button) => (button.left < left.left ? button : left));
  const rightMost = rows.at(-1).reduce((right, button) => (button.right > right.right ? button : right));
  const cardBox = card.getBoundingClientRect();
  return {
    composer: box(composer),
    composerInset: composer.getBoundingClientRect().left - (cardBox.left + card.clientLeft),
    buttons,
    rowCount: rows.length,
    firstRowLeft: leftMost.left,
    firstRowLeftMost: `${leftMost.group}:${leftMost.label}`,
    lastRowRight: rightMost.right,
    lastRowRightMost: `${rightMost.group}:${rightMost.label}`,
  };
});

const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
let checks = 0;
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const viewport of viewports) {
        const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${server.resolvedUrls.local[0]}tests/card-detail-alignment.html`);
        await page.locator('.piComposer').waitFor();

        const agent = await measureAgent(page);
        const where = `${engine.name()} ${viewport.label}`;
        // The fixture must populate both action groups, or space-between cannot
        // exercise the two measured edges.
        assert.deepEqual([...new Set(agent.buttons.map((button) => button.group))].sort(), ['left', 'right'], `${where}: fixture must fill both action groups`);
        assert(agent.buttons.length >= 2, `${where}: fixture needs at least two actions`);
        assert.equal(agent.firstRowLeftMost.split(':')[0], 'left', `${where}: first row's left-most action is not in the left group`);
        assert.equal(agent.lastRowRightMost.split(':')[0], 'right', `${where}: last row's right-most action is not in the right group`);
        assert(Math.abs(agent.composerInset - 24) <= 1, `${where}: composer inset is ${agent.composerInset}, expected 24`);

        const rowNote = agent.rowCount > 1 ? ' (wrapped: first row left-most / last row right-most)' : '';
        const leftDelta = agent.firstRowLeft - agent.composer.left;
        assert(Math.abs(leftDelta) <= 1,
          `${where}${rowNote}: first action border left ${agent.firstRowLeft} (${agent.firstRowLeftMost}) vs composer left ${agent.composer.left}, delta ${leftDelta}`);
        const rightDelta = agent.lastRowRight - agent.composer.right;
        assert(Math.abs(rightDelta) <= 1,
          `${where}${rowNote}: last action border right ${agent.lastRowRight} (${agent.lastRowRightMost}) vs composer right ${agent.composer.right}, delta ${rightDelta}`);

        await page.getByRole('button', { name: 'Overview', exact: true }).click();
        const overview = await page.evaluate(() => {
          const card = document.querySelector('#alignment-card');
          const footer = card.querySelector(':scope > footer');
          const style = getComputedStyle(footer);
          return { chatActive: card.classList.contains('chatActive'), paddingLeft: style.paddingLeft, paddingRight: style.paddingRight };
        });
        assert.equal(overview.chatActive, false, `${where}: Overview must not leave chatActive on`);
        assert.deepEqual({ left: overview.paddingLeft, right: overview.paddingRight }, viewport.overviewPadding,
          `${where}: Overview footer padding changed`);
        assert.deepEqual(errors, [], `${where}: page errors`);
        console.log(`PASS ${where}: first-row left delta ${leftDelta.toFixed(2)}px, last-row right delta ${rightDelta.toFixed(2)}px, composer inset ${agent.composerInset.toFixed(2)}px${rowNote}; Overview footer padding ${overview.paddingLeft}/${overview.paddingRight}`);
        checks++;
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
  console.log(`PASS ${checks} card-detail action alignment checks at default and narrow widths`);
} finally {
  await server.close();
}
