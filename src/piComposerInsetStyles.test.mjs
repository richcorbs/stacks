import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function declarationsFor(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = styles.match(new RegExp(`(?:^|\\n)${escapedSelector}\\s*\\{([^}]*)\\}`));
  if (!rule) throw new Error(`Missing CSS rule for ${selector}`);
  return rule[1];
}

describe('Pi composer inset styling', () => {
  it('uses the pane-width inset for the composer with extra bottom breathing room', () => {
    const pane = declarationsFor('.piGuiPane');
    const composer = declarationsFor('.piComposer');
    const footer = declarationsFor('.piGuiFooter');

    expect(pane).toContain('--pi-composer-inset: max(18px, 7cqw)');
    expect(pane).toContain('--pi-composer-bottom-inset: calc(var(--pi-composer-inset) + 2px)');
    expect(pane).toContain('container-type: inline-size');
    expect(composer).toContain('margin: 0 var(--pi-composer-inset)');
    expect(footer).toContain('height: var(--pi-composer-bottom-inset)');
    expect(footer).toContain('flex: 0 0 var(--pi-composer-bottom-inset)');
    expect(footer).toContain('margin: 0 var(--pi-composer-inset)');
  });

  it('uses the existing fixed card-chat inset everywhere', () => {
    const cardPane = declarationsFor('.cardChat .piGuiPane');
    expect(cardPane).toContain('--pi-composer-inset: 24px');
  });
});
