import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

type Store = { projects: Project[] };
type Project = { id: string; name: string; path: string; terminals: TerminalEntry[]; collapsed?: boolean };
type TerminalEntry = { id: string; name: string; command?: string | null; cwd?: string | null; splits?: SplitNode | null };
type Pane = { id: string; terminalId: string };
type SplitNode =
  | { kind: 'empty' }
  | { kind: 'leaf'; paneId: string }
  | { kind: 'split'; direction: 'row' | 'column'; ratio?: number; first: SplitNode; second: SplitNode };
type PtyData = { pane_id: string; generation: string; data: number[] };
type PtyExit = { pane_id: string; generation: string };
type GitInfo = { branch: string; added: number; removed: number };
type AppStats = { cpu: number; mem_mb: number; version: string };

type TermSize = { cols: number; rows: number };
type PaneSession = {
  term: Terminal;
  fit: FitAddon;
  spawned: boolean;
  running: boolean;
  lastPtySize: TermSize | null;
  dataDisposable: { dispose: () => void };
  resizeObserver?: ResizeObserver;
  unlistenData?: () => void;
  unlistenExit?: () => void;
};

const paneSessions = new Map<string, PaneSession>();
type DialogState =
  | { kind: 'project'; path: string }
  | { kind: 'terminal'; projectId: string; name: string; command: string }
  | { kind: 'editProject'; projectId: string; name: string; path: string }
  | { kind: 'editTerminal'; projectId: string; terminalId: string; name: string; command: string };
type ContextMenuState =
  | { kind: 'project'; projectId: string; x: number; y: number }
  | { kind: 'terminal'; projectId: string; terminalId: string; x: number; y: number };
type DragState =
  | { kind: 'project'; projectId: string }
  | { kind: 'terminal'; projectId: string; terminalId: string };
type PointerDragState = DragState & { startX: number; startY: number; dragging: boolean };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function basename(path: string) {
  return path.replace(/\/$/, '').split('/').pop() || path;
}

function loadSidebarWidth() {
  const raw = window.localStorage.getItem('stacks.sidebarWidth');
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? Math.min(420, Math.max(180, parsed)) : 260;
}

function collectLeafPaneIds(node: SplitNode | null | undefined): string[] {
  if (!node || node.kind === 'empty') return [];
  if (node.kind === 'leaf') return [node.paneId];
  return [...collectLeafPaneIds(node.first), ...collectLeafPaneIds(node.second)];
}

