import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GitChangeSummary, Project } from '../../types';
import type { CardPullRequest, KanbanCard } from '../../kanban/types';
import { CardDetailHeader, CardDetailTabs } from './CardDetailChrome';

const project: Project = { id: 'project-1', name: 'Stacks', path: '/tmp/stacks' };

function pullRequest(): CardPullRequest {
  return {
    repository: 'stacks/example',
    number: 82,
    title: 'Move children badge after status badge',
    url: 'https://github.com/stacks/example/pull/82',
    state: 'open',
    draft: false,
    ci_status: 'success',
    review_state: 'approved',
    has_conflicts: false,
    mergeable: true,
    blockers: [],
  };
}

function card(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: 'local:project-1:82', provider: 'local', external_id: '82',
    title: 'Move children badge after status badge', content: '',
    board_id: 'project-1', board_title: 'Stacks', list_id: '', list_title: '', card_url: '',
    assignee_names: [], status: 'ready', workflow_revision: 1, record_revision: 1,
    project_id: project.id,
    parent: { id: 'local:project-1:12', external_id: '12', title: 'Parent card', status: 'ready' },
    child_count: 2, children: [], hierarchy_finalized: false,
    environment: {
      id: 'environment-82', card_id: 'local:project-1:82', project_id: project.id,
      worktree_path: '/tmp/stacks-card-82', branch: 'stacks/card-82-a-very-long-environment-branch',
      repository_id: null, target_checkout_path: null, target_branch: 'main',
      source_revision: null, target_revision: null, lifecycle_state: 'ready', revision: 1,
      layout_revision: 1, split_layout: { kind: 'empty' }, focused_pane_id: null, panes: [],
    },
    pull_request: pullRequest(),
    created_at: 1, updated_at: 1, sort_order: 0, events: [], capabilities: [],
    ...overrides,
  };
}

function renderHeader(currentCard: KanbanCard, gitChangeSummary: GitChangeSummary | null = { added: 1, modified: 2, deleted: 3 }, editing = false) {
  return renderToStaticMarkup(<CardDetailHeader
    card={currentCard}
    project={project}
    projects={[project]}
    statusLabel="Ready"
    gitChangeSummary={gitChangeSummary}
    editable
    editing={editing}
    draftTitle={currentCard.title}
    titleInputRef={createRef<HTMLInputElement>()}
    onDraftTitleChange={() => undefined}
    onBeginEditing={() => undefined}
    onRequestClose={() => undefined}
    onAssignProject={async () => undefined}
    onActionError={() => undefined}
    onNavigateParent={() => undefined}
  />);
}

function classIndex(markup: string, className: string) {
  return markup.indexOf(`class="${className}`);
}

function repositoryTokens(markup: string) {
  return Array.from(
    markup.matchAll(/class="(?:(kanbanCardHeaderBranch|kanbanDetailRepositorySeparator|kanbanCardGitSummary)"|(kanbanCardPrLink)\s)/g),
    (match) => match[1] ?? match[2],
  );
}

describe('CardDetailTabs', () => {
  it('keeps the Diff refresh control rendered while another tab is active', () => {
    const markup = renderToStaticMarkup(<CardDetailTabs
      activeView="overview"
      hierarchyFinalized={false}
      projectAvailable
      cardPath="/tmp/stacks-card-82"
      serverCommand=""
      consoleCommand=""
      serverServices={{
        serverEnabled: false,
        consoleEnabled: false,
        serverRunning: false,
        consoleRunning: false,
        toggle: async () => undefined,
      }}
      onRequestView={() => undefined}
      onRefreshDiff={() => undefined}
    />);

    expect(markup).toContain('class="cardDiffRefresh"');
    expect(markup).toContain('aria-label="Refresh diff"');
  });
});

