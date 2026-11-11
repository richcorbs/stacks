// Browser-computed invariants for the layered global stylesheet. No Tauri required.
// Run: node tests/styles-cascade.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium, webkit } from 'playwright';

const vendorCss = readFileSync(new URL('../node_modules/@xterm/xterm/css/xterm.css', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  .replace(/@import[^;]+;/g, `@layer vendor { ${vendorCss} }`);
const content = `<div class="app">
  <div class="kanbanHeader"><div class="kanbanHeaderActions"><button data-card-action="primary" class="primaryAction">New</button></div></div>
  <div class="modal projectDialog" id="owner"><h2>Project</h2><div class="modalActions">
    <button id="secondary" data-card-action="secondary">Cancel</button><button id="primary" data-card-action="primary" class="primaryAction">Save</button>
    <button id="danger" data-card-action="danger" class="primaryAction dangerAction">Delete</button>
    <button id="disabled" data-card-action="primary" class="primaryAction" disabled>Wait</button></div></div>
  <div class="kanbanDetail cardWorkspace" id="card"><div class="cardWorkspaceTabs"><button class="active">Chat</button></div>
    <div class="piMessageText" id="transcript">Transcript</div><div class="piComposer"><textarea id="composer">Prompt</textarea></div>
    <div class="diffCode" id="diff">Code</div><div class="cardView" id="hidden">Hidden</div><div class="cardView active" id="active">Visible</div>
    <footer><div class="cardFooterActions"><button data-card-action="danger-tertiary" class="primaryAction workflowActionDangerGhost" id="ghost">Cancel</button></div></footer></div>
  <div class="settingsHeader"><button id="close">×</button></div>
  <div class="globalTerminalTabs"><button class="globalTerminalTabClose" id="tabClose">×</button><button class="globalTerminalAdd" id="tabAdd">+</button><button class="globalTerminalDismiss"><span id="dismiss">×</span></button></div>
  <span class="kanbanPrBadge"><span class="githubCiIcon" id="ci">✓</span></span>
  <button class="kanbanEnvironmentWarning" id="warning">!</button>
  <div class="kanbanDetail"><header><button id="headerClose">×</button></header></div>
  <span class="managedServiceStatus" id="service">Running</span>
  <div class="piMcpStatus"><button class="piMcpDismiss" id="mcpDismiss">×</button></div>
  <div class="scriptedDeliveryStatus" id="delivery">Building</div><details class="scriptedDeliveryOutput" id="output"><summary>Output</summary></details>
  <fieldset class="projectColorField"><legend id="legend">Color</legend></fieldset>
  <div class="piMarkdown"><table id="table"><tbody><tr><td>Content</td></tr></tbody></table></div>
  <div class="terminal active"><div class="terminalHost"><div class="xterm" id="terminalText" style="font-size: 17px"><div class="xterm-viewport"><div class="xterm-scroll-area"></div></div><div class="xterm-screen"><div class="xterm-helpers"><textarea class="xterm-helper-textarea"></textarea></div></div></div></div></div>
</div><div class="toast" id="portal">Outside app</div>`;
for (const engine of [chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<style id="styles">${css}</style>${content}`);
    if (process.argv.includes('--compare-baseline')) {
      // Pin the measured pre-modernization revision so this survives our commit.
      const baseline = execFileSync('git', ['show', 'ec76ec67cb9405adfcb0bfcafc6c26f4d1e03809:src/styles.css'], { encoding: 'utf8' }) + vendorCss;
      const snapshot = () => page.evaluate(() => [...document.querySelectorAll('.app, .app *, #portal')].map((el) => {
        const style = getComputedStyle(el);
        return Object.fromEntries([...style].filter((property) => !property.startsWith('--')).map((property) => [property, style.getPropertyValue(property)]));
      }));
      for (const color of [null, 'teal', 'rose']) {
        await page.evaluate((color) => {
          for (const id of ['owner', 'card']) {
            const el = document.getElementById(id);
            if (color) el.dataset.projectColor = color; else delete el.dataset.projectColor;
          }
        }, color);
        for (const state of ['idle', 'hover', 'focus']) {
          await page.evaluate(() => document.activeElement?.blur());
          await page.mouse.move(0, 0);
          if (state === 'hover') await page.locator('#primary').hover({ force: true });
          if (state === 'focus') await page.locator('#primary').focus();
          await page.locator('#styles').evaluate((el, value) => { el.textContent = value; }, baseline);
          const before = await snapshot();
          await page.locator('#styles').evaluate((el, value) => { el.textContent = value; }, css);
          assert.deepEqual(await snapshot(), before, `${engine.name()} ${color ?? 'unowned'} ${state}: baseline cascade changed`);
        }
      }
      console.log(`${engine.name()}: all fixture computed properties match baseline (excluding approved blue changes)`);
    }
    for (const color of [null, 'blue', 'teal', 'rose']) {
      await page.evaluate((color) => {
        for (const id of ['owner', 'card']) {
          const el = document.getElementById(id);
          if (color) el.dataset.projectColor = color; else delete el.dataset.projectColor;
        }
      }, color);
      for (const delta of [0, 3, -2]) {
        await page.evaluate((delta) => {
          document.documentElement.style.setProperty('--ui-font-delta', `${delta}px`);
          document.documentElement.style.setProperty('--pi-font-size', '15px');
          document.documentElement.style.setProperty('--diff-font-size', '14px');
        }, delta);
        const actual = await page.evaluate(() => {
          const style = (id) => getComputedStyle(document.getElementById(id));
          return { portal: style('portal').fontSize, close: style('close').fontSize,
            primary: style('primary').fontSize, transcript: style('transcript').fontSize,
            composer: style('composer').fontSize, diff: style('diff').fontSize,
            danger: style('danger').color, ghost: style('ghost').color,
            disabled: style('disabled').opacity, hidden: style('hidden').display,
            active: style('active').display, chrome: getComputedStyle(document.querySelector('.app')).backgroundColor,
            table: style('table').fontSize, terminal: style('terminalText').fontSize,
            formerlyFixed: Object.fromEntries(['tabClose', 'tabAdd', 'dismiss', 'ci', 'warning', 'headerClose', 'service', 'mcpDismiss', 'delivery', 'output', 'legend'].map((id) => [id, style(id).fontSize])) };
        });
        assert.equal(actual.portal, `${14 + delta}px`);
        assert.equal(actual.close, `${24 + delta}px`);
        assert.equal(actual.primary, `${12 + delta}px`);
        assert.equal(actual.transcript, '15px');
        assert.equal(actual.composer, '17px');
        assert.equal(actual.diff, '14px');
        assert.equal(actual.danger, 'rgb(240, 160, 160)');
        assert.equal(actual.ghost, 'rgb(215, 146, 152)');
        assert.equal(actual.disabled, '0.45');
        assert.equal(actual.hidden, 'none');
        assert.equal(actual.active, 'flex');
        assert.equal(actual.chrome, 'rgb(15, 15, 15)');
        assert.equal(actual.table, '14px');
        assert.equal(actual.terminal, '17px');
        for (const [id, base] of Object.entries({ tabClose: 17, tabAdd: 18, dismiss: 20, ci: 8, warning: 10, headerClose: 20, service: 10, mcpDismiss: 18, delivery: 12, output: 12, legend: 12 })) {
          assert.equal(actual.formerlyFixed[id], `${base + delta}px`, `${id} must follow UI sizing`);
        }
      }
    }
    console.log(`${engine.name()}: owner/color/size and content-independence matrix passed`);
  } finally { await browser.close(); }
}