function normalizeSplitNode(node: SplitNode | null | undefined): SplitNode | null {
  if (!node || node.kind === 'empty') return null;
  if (node.kind === 'leaf') return node;
  const first = normalizeSplitNode(node.first);
  const second = normalizeSplitNode(node.second);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function disposePaneSession(paneId: string) {
  const session = paneSessions.get(paneId);
  if (!session) return;
  window.dispatchEvent(new CustomEvent('pane-running-changed', { detail: { paneId, running: false } }));
  session.resizeObserver?.disconnect();
  session.dataDisposable.dispose();
  session.unlistenData?.();
  session.unlistenExit?.();
  session.term.dispose();
  paneSessions.delete(paneId);
}

function safeTermSize(term: Terminal): TermSize {
  // Keep the PTY a couple columns narrower than xterm's measured grid.
  // WebKit/xterm fit can be off by ~1px/1col with scrollbars and fractional
  // sizing; apps that redraw by writing spaces to EOL (like pi) visibly wrap
  // those clearing spaces if the PTY is wider than the rendered grid.
  return {
    cols: Math.max(2, (term.cols || 80) - 2),
    rows: Math.max(2, term.rows || 24),
  };
}

function App() {
  const [loaded, setLoaded] = useState(false);
  const [store, setStore] = useState<Store>({ projects: [] });
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [panesByTerminalId, setPanesByTerminalId] = useState<Record<string, Pane[]>>({});
  const [splitRootsByTerminalId, setSplitRootsByTerminalId] = useState<Record<string, SplitNode>>({});
  const [visitedTerminalIds, setVisitedTerminalIds] = useState<string[]>([]);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [focusedPaneByTerminalId, setFocusedPaneByTerminalId] = useState<Record<string, string>>({});
  const [maximizedPaneId, setMaximizedPaneId] = useState<string | null>(null);
  const [sidebarFocusedTerminalId, setSidebarFocusedTerminalId] = useState<string | null>(null);
  const [metaKeyDown, setMetaKeyDown] = useState(false);
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [appStats, setAppStats] = useState<AppStats | null>(null);
  const [runningPaneIds, setRunningPaneIds] = useState<string[]>([]);
  const [activityTerminalIds, setActivityTerminalIds] = useState<string[]>([]);
  const activeTerminalIdRef = useRef<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const pointerDragRef = useRef<PointerDragState | null>(null);
  const resizingSidebarRef = useRef(false);
  const justPointerDraggedRef = useRef(false);
  const [confirmClosePaneId, setConfirmClosePaneId] = useState<string | null>(null);

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

  useEffect(() => {
    invoke<Store>('load_store').then((loadedStore) => {
      setStore(loadedStore);
      const firstProject = loadedStore.projects[0];
      const firstTerminalId = firstProject?.terminals[0]?.id ?? null;
      setActiveProjectId(firstProject?.id ?? null);
      setActiveTerminalId(null);
      setSidebarFocusedTerminalId(firstTerminalId);
      setLoaded(true);
    }).catch((err) => {
      console.error(err);
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!loaded) return;
    invoke('save_store', { store }).catch(console.error);
  }, [loaded, store]);

  useEffect(() => {
    window.localStorage.setItem('stacks.sidebarWidth', String(sidebarWidth));
  }, [sidebarWidth]);

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
    const onPointerMove = (event: PointerEvent) => {
      if (resizingSidebarRef.current) {
        event.preventDefault();
        setSidebarWidth(Math.min(420, Math.max(180, event.clientX)));
        return;
      }

      const drag = pointerDragRef.current;
      if (!drag) return;
      event.preventDefault();
      if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) {
        drag.dragging = true;
        setDragState(drag.kind === 'project'
          ? { kind: 'project', projectId: drag.projectId }
          : { kind: 'terminal', projectId: drag.projectId, terminalId: drag.terminalId });
      }
      if (!drag.dragging) return;

      const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      if (drag.kind === 'project') {
        const projectEl = target?.closest<HTMLElement>('[data-project-row-id]');
        const targetProjectId = projectEl?.dataset.projectRowId;
        if (targetProjectId && targetProjectId !== drag.projectId) moveProject(drag.projectId, targetProjectId);
      } else {
        const termEl = target?.closest<HTMLElement>('[data-terminal-id][data-project-id]');
        const targetProjectId = termEl?.dataset.projectId;
        const targetTerminalId = termEl?.dataset.terminalId;
        if (targetProjectId === drag.projectId && targetTerminalId && targetTerminalId !== drag.terminalId) {
          moveTerminal(drag.projectId, drag.terminalId, targetTerminalId);
        }
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      if (resizingSidebarRef.current) {
        resizingSidebarRef.current = false;
        document.body.classList.remove('resizingSidebar');
        return;
      }

      const drag = pointerDragRef.current;
      pointerDragRef.current = null;
      setDragState(null);
      if (!drag?.dragging) return;

      justPointerDraggedRef.current = true;
      window.setTimeout(() => { justPointerDraggedRef.current = false; }, 0);

      // Reordering happens during pointermove so the list tracks the cursor.
      // pointerup just ends the drag and suppresses the click that follows.
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  });

  useEffect(() => {
    activeTerminalIdRef.current = activeTerminalId;
    setSidebarFocusedTerminalId(activeTerminalId);
    if (activeTerminalId) {
      setActivityTerminalIds((ids) => ids.filter((id) => id !== activeTerminalId));
    }
  }, [activeTerminalId]);

  useEffect(() => {
    let cancelled = false;
    const refreshStats = () => {
      invoke<AppStats>('app_stats')
        .then((stats) => { if (!cancelled) setAppStats(stats); })
        .catch(() => { if (!cancelled) setAppStats(null); });
    };
    refreshStats();
    const interval = window.setInterval(refreshStats, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const onRunningChanged = (event: Event) => {
      const { paneId, running } = (event as CustomEvent<{ paneId: string; running: boolean }>).detail;
      setRunningPaneIds((ids) => {
        const has = ids.includes(paneId);
        if (running && !has) return [...ids, paneId];
        if (!running && has) return ids.filter((id) => id !== paneId);
        return ids;
      });
    };
    const onPaneOutput = (event: Event) => {
      const { terminalId } = (event as CustomEvent<{ terminalId: string; paneId: string }>).detail;
      if (terminalId === activeTerminalIdRef.current) return;
      setActivityTerminalIds((ids) => ids.includes(terminalId) ? ids : [...ids, terminalId]);
    };
    window.addEventListener('pane-running-changed', onRunningChanged);
    window.addEventListener('pane-output', onPaneOutput);
    return () => {
      window.removeEventListener('pane-running-changed', onRunningChanged);
      window.removeEventListener('pane-output', onPaneOutput);
    };
  }, []);

  useEffect(() => {
    const path = activeTerminal?.cwd || activeProject?.path;
    if (!path) {
      setGitInfo(null);
      return;
    }

    let cancelled = false;
    const refreshGitInfo = () => {
      invoke<GitInfo | null>('git_info', { path })
        .then((info) => { if (!cancelled) setGitInfo(info); })
        .catch(() => { if (!cancelled) setGitInfo(null); });
    };

    refreshGitInfo();
    const interval = window.setInterval(refreshGitInfo, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeProject?.path, activeTerminal?.cwd, activeTerminal?.id]);

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
      return rememberedPaneId && paneIds.includes(rememberedPaneId) ? rememberedPaneId : paneId;
    });
  }, [activeTerminal?.id, focusedPaneByTerminalId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      setMetaKeyDown(event.metaKey);
      if (!event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (/^[1-9]$/.test(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        activateTerminalByIndex(Number(event.key) - 1);
        return;
      }
      if (key === 't') {
        event.preventDefault();
        event.stopPropagation();
        if (activeProject) openTerminalDialog(activeProject);
        else openProjectDialog();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) toggleMaximizedPane();
        else activateSidebarFocusedTerminal();
      } else if (key === 'd') {
        event.preventDefault();
        event.stopPropagation();
        splitPane(event.shiftKey ? 'column' : 'row');
      } else if (key === 'w') {
        event.preventDefault();
        event.stopPropagation();
        if (activePaneId) setConfirmClosePaneId(activePaneId);
      } else if (event.key === ']') {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) cycleSidebarTerminal(1);
        else cyclePane(1);
      } else if (event.key === '[') {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) cycleSidebarTerminal(-1);
        else cyclePane(-1);
      } else if (key === 'o') {
        event.preventDefault();
        event.stopPropagation();
        openProjectDialog();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Meta') setMetaKeyDown(false);
    };
    const onBlur = () => setMetaKeyDown(false);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [activeProject, activeTerminal, activePaneId, maximizedPaneId, panesByTerminalId, sidebarTerminals, sidebarFocusedTerminalId]);

  async function openProjectDialog() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Add Project',
    }).catch((err) => {
      console.error(err);
      return null;
    });
    if (typeof selected !== 'string') return;
    await addProjectFromPath(selected);
  }

  async function addProjectFromPath(path: string) {
    const existing = store.projects.find((p) => p.path === path);
    if (existing) {
      const terminalId = existing.terminals[0]?.id ?? null;
      setActiveProjectId(existing.id);
      setActiveTerminalId(terminalId);
      setSidebarFocusedTerminalId(terminalId);
      return;
    }
    const id = await invoke<string>('new_id');
    const project: Project = { id, name: basename(path), path, terminals: [], collapsed: false };
    setStore((s) => ({ projects: [...s.projects, project] }));
    setActiveProjectId(id);
    setActiveTerminalId(null);
    setSidebarFocusedTerminalId(null);
  }

  function openTerminalDialog(project: Project) {
    setDialog({ kind: 'terminal', projectId: project.id, name: `Terminal ${project.terminals.length + 1}`, command: '' });
  }

  async function submitDialog() {
    if (!dialog) return;

    if (dialog.kind === 'project') {
      const path = dialog.path.trim();
      if (!path) return;
      await addProjectFromPath(path);
      setDialog(null);
      return;
    }

    if (dialog.kind === 'editProject') {
      const name = dialog.name.trim();
      const path = dialog.path.trim();
      if (!name || !path) return;
      setStore((s) => ({
        projects: s.projects.map((p) => p.id === dialog.projectId ? { ...p, name, path } : p),
      }));
      setDialog(null);
      return;
    }

    if (dialog.kind === 'editTerminal') {
      const name = dialog.name.trim();
      if (!name) return;
      setStore((s) => ({
        projects: s.projects.map((p) => p.id === dialog.projectId ? {
          ...p,
          terminals: p.terminals.map((t) => t.id === dialog.terminalId ? { ...t, name, command: dialog.command.trim() || null } : t),
        } : p),
      }));
      setDialog(null);
      return;
    }

    const project = store.projects.find((p) => p.id === dialog.projectId);
    if (!project) return;
    const name = dialog.name.trim();
    if (!name) return;
    const id = await invoke<string>('new_id');
    const terminal: TerminalEntry = {
      id,
      name,
      command: dialog.command.trim() || null,
      cwd: project.path,
    };
    setStore((s) => ({
      projects: s.projects.map((p) => p.id === project.id ? { ...p, collapsed: false, terminals: [...p.terminals, terminal] } : p),
    }));
    setActiveProjectId(project.id);
    setActiveTerminalId(id);
    setSidebarFocusedTerminalId(id);
    setDialog(null);
  }

  function toggleProject(projectId: string) {
    setStore((s) => ({
      projects: s.projects.map((p) => p.id === projectId ? { ...p, collapsed: !p.collapsed } : p),
    }));
  }

  function openEditProjectDialog(project: Project) {
    setDialog({ kind: 'editProject', projectId: project.id, name: project.name, path: project.path });
  }

  function openEditTerminalDialog(project: Project, terminal: TerminalEntry) {
    setDialog({ kind: 'editTerminal', projectId: project.id, terminalId: terminal.id, name: terminal.name, command: terminal.command ?? '' });
  }

  function saveTerminalSplit(terminalId: string, root: SplitNode | null) {
    const normalizedRoot = normalizeSplitNode(root);
    setStore((s) => ({
      projects: s.projects.map((p) => ({
        ...p,
        terminals: p.terminals.map((t) => t.id === terminalId ? { ...t, splits: normalizedRoot } : t),
      })),
    }));
  }

  function focusPane(terminalId: string, paneId: string) {
    setActivePaneId(paneId);
    setFocusedPaneByTerminalId((all) => ({ ...all, [terminalId]: paneId }));
  }

  function deleteTerminal(projectId: string, terminalId: string) {
    (panesByTerminalId[terminalId] ?? []).forEach((pane) => {
      disposePaneSession(pane.id);
      invoke('kill_pty', { paneId: pane.id }).catch(() => {});
    });
    setStore((s) => ({
      projects: s.projects.map((p) => p.id === projectId ? { ...p, terminals: p.terminals.filter((t) => t.id !== terminalId) } : p),
    }));
    setPanesByTerminalId((all) => {
      const { [terminalId]: _removed, ...rest } = all;
      return rest;
    });
    setSplitRootsByTerminalId((all) => {
      const { [terminalId]: _removed, ...rest } = all;
      return rest;
    });
    setVisitedTerminalIds((ids) => ids.filter((id) => id !== terminalId));
    setRunningPaneIds((ids) => ids.filter((id) => !id.startsWith(`${terminalId}:`)));
    setActivityTerminalIds((ids) => ids.filter((id) => id !== terminalId));
    setFocusedPaneByTerminalId((all) => {
      const { [terminalId]: _removed, ...rest } = all;
      return rest;
    });
    if (activeTerminalId === terminalId) setActiveTerminalId(null);
    if (sidebarFocusedTerminalId === terminalId) setSidebarFocusedTerminalId(null);
  }

  function moveProject(draggedProjectId: string, targetProjectId: string) {
    if (draggedProjectId === targetProjectId) return;
    setStore((s) => {
      const projects = [...s.projects];
      const from = projects.findIndex((p) => p.id === draggedProjectId);
      const to = projects.findIndex((p) => p.id === targetProjectId);
      if (from < 0 || to < 0) return s;
      const [item] = projects.splice(from, 1);
      projects.splice(to, 0, item);
      return { projects };
    });
  }

  function moveTerminal(projectId: string, draggedTerminalId: string, targetTerminalId: string) {
    if (draggedTerminalId === targetTerminalId) return;
    setStore((s) => ({
      projects: s.projects.map((p) => {
        if (p.id !== projectId) return p;
        const terminals = [...p.terminals];
        const from = terminals.findIndex((t) => t.id === draggedTerminalId);
        const to = terminals.findIndex((t) => t.id === targetTerminalId);
        if (from < 0 || to < 0) return p;
        const [item] = terminals.splice(from, 1);
        terminals.splice(to, 0, item);
        return { ...p, terminals };
      }),
    }));
  }

  function deleteProject(projectId: string) {
    const project = store.projects.find((p) => p.id === projectId);
    if (!project) return;
    const terminalIds = project.terminals.map((terminal) => terminal.id);
    terminalIds.forEach((terminalId) => {
      (panesByTerminalId[terminalId] ?? []).forEach((pane) => {
        disposePaneSession(pane.id);
        invoke('kill_pty', { paneId: pane.id }).catch(() => {});
      });
    });
    setStore((s) => ({ projects: s.projects.filter((p) => p.id !== projectId) }));
    setPanesByTerminalId((all) => {
      const next = { ...all };
      terminalIds.forEach((id) => delete next[id]);
      return next;
    });
    setSplitRootsByTerminalId((all) => {
      const next = { ...all };
      terminalIds.forEach((id) => delete next[id]);
      return next;
    });
    setVisitedTerminalIds((ids) => ids.filter((id) => !terminalIds.includes(id)));
    setFocusedPaneByTerminalId((all) => {
      const next = { ...all };
      terminalIds.forEach((id) => delete next[id]);
      return next;
    });
    setRunningPaneIds((ids) => ids.filter((id) => !terminalIds.some((terminalId) => id.startsWith(`${terminalId}:`))));
    setActivityTerminalIds((ids) => ids.filter((id) => !terminalIds.includes(id)));
    if (activeProjectId === projectId) {
      setActiveProjectId(null);
      setActiveTerminalId(null);
      setSidebarFocusedTerminalId(null);
    }
  }

  async function splitPane(direction: 'row' | 'column' = 'row') {
    if (!activeTerminal) return;
    const focusedPaneId = activePaneId?.startsWith(`${activeTerminal.id}:`) ? activePaneId : `${activeTerminal.id}:0`;
    const id = `${activeTerminal.id}:${Date.now()}`;
    setPanesByTerminalId((all) => ({
      ...all,
      [activeTerminal.id]: [...(all[activeTerminal.id] ?? []), { id, terminalId: activeTerminal.id }],
    }));
    setSplitRootsByTerminalId((all) => {
      const root = all[activeTerminal.id] ?? { kind: 'leaf' as const, paneId: focusedPaneId };
      const nextRoot = splitLeaf(root, focusedPaneId, id, direction);
      saveTerminalSplit(activeTerminal.id, nextRoot);
      return { ...all, [activeTerminal.id]: nextRoot };
    });
    focusPane(activeTerminal.id, id);
  }

  function cyclePane(delta: number) {
    if (!activeTerminal) return;
    const panes = panesByTerminalId[activeTerminal.id] ?? [];
    if (panes.length === 0) return;
    const currentPaneId = maximizedPaneId ?? activePaneId;
    const currentIndex = Math.max(0, panes.findIndex((p) => p.id === currentPaneId));
    const nextIndex = (currentIndex + delta + panes.length) % panes.length;
    const nextPaneId = panes[nextIndex].id;
    focusPane(activeTerminal.id, nextPaneId);
    if (maximizedPaneId) setMaximizedPaneId(nextPaneId);
  }

  function cycleSidebarTerminal(delta: number) {
    if (sidebarTerminals.length === 0) return;
    const currentId = sidebarFocusedTerminalId ?? activeTerminalId;
    const currentIndex = Math.max(0, sidebarTerminals.findIndex(({ terminal }) => terminal.id === currentId));
    const nextIndex = (currentIndex + delta + sidebarTerminals.length) % sidebarTerminals.length;
    setSidebarFocusedTerminalId(sidebarTerminals[nextIndex].terminal.id);
  }

  function activateSidebarFocusedTerminal() {
    if (!sidebarFocusedTerminalId) return;
    const match = sidebarTerminals.find(({ terminal }) => terminal.id === sidebarFocusedTerminalId);
    if (!match) return;
    setActiveProjectId(match.project.id);
    setActiveTerminalId(match.terminal.id);
  }

  function activateTerminalByIndex(index: number) {
    const match = sidebarTerminals[index];
    if (!match) return;
    setActiveProjectId(match.project.id);
    setActiveTerminalId(match.terminal.id);
    setSidebarFocusedTerminalId(match.terminal.id);
  }

  function toggleMaximizedPane() {
    if (!activePaneId) return;
    setMaximizedPaneId((id) => id === activePaneId ? null : activePaneId);
  }

  function resizeSplit(terminalId: string, path: string, ratio: number) {
    setSplitRootsByTerminalId((all) => {
      const root = all[terminalId];
      if (!root) return all;
      const nextRoot = setSplitRatio(root, path, ratio);
      saveTerminalSplit(terminalId, nextRoot);
      return { ...all, [terminalId]: nextRoot };
    });
  }

  async function closePane(paneId: string) {
    disposePaneSession(paneId);
    await invoke('kill_pty', { paneId }).catch(() => {});
    const terminalId = paneId.split(':')[0];
    const remainingPaneCount = (panesByTerminalId[terminalId] ?? []).filter((p) => p.id !== paneId).length;
    if (maximizedPaneId === paneId) setMaximizedPaneId(null);
    setPanesByTerminalId((all) => {
      const nextPanes = (all[terminalId] ?? []).filter((p) => p.id !== paneId);
      if (activePaneId === paneId) {
        const nextPaneId = nextPanes[0]?.id ?? null;
        setActivePaneId(nextPaneId);
        setFocusedPaneByTerminalId((focused) => nextPaneId ? { ...focused, [terminalId]: nextPaneId } : focused);
      }
      return { ...all, [terminalId]: nextPanes };
    });
    setSplitRootsByTerminalId((all) => {
      const root = all[terminalId];
      if (!root) return all;
      if (remainingPaneCount === 0) {
        saveTerminalSplit(terminalId, null);
        const { [terminalId]: _removed, ...rest } = all;
        return rest;
      }
      const nextRoot = removeLeaf(root, paneId);
      saveTerminalSplit(terminalId, nextRoot);
      return nextRoot ? { ...all, [terminalId]: nextRoot } : all;
    });
  }

  const visitedTerminalWorkspaces = visitedTerminalIds.flatMap((terminalId) => {
    for (const project of store.projects) {
      const terminal = project.terminals.find((t) => t.id === terminalId);
      if (terminal) return [{ project, terminal, panes: panesByTerminalId[terminalId] ?? [], root: splitRootsByTerminalId[terminalId] }];
    }
    return [];
  });

  return (
    <div className="app">
      <aside className="sidebar" style={{ width: sidebarWidth }}>
        <div className="projectList">
          {store.projects.map((project) => (
            <div
              className={`projectBlock ${activeProjectId === project.id ? 'activeProject' : ''}`}
              key={project.id}
              data-project-row-id={project.id}
            >
              <button
                className="project"
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  pointerDragRef.current = { kind: 'project', projectId: project.id, startX: e.clientX, startY: e.clientY, dragging: false };
                }}
                onClick={(e) => {
                  if (justPointerDraggedRef.current) e.preventDefault();
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ kind: 'project', projectId: project.id, x: e.clientX, y: e.clientY });
                }}
              >
                <strong>{project.name}</strong>
              </button>
              {!project.collapsed && (
                <div className="termList">
                  {project.terminals.map((term) => {
                    const isRunning = runningPaneIds.some((paneId) => paneId.startsWith(`${term.id}:`));
                    const hasBackgroundActivity = term.id !== activeTerminalId && activityTerminalIds.includes(term.id);
                    const shortcutIndex = sidebarTerminals.findIndex(({ terminal }) => terminal.id === term.id);
                    return (
                      <button
                        className={`term ${activeTerminalId === term.id ? 'active' : ''} ${sidebarFocusedTerminalId === term.id ? 'focused' : ''}`}
                        key={term.id}
                        data-project-id={project.id}
                        data-terminal-id={term.id}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          e.currentTarget.setPointerCapture(e.pointerId);
                          pointerDragRef.current = { kind: 'terminal', projectId: project.id, terminalId: term.id, startX: e.clientX, startY: e.clientY, dragging: false };
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setContextMenu({ kind: 'terminal', projectId: project.id, terminalId: term.id, x: e.clientX, y: e.clientY });
                        }}
                        onClick={(e) => {
                          if (justPointerDraggedRef.current) {
                            e.preventDefault();
                            return;
                          }
                          setActiveProjectId(project.id);
                          setActiveTerminalId(term.id);
                          setSidebarFocusedTerminalId(term.id);
                        }}
                      >
                        <span className="termLabel">
                          <span className="activitySlot">
                            {hasBackgroundActivity && <span className="dot activityDot" title="Background output" />}
                          </span>
                          <span className="termName">{term.name}</span>
                        </span>
                        <span className="termIndicators">
                          {metaKeyDown && shortcutIndex >= 0 && shortcutIndex < 9 && <span className="shortcutHint">⌘{shortcutIndex + 1}</span>}
                          {isRunning && <span className="dot" title="Active terminal running" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="sidebarFooter">
          {appStats ? (
            <>CPU {Math.round(appStats.cpu)}% <span>•</span> MEM {appStats.mem_mb}MB <span>•</span> v{appStats.version}</>
          ) : (
            <>CPU --% <span>•</span> MEM --MB <span>•</span> v--</>
          )}
        </div>
        <div
          className="sidebarResizeHandle"
          onPointerDown={(e) => {
            e.preventDefault();
            resizingSidebarRef.current = true;
            document.body.classList.add('resizingSidebar');
          }}
        />
      </aside>
      <main className="main">
        <header className="topbar">
          <div>
            <div className="subtitle">{activeTerminal?.cwd || activeProject?.path || 'Add a project to get started'}</div>
          </div>
          <div className="branchDisplay">
            {gitInfo && (
              <>
                <span className="branchName"> {gitInfo.branch}</span>
                {(gitInfo.added > 0 || gitInfo.removed > 0) && (
                  <span className="gitStats">
                    <span className="gitSeparator">•</span>
                    {gitInfo.added > 0 && <span className="gitAdded">+{gitInfo.added}</span>}
                    {gitInfo.removed > 0 && <span className="gitRemoved">-{gitInfo.removed}</span>}
                  </span>
                )}
              </>
            )}
          </div>
        </header>
        <section className="workspace">
          {visitedTerminalWorkspaces.length > 0 ? (
            visitedTerminalWorkspaces.map(({ project, terminal, panes, root }) => {
              const visible = terminal.id === activeTerminalId;
              const panesById = Object.fromEntries(panes.map((pane) => [pane.id, pane]));
              return (
                <div
                  key={terminal.id}
                  className={`terminalWorkspace ${visible ? 'visible' : ''}`}
                  aria-hidden={!visible}
                >
                  {root && (
                    <SplitView
                      node={root}
                      panesById={panesById}
                      terminal={terminal}
                      project={project}
                      visible={visible}
                      activePaneId={activePaneId}
                      maximizedPaneId={visible ? maximizedPaneId : null}
                      path=""
                      onResizeSplit={(path, ratio) => resizeSplit(terminal.id, path, ratio)}
                      onFocus={(paneId) => { setActiveProjectId(project.id); setActiveTerminalId(terminal.id); focusPane(terminal.id, paneId); }}
                      onClose={closePane}
                    />
                  )}
                </div>
              );
            })
          ) : (
            <div className="empty">Create or select a terminal. Shortcuts: ⌘O project, ⌘T terminal, ⌘D split.</div>
          )}
        </section>
      </main>
      {contextMenu && (
        <ContextMenu
          menu={contextMenu}
          store={store}
          onClose={() => setContextMenu(null)}
          onEditProject={(project) => { setContextMenu(null); openEditProjectDialog(project); }}
          onDeleteProject={(project) => { setContextMenu(null); deleteProject(project.id); }}
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
    </div>
  );
}

function parseDragData(value: string): DragState | null {
  const parts = value.split(':');
  if (parts[0] === 'project' && parts[1]) return { kind: 'project', projectId: parts[1] };
  if (parts[0] === 'terminal' && parts[1] && parts[2]) return { kind: 'terminal', projectId: parts[1], terminalId: parts[2] };
  return null;
}

function splitLeaf(node: SplitNode, targetPaneId: string, newPaneId: string, direction: 'row' | 'column'): SplitNode {
  if (node.kind === 'empty') return node;
  if (node.kind === 'leaf') {
    if (node.paneId !== targetPaneId) return node;
    return {
      kind: 'split',
      direction,
      ratio: 0.5,
      first: node,
      second: { kind: 'leaf', paneId: newPaneId },
    };
  }
  return {
    ...node,
    first: splitLeaf(node.first, targetPaneId, newPaneId, direction),
    second: splitLeaf(node.second, targetPaneId, newPaneId, direction),
  };
}

function setSplitRatio(node: SplitNode, path: string, ratio: number): SplitNode {
  if (node.kind !== 'split') return node;
  if (path === '') return { ...node, ratio: Math.min(0.9, Math.max(0.1, ratio)) };
  const [head, ...rest] = path.split('.');
  const childPath = rest.join('.');
  return {
    ...node,
    first: head === 'first' ? setSplitRatio(node.first, childPath, ratio) : node.first,
    second: head === 'second' ? setSplitRatio(node.second, childPath, ratio) : node.second,
  };
}

function removeLeaf(node: SplitNode, paneId: string): SplitNode | null {
  if (node.kind === 'empty') return node;
  if (node.kind === 'leaf') return node.paneId === paneId ? null : node;
  const first = removeLeaf(node.first, paneId);
  const second = removeLeaf(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function ContextMenu({ menu, store, onClose, onEditProject, onDeleteProject, onEditTerminal, onDeleteTerminal }: {
  menu: ContextMenuState;
  store: Store;
  onClose: () => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
  onEditTerminal: (project: Project, terminal: TerminalEntry) => void;
  onDeleteTerminal: (project: Project, terminal: TerminalEntry) => void;
}) {
  const project = store.projects.find((p) => p.id === menu.projectId);
  if (!project) return null;
  const terminal = menu.kind === 'terminal' ? project.terminals.find((t) => t.id === menu.terminalId) : null;

  return (
    <div
      className="contextMenu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button onClick={() => menu.kind === 'project' ? onEditProject(project) : terminal && onEditTerminal(project, terminal)}>Edit</button>
      <button className="dangerItem" onClick={() => menu.kind === 'project' ? onDeleteProject(project) : terminal && onDeleteTerminal(project, terminal)}>Delete</button>
    </div>
  );
}

function ConfirmClosePaneDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const yesRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    requestAnimationFrame(() => yesRef.current?.focus());
  }, []);

  return (
    <div className="modalBackdrop" onMouseDown={onCancel}>
      <form
        className="modal confirmModal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); onConfirm(); }}
      >
        <h2>Close pane?</h2>
        <p>This will terminate the process running in this pane.</p>
        <div className="modalActions">
          <button type="button" onClick={onCancel}>No</button>
          <button ref={yesRef} className="primaryAction" type="submit">Yes</button>
        </div>
      </form>
    </div>
  );
}

function Dialog({ dialog, setDialog, onCancel, onSubmit }: {
  dialog: DialogState;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const firstInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    requestAnimationFrame(() => firstInputRef.current?.focus());
  }, []);

  return (
    <div className="modalBackdrop" onMouseDown={onCancel}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
      >
        {dialog.kind === 'project' ? (
          <>
            <h2>Add Project</h2>
            <label>
              Project path
              <input
                ref={firstInputRef}
                value={dialog.path}
                placeholder="/Users/rich/Code/my-project"
                onChange={(e) => setDialog({ ...dialog, path: e.target.value })}
              />
            </label>
          </>
        ) : dialog.kind === 'editProject' ? (
          <>
            <h2>Edit Project</h2>
            <label>
              Name
              <input
                ref={firstInputRef}
                value={dialog.name}
                onChange={(e) => setDialog({ ...dialog, name: e.target.value })}
              />
            </label>
            <label>
              Directory
              <input
                value={dialog.path}
                placeholder="/Users/rich/Code/my-project"
                onChange={(e) => setDialog({ ...dialog, path: e.target.value })}
              />
            </label>
          </>
        ) : (
          <>
            <h2>{dialog.kind === 'editTerminal' ? 'Edit Terminal' : 'New Terminal'}</h2>
            <label>
              Name
              <input
                ref={firstInputRef}
                value={dialog.name}
                onChange={(e) => setDialog({ ...dialog, name: e.target.value })}
              />
            </label>
            <label>
              Startup command <span>(optional)</span>
              <input
                value={dialog.command}
                placeholder="pi, claude, npm run dev, ..."
                onChange={(e) => setDialog({ ...dialog, command: e.target.value })}
              />
            </label>
          </>
        )}
        <div className="modalActions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="primaryAction" type="submit">{dialog.kind === 'project' || dialog.kind === 'terminal' ? 'Create' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}

function SplitView({ node, panesById, terminal, project, visible, activePaneId, maximizedPaneId, path, onResizeSplit, onFocus, onClose }: {
  node: SplitNode;
  panesById: Record<string, Pane>;
  terminal: TerminalEntry;
  project: Project;
  visible: boolean;
  activePaneId: string | null;
  maximizedPaneId: string | null;
  path: string;
  onResizeSplit: (path: string, ratio: number) => void;
  onFocus: (paneId: string) => void;
  onClose: (paneId: string) => void;
}) {
  if (maximizedPaneId) {
    const pane = panesById[maximizedPaneId];
    if (!pane) return null;
    return (
      <TerminalPane
        pane={pane}
        terminal={terminal}
        project={project}
        active={visible && activePaneId === pane.id}
        maximized={true}
        onFocus={() => onFocus(pane.id)}
        onClose={() => onClose(pane.id)}
      />
    );
  }
  if (node.kind === 'empty') return null;
  if (node.kind === 'leaf') {
    const pane = panesById[node.paneId];
    if (!pane) return null;
    return (
      <TerminalPane
        pane={pane}
        terminal={terminal}
        project={project}
        active={visible && activePaneId === pane.id}
        maximized={false}
        onFocus={() => onFocus(pane.id)}
        onClose={() => onClose(pane.id)}
      />
    );
  }
  const ratio = node.ratio ?? 0.5;
  return (
    <div className={`split split-${node.direction}`}>
      <div className="splitChild" style={{ flex: `${ratio} 1 0` }}>
        <SplitView node={node.first} panesById={panesById} terminal={terminal} project={project} visible={visible} activePaneId={activePaneId} maximizedPaneId={null} path={path ? `${path}.first` : 'first'} onResizeSplit={onResizeSplit} onFocus={onFocus} onClose={onClose} />
      </div>
      <SplitResizeHandle direction={node.direction} onResize={(nextRatio) => onResizeSplit(path, nextRatio)} />
      <div className="splitChild" style={{ flex: `${1 - ratio} 1 0` }}>
        <SplitView node={node.second} panesById={panesById} terminal={terminal} project={project} visible={visible} activePaneId={activePaneId} maximizedPaneId={null} path={path ? `${path}.second` : 'second'} onResizeSplit={onResizeSplit} onFocus={onFocus} onClose={onClose} />
      </div>
    </div>
  );
}

function SplitResizeHandle({ direction, onResize }: { direction: 'row' | 'column'; onResize: (ratio: number) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);

  return (
    <div
      ref={ref}
      className={`splitResizeHandle splitResizeHandle-${direction}`}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const split = ref.current?.parentElement;
        if (!split) return;
        const rect = split.getBoundingClientRect();
        const update = (event: PointerEvent) => {
          const raw = direction === 'row'
            ? (event.clientX - rect.left) / rect.width
            : (event.clientY - rect.top) / rect.height;
          onResize(Math.min(0.9, Math.max(0.1, raw)));
        };
        const stop = () => {
          window.removeEventListener('pointermove', update);
          window.removeEventListener('pointerup', stop);
          document.body.classList.remove('resizingSplit');
        };
        document.body.classList.add('resizingSplit');
        window.addEventListener('pointermove', update);
        window.addEventListener('pointerup', stop);
      }}
    />
  );
}

function TerminalPane({ pane, terminal, project, active, maximized, onFocus, onClose }: {
  pane: Pane;
  terminal: TerminalEntry;
  project: Project;
  active: boolean;
  maximized: boolean;
  onFocus: () => void;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const startupCommand = pane.id === `${terminal.id}:0` ? terminal.command : null;
    const host = hostRef.current!;
    let cancelled = false;
    let session = paneSessions.get(pane.id);

    if (!session) {
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: 'Menlo, Monaco, "SF Mono", monospace',
        fontSize: 13,
        theme: { background: '#0f141b', foreground: '#d6deeb', cursor: '#80cbc4' },
        scrollback: 10000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);

      session = {
        term,
        fit,
        spawned: false,
        running: false,
        lastPtySize: null,
        dataDisposable: term.onData((data) => {
          invoke('write_pty', { paneId: pane.id, data: Array.from(encoder.encode(data)) })
            .catch((e) => term.writeln(`\r\nwrite_pty error: ${e}\r\n`));
        }),
      };
      paneSessions.set(pane.id, session);

      const generation = `${pane.id}:${Date.now()}:${Math.random()}`;
      const dataPromise = listen<PtyData>('pty-data', (event) => {
        if (event.payload.pane_id === pane.id && event.payload.generation === generation) {
          term.write(decoder.decode(new Uint8Array(event.payload.data)));
          window.dispatchEvent(new CustomEvent('pane-output', { detail: { terminalId: terminal.id, paneId: pane.id } }));
        }
      }).then((fn) => { session!.unlistenData = fn; });
      const exitPromise = listen<PtyExit>('pty-exit', (event) => {
        if (event.payload.pane_id === pane.id && event.payload.generation === generation) {
          session!.running = false;
          window.dispatchEvent(new CustomEvent('pane-running-changed', { detail: { paneId: pane.id, running: false } }));
          term.writeln('\r\n[process exited]');
        }
      }).then((fn) => { session!.unlistenExit = fn; });

      const spawn = async () => {
        await Promise.all([dataPromise, exitPromise]);
        if (cancelled) return;
        await document.fonts?.ready.catch(() => undefined);
        if (cancelled) return;
        fit.fit();
        const size = safeTermSize(term);
        session!.lastPtySize = size;
        await invoke('spawn_pty', {
          paneId: pane.id,
          generation,
          cwd: terminal.cwd || project.path,
          command: startupCommand || null,
          cols: size.cols,
          rows: size.rows,
        });
        session!.spawned = true;
        session!.running = true;
        window.dispatchEvent(new CustomEvent('pane-running-changed', { detail: { paneId: pane.id, running: true } }));
        term.focus();
      };
      requestAnimationFrame(() => {
        spawn().catch((e) => term.writeln(`\r\nPTY error: ${e}\r\n`));
      });
    } else if (session.term.element && session.term.element.parentElement !== host) {
      host.replaceChildren(session.term.element);
    }

    termRef.current = session.term;
    fitRef.current = session.fit;

    const resizePtyToXterm = () => {
      session!.fit.fit();
      const size = safeTermSize(session!.term);
      if (session!.spawned && (!session!.lastPtySize || session!.lastPtySize.cols !== size.cols || session!.lastPtySize.rows !== size.rows)) {
        session!.lastPtySize = size;
        invoke('resize_pty', { paneId: pane.id, cols: size.cols, rows: size.rows }).catch(() => {});
      }
    };

    session.resizeObserver?.disconnect();
    session.resizeObserver = new ResizeObserver(resizePtyToXterm);
    session.resizeObserver.observe(host);
    requestAnimationFrame(resizePtyToXterm);

    return () => {
      cancelled = true;
      session?.resizeObserver?.disconnect();
      if (session) session.resizeObserver = undefined;
    };
  }, [pane.id, terminal.id, project.path, terminal.cwd, terminal.command]);

  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;

    term.options.cursorBlink = active;
    if (!active) return;

    requestAnimationFrame(() => {
      fit.fit();
      const size = safeTermSize(term);
      invoke('resize_pty', { paneId: pane.id, cols: size.cols, rows: size.rows }).catch(() => {});
      term.focus();
    });
  }, [active, pane.id]);

  return (
    <div className={`pane ${active ? 'active' : ''} ${maximized ? 'maximized' : ''}`} onMouseDown={onFocus}>
      <div className="terminalHost" ref={hostRef} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