describe('CardDetailHeader', () => {
  it('groups workflow metadata and the edit button on the left and adjacent hierarchy badges on the right', () => {
    const markup = renderHeader(card());
    const titleIndex = markup.indexOf('<h2>');
    const leftStart = classIndex(markup, 'kanbanDetailHeaderMetaLeft');
    const leftEnd = markup.indexOf('</div><div class="kanbanHierarchyGroup">');

    expect(markup.indexOf('#82')).toBeGreaterThan(leftStart);
    expect(markup.indexOf('#82')).toBeLessThan(classIndex(markup, 'kanbanProjectBadge'));
    expect(classIndex(markup, 'kanbanProjectBadge')).toBeLessThan(classIndex(markup, 'kanbanCardStatus'));
    expect(classIndex(markup, 'kanbanCardStatus')).toBeLessThan(classIndex(markup, 'kanbanCardEditButton'));
    expect(classIndex(markup, 'kanbanCardEditButton')).toBeLessThan(leftEnd);
    expect(classIndex(markup, 'kanbanHierarchyGroup')).toBeGreaterThan(leftEnd);
    expect(classIndex(markup, 'kanbanHierarchyBadge parent')).toBeGreaterThan(classIndex(markup, 'kanbanHierarchyGroup'));
    expect(classIndex(markup, 'kanbanHierarchyBadge parent')).toBeLessThan(classIndex(markup, 'kanbanHierarchyBadge children'));

    expect(classIndex(markup, 'kanbanCardGitSummary')).toBeGreaterThan(titleIndex);
    expect(classIndex(markup, 'kanbanCardPrLink')).toBeGreaterThan(titleIndex);
    expect(classIndex(markup, 'kanbanCardHeaderBranch')).toBeLessThan(classIndex(markup, 'kanbanCardGitSummary'));
    expect(classIndex(markup, 'kanbanCardGitSummary')).toBeLessThan(classIndex(markup, 'kanbanCardPrLink'));
  });

  it('renders the close icon after the heading with its accessible label intact', () => {
    const markup = renderHeader(card());

    expect(classIndex(markup, 'kanbanDetailClose')).toBeGreaterThan(markup.indexOf('</div><button'));
    expect(markup).toContain('<button class="kanbanDetailClose" type="button" aria-label="Close card details"></button>');
  });

  it('keeps an editable project control in the left group and omits an empty hierarchy group', () => {
    const markup = renderHeader(card({ status: 'needs_refinement', parent: null, child_count: 0, environment: null }));
    const leftStart = classIndex(markup, 'kanbanDetailHeaderMetaLeft');

    expect(classIndex(markup, 'kanbanProjectAssignment')).toBeGreaterThan(leftStart);
    expect(classIndex(markup, 'kanbanProjectAssignment')).toBeLessThan(classIndex(markup, 'kanbanCardStatus'));
    expect(classIndex(markup, 'kanbanCardEditButton')).toBeGreaterThan(classIndex(markup, 'kanbanCardStatus'));
    expect(markup).not.toContain('kanbanHierarchyGroup');
  });

  it('renders separators only between repository metadata items for every presence combination', () => {
    const changed: GitChangeSummary = { added: 1, modified: 2, deleted: 3 };
    const unchanged: GitChangeSummary = { added: 0, modified: 0, deleted: 0 };
    const cases: Array<{
      label: string;
      currentCard: KanbanCard;
      summary: GitChangeSummary | null;
      expected: string[];
    }> = [
      {
        label: 'branch, Git summary, and pull request',
        currentCard: card(),
        summary: changed,
        expected: ['kanbanCardHeaderBranch', 'kanbanDetailRepositorySeparator', 'kanbanCardGitSummary', 'kanbanDetailRepositorySeparator', 'kanbanCardPrLink'],
      },
      {
        label: 'branch and Git summary',
        currentCard: card({ pull_request: null }),
        summary: changed,
        expected: ['kanbanCardHeaderBranch', 'kanbanDetailRepositorySeparator', 'kanbanCardGitSummary'],
      },
      {
        label: 'branch and pull request',
        currentCard: card(),
        summary: null,
        expected: ['kanbanCardHeaderBranch', 'kanbanDetailRepositorySeparator', 'kanbanCardPrLink'],
      },
      {
        label: 'Git summary and pull request',
        currentCard: card({ environment: null }),
        summary: changed,
        expected: ['kanbanCardGitSummary', 'kanbanDetailRepositorySeparator', 'kanbanCardPrLink'],
      },
      {
        label: 'branch only',
        currentCard: card({ pull_request: null }),
        summary: unchanged,
        expected: ['kanbanCardHeaderBranch'],
      },
      {
        label: 'Git summary only',
        currentCard: card({ environment: null, pull_request: null }),
        summary: changed,
        expected: ['kanbanCardGitSummary'],
      },
      {
        label: 'pull request only',
        currentCard: card({ environment: null }),
        summary: null,
        expected: ['kanbanCardPrLink'],
      },
      {
        label: 'no repository metadata',
        currentCard: card({ environment: null, pull_request: null }),
        summary: unchanged,
        expected: [],
      },
    ];

    for (const { label, currentCard, summary, expected } of cases) {
      const markup = renderHeader(currentCard, summary);
      expect(repositoryTokens(markup), label).toEqual(expected);
      expect(markup.match(/class="kanbanDetailRepositorySeparator" aria-hidden="true">•<\/span>/g)?.length ?? 0, label)
        .toBe(expected.filter((token) => token === 'kanbanDetailRepositorySeparator').length);
    }
  });

  it('renders Git and pull-request metadata without an environment branch', () => {
    const markup = renderHeader(card({ environment: null }));

    expect(markup).toContain('class="kanbanDetailRepositoryMeta"');
    expect(markup).not.toContain('kanbanCardHeaderBranch');
    expect(markup).toContain('kanbanCardGitSummary');
    expect(markup).toContain('kanbanCardPrLink openReady');
  });

  it.each([
    ['Git changes', card({ environment: null, pull_request: null }), { added: 1, modified: 0, deleted: 0 }, 'kanbanCardGitSummary'],
    ['a pull request', card({ environment: null }), null, 'kanbanCardPrLink openReady'],
  ])('renders the repository row with only %s', (_label, currentCard, summary, expectedClass) => {
    const markup = renderHeader(currentCard, summary);

    expect(markup).toContain('class="kanbanDetailRepositoryMeta"');
    expect(markup).toContain(expectedClass);
  });

  it('renders branch metadata beneath the title input while editing', () => {
    const markup = renderHeader(card({ pull_request: null }), { added: 0, modified: 0, deleted: 0 }, true);

    expect(classIndex(markup, 'kanbanCardTitleInput')).toBeLessThan(classIndex(markup, 'kanbanDetailRepositoryMeta'));
    expect(markup).toContain('kanbanCardHeaderBranch');
    expect(markup).not.toContain('kanbanCardGitSummary');
    expect(markup).not.toContain('kanbanCardPrLink');
  });

  it('omits the repository row when branch, Git changes, and pull request are absent', () => {
    const markup = renderHeader(card({ environment: null, pull_request: null }), { added: 0, modified: 0, deleted: 0 });

    expect(markup).not.toContain('kanbanDetailRepositoryMeta');
    expect(markup).not.toContain('kanbanCardHeaderBranch');
    expect(markup).not.toContain('kanbanCardGitSummary');
    expect(markup).not.toContain('kanbanCardPrLink');
  });
});
