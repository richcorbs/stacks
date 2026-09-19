import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import type { AppSettings, DialogState, Project, Store } from '../types';
import { DEFAULT_APP_SETTINGS, resolveAppSettings, toPersistedAppSettings, type ResolvedAppSettings } from '../settingsModel';
import { useDebouncedStoreSave } from './useDebouncedSave';
import { useWindowStatePersistence } from './useWindowStatePersistence';
import { useAppCloseRequest, useAppToastEvents } from './useAppWindowEvents';
import { useAppWindowFocusClass } from './useAppWindowFocusClass';
import { useToast } from './useToast';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useAppStyle } from './useAppStyle';
import { useNativeFileDropRouter } from './useNativeFileDropRouter';
import { clampTerminalFontSize, clampUiFontSize } from '../settings';
import { buildCommandPaletteItems } from '../commandPaletteItems';
import { selectedKanbanProject } from '../kanban/providerSelection';
import { canOpenProjectSwitcher, OPEN_PROJECT_SWITCHER_EVENT } from '../projectSwitcher';
import { OPEN_DIRECT_WORK_EVENT } from '../directWork';
import { CARD_TERMINAL_CONTEXT_EVENT, dispatchCardTerminalCommand, type CardTerminalContext } from '../cardTerminalCommands';
import { fetchKanbanCards, fetchKanbanEnvironmentHealth, startKanbanEnvironment } from '../kanban/api';
import { buildLocalWorkspaceInput, buildSuperthreadWorkspaceInput } from '../superthread/startWork';
import type { KanbanCard } from '../kanban/types';
import { disposeTerminalSessions } from '../terminalSessionManager';
import { runShortcutAction } from '../shortcutActions';
import type { ShortcutAction, ShortcutHandlers } from '../shortcutTypes';
import { buildCardPaletteItems, type CardPaletteRegistration } from '../commandPaletteCards';
import { launchWorkAgent } from '../kanban/workAgentLauncher';
import { flushAllProjectNotes } from '../projectNotes';
import { useActivityNotifications } from './useActivityNotifications';
import { GLOBAL_TERMINAL_COMMAND_EVENT, type GlobalTerminalCommand } from '../components/GlobalTerminal';

