import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KanbanList } from './components/kanban/KanbanList';
import { KanbanCardContents } from './components/kanban/KanbanCardParts';
import { CardHierarchyBadges } from './components/kanban/CardHierarchyBadges';
import { channelSpread, color, isNeutral, isTransparent, parseCssColor, renderToStyle } from './test/renderToStyle.mjs';

const tealAccent = '#56a9a4';
const project = { id: 'project', name: 'Stacks', path: '/repo', color_id: 'teal' };

function card(overrides = {}) {
  return {
    id: 'local:333', external_id: '333', title: 'Replace the regex CSS assertions', provider: 'superthread',
    project_id: 'project', status: 'ready', parent: null, child_count: 0, board_title: 'Dev',
    assignee_names: ['Rich'], pull_request: null, environment: null, ...overrides,
  };
}

function list(cards, { focused = null, projectColor = 'teal' } = {}) {
  return h(KanbanList, {
    cards,
    projects: [project],
    selectedProjectColor: projectColor,
    repositoryStatuses: {},
    serverServices: {},
    backlogCollapsed: true,
    attentionCollapsed: false,
    progressCollapsed: false,
    doneCollapsed: true,
    openLaneMenu: null,
    setOpenLaneMenu() {},
    cleaningMerged: false,
    keyboardFocusedCardId: focused,
    setKeyboardFocusedCardId() {},
    onToggleBacklog() {},
    onToggleAttention() {},
    onToggleProgress() {},
    onToggleDone() {},
    onCleanupMerged() {},
    onOpenCard() {},
    onNavigateParent() {},
    onToggleServer() {},
  });
}

function cardMarkup(overrides = {}, { parent = false } = {}) {
  const value = card(overrides);
  return h('div', { className: `kanbanCard${parent ? ' kanbanParentCard' : ''}` },
    h(KanbanCardContents, {
      card: value,
      projects: [project],
      repositoryStatus: undefined,
      serverServices: undefined,
      onNavigateParent() {},
      onToggleServer() {},
    }));
}

const surfaceTokens = ['canvas', 'inset', 'panel', 'raised', 'parent', 'hover', 'selected', 'drag', 'action', 'action-hover'];

describe('neutral app surfaces', () => {
  it('matches the native window backing color to the neutral app canvas', () => {
    const app = renderToStyle('');
    const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
    for (const window of config.app.windows) expect(color(window.backgroundColor)).toBe(color(app.token('--surface-canvas')));
  });

  it('keeps the shared depth palette neutral, distinct, and ordered by emphasis', () => {
    const { token } = renderToStyle('');
    const values = surfaceTokens.map((name) => token(`--surface-${name}`));
    for (const value of values) expect(isNeutral(value), value).toBe(true);
    expect(new Set(values).size).toBe(values.length);
  });

  it('paints list and card depth from the neutral palette while content surfaces keep their own colors', () => {
    const view = renderToStyle(h('div', { className: 'kanbanView' }, list([card()])), { projectAccent: tealAccent });
    expect(view.style('.kanbanView', 'backgroundColor')).toBe(color(view.token('--surface-canvas')));
    expect(view.style('.kanbanListGroup', 'backgroundColor')).toBe(color(view.token('--surface-panel')));

    const drag = renderToStyle('<div class="kanbanListDragOverlay"><div class="kanbanListRow kanbanCard"></div></div>');
    expect(drag.style('.kanbanListRow.kanbanCard', 'backgroundColor')).toBe(color(drag.token('--kanban-card-surface-hover')));
    expect(drag.style('.kanbanListRow.kanbanCard', 'borderTopColor')).toBe(color(drag.token('--kanban-border-drag')));

    const content = renderToStyle('<div class="terminalHost"></div><div class="diffOverlay"></div><div class="kanbanServerToggle running"></div>');
    expect(content.colorOf('.terminalHost', 'backgroundColor')).toBe('rgb(15, 20, 27)');
    expect(content.colorOf('.diffOverlay', 'backgroundColor')).toBe('rgb(12, 19, 27)');
    expect(content.colorOf('.kanbanServerToggle.running', 'backgroundColor')).toBe('rgb(21, 39, 30)');
    expect(content.colorOf('.kanbanServerToggle.running', 'borderTopColor')).toBe('rgb(65, 107, 85)');
  });

  it('keeps the card-fill trial to a subtle cool bias with increasing luminance', () => {
    const { token } = renderToStyle('');
    const fills = ['--kanban-card-surface', '--kanban-card-surface-parent', '--kanban-card-surface-hover', '--kanban-card-surface-drag'].map((name) => token(name));
    for (const fill of fills) {
      const parsed = parseCssColor(fill);
      expect(parsed.g - parsed.r).toBe(2);
      expect(parsed.b - parsed.g).toBe(2);
    }
    const luminance = fills.map((fill) => parseCssColor(fill).r);
    expect(luminance).toEqual([...luminance].sort((a, b) => a - b));
    expect(new Set(luminance).size).toBe(luminance.length);
  });

  it('keeps list rows transparent so the shared neutral group surface shows through', () => {
    const { style } = renderToStyle(list([card()]), { projectAccent: tealAccent });
    expect(isTransparent(style('.kanbanListRow.kanbanCard', 'backgroundColor'))).toBe(true);
  });
});

