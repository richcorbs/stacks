import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mapWithConcurrency, superthreadIntegration } from './cardProvider';
import { createSuperthreadCard, fetchSuperthreadBoards, fetchSuperthreadCard, fetchSuperthreadCards, fetchSuperthreadLists } from './api';

vi.mock('./api', () => ({
  createSuperthreadCard: vi.fn(),
  fetchSuperthreadBoards: vi.fn(),
  fetchSuperthreadCard: vi.fn(),
  fetchSuperthreadCards: vi.fn(),
  fetchSuperthreadLists: vi.fn(),
}));

const createMock = vi.mocked(createSuperthreadCard);
const boardsMock = vi.mocked(fetchSuperthreadBoards);
const cardMock = vi.mocked(fetchSuperthreadCard);
const cardsMock = vi.mocked(fetchSuperthreadCards);
const listsMock = vi.mocked(fetchSuperthreadLists);

describe('Superthread card provider creation', () => {
  beforeEach(() => {
    createMock.mockReset(); boardsMock.mockReset(); cardMock.mockReset(); cardsMock.mockReset(); listsMock.mockReset();
  });

  it('creates in configured scope and maps a complete managed sync snapshot', async () => {
    createMock.mockResolvedValue({
      id: '48',
      title: 'New card',
      content: 'Detailed brief',
      board_id: 'board-1',
      board_title: 'Dev - Active',
      list_id: 'list-1',
      list_title: 'Backlog',
      total_comments: 0,
      assignee_names: [],
      card_url: 'https://app.superthread.com/example/card-48',
    });

    await expect(superthreadIntegration({ ownerProjectId: 'owner', spaces: 'Product, Engineering', workspaceSlug: 'example', boardId: 'board-1', boardName: 'Dev - Active', incomingColumnIds: ['triage', 'list-1'], defaultIncomingColumnId: 'list-1' }).create('New card', 'Detailed brief')).resolves.toEqual({
      id: '48',
      title: 'New card',
      content: 'Detailed brief',
      board_id: 'board-1',
      board_title: 'Dev - Active',
      list_id: 'list-1',
      list_title: 'Backlog',
      card_url: 'https://app.superthread.com/example/card-48',
      assignee_names: [],
      task_parent_id: null,
      task_parent_title: null,
      parent_relationship_hydrated: true,
      total_task_children: 0,
      in_scope: true,
    });
    expect(createMock).toHaveBeenCalledWith({
      boardId: 'board-1',
      apiTokenEnvVar: 'ST_TOKEN',
      listId: 'list-1',
      workspaceSlug: 'example',
      title: 'New card',
      content: 'Detailed brief',
    });
  });

  it('returns successful board data and conservative coverage for a partial snapshot', async () => {
    boardsMock.mockResolvedValue({
      boards: [{ id: 'good', title: 'Dev - Active' }, { id: 'bad', title: 'Roadmap' }],
      successful_space_ids: ['space-1'], warnings: [], complete: true,
    });
    listsMock.mockImplementation(async (boardId) => {
      if (boardId === 'bad') throw new Error('list access denied');
      return [{ id: 'doing', title: 'Doing', behavior: 'started' }];
    });
    cardsMock.mockImplementation(async (boardId) => boardId === 'good' ? [{
      id: '1', title: 'Fetched', content: null, board_id: 'good', board_title: 'Dev - Active',
      list_id: 'doing', list_title: '', total_comments: 0, assignee_names: [], card_url: '',
    }] : [{
      id: '2', title: 'Still fetched', content: '', board_id: 'bad', board_title: 'Roadmap',
      list_id: 'done', list_title: 'Done', total_comments: 0, assignee_names: [], card_url: '',
    }, {
      id: '3', title: 'Unknown list', content: null, board_id: 'bad', board_title: 'Roadmap',
      list_id: 'unknown', list_title: '', total_comments: 0, assignee_names: [], card_url: '',
    }]);

    const snapshot = await superthreadIntegration({ ownerProjectId: 'owner', spaces: 'Product', boardId: 'good', boardName: 'Dev - Active', incomingColumnIds: ['doing'], defaultIncomingColumnId: 'doing' }).sync();
    expect(snapshot.cards).toHaveLength(1);
    expect(snapshot.cards[0]).toMatchObject({ id: '1', content: null, in_scope: true, parent_relationship_hydrated: false });
    expect(snapshot.successful_board_ids).toEqual(['good']);
    expect(snapshot.failed_scopes).toEqual([]);
    expect(snapshot.complete).toBe(true);
  });

  it('maps detailed parent coverage authoritatively', async () => {
    cardMock.mockResolvedValue({
      id: '2242', title: 'Child', content: 'Details', board_id: 'board-1', board_title: 'Dev - Active',
      list_id: 'doing', list_title: 'Doing', total_comments: 0, assignee_names: [], card_url: '',
      task_parent: { id: '2240', title: 'Parent card' },
    });
    const provider = superthreadIntegration({ ownerProjectId: 'owner', spaces: 'Product', boardId: 'board-1', boardName: 'Dev - Active', incomingColumnIds: ['doing'], defaultIncomingColumnId: 'doing' });
    const local = {
      id: 'superthread:2242', provider: 'superthread' as const, external_id: '2242', title: 'Child', content: '',
      board_id: 'board-1', board_title: 'Dev - Active', list_id: 'doing', list_title: 'Doing', card_url: '', assignee_names: [],
      status: 'needs_refinement' as const, workflow_revision: 1, record_revision: 1, project_id: 'owner', parent: null,
      child_count: 0, children: [], hierarchy_finalized: false, environment: null, created_at: 1, updated_at: 1,
      sort_order: 0, events: [], capabilities: [],
    };

    await expect(provider.load(local)).resolves.toMatchObject({
      id: '2242', task_parent_id: '2240', task_parent_title: 'Parent card', parent_relationship_hydrated: true,
    });
  });

  it('hydrates positive-count and locally known parents, including a zero-child transition', async () => {
    boardsMock.mockResolvedValue({ boards: [{ id: 'board-1', title: 'Dev - Active' }], successful_space_ids: ['space-1'], warnings: [], complete: true });
    listsMock.mockResolvedValue([{ id: 'doing', title: 'Doing', behavior: 'started' }]);
    cardsMock.mockResolvedValue([
      { id: '2240', title: 'Listed parent', content: null, board_id: 'board-1', board_title: 'Dev - Active', list_id: 'doing', list_title: 'Doing', total_comments: 0, assignee_names: [], card_url: '', total_task_children: 1 },
      { id: '2242', title: 'Child', content: null, board_id: 'board-1', board_title: 'Dev - Active', list_id: 'doing', list_title: 'Doing', total_comments: 0, assignee_names: [], card_url: '', total_task_children: 0 },
      { id: '3000', title: 'Known parent now empty', content: null, board_id: 'board-1', board_title: 'Dev - Active', list_id: 'doing', list_title: 'Doing', total_comments: 0, assignee_names: [], card_url: '', total_task_children: 0 },
    ]);
    cardMock.mockImplementation(async (id) => ({
      id, title: id === '2240' ? 'Listed parent' : 'Known parent now empty', content: null,
      board_id: 'board-1', board_title: 'Dev - Active', list_id: 'doing', list_title: 'Doing',
      total_comments: 0, assignee_names: [], card_url: '', total_task_children: id === '2240' ? 1 : 0,
      task_children: id === '2240' ? [{ task_id: '2242', title: 'Child', status: 'started' }] : null,
    }));

    const snapshot = await superthreadIntegration({ ownerProjectId: 'owner', spaces: 'Product', boardId: 'board-1', boardName: 'Dev - Active', incomingColumnIds: ['doing'], defaultIncomingColumnId: 'doing' }).sync(false, ['superthread:3000']);

    expect(cardMock.mock.calls.map(([id]) => id)).toEqual(['2240', '3000']);
    expect(snapshot.parent_hydrations).toEqual([
      { parent_id: '2240', parent_title: 'Listed parent', children: [{ id: '2242', title: 'Child', status: 'started' }] },
      { parent_id: '3000', parent_title: 'Known parent now empty', children: [] },
    ]);
  });

  it('rejects count mismatches and conflicting child claims without choosing by completion order', async () => {
    boardsMock.mockResolvedValue({ boards: [{ id: 'board-1', title: 'Dev - Active' }], successful_space_ids: ['space-1'], warnings: [], complete: true });
    listsMock.mockResolvedValue([{ id: 'doing', title: 'Doing', behavior: 'started' }]);
    cardsMock.mockResolvedValue(['10', '20', '30'].map((id) => ({ id, title: `Parent ${id}`, content: null, board_id: 'board-1', board_title: 'Dev - Active', list_id: 'doing', list_title: 'Doing', total_comments: 0, assignee_names: [], card_url: '', total_task_children: id === '30' ? 2 : 1 })));
    cardMock.mockImplementation(async (id) => ({
      id, title: `Parent ${id}`, content: null, board_id: 'board-1', board_title: 'Dev - Active', list_id: 'doing', list_title: 'Doing', total_comments: 0, assignee_names: [], card_url: '',
      task_children: [{ task_id: id === '30' ? 'other' : 'shared', title: 'Child', status: 'started' }],
    }));

    const snapshot = await superthreadIntegration({ ownerProjectId: 'owner', spaces: 'Product', boardId: 'board-1', boardName: 'Dev - Active', incomingColumnIds: ['doing'], defaultIncomingColumnId: 'doing' }).sync();

    expect(snapshot.parent_hydrations).toEqual([]);
    expect(snapshot.failed_scopes.map(({ scope }) => scope)).toEqual(expect.arrayContaining([
      'parent:10:hierarchy', 'parent:20:hierarchy', 'parent:30:hierarchy',
    ]));
  });

  it('enforces the fixed hierarchy concurrency bound', async () => {
    let inFlight = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const operation = vi.fn(async (id: number) => {
      inFlight += 1;
      maximum = Math.max(maximum, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
      return id;
    });
    const pending = mapWithConcurrency([1, 2, 3, 4, 5, 6], 4, operation);
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(4));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(6));
    releases.splice(0).forEach((release) => release());

    await expect(pending).resolves.toEqual([1, 2, 3, 4, 5, 6]);
    expect(maximum).toBe(4);
  });

  it('classifies a fully discovered empty snapshot as complete', async () => {
    boardsMock.mockResolvedValue({ boards: [], successful_space_ids: ['space-1'], warnings: [], complete: true });
    await expect(superthreadIntegration({ ownerProjectId: 'owner', spaces: 'Product', boardId: 'board-1', boardName: 'Dev - Active', incomingColumnIds: ['doing'], defaultIncomingColumnId: 'doing' }).sync()).resolves.toMatchObject({
      cards: [], successful_scope_ids: ['space-1'], successful_board_ids: [], complete: false,
    });
  });
});
