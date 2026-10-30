import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const tabHoverSelector = '.cardWorkspaceTabs > button:hover:not(:disabled),\n.cardDiffTab:hover:has(button:not(:disabled)),\n.cardServiceTab:hover:has(button:not(:disabled))';

function declarationsFor(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  if (!rule) throw new Error(`Missing CSS rule for ${selector}`);
  return rule[1];
}

describe('shared card workspace tab alignment', () => {
  it('keeps card workspace chrome stable while switching views', () => {
    expect(declarationsFor('.kanbanDetail.cardWorkspace')).toContain('background: var(--surface-inset)');
    const header = declarationsFor('.kanbanDetail.cardWorkspace > header');
    const tabs = declarationsFor('.kanbanDetail.cardWorkspace .cardWorkspaceTabs');
    expect(header).toContain('background: var(--surface-inset)');
    expect(header).toContain('border-bottom: 0');
    expect(tabs).toContain('background: var(--surface-inset)');
    expect(tabs).toContain('border-bottom: 1px solid #223142');
  });

  it('raises icon-free and grouped tab labels through their shared rule without changing total vertical padding', () => {
    const declarations = declarationsFor('.cardWorkspaceTabs button');

    expect(declarations).toContain('padding: 7px 10px 11px');
    expect(declarationsFor('.cardWorkspaceTabs .cardDiffTabLabel')).not.toMatch(/padding-(top|bottom):/);
    expect(declarationsFor('.cardWorkspaceTabs .cardServiceTabLabel')).not.toMatch(/padding-(top|bottom):/);
  });

  it('gives icon-free tabs the same stretched, bottom-aligned y geometry', () => {
    const declarations = declarationsFor('.cardWorkspaceTabs > button');

    expect(declarations).toContain('align-self: stretch');
    expect(declarations).toContain('display: inline-flex');
    expect(declarations).toContain('align-items: end');
  });

  it('stretches service hover paint through the tab row in both workspace layouts', () => {
    const wrapper = declarationsFor('.cardServiceTabs');
    const service = declarationsFor('.cardServiceTab');
    const diff = declarationsFor('.cardDiffTab');

    // Card detail nests service tabs; direct project work renders them directly in the row.
    expect(wrapper).toContain('align-self: stretch');
    expect(wrapper).toContain('align-items: stretch');
    expect(service).toContain('align-self: stretch');
    expect(service).toContain('align-items: end');
    expect(diff).toContain('align-self: stretch');
    expect(declarationsFor(tabHoverSelector)).toContain('background: var(--surface-drag)');
  });

  it('reserves the extra trailing inset for icon-bearing tabs', () => {
    const declarations = declarationsFor(
      '.cardWorkspaceTabs .cardDiffTab:has(.cardDiffRefresh), .cardWorkspaceTabs .cardServiceTab',
    );

    expect(declarations).toContain('padding-right: 10px');
  });

  it('uses high-contrast hover text for direct and grouped tabs', () => {
    const declarations = declarationsFor(
      '.cardWorkspaceTabs button:hover:not(:disabled), .cardDiffTab:hover .cardDiffTabLabel:not(:disabled), .cardServiceTab:hover .cardServiceTabLabel:not(:disabled)',
    );

    expect(declarations).toContain('color: #fff');
  });

  it('includes grouped action icons in the tab hover treatment', () => {
    const groupedTabs = declarationsFor(tabHoverSelector);
    expect(groupedTabs).toContain('background: var(--surface-drag)');

    const controls = declarationsFor(
      '.cardWorkspaceTabs button.cardServiceToggle:hover, .cardWorkspaceTabs button.cardDiffRefresh:hover, .cardServiceTab:hover button.cardServiceToggle, .cardDiffTab:hover button.cardDiffRefresh',
    );
    expect(controls).toContain('border-color: #4a6278');
    expect(controls).toContain('color: #aabac8');
  });

  it('scopes the subdued project hover palette to owned workspace tabs only', () => {
    const projectHoverSelector = tabHoverSelector.split(',\n')
      .map((selector) => `.cardWorkspace[data-project-color] ${selector}`).join(',\n');
    expect(declarationsFor(projectHoverSelector)).toContain('background: var(--project-card-hover-surface)');
    expect(declarationsFor('[data-project-color="blue"]')).toContain('--project-card-hover-surface: #192838');
    expect(declarationsFor('[data-project-color]:not([data-project-color="blue"])'))
      .toContain('--project-card-hover-surface: color-mix(in srgb, var(--project-accent) 24%, #15202c)');
    for (const color of ['slate', 'teal', 'green', 'amber', 'coral', 'rose', 'violet', 'indigo', 'cyan']) {
      expect(declarationsFor(`[data-project-color="${color}"]`)).toMatch(/--project-accent: #[0-9a-f]{6}/);
    }
  });

  it('keeps nested label hover transparent without resetting controls, focus, or active underlines', () => {
    expect(declarationsFor('.cardWorkspaceTabs :is(.cardDiffTabLabel, .cardServiceTabLabel):hover:not(:disabled)'))
      .toContain('background: transparent');
    expect(declarationsFor(tabHoverSelector).trim())
      .toBe('background: var(--surface-drag);');
    expect(declarationsFor('[data-project-color] .cardWorkspaceTabs button.active,\n[data-project-color] .cardDiffTab.active,\n[data-project-color] .cardServiceTab.active'))
      .toContain('border-bottom-color: var(--project-tab-accent)');
    expect(declarationsFor('.cardWorkspaceTabs button.cardServiceToggle.running'))
      .toContain('border-color: #416b55; background: #15271e; color: #70bd8d');
  });

  it('preserves service control and icon geometry', () => {
    const controls = declarationsFor(
      '.cardWorkspaceTabs button.cardServiceToggle, .cardWorkspaceTabs button.cardDiffRefresh',
    );

    expect(controls).toContain('width: 20px');
    expect(controls).toContain('height: 20px');
    expect(controls).toContain('margin-bottom: 7px');
    expect(controls).toContain('padding: 0');

    const playIcon = declarationsFor('.servicePlayIcon');
    expect(playIcon).toContain('margin-left: 1px');
    expect(playIcon).toContain('border-top: 4px solid transparent');
    expect(playIcon).toContain('border-bottom: 4px solid transparent');
    expect(playIcon).toContain('border-left: 6px solid currentColor');

    const stopIcon = declarationsFor('.serviceStopIcon');
    expect(stopIcon).toContain('width: 8px');
    expect(stopIcon).toContain('height: 8px');
  });
});
