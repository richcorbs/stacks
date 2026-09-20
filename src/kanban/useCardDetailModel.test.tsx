import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { KanbanCard } from './types';
import { useCardDetailModel } from './useCardDetailModel';

function card(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return { id: 'c', provider: 'local', external_id: '1', title: 'Title', content: 'Body', board_id: 'p', board_title: 'P', list_id: '', list_title: '', card_url: '', assignee_names: [], status: 'needs_refinement', workflow_revision: 1, record_revision: 1, project_id: 'p', parent: null, child_count: 0, children: [], hierarchy_finalized: false, environment: null, created_at: 1, updated_at: 1, sort_order: 0, events: [], capabilities: [], ...overrides };
}

type Model = ReturnType<typeof useCardDetailModel>;
let model: Model;
function Harness({ value, update, confirmDiscard }: { value: KanbanCard; update: (title: string, content: string) => Promise<KanbanCard>; confirmDiscard: () => boolean }) {
  model = useCardDetailModel({ card: value, availability: { chat: true, workspace: true, server: false, console: false }, onUpdate: update, confirmDiscard });
  return null;
}

describe('useCardDetailModel editing', () => {
  it('guards dirty navigation and cancel restores the canonical draft', async () => {
    const confirmDiscard = vi.fn(() => false);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<Harness value={card()} update={async () => card()} confirmDiscard={confirmDiscard} />); });
    act(() => { model.command({ type: 'select', view: 'overview' }); });
    act(() => { model.begin(); model.setDraftTitle('Changed'); });
    expect(model.dirty).toBe(true);
    act(() => { expect(model.command({ type: 'select', view: 'chat' })).toBe(false); });
    expect(model.activeView).toBe('overview');
    expect(confirmDiscard).toHaveBeenCalledOnce();
    act(() => model.cancel());
    expect(model.draftTitle).toBe('Title');
    renderer.unmount();
  });

  it('isolates save failures and successful completion', async () => {
    const update = vi.fn().mockRejectedValueOnce(new Error('save failed')).mockResolvedValueOnce(card({ title: 'Changed' }));
    await act(async () => { TestRenderer.create(<Harness value={card()} update={update} confirmDiscard={() => true} />); });
    act(() => { model.command({ type: 'select', view: 'overview' }); });
    act(() => { model.begin(); model.setDraftTitle('Changed'); });
    await act(async () => { await model.save(); });
    expect(model.editError).toBe('save failed'); expect(model.editing).toBe(true);
    await act(async () => { await model.save(); });
    expect(model.editError).toBeNull(); expect(model.editing).toBe(false); expect(model.draftTitle).toBe('Changed');
  });
});
