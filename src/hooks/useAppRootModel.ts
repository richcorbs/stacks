import { useCallback, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStats } from './useAppStats';
import { useWorkspaceCommands } from './useWorkspaceCommands';
import { useAppShortcutHandlers } from './useAppShortcutHandlers';
import { useAppWorkspaceModels } from './useAppWorkspaceModels';
import { useAppFocusRestore } from './useAppFocusRestore';
import { useAppUiActions } from './useAppUiActions';
import { useAppOverlayModels } from './useAppOverlayModels';
import { useAppLifecycleEffects } from './useAppLifecycleEffects';
import { useAppInteractionEffects } from './useAppInteractionEffects';
import { useAppStateBundle } from './useAppStateBundle';
import { useAppLayoutProps } from './useAppLayoutProps';
import { useAutomationRequests } from './useAutomationRequests';
import { useWorkspaceCreation } from './useWorkspaceCreation';
import { useOneTimeCommand } from './useOneTimeCommand';
import { useWorkspacePullRequests } from './useWorkspacePullRequests';
import { useActivityNotifications } from './useActivityNotifications';
import { matchingWorkspaceDeleteTargets } from '../workspaceBulkDelete';
import { buildLocalWorkspaceInput, buildSuperthreadWorkspaceInput } from '../superthread/startWork';
import { nextWorkspaceWithUnseenOutput } from '../workspace/statusDots';
import { disposeTerminalSessions } from '../terminalSessionManager';
import { createKanbanEnvironment, fetchKanbanCards } from '../kanban/api';
import type { CardServiceDefinition } from '../kanban/types';
import type { KanbanCard } from '../kanban/types';
import type { GitInfo } from '../types';
import { developerServicesShortcutState, type DeveloperServicesTab } from '../developerServices';
import { updateProjectNotes } from '../projectNotes';

const encoder = new TextEncoder();