describe('neutral Kanban borders and focus paint', () => {
  const borderTokens = ['--kanban-border-subtle', '--kanban-border', '--kanban-border-hover', '--kanban-border-drag'];

  it('uses one cool-biased neutral border ramp with distinct contrast levels', () => {
    const { token } = renderToStyle('');
    const values = borderTokens.map((name) => token(name));
    for (const value of values) {
      const parsed = parseCssColor(value);
      expect(parsed.g - parsed.r).toBe(2);
      expect(parsed.b - parsed.g).toBe(2);
    }
    const luminance = values.map((value) => parseCssColor(value).r);
    expect(luminance).toEqual([...luminance].sort((a, b) => a - b));
    expect(new Set(luminance).size).toBe(luminance.length);
  });

  it('keeps populated attention sections neutral and identical with or without a project accent', () => {
    const plain = renderToStyle(list([card()], { projectColor: undefined }));
    const owned = renderToStyle(list([card()]), { projectAccent: tealAccent });
    const attention = '.kanbanListGroup[data-kanban-group="attention"][data-populated="true"]';
    for (const rendered of [plain, owned]) {
      expect(rendered.style(attention, 'borderTopColor')).toBe(color(rendered.token('--kanban-border-hover')));
      expect(rendered.style('.kanbanListGroup:not([data-populated])', 'borderTopColor')).toBe(color(rendered.token('--kanban-border-subtle')));
    }
    expect(plain.colorOf(attention, 'borderTopColor')).toBe(owned.colorOf(attention, 'borderTopColor'));
  });

  it('raises only the keyboard-focused row above its neighbours', () => {
    const { style } = renderToStyle(list([card(), card({ id: 'local:334', external_id: '334' })], { focused: 'local:333' }));
    const focused = '.kanbanListRows > .kanbanListRow.keyboardFocused';
    expect(style('.kanbanListRow', 'position')).toBe('relative');
    expect(style(focused, 'zIndex')).toBe('1');
    expect(style(focused, 'outline')).toBe('2px solid #4f83ad');
    expect(style(focused, 'outlineOffset')).toBe('1px');
    expect(style(focused, 'borderTopColor')).toBe('transparent');
    expect(style('.kanbanListRow:not(.keyboardFocused)', 'zIndex')).not.toBe('1');
  });

  it('keeps focused list rows neutral except for the deliberate focus accent', () => {
    const { style } = renderToStyle(list([card()], { focused: 'local:333' }));
    const outline = style('.kanbanListRow.keyboardFocused', 'outline');
    expect(outline).toBe('2px solid #4f83ad');
    expect(channelSpread(outline.slice(outline.indexOf('#')))).toBeGreaterThan(0);
  });
});

