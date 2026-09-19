import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import type { KanbanCard } from '../../kanban/types';
import { CardOverview } from './CardOverview';

vi.mock('dompurify', () => ({
  default: { sanitize: (content: string) => content },
}));

const project: Project = { id: 'project-1', name: 'Stacks', path: '/tmp/stacks' };

function card(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: 'local:project-1:93', provider: 'local', external_id: '93',
    title: 'Cards should have overflow scroll', content: 'Description',
    board_id: 'project-1', board_title: 'Stacks', list_id: '', list_title: '', card_url: '',
    assignee_names: [], status: 'ready', workflow_revision: 1, record_revision: 1,
    project_id: project.id, parent: null, child_count: 0, children: [], hierarchy_finalized: false,
    environment: null, created_at: 1, updated_at: 1, sort_order: 0, events: [], capabilities: [],
    ...overrides,
  };
}

function renderOverview(currentCard: KanbanCard) {
  return renderToStaticMarkup(<CardOverview
    active
    editing={false}
    card={currentCard}
    cards={[currentCard]}
    project={project}
    recheckingEnvironment={false}
    draftContent={currentCard.content}
    editError={null}
    setDraftContent={() => undefined}
    setEditError={() => undefined}
    setActionError={() => undefined}
    onRecheckEnvironment={() => undefined}
    onUpdate={async () => currentCard}
    onCardUpdated={() => undefined}
    onNavigate={() => undefined}
  />);
}

describe('CardOverview descriptions', () => {
  it('uses the shared wrapping container for local plain text', () => {
    const markup = renderOverview(card({ content: 'long_unbroken_local_description' }));

    expect(markup).toContain('class="kanbanCardDescription kanbanLocalDescription"');
    expect(markup).toContain('long_unbroken_local_description');
  });

  it('uses the shared wrapping container for remote HTML including preformatted content', () => {
    const markup = renderOverview(card({
      id: 'superthread:93',
      provider: 'superthread',
      content: '<p>long_unbroken_remote_description</p><pre><code>const  value = 1;</code></pre>',
    }));

    expect(markup).toContain('class="kanbanCardDescription"');
    expect(markup).toContain('<p>long_unbroken_remote_description</p>');
    expect(markup).toContain('<pre><code>const  value = 1;</code></pre>');
  });

  it('shows durable provider failures with an independent retry control', () => {
    const markup = renderOverview(card({ provider_sync: {
      id: 'operation', kind: 'done', state: 'failed', destination_column_name: 'Stacks is done',
      attempts: 2, error: 'Superthread timed out', updated_at: 2,
    } }));
    expect(markup).toContain('Superthread update failed');
    expect(markup).toContain('Superthread timed out');
    expect(markup).toContain('Retry provider sync');
  });
});
