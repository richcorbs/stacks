import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function declarationsFor(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  if (!rule) throw new Error(`Missing CSS rule for ${selector}`);
  return rule[1];
}

describe('shared card workspace tab alignment', () => {
  it('keeps card workspace chrome stable while switching views', () => {
    expect(declarationsFor('.kanbanDetail.cardWorkspace')).toContain('background: #0c1219');
    const header = declarationsFor('.kanbanDetail.cardWorkspace > header');
    const tabs = declarationsFor('.kanbanDetail.cardWorkspace .cardWorkspaceTabs');
    expect(header).toContain('background: #0c1219');
    expect(header).toContain('border-bottom: 0');
    expect(tabs).toContain('background: #0c1219');
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

    expect(declarations).toContain('color: #d6deeb');
  });

  it('includes grouped action icons in the tab hover treatment', () => {
    const groupedTabs = declarationsFor('.cardDiffTab:hover, .cardServiceTab:hover');
    expect(groupedTabs).toContain('background: #2b4058');

    const controls = declarationsFor(
      '.cardWorkspaceTabs button.cardServiceToggle:hover, .cardWorkspaceTabs button.cardDiffRefresh:hover, .cardServiceTab:hover button.cardServiceToggle, .cardDiffTab:hover button.cardDiffRefresh',
    );
    expect(controls).toContain('border-color: #4a6278');
    expect(controls).toContain('color: #aabac8');
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
