import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { useComposerDraft } from './useComposerDraft';

function mount(key?: string) {
  let draft!: ReturnType<typeof useComposerDraft>;
  function Composer() { draft = useComposerDraft(key); return null; }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(<Composer />); });
  return { get draft() { return draft; }, close: () => act(() => renderer.unmount()) };
}

describe('session-only card composer drafts', () => {
  it('restores exact text and isolates cards and planning/work threads', () => {
    const text = '  unsent\n\ntext 😃  ';
    const first = mount('draft-card-a:planning');
    act(() => first.draft.setPrompt(text));
    first.close();
    for (const key of ['draft-card-b:planning', 'draft-card-a:work', undefined]) {
      const other = mount(key);
      expect(other.draft.prompt).toBe('');
      act(() => other.draft.setPrompt('another draft'));
      other.close();
    }
    const reopened = mount('draft-card-a:planning');
    expect(reopened.draft.prompt).toBe(text);
    reopened.close();
    const workspace = mount();
    expect(workspace.draft.prompt).toBe('');
    workspace.close();
  });

  it.each([true, false])('settles an in-flight send after closing (success: %s)', (success) => {
    const key = `pending-card:${success}`;
    const first = mount(key);
    const original = '  exact\n draft  ';
    act(() => first.draft.setPrompt(original));
    let finish!: (success: boolean) => void;
    act(() => { finish = first.draft.beginSubmission(); });
    expect(first.draft.prompt).toBe('');
    first.close();
    const reopened = mount(key);
    expect(reopened.draft.prompt).toBe(original);
    act(() => finish(success));
    expect(reopened.draft.prompt).toBe(success ? '' : original);
    reopened.close();
    const again = mount(key);
    expect(again.draft.prompt).toBe(success ? '' : original);
    again.close();
  });

  it.each([true, false])('does not overwrite a newer draft when an older send settles (%s)', (success) => {
    const card = mount(`newer-draft:${success}`);
    act(() => card.draft.setPrompt('sending'));
    let finish!: (success: boolean) => void;
    act(() => { finish = card.draft.beginSubmission(); });
    act(() => card.draft.setPrompt('new draft'));
    act(() => finish(success));
    expect(card.draft.prompt).toBe('new draft');
    card.close();
  });
});
