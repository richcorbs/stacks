import { beforeEach, describe, expect, it, vi } from 'vitest';
import { superthreadCardProvider } from './cardProvider';
import { createSuperthreadCard } from './api';

vi.mock('./api', () => ({
  createSuperthreadCard: vi.fn(),
  fetchSuperthreadBoards: vi.fn(),
  fetchSuperthreadCard: vi.fn(),
  fetchSuperthreadCards: vi.fn(),
  fetchSuperthreadLists: vi.fn(),
}));

const createMock = vi.mocked(createSuperthreadCard);

describe('Superthread card provider creation', () => {
  beforeEach(() => createMock.mockReset());

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

    await expect(superthreadCardProvider('Product, Engineering', 'example').create?.('New card', 'Detailed brief')).resolves.toEqual({
      id: '48',
      title: 'New card',
      content: 'Detailed brief',
      board_id: 'board-1',
      board_title: 'Dev - Active',
      list_id: 'list-1',
      list_title: 'Backlog',
      card_url: 'https://app.superthread.com/example/card-48',
      assignee_names: [],
      in_scope: true,
    });
    expect(createMock).toHaveBeenCalledWith({
      spaces: 'Product, Engineering',
      workspaceSlug: 'example',
      title: 'New card',
      content: 'Detailed brief',
    });
  });
});
