import { describe, expect, it, vi } from 'vitest';
import { buildCardPaletteItems } from './commandPaletteCards';
import { filterPaletteItems, scorePaletteItem, type PaletteItem } from './components/CommandPalette';
import { filterKanbanCards } from './kanban/projectScope';
import type { KanbanCard, KanbanCardSummary } from './kanban/types';
import type { Project } from './types';

const projects: Project[] = [
  { id: 'p1', name: 'Stacks', path: '/stacks', workspaces: [] },
  { id: 'p2', name: 'Elsewhere', path: '/elsewhere', workspaces: [] },
];

function card(id: string, number: string, title: string, projectId: string | null, status: KanbanCard['status'] = 'needs_refinement'): KanbanCard {
  return {
    id, provider: 'local', external_id: number, title, content: 'Secret searchable metadata',
    board_id: 'board', board_title: 'Hidden board', list_id: 'list', list_title: 'Hidden lane', card_url: '',
    assignee_names: [], status, workflow_revision: 1, record_revision: 1, project_id: projectId,
    parent: null, child_count: 0, children: [], hierarchy_finalized: false, environment: null,
    created_at: 1, updated_at: 1, sort_order: 0, events: [], capabilities: [],
  };
}

function items(cards: KanbanCardSummary[], openCard = vi.fn()) {
  return { openCard, results: buildCardPaletteItems({ cards, projects, openCard }) };
}

describe('card command-palette items', () => {
  it('displays card number/title and the owning project without searching the subtitle or metadata', () => {
    const { results } = items([card('c89', '89', 'Cmd-P card lookup', 'p1')]);
    expect(results[0]).toMatchObject({ title: '#89 Cmd-P card lookup', subtitle: 'Stacks' });
    expect(scorePaletteItem(results[0], 'stacks')).toBe(0);
    expect(scorePaletteItem(results[0], 'secret')).toBe(0);
    expect(scorePaletteItem(results[0], 'lane')).toBe(0);
  });

  it('matches plain and hash-prefixed exact numbers ahead of title and command matches', () => {
    const { results } = items([
      card('first-89', '89', 'Unrelated', 'p1'),
      card('second-89', '89', 'Another card', 'p2'),
      card('title', '12', 'Investigate 89 failures', 'p1'),
    ]);
    const command: PaletteItem = { id: 'command', title: 'Open 89 tools', action: () => {} };

    for (const query of ['89', '#89']) {
      const matches = filterPaletteItems([command], results, query);
      expect(matches.slice(0, 2).map(({ id }) => id)).toEqual(['card:first-89', 'card:second-89']);
    }
  });

  it('uses case-insensitive substring and ordered fuzzy title matching', () => {
    const { results } = items([card('c1', '1', 'Palette Search Support', 'p1')]);
    expect(scorePaletteItem(results[0], 'SEARCH')).toBeGreaterThan(0);
    expect(scorePaletteItem(results[0], 'pltspt')).toBeGreaterThan(0);
    expect(scorePaletteItem(results[0], 'zpalette')).toBe(0);
  });

  it('uses the board project scope while retaining Done cards and duplicate numbers in All projects', () => {
    const cards = [
      card('p1-done', '7', 'Finished in Stacks', 'p1', 'done'),
      card('p2-open', '7', 'Open elsewhere', 'p2'),
    ];
    expect(items(filterKanbanCards(cards, 'p1')).results.map(({ id }) => id)).toEqual(['card:p1-done']);
    expect(items(filterKanbanCards(cards, null)).results.map(({ id }) => id)).toEqual(['card:p1-done', 'card:p2-open']);
  });

  it('uses the unknown-project treatment and opens by stable card id', () => {
    const { openCard, results } = items([card('orphan-id', '3', 'Orphan', 'missing')]);
    expect(results[0].subtitle).toBe('Unknown project');
    results[0].action();
    expect(openCard).toHaveBeenCalledWith('orphan-id');
  });
});
