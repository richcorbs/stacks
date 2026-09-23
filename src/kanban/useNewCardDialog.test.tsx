import { useEffect } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../types';
import type { KanbanCardSummary } from './types';
import { useNewCardDialog } from './useNewCardDialog';

const project: Project = { id: 'project', name: 'Project', path: '/project' };
const card = { id: 'local:1', project_id: project.id } as KanbanCardSummary;

type Model = ReturnType<typeof useNewCardDialog>;
function mount(create = vi.fn(async () => card), refine = vi.fn(async () => true)) {
  let model!: Model;
  function Harness() {
    const current = useNewCardDialog({ creationProjects: [project], selectedProject: project, filterProjectId: null, create, refine });
    useEffect(() => { model = current; });
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(<Harness />); });
  return { get model() { return model; }, create, refine, renderer };
}

async function populate(instance: ReturnType<typeof mount>, addMore: boolean) {
  await act(async () => {
    instance.model.show();
    instance.model.setTitle('Title');
    instance.model.setDescription('Description');
    instance.model.setParentId('parent');
    instance.model.setAddMore(addMore);
  });
}

describe('useNewCardDialog', () => {

  it('closes after queued creation and does not start refinement', async () => {
    const instance = mount();
    await populate(instance, false);
    await act(async () => { await instance.model.submit('queued'); });

    expect(instance.create).toHaveBeenCalledWith(project, 'Title', 'Description', 'parent');
    expect(instance.refine).not.toHaveBeenCalled();
    expect(instance.model.open).toBe(false);
  });

  it.each(['queued', 'refining'] as const)('keeps only project and Add more after %s creation and refocuses Title', async (kind) => {
    const focus = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    const instance = mount();
    await populate(instance, true);
    instance.model.titleRef.current = { focus } as unknown as HTMLInputElement;
    await act(async () => { await instance.model.submit(kind); });

    expect(instance.model.open).toBe(true);
    expect(instance.model.projectId).toBe(project.id);
    expect(instance.model.addMore).toBe(true);
    expect(instance.model.title).toBe('');
    expect(instance.model.description).toBe('');
    expect(instance.model.parentId).toBe('');
    expect(focus).toHaveBeenCalledOnce();
    expect(instance.refine).toHaveBeenCalledTimes(kind === 'refining' ? 1 : 0);
  });
});
