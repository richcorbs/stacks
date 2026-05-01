import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { ContextMenu, ConfirmClosePaneDialog, ConfirmDeleteProjectDialog, ConfirmQuitDialog, Dialog } from './components/Dialogs';
import { Sidebar } from './components/Sidebar';
import { MainWorkspace } from './components/MainWorkspace';
import type { AppSettings, ContextMenuState, DialogState, PointerDragState, Store } from './types';
import { collectLeafPaneIds, loadSidebarWidth, normalizeSplitNode } from './utils';
import { useAppStats } from './hooks/useAppStats';
import { useDebouncedStoreSave } from './hooks/useDebouncedSave';
import { usePersistentSidebarWidth } from './hooks/useSettingsPersistence';
import { useGitInfo } from './hooks/useGitInfo';
import { usePaneActivity } from './hooks/usePaneActivity';
import { useWorkspaceState } from './hooks/useWorkspaceState';
import { runShortcutAction, type ShortcutAction, useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { usePaneCwd } from './hooks/usePaneCwd';
import { useSidebarInteractions } from './hooks/useSidebarInteractions';
import { useImageDropToTerminal } from './hooks/useImageDropToTerminal';
import { useWindowStatePersistence } from './hooks/useWindowStatePersistence';
import { useWorkspaceCommands } from './hooks/useWorkspaceCommands';
import { useToast } from './hooks/useToast';

function App() {
  const [loaded, setLoaded] = useState(false);
  const [store, setStore] = useState<Store>({ projects: [] });
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const { state: workspace, actions: workspaceActions } = useWorkspaceState();
  const {
    activeProjectId,
    activeTerminalId,
    panesByTerminalId,
    splitRootsByTerminalId,
    visitedTerminalIds,
    activePaneId,
    focusedPaneByTerminalId,
    maximizedPaneId,
    sidebarFocusedTerminalId,
    paneCwds,
  } = workspace;
  const {
    setActiveProjectId,
    setActiveTerminalId,
    setPanesByTerminalId,
    setSplitRootsByTerminalId,
    setVisitedTerminalIds,
    setActivePaneId,
    setFocusedPaneByTerminalId,
    setMaximizedPaneId,
    setSidebarFocusedTerminalId,
    selectTerminal,
    focusPane: focusPaneState,
    toggleMaximizedPane: toggleMaximizedPaneState,
    removeTerminalState,
    removeProjectState,
    rememberPaneCwd,
  } = workspaceActions;
  const [metaKeyDown, setMetaKeyDown] = useState(false);

  const { runningPaneIds, setRunningPaneIds, activityTerminalIds, setActivityTerminalIds } = usePaneActivity(activeTerminalId);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const pointerDragRef = useRef<PointerDragState | null>(null);
  const resizingSidebarRef = useRef(false);
  const justPointerDraggedRef = useRef(false);
  const [confirmClosePaneId, setConfirmClosePaneId] = useState<string | null>(null);
  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<string | null>(null);
  const [confirmQuitOpen, setConfirmQuitOpen] = useState(false);
  const { toast, showToast } = useToast();

  const activeProject = useMemo(
    () => store.projects.find((p) => p.id === activeProjectId) ?? null,
    [store, activeProjectId]
  );
  const activeTerminal = useMemo(
    () => activeProject?.terminals.find((t) => t.id === activeTerminalId) ?? null,
    [activeProject, activeTerminalId]
  );
  const sidebarTerminals = useMemo(
    () => store.projects.flatMap((project) => project.terminals.map((terminal) => ({ project, terminal }))),
    [store]
  );
  const activePath = (activePaneId && paneCwds[activePaneId]) || activeTerminal?.cwd || activeProject?.path || null;
  const appStats = useAppStats();
  const gitInfo = useGitInfo(activePath);

  useDebouncedStoreSave(loaded, store);
  usePersistentSidebarWidth(loaded, sidebarWidth);
  useWindowStatePersistence();

  useEffect(() => {
    Promise.all([
      invoke<Store>('load_store'),
      invoke<AppSettings>('load_settings').catch(() => null),
    ]).then(([loadedStore, settings]) => {
      setStore(loadedStore);
      if (settings?.sidebar_width) setSidebarWidth(Math.min(420, Math.max(180, settings.sidebar_width)));
      const firstProject = loadedStore.projects[0];
      if (firstProject) selectTerminal(firstProject.id, null);
      else setActiveProjectId(null);
      setLoaded(true);
    }).catch((err) => {
      console.error(err);
      setLoaded(true);
    });
  }, []);


  useEffect(() => {
    const onToast = (event: Event) => {
      showToast((event as CustomEvent<{ message: string }>).detail.message);
    };
    window.addEventListener('app-toast', onToast);
    return () => window.removeEventListener('app-toast', onToast);
  }, [showToast]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    appWindow.onCloseRequested((event) => {
      event.preventDefault();
      invoke('save_current_window_state').catch(console.error);
      setConfirmQuitOpen(true);
    }).then((fn) => { unlisten = fn; }).catch(console.error);
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', close);
    };
  }, []);

  useEffect(() => {
    setSidebarFocusedTerminalId(activeTerminalId);
  }, [activeTerminalId]);

  usePaneCwd(activePaneId, rememberPaneCwd, setStore);
  useImageDropToTerminal(activePaneId);

  const commands = useWorkspaceCommands({
    store,
    setStore,
    dialog,
    setDialog,
    activeTerminal,
    activePaneId,
    maximizedPaneId,
    sidebarFocusedTerminalId,
    activeTerminalId,
    panesByTerminalId,
    sidebarTerminals,
    selectTerminal,
    focusPaneState,
    toggleMaximizedPaneState,
    removeTerminalState,
    removeProjectState,
    setPanesByTerminalId,
    setSplitRootsByTerminalId,
    setActivePaneId,
    setFocusedPaneByTerminalId,
    setMaximizedPaneId,
    setSidebarFocusedTerminalId,
    setRunningPaneIds,
    setActivityTerminalIds,
  });
  const {
    openProjectDialog,
    openTerminalDialog,
    submitDialog,
    toggleProject,
    openEditProjectDialog,
    openEditTerminalDialog,
    focusPane,
    deleteTerminal,
    moveProject,
    moveTerminal,
    deleteProject,
    splitPane,
    cyclePane,
    cycleSidebarTerminal,
    activateSidebarFocusedTerminal,
    activateTerminalByIndex,
    toggleMaximizedPane,
    resizeSplit,
    closePane,
  } = commands;

  useSidebarInteractions({
    resizingSidebarRef,
    pointerDragRef,
    justPointerDraggedRef,
    setSidebarWidth,
    moveProject,
    moveTerminal,
  });

  useEffect(() => {
    if (!activeTerminal) {
      setActivePaneId(null);
      return;
    }

    const paneId = `${activeTerminal.id}:0`;
    const root = normalizeSplitNode(activeTerminal.splits) ?? { kind: 'leaf' as const, paneId };
    const leafIds = collectLeafPaneIds(root);
    const paneIds = leafIds.length > 0 ? leafIds : [paneId];
    setVisitedTerminalIds((ids) => ids.includes(activeTerminal.id) ? ids : [...ids, activeTerminal.id]);
    setPanesByTerminalId((all) => {
      if (all[activeTerminal.id]?.length) return all;
      return { ...all, [activeTerminal.id]: paneIds.map((id) => ({ id, terminalId: activeTerminal.id })) };
    });
    setSplitRootsByTerminalId((all) => {
      if (all[activeTerminal.id]) return all;
      return { ...all, [activeTerminal.id]: root };
    });
    setActivePaneId((id) => {
      if (id?.startsWith(`${activeTerminal.id}:`)) return id;
      const rememberedPaneId = focusedPaneByTerminalId[activeTerminal.id];
      const nextPaneId = rememberedPaneId && paneIds.includes(rememberedPaneId) ? rememberedPaneId : paneIds[0] ?? paneId;
      setFocusedPaneByTerminalId((focused) => focused[activeTerminal.id] === nextPaneId
        ? focused
        : { ...focused, [activeTerminal.id]: nextPaneId });
      return nextPaneId;
    });
  }, [activeTerminal?.id, focusedPaneByTerminalId]);

  const shortcutHandlers = {
    activeProject,
    activePaneId,
    setMetaKeyDown,
    activateTerminalByIndex,
    openTerminalDialog,
    openProjectDialog,
    toggleMaximizedPane,
    activateSidebarFocusedTerminal,
    splitPane,
    requestClosePane: setConfirmClosePaneId,
    requestQuit: () => setConfirmQuitOpen(true),
    cycleSidebarTerminal,
    cyclePane,
  };

  useKeyboardShortcuts(shortcutHandlers);

  useEffect(() => {
    const unlistenPromise = getCurrentWindow().listen<string>('menu-shortcut', (event) => {
      runShortcutAction(event.payload as ShortcutAction, shortcutHandlers);
    });
    return () => { unlistenPromise.then((unlisten) => unlisten()).catch(console.error); };
  }, [shortcutHandlers]);

  const visitedTerminalWorkspaces = visitedTerminalIds.flatMap((terminalId) => {
    for (const project of store.projects) {
      const terminal = project.terminals.find((t) => t.id === terminalId);
      if (terminal) return [{ project, terminal, panes: panesByTerminalId[terminalId] ?? [], root: splitRootsByTerminalId[terminalId] }];
    }
    return [];
  });
  const confirmDeleteProject = confirmDeleteProjectId
    ? store.projects.find((project) => project.id === confirmDeleteProjectId) ?? null
    : null;

  return (
    <div className="app">
      <Sidebar
        width={sidebarWidth}
        store={store}
        activeProjectId={activeProjectId}
        activeTerminalId={activeTerminalId}
        sidebarFocusedTerminalId={sidebarFocusedTerminalId}
        sidebarTerminals={sidebarTerminals}
        runningPaneIds={runningPaneIds}
        activityTerminalIds={activityTerminalIds}
        metaKeyDown={metaKeyDown}
        appStats={appStats}
        justPointerDraggedRef={justPointerDraggedRef}
        pointerDragRef={pointerDragRef}
        resizingSidebarRef={resizingSidebarRef}
        toggleProject={toggleProject}
        selectTerminal={selectTerminal}
        setContextMenu={setContextMenu}
      />
      <MainWorkspace
        activePath={activePath}
        gitInfo={gitInfo}
        workspaces={visitedTerminalWorkspaces}
        activeTerminalId={activeTerminalId}
        activePaneId={activePaneId}
        maximizedPaneId={maximizedPaneId}
        hasActivePane={Boolean(activeTerminalId && activePaneId)}
        onResizeSplit={resizeSplit}
        onFocusPane={(projectId, terminalId, paneId) => {
          selectTerminal(projectId, terminalId);
          focusPane(terminalId, paneId);
        }}
        onClosePane={closePane}
        onSplitPane={splitPane}
      />
      {contextMenu && (
        <ContextMenu
          menu={contextMenu}
          store={store}
          onClose={() => setContextMenu(null)}
          onNewTerminal={(project) => { setContextMenu(null); openTerminalDialog(project); }}
          onEditProject={(project) => { setContextMenu(null); openEditProjectDialog(project); }}
          onDeleteProject={(project) => { setContextMenu(null); setConfirmDeleteProjectId(project.id); }}
          onEditTerminal={(project, terminal) => { setContextMenu(null); openEditTerminalDialog(project, terminal); }}
          onDeleteTerminal={(project, terminal) => { setContextMenu(null); deleteTerminal(project.id, terminal.id); }}
        />
      )}
      {dialog && <Dialog dialog={dialog} setDialog={setDialog} onCancel={() => setDialog(null)} onSubmit={submitDialog} />}
      {confirmClosePaneId && (
        <ConfirmClosePaneDialog
          onCancel={() => setConfirmClosePaneId(null)}
          onConfirm={() => {
            const paneId = confirmClosePaneId;
            setConfirmClosePaneId(null);
            closePane(paneId);
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
      {confirmDeleteProject && (
        <ConfirmDeleteProjectDialog
          projectName={confirmDeleteProject.name}
          onCancel={() => setConfirmDeleteProjectId(null)}
          onConfirm={() => {
            const projectId = confirmDeleteProject.id;
            setConfirmDeleteProjectId(null);
            deleteProject(projectId);
          }}
        />
      )}
      {confirmQuitOpen && (
        <ConfirmQuitDialog
          onCancel={() => setConfirmQuitOpen(false)}
          onConfirm={() => {
            setConfirmQuitOpen(false);
            invoke('save_current_window_state')
              .catch(console.error)
              .finally(() => invoke('quit_app').catch(console.error));
          }}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
