import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import type { AppSettings, DialogState, Project, Store } from '../types';
import { DEFAULT_APP_SETTINGS, resolveAppSettings, toPersistedAppSettings, type ResolvedAppSettings } from '../settingsModel';
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
import { canOpenProjectSwitcher } from '../projectSwitcher';
import type { CardTerminalContext } from '../cardTerminalCommands';
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
import type { GlobalTerminalCommand } from '../globalTerminalState';
import type { AppEventMap, EventBroker } from '../applicationEvents';
import type { GlobalSettingsSection, SettingsPageId } from '../components/SettingsDialog';

function dialogProject(draft: Extract<DialogState, { kind: 'editProject' }>, current: Project): Project {
  return { ...current, name: draft.name.trim(), path: draft.path.trim(), kanban_source: draft.kanbanSource ?? 'local',
    start_work_command: draft.startWorkCommand?.trim() || undefined,
    superthread_spaces: draft.kanbanSource === 'superthread' ? draft.superthreadSpaces?.trim() : undefined,
    superthread_workspace_id: draft.superthreadWorkspaceId, superthread_workspace_name: draft.superthreadWorkspaceName,
    superthread_space_id: draft.superthreadSpaceId, superthread_space_name: draft.superthreadSpaceName, superthread_binding_id: draft.superthreadBindingId,
    superthread_workspace_slug: draft.kanbanSource === 'superthread' ? draft.superthreadWorkspaceSlug?.trim() || undefined : undefined,
    superthread_api_token_env_var: draft.kanbanSource === 'superthread' ? draft.superthreadApiTokenEnvVar?.trim() || 'ST_TOKEN' : undefined,
    superthread_board_id: draft.kanbanSource === 'superthread' ? draft.superthreadBoardId : undefined,
    superthread_board_name: draft.kanbanSource === 'superthread' ? draft.superthreadBoardName : undefined,
    superthread_incoming_columns: draft.kanbanSource === 'superthread' ? draft.superthreadIncomingColumns : undefined,
    superthread_default_incoming_column_id: draft.kanbanSource === 'superthread' ? draft.superthreadDefaultIncomingColumnId : undefined,
    superthread_in_progress_column_id: draft.kanbanSource === 'superthread' ? draft.superthreadInProgressColumnId : undefined,
    superthread_in_progress_column_name: draft.kanbanSource === 'superthread' ? draft.superthreadInProgressColumnName : undefined,
    superthread_done_column_id: draft.kanbanSource === 'superthread' ? draft.superthreadDoneColumnId : undefined,
    superthread_done_column_name: draft.kanbanSource === 'superthread' ? draft.superthreadDoneColumnName : undefined,
    server_command: draft.serverCommand?.trim() || undefined, console_command: draft.consoleCommand?.trim() || undefined,
    delivery_workflow: draft.deliveryWorkflow ?? 'local_merge', deployment_command: draft.deploymentCommand?.trim() || undefined, target_branch: draft.targetBranch?.trim() || 'main',
    supports_feature_environments: draft.supportsFeatureEnvironments ?? false, github_merge_strategy: draft.githubMergeStrategy ?? 'merge',
    require_passing_ci: draft.requirePassingCi ?? true, require_approval: draft.requireApproval ?? false,
    releases_enabled: draft.releasesEnabled ?? false, release_config_path: draft.releaseConfigPath?.trim() || '.stacks/release.json' };
}

function projectConfigurationInput(project: Project, expectedRevision: number) {
  return { id: project.id, name: project.name, path: project.path, kanban_source: project.kanban_source,
    start_work_command: project.start_work_command, superthread_spaces: project.superthread_spaces,
    superthread_workspace_id: project.superthread_workspace_id, superthread_workspace_name: project.superthread_workspace_name,
    superthread_space_id: project.superthread_space_id, superthread_space_name: project.superthread_space_name, superthread_binding_id: project.superthread_binding_id,
    superthread_workspace_slug: project.superthread_workspace_slug, superthread_api_token_env_var: project.superthread_api_token_env_var,
    superthread_board_id: project.superthread_board_id,
    superthread_board_name: project.superthread_board_name, superthread_incoming_columns: project.superthread_incoming_columns,
    superthread_default_incoming_column_id: project.superthread_default_incoming_column_id,
    superthread_in_progress_column_id: project.superthread_in_progress_column_id, superthread_in_progress_column_name: project.superthread_in_progress_column_name,
    superthread_done_column_id: project.superthread_done_column_id, superthread_done_column_name: project.superthread_done_column_name,
    server_command: project.server_command,
    console_command: project.console_command, delivery_workflow: project.delivery_workflow ?? 'local_merge', deployment_command: project.deployment_command,
    target_branch: project.target_branch ?? 'main', supports_feature_environments: project.supports_feature_environments ?? false,
    github_merge_strategy: project.github_merge_strategy ?? 'merge', require_passing_ci: project.require_passing_ci ?? true,
    require_approval: project.require_approval ?? false, releases_enabled: project.releases_enabled ?? false,
    release_config_path: project.release_config_path ?? '.stacks/release.json', expected_revision: expectedRevision };
}