export function useAppRootModel() {
  const [loaded, setLoaded] = useState(false);
  const [store, setStore] = useState<Store>({ projects: [] });
  const [appSettings, setAppSettings] = useState<ResolvedAppSettings>(DEFAULT_APP_SETTINGS);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [oneTimeCommandOpen, setOneTimeCommandOpen] = useState(false);
  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<string | null>(null);
  const [confirmQuitOpen, setConfirmQuitOpen] = useState(false);
  const [cardTerminal, setCardTerminal] = useState<CardTerminalContext | null>(null);
  const [globalTerminalVisible, setGlobalTerminalVisible] = useState(false);
  const [globalTerminalNewTabNonce, setGlobalTerminalNewTabNonce] = useState(0);
  const [paletteCards, setPaletteCards] = useState<CardPaletteRegistration | null>(null);
  const [, setMetaKeyDown] = useState(false);
  const startingCardIds = useRef(new Set<string>());
  const { toast, showToast } = useToast();
  const flushAndQuit = useCallback(async () => {
    try {
      await flushAllProjectNotes();
      await invoke('save_current_window_state');
      await invoke('quit_app');
    } catch (error) {
      console.error('Quit cancelled because pending changes could not be saved', error);
    }
  }, []);
  const requestQuit = useCallback(() => {
    if (appSettings.confirm_close) setConfirmQuitOpen(true);
    else void flushAndQuit();
  }, [appSettings.confirm_close, flushAndQuit]);

  useEffect(() => {
    Promise.all([invoke<Store>('load_store'), invoke<AppSettings>('load_settings').catch(() => null)])
      .then(([nextStore, settings]) => { setStore(nextStore); setAppSettings(resolveAppSettings(settings)); })
      .catch(console.error).finally(() => setLoaded(true));
  }, []);
  useDebouncedStoreSave(loaded, store);
  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => invoke('save_app_settings', { next: toPersistedAppSettings(appSettings) }).catch(console.error), 250);
    return () => window.clearTimeout(timer);
  }, [appSettings, loaded]);
  useEffect(() => {
    const update = (event: Event) => setCardTerminal((event as CustomEvent<CardTerminalContext | null>).detail);
    window.addEventListener(CARD_TERMINAL_CONTEXT_EVENT, update);
    return () => window.removeEventListener(CARD_TERMINAL_CONTEXT_EVENT, update);
  }, []);
  useWindowStatePersistence();
  useAppWindowFocusClass();
  useAppToastEvents(showToast);
  useAppCloseRequest(requestQuit);
  useNativeFileDropRouter();
  useActivityNotifications({ settings: appSettings, setSettings: setAppSettings, projects: store.projects, showToast });

  async function openProjectDialog() {
    const selected = await open({ directory: true, multiple: false, title: 'Choose Project Directory' }).catch(() => null);
    if (typeof selected !== 'string') return;
    setDialog({ kind: 'project', name: selected.split('/').filter(Boolean).at(-1) ?? 'Project', path: selected, kanbanSource: 'local', deliveryWorkflow: 'local_merge', targetBranch: 'main', supportsFeatureEnvironments: false, githubMergeStrategy: 'merge', requirePassingCi: true, requireApproval: false, releasesEnabled: false, releaseConfigPath: '.stacks/release.json' });
  }
  function editProject(project: Project) {
    setDialog({ kind: 'editProject', projectId: project.id, name: project.name, path: project.path, kanbanSource: project.kanban_source, startWorkCommand: project.start_work_command, superthreadSpaces: project.superthread_spaces, superthreadWorkspaceSlug: project.superthread_workspace_slug, serverCommand: project.server_command, consoleCommand: project.console_command, deliveryWorkflow: project.delivery_workflow, targetBranch: project.target_branch, supportsFeatureEnvironments: project.supports_feature_environments, githubMergeStrategy: project.github_merge_strategy, requirePassingCi: project.require_passing_ci, requireApproval: project.require_approval, releasesEnabled: project.releases_enabled, releaseConfigPath: project.release_config_path ?? '.stacks/release.json' });
  }
  async function submitDialog() {
    if (!dialog) return;
    const name = dialog.name.trim(); const path = dialog.path.trim();
    if (!name || !path) throw new Error('Name and directory are required');
    const duplicate = store.projects.find((project) => project.path === path && (dialog.kind === 'project' || project.id !== dialog.projectId));
    if (duplicate) throw new Error('That project directory is already added');
    const id = dialog.kind === 'project' ? crypto.randomUUID() : dialog.projectId;
    const existingOwner = store.projects.find((project) => project.kanban_source === 'superthread' && project.id !== id);
    if (dialog.kanbanSource === 'superthread' && existingOwner) throw new Error(`Superthread is already owned by ${existingOwner.name}. Change that project to a local board first.`);
    if (dialog.kanbanSource === 'superthread' && !dialog.superthreadSpaces?.trim()) throw new Error('Superthread spaces are required');
    const project: Project = {
      id, name, path, workspaces: [], kanban_source: dialog.kanbanSource ?? 'local',
      start_work_command: dialog.startWorkCommand?.trim() || undefined,
      superthread_spaces: dialog.kanbanSource === 'superthread' ? dialog.superthreadSpaces?.trim() : undefined,
      superthread_workspace_slug: dialog.kanbanSource === 'superthread' ? dialog.superthreadWorkspaceSlug?.trim() || undefined : undefined,
      server_command: dialog.serverCommand?.trim() || undefined,
      console_command: dialog.consoleCommand?.trim() || undefined, delivery_workflow: dialog.deliveryWorkflow ?? 'local_merge',
      target_branch: dialog.targetBranch?.trim() || 'main', supports_feature_environments: dialog.supportsFeatureEnvironments ?? false,
      github_merge_strategy: dialog.githubMergeStrategy ?? 'merge', require_passing_ci: dialog.requirePassingCi ?? true,
      require_approval: dialog.requireApproval ?? false,
      releases_enabled: dialog.releasesEnabled ?? false,
      release_config_path: dialog.releaseConfigPath?.trim() || '.stacks/release.json',
    };
    const next = { projects: dialog.kind === 'project' ? [...store.projects, project] : store.projects.map((item) => item.id === id ? project : item) };
    await invoke('save_store', { store: next }); setStore(next); setDialog(null);
    setAppSettings((current) => ({ ...current, kanban_project_id: id }));
  }
  async function deleteConfirmedProject() {
    if (!confirmDeleteProjectId) return;
    const next = { projects: store.projects.filter((project) => project.id !== confirmDeleteProjectId) };
    try {
      await invoke('save_store', { store: next }); setStore(next);
      if (appSettings.kanban_project_id === confirmDeleteProjectId) setAppSettings((current) => ({ ...current, kanban_project_id: null }));
      setConfirmDeleteProjectId(null);
    } catch (error) { showToast(error instanceof Error ? error.message : String(error)); }
  }

  async function startCardWork(cardId: string) {
    if (startingCardIds.current.has(cardId)) return false;
    startingCardIds.current.add(cardId);
    try {
      const card = (await fetchKanbanCards()).cards.find((candidate) => candidate.id === cardId);
      if (!card?.project_id) throw new Error('The card is not assigned to a project');
      const project = store.projects.find((candidate) => candidate.id === card.project_id);
      if (!project) throw new Error('The card project was not found');
      let updated = card;
      if (card.environment) {
        const health = (await fetchKanbanEnvironmentHealth([card.id]))[0];
        if (health?.issues.length) throw new Error(health.issues[0].message);
      } else {
        if (card.status !== 'ready') throw new Error('The card must be Ready for agent before work can start');
        const input = card.provider === 'local' ? buildLocalWorkspaceInput(store, card.project_id, card.external_id, card.title) : buildSuperthreadWorkspaceInput(store, card.project_id, card.external_id, card.title, project.start_work_command || '');
        const setup = input.setupCommand?.trim();
        if (!setup) throw new Error('Start-work setup command is empty');
        updated = await startKanbanEnvironment(
          cardId,
          card.workflow_revision,
          setup,
          card.provider === 'superthread' || Boolean(project.start_work_command?.trim()),
          card.creation_operation?.phase === 'recovery_required',
        );
        if (!updated.environment) {
          showToast(updated.creation_operation?.error || 'Environment creation needs attention');
          return false;
        }
      }
      if (!await launchWorkAgent(cardId, store.projects)) throw new Error('The card changed before its work agent could start');
      showToast(`Started work on #${updated.external_id}`); return true;
    } catch (error) { showToast(`Could not start work: ${error instanceof Error ? error.message : String(error)}`); return false; }
    finally { startingCardIds.current.delete(cardId); }
  }
  async function cleanupCard(card: KanbanCard) {
    const terminalIds = Array.from(new Set([
      ...(card.environment?.panes.filter((pane) => pane.kind === 'terminal').map((pane) => pane.id) ?? []),
      `kanban-card:${card.id}:terminal:server`, `kanban-card:${card.id}:terminal:console`,
    ]));
    try {
      await invoke('kanban_cleanup_environment', {
        id: card.id,
        expectedWorkflowRevision: card.workflow_revision,
        expectedEnvironmentRevision: card.environment?.revision ?? 0,
      });
      return true;
    } finally {
      // The backend owns durable process cleanup. This only reconciles xterm UI caches.
      disposeTerminalSessions(terminalIds);
    }
  }

  const selectedProject = selectedKanbanProject(store.projects, appSettings.kanban_project_id);
  const paletteItems = useMemo(() => buildCommandPaletteItems({
    store, selectedKanbanProject: selectedProject, superthreadEnabled: appSettings.superthread_enabled, cardTerminal,
    onNewProject: () => { void openProjectDialog(); }, onEditProject: editProject,
    onDeleteProject: setConfirmDeleteProjectId, onOpenSettings: () => setSettingsOpen(true),
    onRestartApp: () => { void invoke('restart_app'); },
    onOpenDirectoryInEditor: (path) => { void invoke('open_path_in_editor', { path, editor: appSettings.editor_app }); },
    onRunOneTimeCommand: () => setOneTimeCommandOpen(true),
    onNewCard: (project) => window.dispatchEvent(new CustomEvent('stacks:new-card', { detail: { projectId: project?.id } })),
    onDirectProjectWork: (project) => window.dispatchEvent(new CustomEvent(OPEN_DIRECT_WORK_EVENT, { detail: { projectId: project?.id } })),
    onRelease: (project) => window.dispatchEvent(new CustomEvent(OPEN_DIRECT_WORK_EVENT, { detail: { projectId: project?.id, view: 'release' } })),
    onCardTerminalCommand: (action) => dispatchCardTerminalCommand(action === 'split-right' ? { type: 'split', direction: 'row' } : action === 'split-down' ? { type: 'split', direction: 'column' } : action === 'toggle-maximize' ? { type: 'toggle-maximize' } : { type: action }),
    onFocusCardTerminalPane: (paneId) => dispatchCardTerminalCommand({ type: 'focus', paneId }),
  }), [appSettings.editor_app, appSettings.superthread_enabled, cardTerminal, selectedProject, store]);

  const paletteCardItems = useMemo(
    () => paletteCards ? buildCardPaletteItems(paletteCards) : [],
    [paletteCards],
  );

  const dispatchGlobalTerminal = (detail: GlobalTerminalCommand) => window.dispatchEvent(new CustomEvent(GLOBAL_TERMINAL_COMMAND_EVENT, { detail }));
  const shortcutHandlers: ShortcutHandlers = {
    setMetaKeyDown, openProjectDialog: () => { void openProjectDialog(); }, requestQuit,
    isGlobalTerminalVisible: () => globalTerminalVisible,
    toggleGlobalTerminal: () => setGlobalTerminalVisible((visible) => !visible),
    newGlobalTerminalTab: () => { setGlobalTerminalVisible(true); setGlobalTerminalNewTabNonce((nonce) => nonce + 1); },
    runGlobalTerminalAction: (action) => dispatchGlobalTerminal(action === 'split-right' ? { type: 'split', direction: 'row' } : action === 'split-down' ? { type: 'split', direction: 'column' } : action === 'toggle-maximize' ? { type: 'toggle-maximize' } : { type: action }),
    adjustTerminalFontSize: (delta) => setAppSettings((current) => ({ ...current, terminal_font_size: clampTerminalFontSize(current.terminal_font_size + delta) })),
    adjustUiFontSize: (delta) => setAppSettings((current) => ({ ...current, ui_font_size: clampUiFontSize(current.ui_font_size + delta) })),
    openCommandPalette: () => setCommandPaletteOpen(true), openProjectSwitcher: () => { if (canOpenProjectSwitcher(document)) window.dispatchEvent(new CustomEvent(OPEN_PROJECT_SWITCHER_EVENT)); },
    openSettings: () => setSettingsOpen(true),
    runCardTerminalAction: (action) => dispatchCardTerminalCommand(action === 'split-right' ? { type: 'split', direction: 'row' } : action === 'split-down' ? { type: 'split', direction: 'column' } : action === 'toggle-maximize' ? { type: 'toggle-maximize' } : { type: action }),
  };
  useKeyboardShortcuts(shortcutHandlers);
  const shortcutRef = useRef(shortcutHandlers); shortcutRef.current = shortcutHandlers;
  useEffect(() => {
    const listener = getCurrentWindow().listen<string>('menu-shortcut', (event) => runShortcutAction(event.payload as ShortcutAction, shortcutRef.current));
    return () => { listener.then((unlisten) => unlisten()).catch(console.error); };
  }, []);

  return {
    appStyle: useAppStyle(appSettings),
    globalTerminal: { visible: globalTerminalVisible, newTabNonce: globalTerminalNewTabNonce, setVisible: setGlobalTerminalVisible },
    main: { projects: store.projects, projectsHydrated: loaded, appSettings, setKanbanProjectId: (projectId: string | null) => setAppSettings((current) => ({ ...current, kanban_project_id: projectId })), setKanbanDoneCollapsed: (collapsed: boolean) => setAppSettings((current) => ({ ...current, kanban_done_collapsed: collapsed })), openProjectDialog: () => { void openProjectDialog(); }, cleanupCard, startWork: startCardWork, onPaletteCardsChange: setPaletteCards },
    overlays: {
      appSettings, setAppSettings, commandPaletteOpen, commandPaletteItems: paletteItems, commandPaletteCardItems: paletteCardItems, settingsOpen, oneTimeCommandOpen, oneTimeCommandCwd: cardTerminal?.cwd ?? null,
      dialog, confirmDeleteProject: store.projects.find((project) => project.id === confirmDeleteProjectId) ?? null, confirmQuitOpen, toast, setDialog,
      closeCommandPalette: () => setCommandPaletteOpen(false), closeSettings: () => setSettingsOpen(false),
      notificationsUnavailable: (message: string) => { setAppSettings((current) => ({ ...current, activity_notifications: false })); showToast(message, 5000); },
      closeDialog: () => setDialog(null), submitDialog,
      closeOneTimeCommand: () => setOneTimeCommandOpen(false), runOneTimeCommand: (command: string) => { setOneTimeCommandOpen(false); dispatchCardTerminalCommand({ type: 'run-one-time', command }); },
      cancelDeleteProject: () => setConfirmDeleteProjectId(null), deleteProject: () => { void deleteConfirmedProject(); }, cancelQuit: () => setConfirmQuitOpen(false),
      quit: () => { setConfirmQuitOpen(false); void flushAndQuit(); },
    },
  };
}
