import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { invoke } from '@tauri-apps/api/core';
import { describe, expect, it, vi } from 'vitest';
import { ProjectNotesView } from './ProjectNotesView';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => new Promise(() => {})),
}));

describe('ProjectNotesView', () => {
  it('renders a raw multiline project scratch pad and stable inline status area', () => {
    const markup = renderToStaticMarkup(<ProjectNotesView projectId="one" active />);
    expect(markup).toContain('class="projectNotesView cardView active"');
    expect(markup).toContain('<textarea');
    expect(markup).toContain('aria-label="Project notes scratch pad"');
    expect(markup).toContain('class="projectNotesStatus loading"');
    expect(markup).toContain('Loading…');
  });

  it('waits for readiness, then focuses once per request without replacing the draft', async () => {
    let finishLoad!: (value: { notes: string; revision: number }) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => { finishLoad = resolve; }) as never);
    const focus = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <ProjectNotesView projectId="one" active focusRequest={1} />,
        { createNodeMock: (element) => element.type === 'textarea' ? { focus } : null },
      );
    });

    expect(focus).not.toHaveBeenCalled();
    await act(async () => {
      finishLoad({ notes: 'Loaded note', revision: 1 });
      await Promise.resolve();
    });
    expect(focus).toHaveBeenCalledTimes(1);

    act(() => renderer.root.findByProps({ 'aria-label': 'Project notes scratch pad' }).props.onChange({ target: { value: 'Unsaved draft' } }));
    act(() => renderer.update(<ProjectNotesView projectId="one" active focusRequest={2} />));

    expect(renderer.root.findByProps({ 'aria-label': 'Project notes scratch pad' }).props.value).toBe('Unsaved draft');
    expect(focus).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });
});
