import { createElement as h } from 'react';
import { describe, expect, it } from 'vitest';
import { CardWorkflowControls } from './components/CardWorkflowControls';
import { CardDetailTabs } from './components/kanban/CardDetailChrome';
import { color, isTransparent, parseCssColor, renderToStyle } from './test/renderToStyle.mjs';

const tealAccent = '#56a9a4';
const actions = [
  { kind: 'ship', label: 'Start work', primary: true },
  { kind: 'request_changes', label: 'Request changes' },
  { kind: 'close', label: 'Close without delivery', appearance: 'neutral-ghost' },
  { kind: 'delete', label: 'Delete card', appearance: 'danger-ghost' },
];

function detail(children, { owned = true, working = false } = {}) {
  return h('div', { className: 'kanbanDetail cardWorkspace', ...(owned ? { 'data-project-color': 'teal' } : {}) },
    h('footer', null, h(CardWorkflowControls, { actions, working, onAction() {} }), children ?? null));
}

const primary = '.kanbanDetail.cardWorkspace[data-project-color] button[data-card-action="primary"]';
const secondary = '.kanbanDetail.cardWorkspace[data-project-color] button[data-card-action="secondary"]';
const tertiary = '.kanbanDetail.cardWorkspace[data-project-color] button[data-card-action="tertiary"]';
const danger = '.kanbanDetail.cardWorkspace .cardFooterActions button.workflowActionDangerGhost[data-card-action="danger-tertiary"]';
const unownedTertiary = '.kanbanDetail.cardWorkspace:not([data-project-color]) .cardFooterActions button.workflowActionNeutralGhost[data-card-action="tertiary"]';

describe('card detail action theming', () => {
  it('derives regular action surfaces and text from the owner accent', () => {
    const owned = renderToStyle(detail(), { projectAccent: tealAccent });
    const plain = renderToStyle(detail(null, { owned: false }));
    const ownedPrimary = owned.colorOf(primary, 'backgroundColor');
    expect(ownedPrimary).not.toBe(plain.colorOf('.kanbanDetail button[data-card-action="primary"]', 'backgroundColor'));
    expect(parseCssColor(ownedPrimary).g - parseCssColor(ownedPrimary).r).toBeGreaterThan(20);
    expect(parseCssColor(owned.colorOf(secondary, 'backgroundColor')).b).toBeGreaterThan(parseCssColor(owned.colorOf(secondary, 'backgroundColor')).r);
    expect(owned.colorOf(primary)).not.toBe(ownedPrimary);
  });

  it('keeps tertiary actions transparent even when they are primary', () => {
    const { style, declaration } = renderToStyle(detail(), { projectAccent: tealAccent });
    expect(isTransparent(style(tertiary, 'backgroundColor'))).toBe(true);
    expect(isTransparent(declaration(`${tertiary}:hover:not(:disabled)`, 'background'))).toBe(true);
  });

  it('keeps neutral fallback actions transparent without an owner', () => {
    const { style, declaration } = renderToStyle(detail(null, { owned: false }));
    expect(isTransparent(style(unownedTertiary, 'backgroundColor'))).toBe(true);
    expect(color(style(unownedTertiary, 'color'))).toBe('rgb(147, 164, 183)');
    expect(declaration(`${unownedTertiary}:is(:hover, :focus-visible):not(:disabled)`, 'background')).toBe('transparent');
    expect(color(declaration(`${unownedTertiary}:is(:hover, :focus-visible):not(:disabled)`, 'color'))).toBe('rgb(196, 208, 220)');
  });

  it('keeps destructive actions red independently of project ownership', () => {
    const owned = renderToStyle(detail(), { projectAccent: tealAccent });
    const plain = renderToStyle(detail(null, { owned: false }));
    for (const rendered of [owned, plain]) {
      expect(rendered.colorOf(danger)).toBe('rgb(215, 146, 152)');
      expect(isTransparent(rendered.style(danger, 'backgroundColor'))).toBe(true);
    }
    const interactive = `${danger}:is(:hover, :focus-visible):not(:disabled)`;
    expect(color(owned.declaration(interactive, 'color'))).toBe('rgb(240, 170, 176)');
    expect(owned.declaration(interactive, 'background')).toBe('transparent');
    expect(owned.declaration(interactive, 'outline')).toContain('2px solid');
    expect(owned.declaration(interactive, 'outline')).not.toContain('--project-');
  });

  it('does not override the disabled opacity and never dims enabled actions', () => {
    const rendered = renderToStyle(detail(), { projectAccent: tealAccent });
    expect(rendered.style(primary, 'opacity')).not.toBe('0.45');
    const disabled = renderToStyle(detail(null, { working: true }), { projectAccent: tealAccent });
    expect(disabled.style(`${primary}:disabled`, 'opacity')).toBe('0.45');
  });

  it('outlines owner actions with the owner-derived focus color', () => {
    const { declaration } = renderToStyle(detail(), { projectAccent: tealAccent });
    const focus = '.kanbanDetail.cardWorkspace[data-project-color] button:is([data-card-action="primary"], [data-card-action="secondary"], [data-card-action="tertiary"]):focus-visible';
    const outline = declaration(focus, 'outline');
    expect(outline).toContain('2px solid');
    expect(parseCssColor(outline.slice(outline.indexOf('color-mix'))).g).toBeGreaterThan(parseCssColor(outline.slice(outline.indexOf('color-mix'))).r);
  });
});

