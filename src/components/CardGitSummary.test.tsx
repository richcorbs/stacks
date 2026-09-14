import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CardGitSummary } from './CardGitSummary';

describe('CardGitSummary', () => {
  it('formats all nonzero categories with the shared Git colors', () => {
    const markup = renderToStaticMarkup(<CardGitSummary summary={{ added: 2, modified: 3, deleted: 4 }} />);
    expect(markup).toContain('class="gitAdded">+2');
    expect(markup).toContain('class="gitChanged">~3');
    expect(markup).toContain('class="gitRemoved">-4');
  });

  it('omits zero-value categories', () => {
    const markup = renderToStaticMarkup(<CardGitSummary summary={{ added: 0, modified: 3, deleted: 0 }} />);
    expect(markup).toContain('~3');
    expect(markup).not.toContain('gitAdded');
    expect(markup).not.toContain('gitRemoved');
  });

  it('omits the complete summary for clean or unavailable results', () => {
    expect(renderToStaticMarkup(<CardGitSummary summary={{ added: 0, modified: 0, deleted: 0 }} />)).toBe('');
    expect(renderToStaticMarkup(<CardGitSummary summary={null} />)).toBe('');
  });

  it('stays immediately beside the workflow status in heading metadata', () => {
    const markup = renderToStaticMarkup(<div className="kanbanDetailHeaderMeta">
      <span className="kanbanCardStatus">In progress</span>
      <CardGitSummary summary={{ added: 1, modified: 0, deleted: 0 }} />
      <button>Edit</button>
    </div>);
    expect(markup.indexOf('kanbanCardStatus')).toBeLessThan(markup.indexOf('kanbanCardGitSummary'));
    expect(markup.indexOf('kanbanCardGitSummary')).toBeLessThan(markup.indexOf('<button'));
  });
});
