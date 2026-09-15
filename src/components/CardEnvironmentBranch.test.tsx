import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CardEnvironmentBranch } from './CardEnvironmentBranch';

describe('CardEnvironmentBranch', () => {
  it('shows the persisted environment branch beneath a card title', () => {
    const markup = renderToStaticMarkup(<div className="kanbanDetailHeading">
      <h2>Clean up the composer context</h2>
      <CardEnvironmentBranch branch="stacks/card-55-clean-up-the-sub-text-under-the-gui-input" />
    </div>);

    expect(markup).toContain('aria-label="Environment branch: stacks/card-55-clean-up-the-sub-text-under-the-gui-input"');
    expect(markup).toContain('class="kanbanCardHeaderBranchSymbol" aria-hidden="true">');
    expect(markup.indexOf('</h2>')).toBeLessThan(markup.indexOf('kanbanCardHeaderBranch'));
  });

  it('stays beneath the title input while a card title is being edited', () => {
    const markup = renderToStaticMarkup(<div className="kanbanDetailHeading">
      <input className="kanbanCardTitleInput" aria-label="Card title" defaultValue="Edited title" />
      <CardEnvironmentBranch branch="feature/long-running-card-work" />
    </div>);

    expect(markup.indexOf('kanbanCardTitleInput')).toBeLessThan(markup.indexOf('kanbanCardHeaderBranch'));
  });

  it.each([null, undefined, '', '   '])('renders nothing without an environment branch (%s)', (branch) => {
    expect(renderToStaticMarkup(<CardEnvironmentBranch branch={branch} />)).toBe('');
  });
});