describe('card heading hierarchy and badges', () => {
  it('keeps the heading on one justified row and lets the left cluster shrink without wrapping', () => {
    const { style } = renderToStyle(cardMarkup({ parent: { id: 'parent', external_id: '12', title: 'Parent' }, child_count: 2 }), { projectAccent: tealAccent });
    for (const [selector, property, value] of [
      ['.kanbanCardSource', 'display', 'flex'],
      ['.kanbanCardSource', 'justifyContent', 'space-between'],
      ['.kanbanCardSource', 'flexWrap', 'nowrap'],
      ['.kanbanCardSource', 'whiteSpace', 'nowrap'],
      ['.kanbanCardSourceLeft', 'minWidth', '0'],
      ['.kanbanCardSourceLeft', 'display', 'flex'],
      ['.kanbanCardSourceLeft', 'whiteSpace', 'nowrap'],
    ]) expect(style(selector, property), `${selector} ${property}`).toBe(value);
  });

  it('keeps hierarchy badges adjacent, right-aligned, and shrinkable while the project shrinks before status', () => {
    const { style } = renderToStyle(cardMarkup({ parent: { id: 'parent', external_id: '12', title: 'Parent' }, child_count: 2 }), { projectAccent: tealAccent });
    for (const [selector, property, value] of [
      ['.kanbanHierarchyGroup', 'display', 'inline-flex'],
      ['.kanbanHierarchyGroup', 'justifyContent', 'flex-end'],
      ['.kanbanHierarchyGroup', 'gap', '5px'],
      ['.kanbanHierarchyGroup', 'maxWidth', '30%'],
      ['.kanbanHierarchyGroup', 'flex', '0 1 auto'],
      ['.kanbanHierarchyGroup', 'whiteSpace', 'nowrap'],
      ['.kanbanHierarchyGroup > .kanbanHierarchyBadge', 'minWidth', '0'],
      ['.kanbanHierarchyGroup > .kanbanHierarchyBadge', 'flex', '0 1 auto'],
      ['.kanbanCardSourceLeft > .kanbanCardNumber', 'flex', '0 0 auto'],
      ['.kanbanCardSourceLeft > .kanbanProjectBadge', 'flex', '0 10 auto'],
      ['.kanbanCardSourceLeft > .kanbanProjectBadge', 'maxWidth', '150px'],
      ['.kanbanCardSourceLeft > .kanbanCardStatusBadge', 'minWidth', '55px'],
    ]) expect(style(selector, property), `${selector} ${property}`).toBe(value);
  });

  it('keeps project text subdued and the workflow status bright', () => {
    const { colorOf, style } = renderToStyle(cardMarkup(), { projectAccent: tealAccent });
    expect(colorOf('.kanbanProjectBadge')).toBe('rgb(91, 157, 159)');
    expect(colorOf('.kanbanCardStatusBadge')).toBe('rgb(144, 197, 196)');
    expect(parseCssColor(colorOf('.kanbanCardStatusBadge')).r).toBeGreaterThan(parseCssColor(colorOf('.kanbanProjectBadge')).r);
    expect(color(style('.kanbanCardStatusBadge', 'borderTopColor'))).toBe(color(style('.kanbanCardStatusBadge', '--project-status-border')));
  });

  it('does not let generic detail metadata override the status, project, or hierarchy badges', () => {
    const { colorOf } = renderToStyle(`<div class="kanbanDetail"><header><div class="kanbanDetailHeaderMeta"><div class="kanbanDetailHeaderMetaLeft">
      <span class="kanbanProjectBadge">Stacks</span><span class="kanbanCardStatus">Ready</span>
      <span class="kanbanHierarchyBadge">#12</span><span class="metatext">metadata</span>
    </div></div></header></div>`);
    expect(colorOf('.kanbanCardStatus')).toBe('rgb(160, 175, 190)');
    expect(colorOf('.kanbanProjectBadge')).toBe('rgb(104, 124, 146)');
    expect(colorOf('.kanbanHierarchyBadge')).toBe('rgb(145, 164, 182)');
    expect(colorOf('.metatext')).toBe('rgb(104, 124, 146)');
  });

  it('ellipsizes long project names and gives the header badge a neutral pill', () => {
    const badge = renderToStyle(cardMarkup(), { projectAccent: tealAccent });
    for (const [property, value] of [['minWidth', '0'], ['maxWidth', '150px'], ['overflow', 'hidden'], ['textOverflow', 'ellipsis'], ['whiteSpace', 'nowrap']]) {
      expect(badge.style('.kanbanProjectBadge', property), property).toBe(value);
    }
    expect(badge.style('.kanbanProjectBadge', 'fontSize')).toBe('11px');
    const standalone = renderToStyle('<span class="kanbanProjectBadge">Stacks</span>');
    expect(standalone.style('.kanbanProjectBadge', 'maxWidth')).toBe('100%');
    expect(standalone.style('.kanbanProjectBadge', 'fontSize')).toBe('12px');

    const hierarchy = renderToStyle(
      h('div', { className: 'kanbanDetail' },
        h('header', null,
          h(CardHierarchyBadges, {
            card: card({ parent: { id: 'parent', external_id: '12', title: 'Parent' } }),
            onNavigateParent() {},
          }))),
      { projectAccent: tealAccent },
    );
    const parent = '.kanbanDetail > header button.kanbanHierarchyBadge.parent';
    for (const [property, value] of [
      ['padding', '3px 8px'], ['borderTopColor', color(hierarchy.token('--kanban-border'))], ['borderRadius', '999px'],
      ['backgroundColor', color(hierarchy.token('--surface-parent'))], ['color', 'rgb(145, 164, 182)'], ['fontSize', '12px'], ['fontWeight', '650'],
    ]) expect(property === 'color' ? color(hierarchy.style(parent, property)) : hierarchy.style(parent, property), property).toBe(value);
    for (const suffix of [':hover:not(:disabled)', ':focus-visible']) {
      expect(color(hierarchy.declaration(`${parent}${suffix}`, 'background'))).toBe(color(hierarchy.token('--surface-parent')));
      expect(color(hierarchy.declaration(`${parent}${suffix}`, 'color'))).toBe('rgb(145, 164, 182)');
      expect(color(hierarchy.declaration(`${parent}${suffix}`, 'border-color'))).toBe(color(hierarchy.token('--kanban-border')));
    }
    expect(hierarchy.declaration(`${parent}:focus-visible`, 'outline')).toBe('2px solid #78a9d1');
    expect(hierarchy.declaration(`${parent}:focus-visible`, 'outline-offset')).toBe('2px');
  });

  it('centers the square close icon beside the hierarchy row with equal top and right insets', () => {
    const { style, declaration } = renderToStyle('<div class="kanbanDetail"><header><button class="kanbanDetailClose"></button></header></div>');
    expect(style('.kanbanDetail > header', 'padding')).toBe('20px');
    for (const [property, value] of [
      ['width', '26px'], ['height', '26px'], ['flex', '0 0 26px'], ['padding', '0'], ['display', 'grid'], ['placeItems', 'center'],
    ]) expect(style('.kanbanDetail > header > .kanbanDetailClose', property), property).toBe(value);
    expect(declaration('.kanbanDetailClose::before', 'content')).toBe("''");
    expect(declaration('.kanbanDetailClose::before', 'width')).toBe('13px');
    expect(declaration('.kanbanDetailClose::before', 'height')).toBe('1.5px');
    expect(declaration('.kanbanDetailClose::before', 'grid-area')).toBe('1 / 1');
    expect(declaration('.kanbanDetailClose::after', 'content')).toBe("''");
  });
});