describe('owned-card snippet theme', () => {
  const owner = '.kanbanDetail.cardWorkspace[data-project-color]';
  const content = (owned = true) => h('div', { className: 'kanbanDetail cardWorkspace', ...(owned ? { 'data-project-color': 'teal' } : {}) },
    h('div', { className: 'cardChat' },
      h('div', { className: 'kanbanDetailMeta' }),
      h('div', { className: 'cardHistory' }),
      h('div', { className: 'kanbanChildList' }),
      h('div', { className: 'cardWorkspaceTabs' }),
      h('div', { className: 'cardDiffExplorer' }),
      h('div', { className: 'diffReviewToolbar' }),
      h('div', { className: 'diffOverallComment' }),
      h('div', { className: 'diffFileComments' }),
      h('div', { className: 'diffInlineComment' }),
      h('div', { className: 'piMarkdown' },
        h('code', null, 'code'), h('pre', null, h('code', null, 'block')),
        h('hr'), h('blockquote', null, 'quote'), h('table', null, h('thead', null, h('tr', null, h('th', null, 'head'))), h('tbody', null, h('tr', null, h('td', null, 'cell'))))),
      h('div', { className: 'piToolCard' }, h('pre', null, 'output'))),
    h('div', { className: 'scriptedDeliveryOutput' }, h('pre', null, 'output')),
    h('footer'));

  it('defines owner-derived card tokens only on open, project-owned cards', () => {
    const owned = renderToStyle(content(), { projectAccent: tealAccent });
    for (const token of ['--card-border', '--card-code-bg', '--card-pre-bg']) {
      const value = owned.style(owner, token);
      expect(value, token).toContain('color-mix');
      expect(parseCssColor(value), token).not.toBeNull();
    }
    const unowned = renderToStyle(content(false));
    expect(unowned.style('.kanbanDetail.cardWorkspace', '--card-border')).toBe('');
  });

  it('themes dividers and code/output surfaces while keeping neutral fallbacks outside cards', () => {
    const owned = renderToStyle(content(), { projectAccent: tealAccent });
    expect(owned.colorOf('.cardChat', 'borderTopColor')).toBe(color(owned.style(owner, '--card-border')));
    expect(owned.colorOf('.kanbanDetailMeta', 'borderTopColor')).toBe(color(owned.style(owner, '--card-border')));
    expect(owned.colorOf('.piMarkdown code', 'backgroundColor')).toBe(color(owned.style(owner, '--card-code-bg')));
    expect(owned.colorOf('.piMarkdown pre', 'backgroundColor')).toBe(color(owned.style(owner, '--card-pre-bg')));
    expect(isTransparent(owned.style('.piMarkdown pre code', 'backgroundColor'))).toBe(true);

    const unowned = renderToStyle(content(false));
    expect(unowned.colorOf('.cardChat', 'borderTopColor')).toBe('rgb(34, 49, 66)');
    expect(unowned.colorOf('.piMarkdown code', 'borderTopColor')).toBe('rgb(38, 55, 70)');
    expect(unowned.colorOf('.piMarkdown code', 'backgroundColor')).toBe('rgb(17, 28, 39)');
    expect(unowned.colorOf('.piMarkdown pre', 'backgroundColor')).toBe('rgb(10, 17, 24)');
  });

  it('themes internal dividers across Details, Chat, Diff, and output surfaces', () => {
    const { colorOf, style } = renderToStyle(content(), { projectAccent: tealAccent });
    const border = color(style(owner, '--card-border'));
    for (const selector of ['.kanbanDetailMeta', '.cardHistory', '.kanbanChildList', '.cardWorkspaceTabs', '.cardDiffExplorer', '.diffReviewToolbar', '.diffOverallComment', '.diffFileComments', '.diffInlineComment', '.cardChat']) {
      expect(colorOf(selector, 'borderTopColor'), selector).toBe(border);
    }
    for (const selector of ['.piToolCard pre', '.scriptedDeliveryOutput pre']) {
      expect(colorOf(selector, 'borderTopColor'), selector).toBe(border);
    }
    for (const selector of ['.piMarkdown hr', '.piMarkdown blockquote', '.piMarkdown th', '.piMarkdown td']) {
      expect(colorOf(selector, 'borderTopColor'), selector).toBe(border);
    }
  });
});

