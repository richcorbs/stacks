import { beforeEach, describe, expect, it, vi } from 'vitest';
import { superthreadIntegration } from './cardProvider';
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

    await expect(superthreadIntegration({ ownerProjectId: 'owner', spaces: 'Product, Engineering', workspaceSlug: 'example' }).create('New card', 'Detailed brief')).resolves.toEqual({
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
      spaces: 'Product, Engineering',
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

    const snapshot = await superthreadIntegration({ ownerProjectId: 'owner', spaces: 'Product' }).sync();
    expect(snapshot.cards).toHaveLength(3);
    expect(snapshot.cards[0]).toMatchObject({ id: '1', content: null, in_scope: true, parent_relationship_hydrated: false });
    expect(snapshot.cards[1]).toMatchObject({ id: '2', content: '', in_scope: false });
    expect(snapshot.cards[2]).toMatchObject({ id: '3', in_scope: null });
    expect(snapshot.successful_board_ids).toEqual(['good']);
    expect(snapshot.failed_scopes).toEqual([{ scope: 'board:bad:lists', message: 'list access denied' }]);
    expect(snapshot.complete).toBe(false);
  });

  it('maps detailed parent coverage authoritatively', async () => {
    cardMock.mockResolvedValue({
      id: '2242', title: 'Child', content: 'Details', board_id: 'board-1', board_title: 'Dev - Active',
      list_id: 'doing', list_title: 'Doing', total_comments: 0, assignee_names: [], card_url: '',
      task_parent: { id: '2240', title: 'Parent card' },
    });
    const provider = superthreadIntegration({ ownerProjectId: 'owner', spaces: 'Product' });
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

  it('classifies a fully discovered empty snapshot as complete', async () => {
    boardsMock.mockResolvedValue({ boards: [], successful_space_ids: ['space-1'], warnings: [], complete: true });
    await expect(superthreadIntegration({ ownerProjectId: 'owner', spaces: 'Product' }).sync()).resolves.toMatchObject({
      cards: [], successful_scope_ids: ['space-1'], successful_board_ids: [], failed_scopes: [], complete: true,
    });
  });
});