export function useAppRootModel(events: EventBroker<AppEventMap>) {
  const [loaded, setLoaded] = useState(false);
  const [store, setStore] = useState<Store>({ projects: [] });
  const [appSettings, setAppSettings] = useState<ResolvedAppSettings>(DEFAULT_APP_SETTINGS);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPageId>('global:interface');
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
  const persistedSettingsRef = useRef<ResolvedAppSettings | null>(null);
  const pendingSettingsFieldsRef = useRef(new Set<keyof ResolvedAppSettings>());
  const settingsSaveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (!loaded) return;
    const previous = persistedSettingsRef.current;
    persistedSettingsRef.current = appSettings;
    if (!previous) return;
    (Object.keys(appSettings) as Array<keyof ResolvedAppSettings>)
      .filter((key) => appSettings[key] !== previous[key])
      .forEach((key) => pendingSettingsFieldsRef.current.add(key));
    if (!pendingSettingsFieldsRef.current.size) return;
    const timer = window.setTimeout(() => {
      const fields = Array.from(pendingSettingsFieldsRef.current);
      pendingSettingsFieldsRef.current.clear();
      settingsSaveChainRef.current = settingsSaveChainRef.current.catch(() => undefined)
        .then(() => invoke('patch_app_settings', { next: toPersistedAppSettings(appSettings), fields }));
      void settingsSaveChainRef.current.catch(console.error);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [appSettings, loaded]);
  useEffect(() => events.subscribe('card-terminal-context', setCardTerminal), [events]);
  useWindowStatePersistence();
  useAppWindowFocusClass();
  useAppToastEvents(showToast);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow().listen<string>('superthread-credential-rotated', () => {
      showToast('Superthread credential changed. Affected Pi sessions were restarted.');
    }).then((cleanup) => { unlisten = cleanup; }).catch(console.error);
    return () => unlisten?.();
  }, [showToast]);
  useAppCloseRequest(requestQuit);
  useNativeFileDropRouter();
  useActivityNotifications({ settings: appSettings, setSettings: setAppSettings, projects: store.projects, showToast });

  async function openProjectDialog() {
    const selected = await open({ directory: true, multiple: false, title: 'Choose Project Directory' }).catch(() => null);
    if (typeof selected !== 'string') return;
    setDialog({ kind: 'project', name: selected.split('/').filter(Boolean).at(-1) ?? 'Project', path: selected, kanbanSource: 'local', deliveryWorkflow: 'local_merge', targetBranch: 'main', supportsFeatureEnvironments: false, githubMergeStrategy: 'merge', requirePassingCi: true, requireApproval: false, releasesEnabled: false, releaseConfigPath: '.stacks/release.json' });
  }
  function editProject(project: Project) {
    setSettingsPage(`project:${project.id}`); setSettingsOpen(true);
  }
  async function submitDialog() {
    if (!dialog) return;
    const name = dialog.name.trim(); const path = dialog.path.trim();
    if (!name || !path) throw new Error('Name and directory are required');
    const duplicate = store.projects.find((project) => project.path === path && (dialog.kind === 'project' || project.id !== dialog.projectId));
    if (duplicate) throw new Error('That project directory is already added');
    const id = dialog.kind === 'project' ? crypto.randomUUID() : dialog.projectId;
    if (dialog.kanbanSource === 'superthread' && !dialog.superthreadSpaces?.trim()) throw new Error('Superthread spaces are required');
    if (dialog.deliveryWorkflow === 'scripted_delivery' && !dialog.deploymentCommand?.trim()) throw new Error('Deployment command is required for Scripted delivery');
    const project: Project = {
      id, name, path, workspaces: [], kanban_source: dialog.kanbanSource ?? 'local',
      start_work_command: dialog.startWorkCommand?.trim() || undefined,
      superthread_spaces: dialog.kanbanSource === 'superthread' ? dialog.superthreadSpaces?.trim() : undefined,
      superthread_workspace_id: dialog.superthreadWorkspaceId, superthread_workspace_name: dialog.superthreadWorkspaceName,
      superthread_space_id: dialog.superthreadSpaceId, superthread_space_name: dialog.superthreadSpaceName, superthread_binding_id: dialog.superthreadBindingId,
      superthread_workspace_slug: dialog.kanbanSource === 'superthread' ? dialog.superthreadWorkspaceSlug?.trim() || undefined : undefined,
      superthread_api_token_env_var: dialog.kanbanSource === 'superthread' ? dialog.superthreadApiTokenEnvVar?.trim() || 'ST_TOKEN' : undefined,
      superthread_board_id: dialog.kanbanSource === 'superthread' ? dialog.superthreadBoardId : undefined,
      superthread_board_name: dialog.kanbanSource === 'superthread' ? dialog.superthreadBoardName : undefined,
      superthread_incoming_columns: dialog.kanbanSource === 'superthread' ? dialog.superthreadIncomingColumns : undefined,
      superthread_default_incoming_column_id: dialog.kanbanSource === 'superthread' ? dialog.superthreadDefaultIncomingColumnId : undefined,
      superthread_in_progress_column_id: dialog.kanbanSource === 'superthread' ? dialog.superthreadInProgressColumnId : undefined,
      superthread_in_progress_column_name: dialog.kanbanSource === 'superthread' ? dialog.superthreadInProgressColumnName : undefined,
      superthread_done_column_id: dialog.kanbanSource === 'superthread' ? dialog.superthreadDoneColumnId : undefined,
      superthread_done_column_name: dialog.kanbanSource === 'superthread' ? dialog.superthreadDoneColumnName : undefined,
      server_command: dialog.serverCommand?.trim() || undefined,
      console_command: dialog.consoleCommand?.trim() || undefined, delivery_workflow: dialog.deliveryWorkflow ?? 'local_merge', deployment_command: dialog.deploymentCommand?.trim() || undefined,
      target_branch: dialog.targetBranch?.trim() || 'main', supports_feature_environments: dialog.supportsFeatureEnvironments ?? false,
      github_merge_strategy: dialog.githubMergeStrategy ?? 'merge', require_passing_ci: dialog.requirePassingCi ?? true,
      require_approval: dialog.requireApproval ?? false,
      releases_enabled: dialog.releasesEnabled ?? false,
      release_config_path: dialog.releaseConfigPath?.trim() || '.stacks/release.json',
    };
    const next = await invoke<Store>('create_project', { input: projectConfigurationInput(project, 0) });
    setStore(next); setDialog(null);
    setAppSettings((current) => ({ ...current, kanban_project_id: id }));
  }
  async function deleteConfirmedProject() {
    if (!confirmDeleteProjectId) return;
    try {
      const saved = await invoke<Store>('delete_project', { projectId: confirmDeleteProjectId }); setStore(saved);
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
    onNewCard: (project) => events.publish('new-card', { projectId: project?.id }),
    onDirectProjectWork: (project) => events.publish('open-direct-work', { projectId: project?.id }),
    onRelease: (project) => events.publish('open-direct-work', { projectId: project?.id, view: 'release' }),
    onCardTerminalCommand: (action) => events.publish('card-terminal-command', action === 'split-right' ? { type: 'split', direction: 'row' } : action === 'split-down' ? { type: 'split', direction: 'column' } : action === 'toggle-maximize' ? { type: 'toggle-maximize' } : { type: action }),
    onFocusCardTerminalPane: (paneId) => events.publish('card-terminal-command', { type: 'focus', paneId }),
  }), [appSettings.editor_app, appSettings.superthread_enabled, cardTerminal, events, selectedProject, store]);

  const paletteCardItems = useMemo(
    () => paletteCards ? buildCardPaletteItems(paletteCards) : [],
    [paletteCards],
  );

  const dispatchGlobalTerminal = (detail: GlobalTerminalCommand) => events.publish('global-terminal-command', detail);
  const shortcutHandlers: ShortcutHandlers = {
    setMetaKeyDown, openProjectDialog: () => { void openProjectDialog(); }, requestQuit,
    isGlobalTerminalVisible: () => globalTerminalVisible,
    toggleGlobalTerminal: () => setGlobalTerminalVisible((visible) => !visible),
    newGlobalTerminalTab: () => { setGlobalTerminalVisible(true); setGlobalTerminalNewTabNonce((nonce) => nonce + 1); },
    runGlobalTerminalAction: (action) => dispatchGlobalTerminal(action === 'split-right' ? { type: 'split', direction: 'row' } : action === 'split-down' ? { type: 'split', direction: 'column' } : action === 'toggle-maximize' ? { type: 'toggle-maximize' } : { type: action }),
    adjustTerminalFontSize: (delta) => setAppSettings((current) => ({ ...current, terminal_font_size: clampTerminalFontSize(current.terminal_font_size + delta) })),
    adjustUiFontSize: (delta) => setAppSettings((current) => ({ ...current, ui_font_size: clampUiFontSize(current.ui_font_size + delta) })),
    openCommandPalette: () => setCommandPaletteOpen(true), openProjectSwitcher: () => { if (canOpenProjectSwitcher(document)) events.publish('open-project-switcher', undefined); },
    openSettings: () => setSettingsOpen(true),
    runCardTerminalAction: (action) => events.publish('card-terminal-command', action === 'split-right' ? { type: 'split', direction: 'row' } : action === 'split-down' ? { type: 'split', direction: 'column' } : action === 'toggle-maximize' ? { type: 'toggle-maximize' } : { type: action }),
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
      appSettings, setAppSettings, projects: store.projects, settingsPage, setSettingsPage,
      saveSettingsSection: async (_section: GlobalSettingsSection, patch: Partial<ResolvedAppSettings>) => {
        const next = { ...appSettings, ...patch };
        const save = settingsSaveChainRef.current.catch(() => undefined)
          .then(() => invoke('patch_app_settings', { next: toPersistedAppSettings(next), fields: Object.keys(patch) }));
        settingsSaveChainRef.current = save;
        await save;
        setAppSettings((current) => ({ ...current, ...patch }));
      },
      saveProjectConfiguration: async (projectId: string, draft: DialogState, expectedRevision: number) => {
        if (draft.kind !== 'editProject' || draft.projectId !== projectId) throw new Error('Invalid project draft');
        const current = store.projects.find((project) => project.id === projectId); if (!current) throw new Error('Project not found');
        const candidate = dialogProject(draft, current);
        const saved = await invoke<Store>('update_project_configuration', { input: projectConfigurationInput(candidate, expectedRevision) });
        setStore(saved);
      },
      deleteSettingsProject: async (projectId: string) => {
        const saved = await invoke<Store>('delete_project', { projectId }); setStore(saved);
        if (appSettings.kanban_project_id === projectId) setAppSettings((current) => ({ ...current, kanban_project_id: null }));
      },
      commandPaletteOpen, commandPaletteItems: paletteItems, commandPaletteCardItems: paletteCardItems, settingsOpen, oneTimeCommandOpen, oneTimeCommandCwd: cardTerminal?.cwd ?? null,
      dialog, confirmDeleteProject: store.projects.find((project) => project.id === confirmDeleteProjectId) ?? null, confirmQuitOpen, toast, setDialog,
      closeCommandPalette: () => setCommandPaletteOpen(false), closeSettings: () => setSettingsOpen(false),
      notificationsUnavailable: (message: string) => { setAppSettings((current) => ({ ...current, activity_notifications: false })); showToast(message, 5000); },
      closeDialog: () => setDialog(null), submitDialog,
      closeOneTimeCommand: () => setOneTimeCommandOpen(false), runOneTimeCommand: (command: string) => { setOneTimeCommandOpen(false); events.publish('card-terminal-command', { type: 'run-one-time', command }); },
      cancelDeleteProject: () => setConfirmDeleteProjectId(null), deleteProject: () => { void deleteConfirmedProject(); }, cancelQuit: () => setConfirmQuitOpen(false),
      quit: () => { setConfirmQuitOpen(false); void flushAndQuit(); },
    },
  };
}