export function useAppRootModel() {
  const startingKanbanCardIdsRef = useRef(new Set<string>());
  const {
    loaded,
    setLoaded,
    store,
    setStore,
    sidebarWidth,
    setSidebarWidth,
    sidebarVisible,
    setSidebarVisible,
    appSettings,
    setAppSettings,
    metaKeyDown,
    setMetaKeyDown,
    workspace,
    workspaceActions,
    overlayState,
    toastState,
    terminalActivity,
  } = useAppStateBundle();
  const {
    activeProjectId,
    activeWorkspaceId,
    terminalsByWorkspaceId,
    splitRootsByWorkspaceId,
    visitedWorkspaceIds,
    activeTerminalId,
    focusedTerminalByWorkspaceId,
    maximizedWorkspaceIds,
    sidebarFocusedWorkspaceId,
    terminalCwds,
  } = workspace;
  const {
    setActiveProjectId,
    setTerminalsByWorkspaceId,
    setSplitRootsByWorkspaceId,
    setActiveTerminalId,
    setFocusedTerminalByWorkspaceId,
    setMaximizedWorkspaceIds,
    setSidebarFocusedWorkspaceId,
    selectWorkspace,
    initializeWorkspace,
    focusTerminal: focusTerminalState,
    removeTerminalState,
    removeProjectState,
    rememberTerminalCwd,
  } = workspaceActions;
  const { runningTerminalIds, setRunningTerminalIds, activityWorkspaceIds, setActivityWorkspaceIds, activityTerminalLastOutputAtById, activityNow } = terminalActivity;
  const {
    dialog,
    setDialog,
    contextMenu,
    setContextMenu,
    pointerDragRef,
    resizingSidebarRef,
    justPointerDraggedRef,
    confirmCloseTerminalId,
    setConfirmCloseTerminalId,
    confirmDeleteProjectId,
    setConfirmDeleteProjectId,
    confirmDeleteWorkspace,
    setConfirmDeleteWorkspace,
    confirmQuitOpen,
    setConfirmQuitOpen,
    commandPaletteOpen,
    setCommandPaletteOpen,
    settingsOpen,
    setSettingsOpen,
    searchTerminalRequest,
    setSearchTerminalRequest,
    restartTerminalRequest,
    setRestartTerminalRequest,
    oneTimeCommandOpen,
    setOneTimeCommandOpen,
    addCmdPCommandOpen,
    setAddCmdPCommandOpen,
    editingCmdPCommand,
    setEditingCmdPCommand,
    deletingCmdPCommand,
    setDeletingCmdPCommand,
    addWorkspaceTemplateOpen,
    setAddWorkspaceTemplateOpen,
    editingWorkspaceTemplate,
    setEditingWorkspaceTemplate,
    deletingWorkspaceTemplate,
    setDeletingWorkspaceTemplate,
    deleteMultipleWorkspacesOpen,
    setDeleteMultipleWorkspacesOpen,
  } = overlayState;
  const { toast, showToast } = toastState;
  const [broadcastWorkspaceIds, setBroadcastWorkspaceIds] = useState<Record<string, boolean>>({});
  const [notesVisible, setNotesVisible] = useState(false);
  const [developerServicesVisible, setDeveloperServicesVisible] = useState(true);
  const [developerServicesTab, setDeveloperServicesTab] = useState<DeveloperServicesTab>('superthread');

  const { activeProject, activeWorkspace, sidebarWorkspaces, activePath, visitedWorkspaceTerminalTrees } = useAppWorkspaceModels({
    store,
    activeProjectId,
    activeWorkspaceId,
    activeTerminalId,
    terminalCwds,
    visitedWorkspaceIds,
    terminalsByWorkspaceId,
    splitRootsByWorkspaceId,
  });
  function changeProjectNotes(notes: string) {
    if (!activeProject) return;
    setStore((current) => updateProjectNotes(current, activeProject.id, notes));
  }

  useActivityNotifications({
    enabled: appSettings.activity_notifications,
    store,
    activeWorkspaceId,
  });
  const appStats = useAppStats();
  const workspacePullRequests = useWorkspacePullRequests(sidebarWorkspaces);
  const { restoreActiveTerminalFocus } = useAppFocusRestore(activeTerminalId);

  function toggleProjectNotes() {
    if (!activeProject) return;
    const closing = notesVisible;
    setNotesVisible((visible) => !visible);
    if (closing) restoreActiveTerminalFocus('close-project-notes');
  }

  function toggleDeveloperServices(reason: string) {
    const closing = developerServicesVisible;
    setDeveloperServicesVisible((visible) => !visible);
    if (closing) restoreActiveTerminalFocus(reason);
  }

  function focusDeveloperServicesTab(requestedTab: DeveloperServicesTab, closeReason: string) {
    const next = developerServicesShortcutState(developerServicesVisible, developerServicesTab, requestedTab);
    setDeveloperServicesTab(next.activeTab);
    setDeveloperServicesVisible(next.visible);
    if (!next.visible) restoreActiveTerminalFocus(closeReason);
  }

  const { saveStoreNow } = useAppLifecycleEffects({
    loaded,
    store,
    sidebarWidth,
    appSettings,
    setLoaded,
    setStore,
    setSidebarWidth,
    setAppSettings,
    developerServicesVisible,
    setDeveloperServicesVisible,
    developerServicesTab,
    setDeveloperServicesTab,
    selectWorkspace,
    setActiveProjectId,
    setFocusedTerminalByWorkspaceId,
    setMaximizedWorkspaceIds,
    activeProjectId,
    activeWorkspaceId,
    activeTerminalId,
    focusedTerminalByWorkspaceId,
    activePaneKind: activeWorkspaceId
      ? (terminalsByWorkspaceId[activeWorkspaceId] ?? []).find((pane) => pane.id === activeTerminalId)?.kind ?? 'terminal'
      : 'terminal',
    maximizedWorkspaceIds,
    sidebarFocusedWorkspaceId,
    setConfirmQuitOpen,
    setContextMenu,
    rememberTerminalCwd,
    showToast,
  });

  const { createWorkspace, rollbackWorkspace } = useWorkspaceCreation({
    store,
    setStore,
    saveStoreNow,
    selectWorkspace,
    focusTerminal: focusTerminalState,
    removeTerminalState,
    setTerminalsByWorkspaceId,
    setSplitRootsByWorkspaceId,
    setSidebarFocusedWorkspaceId,
  });

  const commands = useWorkspaceCommands({
    store,
    setStore,
    dialog,
    setDialog,
    activeWorkspace,
    activeTerminalId,
    focusedTerminalByWorkspaceId,
    maximizedWorkspaceIds,
    sidebarFocusedWorkspaceId,
    activeWorkspaceId,
    terminalsByWorkspaceId,
    splitRootsByWorkspaceId,
    sidebarWorkspaces,
    selectWorkspace,
    focusTerminalState,
    removeTerminalState,
    removeProjectState,
    setTerminalsByWorkspaceId,
    setSplitRootsByWorkspaceId,
    setActiveTerminalId,
    setFocusedTerminalByWorkspaceId,
    setMaximizedWorkspaceIds,
    setSidebarFocusedWorkspaceId,
    setRunningTerminalIds,
    setActivityWorkspaceIds,
    requestTerminalRestart: (terminalId) => setRestartTerminalRequest({ terminalId, nonce: Date.now() }),
    createWorkspace,
  });
  const {
    openProjectDialog,
    openWorkspaceDialog,
    openWorkspaceTemplateDialog,
    openEditTerminalDialog,
    submitDialog,
    toggleProject,
    openEditProjectDialog,
    openEditWorkspaceDialog,
    focusTerminal,
    deleteWorkspace,
    moveProject,
    moveTerminal,
    deleteProject,
    splitTerminal,
    splitTerminalWithCommand,
    cycleTerminal,
    cycleSidebarWorkspace,
    activateSidebarFocusedWorkspace,
    activateWorkspaceByIndex,
    toggleMaximizedTerminal,
    resizeSplit,
    stopTerminal,
    restartTerminal,
    closeTerminal,
  } = commands;

  function focusNextWorkspaceWithUnseenOutput() {
    const workspaceId = nextWorkspaceWithUnseenOutput(
      sidebarWorkspaces.map(({ workspace }) => workspace.id),
      activityWorkspaceIds,
      activeWorkspaceId,
    );
    if (!workspaceId) return;
    const index = sidebarWorkspaces.findIndex(({ workspace }) => workspace.id === workspaceId);
    if (index >= 0) activateWorkspaceByIndex(index);
  }

  async function createKanbanWorkspace(projectId: string, cardNumber: string, cardTitle: string) {
    const project = store.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error('Selected project not found');
    const usesSuperthread = project.kanban_source === 'superthread';
    const input = usesSuperthread
      ? buildSuperthreadWorkspaceInput(store, projectId, cardNumber, cardTitle, {
          command: project.start_work_command || appSettings.superthread_start_work_command,
          workspaceName: appSettings.superthread_workspace_name_template,
        })
      : buildLocalWorkspaceInput(store, projectId, cardNumber, cardTitle);
    return createWorkspace(input);
  }

  async function startKanbanWork(projectId: string, cardNumber: string, cardTitle: string) {
    try {
      const creation = await createKanbanWorkspace(projectId, cardNumber, cardTitle);
      showToast(`Started work on #${cardNumber}`);
      return { projectId: creation.projectId, workspaceId: creation.workspace.id };
    } catch (error) {
      showToast(`Could not start work: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async function startCardWork(cardId: string) {
    const starting = startingKanbanCardIdsRef.current;
    if (starting.has(cardId)) throw new Error('Work is already being started for this card');
    starting.add(cardId);
    try {
      const card = (await fetchKanbanCards()).find((candidate) => candidate.id === cardId);
      if (!card) throw new Error('The scoped local card was not found');
      if (!card.project_id) throw new Error('The card is not assigned to a project');
      const project = store.projects.find((candidate) => candidate.id === card.project_id);
      if (!project) throw new Error('The card project was not found');
      if (card.environment) {
        return {
          ok: true,
          message: `Work is already started on #${card.external_id} in ${card.environment.worktree_path}`,
          workspaceId: card.environment.id,
        };
      }
      if (card.status !== 'ready') throw new Error('The card must be Ready for agent before work can start');

      const input = card.provider === 'local'
        ? buildLocalWorkspaceInput(store, card.project_id, card.external_id, card.title)
        : buildSuperthreadWorkspaceInput(store, card.project_id, card.external_id, card.title, {
            command: project.start_work_command || appSettings.superthread_start_work_command,
            workspaceName: appSettings.superthread_workspace_name_template,
          });
      const setupCommand = input.setupCommand?.trim();
      const setup = setupCommand
        ? await invoke<{ cwd: string; output: string }>('run_workspace_setup', { command: setupCommand, cwd: project.path })
        : { cwd: project.path, output: '' };
      const worktree = setup.cwd;
      const git = await invoke<GitInfo | null>('git_info', { path: worktree }).catch(() => null);
      const services: CardServiceDefinition[] = [
        project.server_command?.trim() ? { id: '', name: 'server', command: project.server_command.trim(), sort_order: 0 } : null,
        project.console_command?.trim() ? { id: '', name: 'console', command: project.console_command.trim(), sort_order: 1 } : null,
      ].filter((service): service is CardServiceDefinition => service !== null);
      const updated = await createKanbanEnvironment(card.id, card.project_id, worktree, git?.branch ?? '', services);
      showToast(`Started work on #${card.external_id}`);
      return {
        ok: true,
        message: `Started work on #${card.external_id}\nWorktree: ${worktree}${git?.branch ? `\nBranch: ${git.branch}` : ''}`,
        workspaceId: updated.environment?.id ?? null,
      };
    } finally {
      starting.delete(cardId);
    }
  }

  async function startCardWorkFromUi(cardId: string) {
    try {
      await startCardWork(cardId);
      return true;
    } catch (error) {
      showToast(`Could not start work: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  useAutomationRequests({
    loaded,
    activeProjectId,
    createWorkspace,
    rollbackWorkspace,
    startCardWork,
  });

  useAppInteractionEffects({
    resizingSidebarRef,
    pointerDragRef,
    justPointerDraggedRef,
    setSidebarWidth,
    moveProject,
    moveTerminal,
    activeWorkspace,
    initializeWorkspace,
    setActiveTerminalId,
  });

  const {
    adjustTerminalFontSize,
    adjustUiFontSize,
    openDirectoryInEditor,
    openTerminalSearch,
    closeCommandPalette,
    closeContextMenu,
    closeSettings,
    closeDialog,
    submitActiveDialog,
  } = useAppUiActions({
    activeTerminalId,
    activePath,
    activeProjectPath: activeProject?.path,
    editorApp: appSettings.editor_app,
    setAppSettings,
    setSearchTerminalRequest,
    setCommandPaletteOpen,
    setContextMenu,
    setSettingsOpen,
    setDialog,
    submitDialog,
    restoreActiveTerminalFocus,
    showToast,
  });

  const { runOneTimeCommand } = useOneTimeCommand({
    activeProjectId,
    activeWorkspaceId,
    activeTerminalId,
    activePath,
    fallbackPath: activeWorkspace?.cwd || activeProject?.path || null,
    maximizedWorkspaceIds,
    terminalsByWorkspaceId,
    splitRootsByWorkspaceId,
    selectWorkspace,
    focusTerminal: focusTerminalState,
    setTerminalsByWorkspaceId,
    setSplitRootsByWorkspaceId,
    setMaximizedWorkspaceIds,
  });

  const toggleBroadcast = useCallback((workspaceId: string) => {
    setBroadcastWorkspaceIds((current) => ({ ...current, [workspaceId]: !current[workspaceId] }));
    restoreActiveTerminalFocus('toggle-broadcast');
  }, [restoreActiveTerminalFocus]);

  const toggleActiveWorkspaceBroadcast = useCallback(() => {
    if (!activeWorkspaceId) return;
    setBroadcastWorkspaceIds((current) => {
      const enabled = !current[activeWorkspaceId];
      showToast(enabled ? 'Broadcast enabled' : 'Broadcast disabled');
      return { ...current, [activeWorkspaceId]: enabled };
    });
    restoreActiveTerminalFocus('toggle-broadcast');
  }, [activeWorkspaceId, restoreActiveTerminalFocus, showToast]);

  const handleTerminalInput = useCallback((terminalId: string, data: string) => {
    const sourceTerminal = Object.values(terminalsByWorkspaceId).flat().find((terminal) => terminal.id === terminalId);
    const workspaceId = sourceTerminal?.workspaceId;
    if (!workspaceId) return;
    const targetIds = broadcastWorkspaceIds[workspaceId] && !sourceTerminal?.temporary
      ? (terminalsByWorkspaceId[workspaceId] ?? []).filter((terminal) => !terminal.temporary && terminal.kind !== 'pi').map((terminal) => terminal.id)
      : [terminalId];
    for (const targetId of targetIds) {
      invoke('write_pty', { terminalId: targetId, data: Array.from(encoder.encode(data)) }).catch(console.error);
    }
  }, [broadcastWorkspaceIds, terminalsByWorkspaceId]);

  async function cleanupKanbanCard(card: KanbanCard) {
    await Promise.all([
      ...Array.from(new Set(card.environment?.panes.filter((pane) => pane.kind === 'pi').map((pane) => pane.id) ?? [
        `kanban-card:${card.id}:planning`, `kanban-card:${card.id}:work`,
      ])).map((paneId) => invoke('delete_pi_session', { paneId })),
      ...Array.from(new Set([
        ...(card.environment?.panes.filter((pane) => pane.kind === 'terminal').map((pane) => pane.id) ?? []),
        ...(card.environment?.services.map((service) => `kanban-card:${card.id}:terminal:${service.name}`) ?? []),
      ])).map((terminalId) => {
        disposeTerminalSessions([terminalId]);
        return invoke('kill_pty', { terminalId, expectedCwd: card.environment?.worktree_path });
      }),
    ]);
    if (!card.project_id || !card.environment) return true;
    const project = store.projects.find((candidate) => candidate.id === card.project_id);
    if (!project) return true;
    const path = card.environment.worktree_path;
    const git = await invoke<GitInfo | null>('git_info', { path });
    await invoke('cleanup_git_worktree', {
      repositoryPath: project.path,
      worktreePath: path,
      branch: git?.branch ?? card.environment.branch,
    });
    return true;
  }

  const { commandPaletteItems } = useAppShortcutHandlers({
    store,
    sidebarWorkspaces,
    terminalsByWorkspaceId,
    activeProject,
    activeWorkspace,
    activeWorkspaceId,
    activeTerminalId,
    focusedTerminalByWorkspaceId,
    maximizedWorkspaceIds,
    activePath,
    appSettings,
    setMetaKeyDown,
    toggleSidebar: () => setSidebarVisible((visible) => !visible),
    toggleSuperthread: () => toggleDeveloperServices('close-developer-services-shortcut'),
    toggleGithubPullRequests: () => focusDeveloperServicesTab('pull-requests', 'close-pull-requests-panel'),
    toggleDiff: () => focusDeveloperServicesTab('diff', 'close-diff-panel'),
    toggleProjectNotes,
    setConfirmCloseTerminalId,
    setConfirmDeleteProjectId,
    setConfirmDeleteWorkspace,
    setConfirmQuitOpen,
    setCommandPaletteOpen,
    setSettingsOpen,
    selectWorkspace,
    openProjectDialog,
    openWorkspaceDialog,
    openEditProjectDialog,
    openEditWorkspaceDialog,
    openEditTerminalDialog,
    deleteProject,
    deleteWorkspace,
    splitTerminal,
    splitTerminalWithCommand,
    cycleSidebarWorkspace,
    cycleTerminal,
    focusNextWorkspaceWithUnseenOutput,
    stopTerminal,
    restartTerminal,
    closeTerminal,
    toggleMaximizedTerminal,
    activateWorkspaceByIndex,
    activateSidebarFocusedWorkspace,
    adjustTerminalFontSize,
    adjustUiFontSize,
    openTerminalSearch,
    openDirectoryInEditor,
    openOneTimeCommand: () => setOneTimeCommandOpen(true),
    openAddCmdPCommand: () => setAddCmdPCommandOpen(true),
    openEditCmdPCommand: setEditingCmdPCommand,
    openDeleteCmdPCommand: setDeletingCmdPCommand,
    openAddWorkspaceTemplate: () => setAddWorkspaceTemplateOpen(true),
    openWorkspaceTemplate: openWorkspaceTemplateDialog,
    openEditWorkspaceTemplate: setEditingWorkspaceTemplate,
    openDeleteWorkspaceTemplate: setDeletingWorkspaceTemplate,
    openDeleteMultipleWorkspaces: () => setDeleteMultipleWorkspacesOpen(true),
    broadcastEnabled: activeWorkspaceId ? Boolean(broadcastWorkspaceIds[activeWorkspaceId]) : false,
    onToggleBroadcast: toggleActiveWorkspaceBroadcast,
  });

  const { confirmDeleteProject, confirmDeleteWorkspaceEntry } = useAppOverlayModels({ store, confirmDeleteProjectId, confirmDeleteWorkspace });
  const layoutProps = useAppLayoutProps({
    sidebarVisible,
    sidebarWidth,
    store,
    activeProjectId,
    activeWorkspaceId,
    sidebarFocusedWorkspaceId,
    sidebarWorkspaces,
    workspacePullRequests,
    runningTerminalIds,
    activityWorkspaceIds,
    activityTerminalLastOutputAtById,
    activityNow,
    metaKeyDown,
    appStats,
    justPointerDraggedRef,
    pointerDragRef,
    resizingSidebarRef,
    toggleProject,
    selectWorkspace,
    openWorkspaceDiff: (projectId, workspaceId) => {
      selectWorkspace(projectId, workspaceId);
      setDeveloperServicesTab('diff');
      setDeveloperServicesVisible(true);
    },
    setContextMenu,
    openProjectDialog,
    openWorkspaceDialog,
    activePath,
    activeProjectName: activeProject?.name ?? null,
    activeWorkspaceName: activeWorkspace?.name ?? null,
    activeProjectNotes: activeProject?.notes ?? '',
    notesVisible,
    visitedWorkspaceTerminalTrees,
    activeTerminalId,
    maximizedWorkspaceIds,
    broadcastWorkspaceIds,
    appSettings,
    searchTerminalRequest,
    restartTerminalRequest,
    resizeSplit,
    focusTerminal,
    closeTerminal,
    setConfirmCloseTerminalId,
    toggleBroadcast,
    openEditTerminalDialog,
    handleTerminalInput,
    toggleMaximizedTerminal,
    splitTerminal,
    toggleSidebar: () => setSidebarVisible((visible) => !visible),
    toggleProjectNotes,
    changeProjectNotes,
    toggleDeveloperServices: () => toggleDeveloperServices('close-developer-services-button'),
    developerServicesVisible,
    developerServicesTab,
    setDeveloperServicesTab,
    cleanupKanbanCard,
    startCardWork: startCardWorkFromUi,
    startSuperthreadWork: startKanbanWork,
    setAppSettings,
    contextMenu,
    commandPaletteOpen,
    commandPaletteItems,
    settingsOpen,
    oneTimeCommandOpen,
    setOneTimeCommandOpen,
    addCmdPCommandOpen,
    setAddCmdPCommandOpen,
    editingCmdPCommand,
    setEditingCmdPCommand,
    deletingCmdPCommand,
    setDeletingCmdPCommand,
    addCmdPCommand: (item) => {
      setAppSettings((current) => ({
        ...current,
        custom_cmd_p_commands: [...current.custom_cmd_p_commands, { ...item, id: crypto.randomUUID() }],
      }));
      setAddCmdPCommandOpen(false);
      showToast('Cmd-P command saved');
    },
    editCmdPCommand: (item) => {
      if (!editingCmdPCommand) return;
      setAppSettings((current) => ({
        ...current,
        custom_cmd_p_commands: current.custom_cmd_p_commands.map((command) =>
          command.id === editingCmdPCommand.id ? { ...item, id: command.id } : command),
      }));
      setEditingCmdPCommand(null);
      showToast('Cmd-P command updated');
    },
    deleteCmdPCommand: () => {
      if (!deletingCmdPCommand) return;
      setAppSettings((current) => ({
        ...current,
        custom_cmd_p_commands: current.custom_cmd_p_commands.filter((command) => command.id !== deletingCmdPCommand.id),
      }));
      setDeletingCmdPCommand(null);
      showToast('Cmd-P command deleted');
    },
    addWorkspaceTemplateOpen,
    setAddWorkspaceTemplateOpen,
    editingWorkspaceTemplate,
    setEditingWorkspaceTemplate,
    deletingWorkspaceTemplate,
    setDeletingWorkspaceTemplate,
    addWorkspaceTemplate: (item) => {
      setAppSettings((current) => ({
        ...current,
        workspace_templates: [...current.workspace_templates, { ...item, id: crypto.randomUUID() }],
      }));
      setAddWorkspaceTemplateOpen(false);
      showToast('Workspace template saved');
    },
    editWorkspaceTemplate: (item) => {
      if (!editingWorkspaceTemplate) return;
      setAppSettings((current) => ({
        ...current,
        workspace_templates: current.workspace_templates.map((template) =>
          template.id === editingWorkspaceTemplate.id ? { ...item, id: template.id } : template),
      }));
      setEditingWorkspaceTemplate(null);
      showToast('Workspace template updated');
    },
    deleteWorkspaceTemplate: () => {
      if (!deletingWorkspaceTemplate) return;
      setAppSettings((current) => ({
        ...current,
        workspace_templates: current.workspace_templates.filter((template) => template.id !== deletingWorkspaceTemplate.id),
      }));
      setDeletingWorkspaceTemplate(null);
      showToast('Workspace template deleted');
    },
    deleteMultipleWorkspacesOpen,
    setDeleteMultipleWorkspacesOpen,
    deleteMultipleWorkspaces: (query) => {
      const targets = matchingWorkspaceDeleteTargets(store, query);
      targets.forEach(({ projectId, workspaceId }) => deleteWorkspace(projectId, workspaceId));
      setDeleteMultipleWorkspacesOpen(false);
      showToast(targets.length === 1 ? 'Deleted 1 workspace' : `Deleted ${targets.length} workspaces`);
    },
    runOneTimeCommand: async (command) => {
      try {
        return await runOneTimeCommand(command);
      } catch (error) {
        showToast(`One-time command failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
    dialog,
    confirmCloseTerminalId,
    confirmDeleteProject,
    confirmDeleteWorkspace,
    confirmDeleteWorkspaceEntry,
    confirmQuitOpen,
    toast,
    setDialog,
    setConfirmDeleteProjectId,
    setConfirmDeleteWorkspace,
    setConfirmQuitOpen,
    closeContextMenu,
    closeCommandPalette,
    closeSettings,
    closeDialog,
    submitActiveDialog,
    openEditProjectDialog,
    openEditWorkspaceDialog,
    deleteProject,
    deleteWorkspace,
    restoreActiveTerminalFocus,
  });

  return layoutProps;
}
