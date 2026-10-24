import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KanbanCard } from './types';
import { useCardDetailModel } from './useCardDetailModel';
import type { CardDetailTabAvailability } from './cardDetailModel';
import type { CardView } from './cardView';

function card(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return { id: 'c', provider: 'local', external_id: '1', title: 'Title', content: 'Body', board_id: 'p', board_title: 'P', list_id: '', list_title: '', card_url: '', assignee_names: [], status: 'needs_refinement', workflow_revision: 1, record_revision: 1, project_id: 'p', parent: null, child_count: 0, children: [], hierarchy_finalized: false, environment: null, created_at: 1, updated_at: 1, sort_order: 0, events: [], capabilities: [], ...overrides };
}

type Model = ReturnType<typeof useCardDetailModel>;
let model: Model;
function Harness({ value, update, confirmDiscard, onViewSelected, availability = { chat: true, workspace: true, server: false, console: false } }: { value: KanbanCard; update: (title: string, content: string) => Promise<KanbanCard>; confirmDiscard?: () => boolean | Promise<boolean>; onViewSelected?: (view: CardView) => void; availability?: CardDetailTabAvailability }) {
  model = useCardDetailModel({ card: value, availability, onUpdate: update, confirmDiscard, onViewSelected });
  return model.confirmationDialog;
}

describe('awaited card-detail discard', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
  afterEach(() => { act(() => renderer?.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
  const owner = (value = card()) => <Harness value={value} update={async () => card()} />;
  const submit = () => renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
  async function start() {
    act(() => { renderer = TestRenderer.create(owner()); });
    act(() => { model.command({ type: 'select', view: 'overview' }); });
    act(() => { model.begin(); model.setDraftTitle('Unsaved'); });
    let pending!: boolean | Promise<boolean>;
    act(() => { pending = model.command({ type: 'select', view: 'chat' }); });
    return { pending };
  }
  it('keeps the intended tab pending until accept, ignores duplicates, and preserves edits on cancel', async () => {
    let { pending } = await start();
    expect(model.activeView).toBe('overview');
    await expect(model.command({ type: 'select', view: 'terminal' })).resolves.toBe(false);
    submit();
    expect(model.activeView).toBe('overview');
    act(() => { renderer.root.findAllByType('button')[0].props.onClick(); });
    await expect(pending).resolves.toBe(false);
    expect(model.draftTitle).toBe('Unsaved');
    act(() => { pending = model.command({ type: 'select', view: 'chat' }); });
    act(() => { vi.advanceTimersByTime(2000); });
    await act(async () => { submit(); await pending; });
    expect(model.activeView).toBe('chat'); expect(model.editing).toBe(false);
  });
  it.each(['record', 'draft', 'unmount'])('rejects a stale pending navigation after %s change', async (change) => {
    const { pending } = await start();
    if (change === 'record') act(() => { renderer.update(owner(card({ id: 'other', record_revision: 2 }))); });
    else if (change === 'unmount') act(() => { renderer.unmount(); });
    else {
      act(() => { model.setDraftTitle('Newer draft'); vi.advanceTimersByTime(2000); });
      await act(async () => { submit(); await pending; });
    }
    await expect(pending).resolves.toBe(false);
    expect(model.activeView).toBe('overview');
  });
});

describe('useCardDetailModel editing', () => {
  it('notifies selection only after guards accept and never for disabled Diff', async () => {
    const selected = vi.fn();
    let accept!: (accepted: boolean) => void;
    let renderer!: TestRenderer.ReactTestRenderer;
    const render = (workspace = true) => <Harness value={card()} update={async () => card()} confirmDiscard={() => new Promise((resolve) => { accept = resolve; })} onViewSelected={selected} availability={{ chat: true, workspace, server: false, console: false }} />;
    await act(async () => { renderer = TestRenderer.create(render()); });
    act(() => { model.command({ type: 'select', view: 'overview' }); });
    act(() => { model.begin(); model.setDraftTitle('Unsaved'); });
    selected.mockClear();
    let pending!: boolean | Promise<boolean>;
    act(() => { pending = model.command({ type: 'number', number: 3 }); });
    expect(selected).not.toHaveBeenCalled();
    await act(async () => { accept(false); await pending; });
    expect(selected).not.toHaveBeenCalled();
    act(() => { pending = model.command({ type: 'select', view: 'diff' }); });
    await act(async () => { accept(true); await pending; });
    expect(selected.mock.calls).toEqual([['diff']]);
    act(() => { model.command({ type: 'number', number: 3 }); });
    expect(selected.mock.calls).toEqual([['diff'], ['diff']]);
    await act(async () => { renderer.update(render(false)); });
    selected.mockClear();
    act(() => { expect(model.command({ type: 'select', view: 'diff' })).toBe(false); expect(model.command({ type: 'number', number: 3 })).toBe(false); });
    expect(selected).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

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

  it('only prompts to discard on valid numbered targets, keeping disabled positions', async () => {
    const confirmDiscard = vi.fn(() => false);
    const availability = { chat: false, workspace: true, server: true, console: true };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<Harness value={card()} availability={availability} update={async () => card()} confirmDiscard={confirmDiscard} />); });
    act(() => { model.begin(); model.setDraftTitle('Changed'); });
    act(() => {
      expect(model.command({ type: 'number', number: 2 })).toBe(false);
      expect(model.command({ type: 'number', number: 7 })).toBe(false);
    });
    expect(confirmDiscard).not.toHaveBeenCalled();
    act(() => expect(model.command({ type: 'number', number: 6 })).toBe(false));
    expect(confirmDiscard).toHaveBeenCalledOnce();
    await act(async () => { renderer.update(<Harness value={card()} availability={availability} update={async () => card()} confirmDiscard={() => true} />); });
    act(() => expect(model.command({ type: 'number', number: 6 })).toBe(true));
    expect(model.activeView).toBe('console');
    expect(model.editing).toBe(false);
    act(() => renderer.unmount());
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
