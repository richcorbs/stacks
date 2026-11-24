// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import type { KanbanCard } from '../../kanban/types';
import { CardOverview } from './CardOverview';

const project: Project = { id: 'project-1', name: 'Stacks', path: '/tmp/stacks' };

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
});

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

async function renderOverview(currentCard: KanbanCard) {
  await act(async () => {
    root = createRoot(container);
    root.render(<CardOverview
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
  });
  // Lazy Markdown + Suspense means the first pass only proves the raw fallback.
  for (let attempt = 0; attempt < 10 && container.querySelector('.kanbanLocalDescription'); attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  return container.innerHTML;
}

describe('CardOverview descriptions', () => {
  it('renders local Markdown tables and soft breaks in the shared wrapping container', async () => {
    const markup = await renderOverview(card({
      content: '# Plan\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nline one\nline two',
    }));

    expect(markup).toContain('class="kanbanCardDescription piMarkdown"');
    expect(markup).not.toContain('kanbanLocalDescription');
    expect(markup).toContain('<h1>Plan</h1>');
    expect(markup).toContain('<table>');
    expect(markup).toContain('<thead>');
    expect(markup).toContain('<tbody>');
    expect(markup).toContain('<th>A</th>');
    expect(markup).toContain('<td>1</td>');
    expect(markup).toMatch(/line one<br\/?>line two/);
  });

  it('uses the shared wrapping container for remote HTML including preformatted content', async () => {
    const markup = await renderOverview(card({
      id: 'superthread:93',
      provider: 'superthread',
      content: '<p>long_unbroken_remote_description</p><pre><code>const  value = 1;</code></pre>',
    }));

    expect(markup).toContain('class="kanbanCardDescription"');
    expect(markup).toContain('<p>long_unbroken_remote_description</p>');
    expect(markup).toContain('<pre><code>const  value = 1;</code></pre>');
  });

  it('offers the same retry for a queued update that was never attempted', async () => {
    // A `pending` row with 0 attempts was queued and never drained (the drain can
    // run before the row commits). Without a retry here the card has no way to
    // finish the update, and cleanup refuses while the operation is unresolved.
    const markup = await renderOverview(card({ provider_sync: {
      id: 'operation', kind: 'done', state: 'pending', destination_column_name: 'Done',
      attempts: 0, error: null, updated_at: 2,
    } }));
    expect(markup).toContain('Superthread update pending');
    expect(markup).toContain('Retry provider sync');
  });

  it('shows durable provider failures with an independent retry control', async () => {
    const markup = await renderOverview(card({ provider_sync: {
      id: 'operation', kind: 'done', state: 'failed', destination_column_name: 'Stacks is done',
      attempts: 2, error: 'Superthread timed out', updated_at: 2,
    } }));
    expect(markup).toContain('Superthread update failed');
    expect(markup).toContain('Superthread timed out');
    expect(markup).toContain('Retry provider sync');
  });
});