describe('shared card workspace tabs', () => {
  const tabs = h(CardDetailTabs, {
    activeView: 'overview',
    hierarchyFinalized: false,
    projectAvailable: true,
    cardPath: '/repo',
    terminalRunning: false,
    onRequestView() {},
    onRefreshDiff() {},
  });
  const workspace = (owned = true) => h('div', { className: 'kanbanDetail cardWorkspace', ...(owned ? { 'data-project-color': 'teal' } : {}) }, h('header'), tabs);

  it('keeps the card workspace chrome on one inset surface while switching views', () => {
    const { style, token } = renderToStyle(workspace(), { projectAccent: tealAccent });
    for (const selector of ['.kanbanDetail.cardWorkspace', '.kanbanDetail.cardWorkspace > header']) {
      expect(style(selector, 'backgroundColor'), selector).toBe(color(token('--surface-inset')));
    }
    expect(style('.cardWorkspaceTabs', 'backgroundColor')).toBe(color(token('--surface-inset')));
    expect(color(style('.cardWorkspaceTabs', 'borderBottomColor'))).toBe(color(style('.kanbanDetail.cardWorkspace', '--card-border')));
    const unowned = renderToStyle(workspace(false));
    expect(unowned.style('.cardWorkspaceTabs', 'borderBottomColor')).toBe('rgb(34, 49, 66)');
  });

  it('scopes the active underline to the owner accent and keeps neutral tabs blue otherwise', () => {
    const owned = renderToStyle(workspace(), { projectAccent: tealAccent });
    const plain = renderToStyle(workspace(false));
    expect(owned.colorOf('.cardWorkspaceTabs button.active', 'borderBottomColor')).toBe('rgb(86, 169, 164)');
    expect(plain.colorOf('.cardWorkspaceTabs button.active', 'borderBottomColor')).toBe('rgb(98, 149, 194)');
  });

  it('paints compound tab hover once behind labels and keeps nested label hover transparent', () => {
    const { declaration, token } = renderToStyle(workspace(), { projectAccent: tealAccent });
    expect(color(declaration('.cardWorkspaceTabs > button:hover:not(:disabled),\n.cardDiffTab:hover:has(button:not(:disabled))', 'background'))).toBe(color(token('--surface-drag')));
    expect(declaration('.cardWorkspaceTabs :is(.cardDiffTabLabel):hover:not(:disabled)', 'background')).toBe('transparent');
    expect(color(declaration('.cardWorkspaceTabs button:hover:not(:disabled), .cardDiffTab:hover .cardDiffTabLabel:not(:disabled)', 'color'))).toBe('rgb(255, 255, 255)');
  });

  it('scopes the subdued project hover palette to owned workspace tabs', () => {
    const { declaration, token } = renderToStyle(workspace(), { projectAccent: tealAccent });
    const ownedHover = '.cardWorkspace[data-project-color] .cardWorkspaceTabs > button:hover:not(:disabled),\n.cardWorkspace[data-project-color] .cardDiffTab:hover:has(button:not(:disabled))';
    const hover = declaration(ownedHover, 'background');
    expect(hover).toContain('color-mix');
    expect(parseCssColor(hover).g).toBeGreaterThan(parseCssColor(hover).r);
    expect(hover).not.toBe(color(token('--surface-drag')));
  });

  it('reserves the trailing inset for the Diff refresh control and keeps control geometry', () => {
    const { style } = renderToStyle(workspace(), { projectAccent: tealAccent });
    expect(style('.cardWorkspaceTabs button', 'padding')).toBe('7px 10px 11px');
    expect(style('.cardWorkspaceTabs .cardDiffTabLabel', 'paddingTop')).toBe('7px');
    expect(style('.cardWorkspaceTabs .cardDiffTabLabel', 'paddingBottom')).toBe('11px');
    expect(style('.cardWorkspaceTabs .cardDiffTab:has(.cardDiffRefresh)', 'paddingRight')).toBe('10px');
    expect(style('.cardWorkspaceTabs > button', 'alignSelf')).toBe('stretch');
    expect(style('.cardWorkspaceTabs > button', 'display')).toBe('inline-flex');
    expect(style('.cardWorkspaceTabs > button', 'alignItems')).toBe('end');

    const refresh = renderToStyle('<div class="cardWorkspaceTabs"><button class="cardDiffRefresh"></button></div>');
    expect(refresh.style('.cardWorkspaceTabs button.cardDiffRefresh', 'width')).toBe('20px');
    expect(refresh.style('.cardWorkspaceTabs button.cardDiffRefresh', 'height')).toBe('20px');
    expect(refresh.style('.cardWorkspaceTabs button.cardDiffRefresh', 'marginBottom')).toBe('7px');
    expect(refresh.style('.cardWorkspaceTabs button.cardDiffRefresh', 'padding')).toBe('0');
  });

  it('paints service control buttons in the terminal header with an active and failed state', () => {
    const controls = renderToStyle('<div class="terminalControls"><button class="terminalControlButton terminalServiceButton active"><svg class="terminalServiceIcon"></svg></button><button class="terminalControlButton terminalServiceButton failed"></button></div>');
    expect(controls.colorOf('.terminalServiceButton.active', 'backgroundColor')).toBe('rgb(21, 39, 30)');
    expect(controls.colorOf('.terminalServiceButton.active', 'color')).toBe('rgb(112, 189, 141)');
    expect(controls.colorOf('.terminalServiceButton.failed', 'color')).toBe('rgb(219, 150, 150)');
    expect(controls.style('.terminalServiceIcon', 'display')).toBe('block');
    const dot = renderToStyle('<nav class="cardWorkspaceTabs"><button>Terminal<span class="cardTabRunningDot"></span></button></nav>');
    expect(dot.style('.cardTabRunningDot', 'width')).toBe('6px');
    expect(dot.style('.cardTabRunningDot', 'height')).toBe('6px');
    expect(dot.colorOf('.cardTabRunningDot', 'backgroundColor')).toBe('rgb(112, 189, 141)');
  });
});

describe('split terminal focus border', () => {
  const panes = '<div class="cardTerminalPane multiple"><div class="terminal active"><div class="xterm"></div></div><div class="terminal"><div class="xterm"></div></div></div>';

  it('paints only the active pane with the focus color at the same border width', () => {
    const { style } = renderToStyle(panes);
    expect(style('.cardTerminalPane.multiple .terminal.active', 'borderTopColor')).toBe('rgb(59, 130, 246)');
    expect(isTransparent(style('.cardTerminalPane.multiple .terminal:not(.active)', 'borderTopColor'))).toBe(true);
    expect(style('.cardTerminalPane.multiple .terminal.active', 'borderTopWidth')).toBe(style('.cardTerminalPane.multiple .terminal:not(.active)', 'borderTopWidth'));
  });

  it('uses the maximized accent only for an active maximized pane', () => {
    const { colorOf } = renderToStyle('<div class="cardTerminalPane multiple"><div class="terminal active maximized"></div><div class="terminal active"></div></div>');
    expect(colorOf('.terminal.active.maximized', 'borderTopColor')).toBe('rgb(132, 204, 22)');
    expect(colorOf('.terminal.active:not(.maximized)', 'borderTopColor')).toBe('rgb(59, 130, 246)');
  });
});
