import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TestRenderer, { act } from 'react-test-renderer';
import { DEFAULT_APP_SETTINGS } from '../settingsModel';
import type { Project } from '../types';
import { SettingsDialog } from './SettingsDialog';

const projects: Project[] = [
  { id: 'one', name: 'One', path: '/one', config_revision: 3 },
  { id: 'two', name: 'Two', path: '/two' },
];

function render(initialPage: 'global:interface' | `project:${string}` = 'global:interface') {
  const callbacks = {
    onPageChange: vi.fn(), onSaveSettings: vi.fn().mockResolvedValue(undefined),
    onSaveProject: vi.fn().mockResolvedValue(undefined), onDeleteProject: vi.fn().mockResolvedValue(undefined),
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

  it('passes the loaded project revision when explicitly saving', async () => {
    const { renderer, onSaveProject } = render('project:one');
    const name = renderer.root.findAllByType('input').find((node) => node.props.value === 'One')!;
    act(() => name.props.onChange({ target: { value: 'Renamed' } }));
    await act(async () => { await button(renderer.root, 'Save').props.onClick(); });
    expect(onSaveProject).toHaveBeenCalledWith('one', expect.objectContaining({ name: 'Renamed' }), 3);
  });
});
