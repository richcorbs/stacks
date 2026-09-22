import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TestRenderer, { act } from 'react-test-renderer';
import { DEFAULT_APP_SETTINGS } from '../settingsModel';
import type { Project } from '../types';
import { SettingsDialog } from './SettingsDialog';
import { SuperthreadMappingFields } from './SuperthreadMappingFields';

vi.mock('../superthread/api', () => ({
  fetchSuperthreadBoards: vi.fn(() => new Promise(() => undefined)),
  fetchSuperthreadBoardsForSpace: vi.fn(() => new Promise(() => undefined)),
  fetchSuperthreadLists: vi.fn(() => new Promise(() => undefined)),
  testSuperthreadConnection: vi.fn(), testSuperthreadMapping: vi.fn(),
}));

const projects: Project[] = [
  { id: 'one', name: 'One', path: '/one', config_revision: 3 },
  { id: 'two', name: 'Two', path: '/two' },
  { id: 'remote', name: 'Remote', path: '/remote', config_revision: 5, kanban_source: 'superthread', superthread_spaces: 'Product',
    superthread_workspace_id: 'workspace', superthread_workspace_name: 'Workspace', superthread_space_id: 'space', superthread_space_name: 'Product',
    superthread_board_id: 'board', superthread_board_name: 'Board', superthread_incoming_columns: [{ id: 'one', name: 'Inbox' }, { id: 'two', name: 'Ready' }],
    superthread_default_incoming_column_id: 'one', superthread_in_progress_column_id: 'progress', superthread_in_progress_column_name: 'Doing',
    superthread_done_column_id: 'done', superthread_done_column_name: 'Done' },
];

function render(initialPage: 'global:interface' | `project:${string}` = 'global:interface', savedProject: Project = projects[0]) {
  const callbacks = {
    onPageChange: vi.fn(), onSaveSettings: vi.fn().mockResolvedValue(undefined),
    onSaveProject: vi.fn().mockResolvedValue(savedProject), onDeleteProject: vi.fn().mockResolvedValue(undefined),
    onNotificationsUnavailable: vi.fn(), onClose: vi.fn(),
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(<SettingsDialog settings={DEFAULT_APP_SETTINGS} projects={projects} initialPage={initialPage} {...callbacks} />); });
  return { renderer, ...callbacks };
}

function button(root: TestRenderer.ReactTestInstance, text: string) {
  return root.findAllByType('button').find((node) => node.children.some((child) => child === text))!;
}

describe('SettingsDialog', () => {
  beforeEach(() => vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; }));
  afterEach(() => vi.unstubAllGlobals());

  it('exposes global navigation and an accessible right-chevron Projects disclosure', () => {
    const { renderer } = render();
    const disclosure = button(renderer.root, 'Projects');
    expect(disclosure.props['aria-expanded']).toBe(false);
    expect(disclosure.findByProps({ className: 'settingsDisclosureChevron' })).toBeTruthy();
    act(() => disclosure.props.onClick());
    expect(button(renderer.root, 'Projects').props['aria-expanded']).toBe(true);
    expect(button(renderer.root, 'One')).toBeTruthy();
  });

  it('opens a requested project with its heading and expanded project navigation', () => {
    const { renderer } = render('project:one');
    expect(renderer.root.findByProps({ id: 'settings-page-heading' }).children).toEqual(['One']);
    expect(button(renderer.root, 'Projects').props['aria-expanded']).toBe(true);
    expect(button(renderer.root, 'One').props['aria-current']).toBe('page');
  });

  it('requires Save, Discard, or Cancel before dirty navigation', () => {
    const { renderer, onPageChange } = render();
    const input = renderer.root.findByProps({ type: 'number' });
    act(() => input.props.onChange({ target: { value: '17' } }));
    act(() => button(renderer.root, 'Terminal').props.onClick());
    expect(renderer.root.findByProps({ role: 'alertdialog' })).toBeTruthy();
    expect(onPageChange).not.toHaveBeenCalled();
    act(() => button(renderer.root, 'Cancel').props.onClick());
    expect(renderer.root.findAllByProps({ role: 'alertdialog' })).toHaveLength(0);
    expect(renderer.root.findByProps({ id: 'settings-page-heading' }).children).toEqual(['Interface']);
  });

  it('opens and closes an untouched local project without prompting', () => {
    const { renderer, onClose } = render('project:one');
    expect(button(renderer.root, 'Save').props.disabled).toBe(true);
    act(() => renderer.root.findByProps({ 'aria-label': 'Close Settings' }).props.onClick());
    expect(renderer.root.findAllByProps({ role: 'alertdialog' })).toHaveLength(0);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps an open Superthread page clean through provider metadata hydration', () => {
    const { renderer, onClose } = render('project:remote');
    const mapping = renderer.root.findByType(SuperthreadMappingFields);
    act(() => mapping.props.setDialog((draft: import('../types').DialogState) => ({
      ...draft, superthreadWorkspaceName: 'Canonical workspace', superthreadBoardName: 'Canonical board',
      superthreadIncomingColumns: [{ id: 'two', name: 'Canonical ready' }, { id: 'one', name: 'Canonical inbox' }],
      superthreadInProgressColumnName: 'Canonical doing', superthreadDoneColumnName: 'Canonical done', deliveryWorkflowLocked: true,
    })));
    expect(button(renderer.root, 'Save').props.disabled).toBe(true);
    act(() => renderer.root.findByProps({ 'aria-label': 'Close Settings' }).props.onClick());
    expect(renderer.root.findAllByProps({ role: 'alertdialog' })).toHaveLength(0);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('passes the loaded project revision and resets from the canonical saved project', async () => {
    const canonical = { ...projects[0], name: 'Canonical name', config_revision: 9 };
    const { renderer, onSaveProject } = render('project:one', canonical);
    const name = renderer.root.findAllByType('input').find((node) => node.props.value === 'One')!;
    act(() => name.props.onChange({ target: { value: 'Renamed' } }));
    await act(async () => { await button(renderer.root, 'Save').props.onClick(); });
    expect(onSaveProject).toHaveBeenCalledWith('one', expect.objectContaining({ name: 'Renamed' }), 3);
    expect(renderer.root.findAllByType('input').some((node) => node.props.value === 'Canonical name')).toBe(true);
    expect(button(renderer.root, 'Save').props.disabled).toBe(true);
  });

  it('preserves a failed draft and shows an actionable save error', async () => {
    const { renderer, onSaveProject } = render('project:one');
    onSaveProject.mockRejectedValueOnce(new Error('Superthread board is inaccessible'));
    const name = renderer.root.findAllByType('input').find((node) => node.props.value === 'One')!;
    act(() => name.props.onChange({ target: { value: 'Unsaved name' } }));
    await act(async () => { await button(renderer.root, 'Save').props.onClick(); });
    expect(renderer.root.findByProps({ role: 'alert' }).children).toEqual(['Superthread board is inaccessible']);
    expect(renderer.root.findAllByType('input').some((node) => node.props.value === 'Unsaved name')).toBe(true);
    expect(button(renderer.root, 'Save').props.disabled).toBe(false);
  });
});
