import { createRef, useRef, useState, type ComponentProps } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import { NewCardDialog } from './NewCardDialog';

type DialogModel = ComponentProps<typeof NewCardDialog>['model'];

const projects: Project[] = [
  { id: 'alpha', name: 'Alpha', path: '/alpha' },
  { id: 'beta', name: 'Beta', path: '/beta' },
];

function dialogModel(overrides: Partial<DialogModel> = {}): DialogModel {
  return {
    open: true,
    setOpen: vi.fn(),
    title: '',
    setTitle: vi.fn(),
    description: '',
    setDescription: vi.fn(),
    projectId: '',
    setProjectId: vi.fn(),
    parentId: '',
    setParentId: vi.fn(),
    error: null,
    creating: false,
    titleRef: createRef<HTMLInputElement>(),
    show: vi.fn(),
    submit: vi.fn().mockResolvedValue(undefined),
    invalidateClipboardOperation: vi.fn(),
    handleClipboard: vi.fn(),
    ...overrides,
  };
}

function renderModel(model: DialogModel) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<NewCardDialog model={model} creationProjects={projects} cards={[]} />);
  });
  return renderer;
}

function StatefulDialog() {
  const [projectId, setProjectId] = useState('alpha');
  const [parentId, setParentId] = useState('parent-card');
  const titleRef = useRef<HTMLInputElement | null>(null);
  const model = dialogModel({ projectId, setProjectId, parentId, setParentId, titleRef });
  return <NewCardDialog model={model} creationProjects={projects} cards={[]} />;
}

describe('NewCardDialog', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('makes Project the sole autofocus target when no project is selected', () => {
    const renderer = renderModel(dialogModel());
    const project = renderer.root.findAllByType('select')[0];
    const title = renderer.root.findByType('input');

    expect(project.props.value).toBe('');
    expect(project.findByProps({ value: '', disabled: true }).children).toEqual(['Select a project…']);
    expect(project.props.autoFocus).toBe(true);
    expect(title.props.autoFocus).toBe(false);
    expect(renderer.root.findAll((node) => node.props.autoFocus === true)).toEqual([project]);
  });

  it('makes Title the sole autofocus target when a project is preselected', () => {
    const renderer = renderModel(dialogModel({ projectId: 'alpha' }));
    const project = renderer.root.findAllByType('select')[0];
    const title = renderer.root.findByType('input');

    expect(project.props.value).toBe('alpha');
    expect(project.props.autoFocus).toBe(false);
    expect(title.props.autoFocus).toBe(true);
    expect(renderer.root.findAll((node) => node.props.autoFocus === true)).toEqual([title]);
  });

  it('retains a selected project, clears Parent, and moves focus to Title after rendering', () => {
    const focusTitle = vi.fn();
    let focusFrame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      focusFrame = callback;
      return 1;
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<StatefulDialog />, {
        createNodeMock: (element) => element.type === 'input' ? { focus: focusTitle } : {},
      });
    });

    const project = renderer.root.findAllByType('select')[0];
    act(() => project.props.onChange({ target: { value: 'beta' } }));

    const selects = renderer.root.findAllByType('select');
    expect(selects[0].props.value).toBe('beta');
    expect(selects[1].props.value).toBe('');
    expect(focusTitle).not.toHaveBeenCalled();

    act(() => focusFrame?.(0));
    expect(focusTitle).toHaveBeenCalledOnce();
  });
});
