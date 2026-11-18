import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppAttention } from '../appAttention';
import { applicationEvents } from '../applicationEvents';
import { DEFAULT_APP_SETTINGS, type ResolvedAppSettings } from '../settingsModel';
import type { Project } from '../types';
import { useActivityNotifications } from './useActivityNotifications';

const mocks = vi.hoisted(() => ({
  ensurePermission: vi.fn(async () => true),
  fetchKanbanCard: vi.fn(),
  sendNotification: vi.fn(),
  registerActionListener: vi.fn(async () => ({ unregister: vi.fn() })),
}));

vi.mock('@tauri-apps/plugin-notification', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/plugin-notification')>(),
  sendNotification: mocks.sendNotification,
}));
vi.mock('../activityNotifications', async (importOriginal) => ({
  ...await importOriginal<typeof import('../activityNotifications')>(),
  ensureNotificationPermission: mocks.ensurePermission,
  registerNotificationActionListener: mocks.registerActionListener,
}));
vi.mock('../kanban/api', () => ({ fetchKanbanCard: mocks.fetchKanbanCard }));

const project = (id: string, name: string): Project => ({ id, name, path: `/code/${id}` } as Project);
const projectAttention = (lifecycleKey: string): AppAttention => ({
  kind: 'pi-complete',
  owner: { kind: 'project', projectId: 'p' },
  target: { view: 'terminal', terminalId: 'project-direct:p:shell' },
  lifecycleKey,
});
const cardAttention = (lifecycleKey: string): AppAttention => ({
  kind: 'pi-complete',
  owner: { kind: 'card', cardId: 'c' },
  target: { view: 'agent', agentThread: 'work', terminalId: 'kanban-card:c:work' },
  lifecycleKey,
});

function settings(enabled: boolean): ResolvedAppSettings {
  return { ...DEFAULT_APP_SETTINGS, activity_notifications: enabled };
}

let renderer: TestRenderer.ReactTestRenderer | undefined;
function Harness(props: { settings: ResolvedAppSettings; setSettings: React.Dispatch<React.SetStateAction<ResolvedAppSettings>>; projects: Project[]; showToast: (message: string) => void }) {
  useActivityNotifications(props);
  return null;
}
const setSettings = vi.fn();
const showToast = vi.fn();
async function mount(next: ResolvedAppSettings, projects: Project[]) {
  await act(async () => {
    renderer = TestRenderer.create(<Harness settings={next} setSettings={setSettings} projects={projects} showToast={showToast} />);
  });
}
async function update(next: ResolvedAppSettings, projects: Project[]) {
  await act(async () => {
    renderer!.update(<Harness settings={next} setSettings={setSettings} projects={projects} showToast={showToast} />);
  });
}
async function publish(attention: AppAttention) {
  await act(async () => { applicationEvents.publish('attention', attention); });
}
async function flush() {
  await act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); });
}

beforeEach(() => {
  mocks.ensurePermission.mockReset().mockResolvedValue(true);
  mocks.fetchKanbanCard.mockReset();
  mocks.sendNotification.mockReset();
  mocks.registerActionListener.mockReset().mockResolvedValue({ unregister: vi.fn() });
  setSettings.mockReset();
  showToast.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('document', { hasFocus: () => false });
  vi.stubGlobal('console', { ...console, warn: vi.fn(), error: vi.fn() });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useActivityNotifications', () => {
  it('reads the latest committed enabled flag without re-registering the attention subscription', async () => {
    const subscribe = vi.spyOn(applicationEvents, 'subscribe');
    await mount(settings(false), [project('p', 'Alpha')]);
    await publish(projectAttention('disabled'));
    await flush();
    expect(mocks.sendNotification).not.toHaveBeenCalled();

    await update(settings(true), [project('p', 'Alpha')]);
    await publish(projectAttention('enabled'));
    await flush();
    expect(mocks.sendNotification).toHaveBeenCalledOnce();
    expect(mocks.sendNotification.mock.calls[0][0].body).toContain('Alpha');
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it('keeps the post-await project read fresh', async () => {
    let resolveCard!: (value: { card: { project_id: string; external_id: string; title: string } }) => void;
    mocks.fetchKanbanCard.mockReturnValue(new Promise((resolve) => { resolveCard = resolve; }));
    await mount(settings(true), []);
    await publish(cardAttention('card-await'));
    expect(mocks.fetchKanbanCard).toHaveBeenCalledOnce();

    // The card response resolves after the project list has been committed.
    await update(settings(true), [project('p', 'Beta')]);
    await act(async () => { resolveCard({ card: { project_id: 'p', external_id: '12', title: 'Fresh' } }); });
    await flush();
    expect(mocks.sendNotification).toHaveBeenCalledOnce();
    expect(mocks.sendNotification.mock.calls[0][0].body).toContain('Beta');
    expect(mocks.sendNotification.mock.calls[0][0].body).toContain('#12');
  });

  it('deduplicates lifecycle keys and unsubscribes on unmount', async () => {
    await mount(settings(true), [project('p', 'Alpha')]);
    await publish(projectAttention('same'));
    await publish(projectAttention('same'));
    await flush();
    expect(mocks.sendNotification).toHaveBeenCalledOnce();

    await act(async () => renderer!.unmount());
    renderer = undefined;
    await publish(projectAttention('after-unmount'));
    await flush();
    expect(mocks.sendNotification).toHaveBeenCalledOnce();
  });
});