describe('Kanban list wrapping and row geometry', () => {
  it('wraps list metadata without clipping badges or changing their shared heading typography', () => {
    const { style } = renderToStyle(list([card({ parent: { id: 'parent', external_id: '12', title: 'Parent' }, child_count: 1 })]), { projectAccent: tealAccent });
    for (const selector of ['.kanbanListRow .kanbanCardSource', '.kanbanListRow .kanbanCardSourceLeft', '.kanbanListRow .kanbanCardMeta']) {
      expect(style(selector, 'flexWrap'), selector).toBe('wrap');
    }
    for (const [property, value] of [
      ['flex', '0 0 auto'], ['minWidth', '0'], ['maxWidth', '100%'], ['textOverflow', 'clip'],
      ['overflow', 'visible'], ['whiteSpace', 'normal'], ['overflowWrap', 'anywhere'],
    ]) expect(style('.kanbanListRow .kanbanCardSourceLeft > .kanbanProjectBadge', property), property).toBe(value);
    expect(style('.kanbanListRow .kanbanCardSourceLeft > .kanbanProjectBadge', 'fontSize')).toBe('11px');
    expect(style('.kanbanListRow .kanbanHierarchyGroup', 'flexWrap')).toBe('wrap');
    expect(style('.kanbanListRow > strong', 'overflow')).toBe('hidden');
  });

  it('reserves a stable card-number width and keeps list insets for the outward focus outline', () => {
    const { style } = renderToStyle(list([card()]), { projectAccent: tealAccent });
    expect(style('.kanbanListRow .kanbanCardNumber', 'minWidth')).toBe('6ch');
    expect(style('.kanbanListRows', 'padding')).toBe('3px 8px 8px');
  });
});
