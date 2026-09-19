import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TestRenderer, { act } from 'react-test-renderer';
import type { ComponentProps } from 'react';
import type { Project } from '../types';
import { ProjectSwitcherDialog } from './ProjectSwitcherDialog';

const projects: Project[] = [
  { id: 'alpha', name: 'Alpha', path: '/alpha' },
  { id: 'beta', name: 'Beta', path: '/beta', kanban_source: 'superthread' },
];

function buttonText(button: TestRenderer.ReactTestInstance) {
  return button.findByType('strong').children.join('');
}

function keyEvent(key: string) {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    target: { closest: () => null },
  };
}

function renderDialog(props: Partial<ComponentProps<typeof ProjectSwitcherDialog>> = {}) {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const onAddProject = vi.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<ProjectSwitcherDialog
      open
      projects={projects}
      currentProjectId={null}
      onSelect={onSelect}
      onCancel={onCancel}
      onAddProject={onAddProject}
      {...props}
    />);
  });
  return { renderer, onSelect, onCancel, onAddProject };
}

describe('ProjectSwitcherDialog', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('shows All projects first only when enabled and initially highlights it for the null selection', () => {
    const { renderer } = renderDialog({ includeAllProjects: true });
    const options = renderer.root.findAllByProps({ role: 'option' });

    expect(options.map(buttonText)).toEqual(['All projects (current)', 'Alpha', 'Beta']);
    expect(options.map((option) => option.props['aria-selected'])).toEqual([true, false, false]);

    act(() => renderer.update(<ProjectSwitcherDialog
      open
      projects={projects}
      currentProjectId={null}
      onSelect={vi.fn()}
      onCancel={vi.fn()}
      onAddProject={vi.fn()}
    />));
    expect(renderer.root.findAllByProps({ role: 'option' }).map(buttonText)).toEqual(['Alpha', 'Beta']);
  });

  it('initially highlights the active concrete project', () => {
    const { renderer } = renderDialog({ includeAllProjects: true, currentProjectId: 'beta' });
    const options = renderer.root.findAllByProps({ role: 'option' });

    expect(options.map((option) => option.props['aria-selected'])).toEqual([false, false, true]);
    expect(buttonText(options[2])).toBe('Beta (current)');
  });

  it('selects All projects as null with Enter and click', () => {
    const { renderer, onSelect } = renderDialog({ includeAllProjects: true });
    const dialog = renderer.root.findByProps({ role: 'dialog' });

    act(() => dialog.props.onKeyDown(keyEvent('Enter')));
    act(() => renderer.root.findAllByProps({ role: 'option' })[0].props.onClick());

    expect(onSelect).toHaveBeenNthCalledWith(1, null);
    expect(onSelect).toHaveBeenNthCalledWith(2, null);
  });

  it('includes All projects in hover, j/k navigation, and keyboard wraparound', () => {
    const { renderer, onSelect } = renderDialog({ includeAllProjects: true });
    const dialog = renderer.root.findByProps({ role: 'dialog' });
    let options = renderer.root.findAllByProps({ role: 'option' });

    act(() => options[1].props.onMouseEnter());
    options = renderer.root.findAllByProps({ role: 'option' });
    expect(options.map((option) => option.props['aria-selected'])).toEqual([false, true, false]);

    act(() => dialog.props.onKeyDown(keyEvent('k')));
    expect(renderer.root.findAllByProps({ role: 'option' })[0].props['aria-selected']).toBe(true);

    act(() => dialog.props.onKeyDown(keyEvent('ArrowUp')));
    act(() => dialog.props.onKeyDown(keyEvent('Enter')));
    expect(onSelect).toHaveBeenLastCalledWith(projects[1]);

    act(() => dialog.props.onKeyDown(keyEvent('j')));
    act(() => dialog.props.onKeyDown(keyEvent('Enter')));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('preserves the empty state, Add Project action, and Escape cancellation', () => {
    const { renderer, onCancel, onAddProject } = renderDialog({ projects: [], includeAllProjects: true });

    expect(renderer.root.findAllByProps({ role: 'option' }).map(buttonText)).toEqual(['All projects (current)']);
    expect(renderer.root.findByProps({ className: 'projectSwitcherEmpty' }).children).toEqual(['No projects configured']);

    act(() => renderer.root.findByProps({ className: 'projectSwitcherAdd' }).props.onClick());
    act(() => renderer.root.findByProps({ role: 'dialog' }).props.onKeyDown(keyEvent('Escape')));
    expect(onAddProject).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
