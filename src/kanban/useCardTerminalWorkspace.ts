import { useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { SplitNode, TerminalEntry } from '../types';
import { collectLeafTerminalIds, removeLeaf, setSplitRatio, splitLeaf } from '../utils';
import type { CardEnvironmentPane, KanbanCard } from './types';
import { saveKanbanEnvironmentLayout } from './api';
import { clearOneTimeStartupCommand, disposeTerminalSession, getTerminalSession, registerOneTimeStartupCommand, requestTerminalSessionsScrollToBottomAfterFit } from '../terminalSessionManager';
import { buildOneTimeCommandScript } from '../oneTimeCommand';
import { publishCardTerminalContext, type CardTerminalCommand } from '../cardTerminalCommands';
import { applicationEvents } from '../applicationEvents';
import { insertTemporaryPane, temporaryPaneCwd, type TemporaryPaneRun } from '../cardTerminalState';
import { cardTerminalId, cardWorkspaceId } from './cardWorkspace';
import { LayoutSaveCoordinator, type LayoutSaveSnapshot } from './layoutSaveCoordinator';
import type { CardView } from './cardView';

type CardLayoutSnapshot = LayoutSaveSnapshot<{
  splitLayout: SplitNode;
  focusedPaneId: string | null;
  panes: CardEnvironmentPane[];
}>;

export function useCardTerminalWorkspace({
  card,
  cardPath,
  activeView,
  setActionError,
  onCardUpdatedRef,
  preserveRevisionValues,
  workflowRevisionRef,
  environmentRevisionRef,
  layoutRevisionRef,
}: {
  card: KanbanCard;
  cardPath: string | null;
  activeView: CardView;
  setActionError: Dispatch<SetStateAction<string | null>>;
  onCardUpdatedRef: MutableRefObject<(card: KanbanCard) => void>;
  preserveRevisionValues: (card: KanbanCard) => KanbanCard;
  workflowRevisionRef: MutableRefObject<number>;
  environmentRevisionRef: MutableRefObject<number>;
  layoutRevisionRef: MutableRefObject<number>;
}) {
  const initialShellId = cardTerminalId(card.id, 'shell');
  const [shellTree, setShellTree] = useState<SplitNode>(() => card.environment?.split_layout ?? { kind: 'leaf', terminalId: initialShellId });
  const [focusedShellPane, setFocusedShellPane] = useState(() => card.environment?.focused_pane_id ?? initialShellId);
  const [maximizedShellPane, setMaximizedShellPane] = useState<string | null>(null);
  const [searchShellRequest, setSearchShellRequest] = useState<{ terminalId: string; nonce: number } | null>(null);
  const [restartShellRequest, setRestartShellRequest] = useState<{ terminalId: string; nonce: number } | null>(null);
  const temporaryRunRef = useRef<TemporaryPaneRun | null>(null);
  const temporaryCwdRef = useRef<string | null>(null);
  const savedLayoutSignatureRef = useRef(layoutSignature(
    card.environment?.split_layout ?? { kind: 'leaf', terminalId: initialShellId },
    card.environment?.focused_pane_id ?? initialShellId,
  ));
  const layoutSaveCoordinatorRef = useRef<LayoutSaveCoordinator<CardLayoutSnapshot, KanbanCard> | null>(null);
  const [pendingCloseShellPane, setPendingCloseShellPane] = useState<string | null>(null);
  const shellTerminalIds = useMemo(() => collectLeafTerminalIds(shellTree), [shellTree]);
  const shellTerminals = useMemo(() => Object.fromEntries(shellTerminalIds.map((terminalId): [string, TerminalEntry] => [terminalId, {
    id: terminalId,
    workspaceId: cardWorkspaceId(card.id),
    cwd: temporaryRunRef.current?.terminalId === terminalId ? temporaryCwdRef.current : cardPath,
    temporary: temporaryRunRef.current?.terminalId === terminalId,
  }])), [card.id, cardPath, shellTerminalIds]);

  function applyEnvironment(updated: KanbanCard) {
    if (!updated.environment) return;
    const focusedPane = updated.environment.focused_pane_id ?? collectLeafTerminalIds(updated.environment.split_layout)[0] ?? initialShellId;
    const signature = layoutSignature(updated.environment.split_layout, focusedPane);
    savedLayoutSignatureRef.current = signature;
    layoutSaveCoordinatorRef.current?.reset(updated.environment.layout_revision, signature);
    setShellTree(updated.environment.split_layout);
    setFocusedShellPane(focusedPane);
  }

  useEffect(() => {
    const environment = card.environment;
    if (!environment) return;
    const focusedPane = environment.focused_pane_id ?? collectLeafTerminalIds(environment.split_layout)[0] ?? initialShellId;
    const savedSignature = layoutSignature(environment.split_layout, focusedPane);
    workflowRevisionRef.current = card.workflow_revision;
    environmentRevisionRef.current = environment.revision;
    layoutRevisionRef.current = environment.layout_revision;
    savedLayoutSignatureRef.current = savedSignature;
    setShellTree(environment.split_layout);
    setFocusedShellPane(focusedPane);
    const coordinator = new LayoutSaveCoordinator<CardLayoutSnapshot, KanbanCard>({
      initialLayoutRevision: environment.layout_revision,
      initialSavedSignature: savedSignature,
      save: async (snapshot, expectedLayoutRevision) => {
        const updated = await saveKanbanEnvironmentLayout(card.id, snapshot.value.splitLayout, snapshot.value.focusedPaneId, snapshot.value.panes, expectedLayoutRevision);
        if (!updated.environment) throw new Error('Layout save response is missing the card environment; reload the card.');
        return { layoutRevision: updated.environment.layout_revision, value: updated };
      },
      onSaved: (snapshot, updated) => {
        savedLayoutSignatureRef.current = snapshot.signature;
        onCardUpdatedRef.current(preserveRevisionValues(updated));
      },
      onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
    });
    layoutSaveCoordinatorRef.current = coordinator;
    return () => {
      coordinator.dispose();
      if (layoutSaveCoordinatorRef.current === coordinator) layoutSaveCoordinatorRef.current = null;
    };
  }, [card.id, card.environment?.id]);

  useEffect(() => {
    if (!card.environment?.id || temporaryRunRef.current) return;
    const panes: CardEnvironmentPane[] = shellTerminalIds.map((id, index) => ({ id, role: 'shell', kind: 'terminal', command: null, sort_order: index }));
    layoutSaveCoordinatorRef.current?.submit({
      signature: layoutSignature(shellTree, focusedShellPane),
      value: { splitLayout: shellTree, focusedPaneId: focusedShellPane || null, panes },
    });
  }, [card.id, card.environment?.id, focusedShellPane, shellTerminalIds, shellTree]);

  function focusShellPane(paneId: string) {
    if (!shellTerminalIds.includes(paneId)) return;
    setFocusedShellPane(paneId);
    setMaximizedShellPane((current) => current ? paneId : null);
  }

  function finishTemporaryRun(terminalId: string, restore = true) {
    const run = temporaryRunRef.current;
    if (!run || run.terminalId !== terminalId) return false;
    temporaryRunRef.current = null;
    temporaryCwdRef.current = null;
    clearOneTimeStartupCommand(terminalId);
    disposeTerminalSession(terminalId);
    invoke('kill_pty', { terminalId }).catch(() => {});
    if (restore) {
      setShellTree(run.previousTree);
      setFocusedShellPane(run.previousFocus);
      setMaximizedShellPane(null);
      requestTerminalSessionsScrollToBottomAfterFit([run.previousFocus]);
    }
    return true;
  }

  async function runOneTimeCommand(command: string) {
    const trimmed = command.trim();
    if (!trimmed || temporaryRunRef.current || !focusedShellPane) return;
    const cwd = temporaryPaneCwd(await invoke<string | null>('pty_cwd', { terminalId: focusedShellPane }).catch(() => null), cardPath);
    if (!cwd) return;
    const terminalId = cardTerminalId(card.id, `temporary:${crypto.randomUUID()}`);
    const inserted = insertTemporaryPane(shellTree, focusedShellPane, terminalId);
    temporaryRunRef.current = inserted.run;
    temporaryCwdRef.current = cwd;
    registerOneTimeStartupCommand(terminalId, buildOneTimeCommandScript(trimmed));
    setShellTree(inserted.tree);
    setFocusedShellPane(inserted.focusedPaneId);
    setMaximizedShellPane(inserted.maximizedPaneId);
    requestTerminalSessionsScrollToBottomAfterFit([terminalId]);
  }

  useEffect(() => {
    publishCardTerminalContext({ cardId: card.id, active: activeView === 'terminal', focusedPaneId: activeView === 'terminal' ? focusedShellPane || null : null, paneIds: shellTerminalIds, cwd: cardPath, maximized: Boolean(maximizedShellPane) });
    return () => publishCardTerminalContext(null);
  }, [activeView, card.id, cardPath, focusedShellPane, maximizedShellPane, shellTerminalIds]);

  useEffect(() => () => {
    const run = temporaryRunRef.current;
    if (run) finishTemporaryRun(run.terminalId, false);
  }, []);

  useEffect(() => {
    const splitTerminal = (direction: 'row' | 'column', requestedPane?: string) => {
      const targetPane = requestedPane && shellTerminalIds.includes(requestedPane) ? requestedPane : shellTerminalIds.includes(focusedShellPane) ? focusedShellPane : shellTerminalIds.at(-1);
      if (!targetPane) return;
      const newPane = cardTerminalId(card.id, `shell:${crypto.randomUUID()}`);
      const applySplit = () => {
        setShellTree((current) => splitLeaf(current, targetPane, newPane, direction));
        focusShellPane(newPane);
      };
      const session = getTerminalSession(targetPane);
      if (session?.running) session.term.write(clearWrappedPrompt(session.term), applySplit);
      else applySplit();
    };
    const closeTerminal = (detail?: { pane?: string }) => {
      const requestedPane = detail?.pane;
      const closing = requestedPane && shellTerminalIds.includes(requestedPane) ? requestedPane : shellTerminalIds.includes(focusedShellPane) ? focusedShellPane : shellTerminalIds.at(-1);
      if (closing) setPendingCloseShellPane(closing);
    };
    const handleSplit = (detail: { direction?: 'row' | 'column'; pane?: string }) => {
      if (detail?.direction) splitTerminal(detail.direction, detail.pane);
    };
    const handleCommand = (command: CardTerminalCommand) => {
      if (activeView !== 'terminal') return;
      const pane = focusedShellPane;
      if (!command || !pane) return;
      if (command.type === 'split') splitTerminal(command.direction);
      else if (command.type === 'focus') focusShellPane(command.paneId);
      else if (command.type === 'search') setSearchShellRequest({ terminalId: pane, nonce: Date.now() });
      else if (command.type === 'clear') { const session = getTerminalSession(pane); session?.term.clearSelection(); session?.term.clear(); session?.term.scrollToBottom(); }
      else if (command.type === 'restart') { disposeTerminalSession(pane); invoke('kill_pty', { terminalId: pane }).catch(() => {}); setRestartShellRequest({ terminalId: pane, nonce: Date.now() }); }
      else if (command.type === 'stop') { disposeTerminalSession(pane); invoke('kill_pty', { terminalId: pane }).catch(console.error); }
      else if (command.type === 'close') { if (!finishTemporaryRun(pane)) closeTerminal(); }
      else if (command.type === 'toggle-maximize' && shellTerminalIds.length > 1) { setMaximizedShellPane((current) => current ? null : pane); requestTerminalSessionsScrollToBottomAfterFit([pane]); }
      else if (command.type === 'run-one-time') void runOneTimeCommand(command.command);
    };
    const unsubscribes = [
      applicationEvents.subscribe('card-terminal-split', handleSplit),
      applicationEvents.subscribe('card-terminal-close', closeTerminal),
      applicationEvents.subscribe('card-terminal-command', handleCommand),
    ];
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [activeView, card.id, cardPath, focusedShellPane, maximizedShellPane, shellTerminalIds, shellTree]);

  function closeShellPane(terminalId: string) {
    if (finishTemporaryRun(terminalId)) { setPendingCloseShellPane(null); return; }
    disposeTerminalSession(terminalId);
    invoke('kill_pty', { terminalId }).catch(console.error);
    setShellTree((current) => removeLeaf(current, terminalId) ?? { kind: 'empty' });
    const remaining = shellTerminalIds.filter((pane) => pane !== terminalId);
    setFocusedShellPane(remaining.at(-1) ?? '');
    setMaximizedShellPane(null);
    setPendingCloseShellPane(null);
  }

  return {
    initialShellId,
    shellTree,
    shellTerminals,
    shellTerminalIds,
    focusedShellPane,
    maximizedShellPane,
    searchShellRequest,
    restartShellRequest,
    pendingCloseShellPane,
    setPendingCloseShellPane,
    setSplitRatio: (path: string, ratio: number) => setShellTree((current) => setSplitRatio(current, path, ratio)),
    focusShellPane,
    toggleMaximize: (terminalId: string) => {
      focusShellPane(terminalId);
      setMaximizedShellPane((current) => current ? null : terminalId);
      requestTerminalSessionsScrollToBottomAfterFit([terminalId]);
    },
    closeShellPane,
    applyEnvironment,
    handleTerminalStopped: (terminalId: string) => {
      if (temporaryRunRef.current?.terminalId === terminalId) window.setTimeout(() => finishTemporaryRun(terminalId), 0);
    },
  };
}

function layoutSignature(tree: SplitNode, focusedPaneId: string | null) {
  return JSON.stringify([tree, focusedPaneId]);
}

function clearWrappedPrompt(term: import('@xterm/xterm').Terminal) {
  const buffer = term.buffer.active;
  const cursorLine = buffer.baseY + buffer.cursorY;
  let promptStart = cursorLine;
  while (promptStart > 0 && buffer.getLine(promptStart)?.isWrapped) promptStart -= 1;
  const marker = buffer.getLine(promptStart)?.translateToString(true).trim() ?? '';
  if (/^[%$#❯>]$/.test(marker) && promptStart > 0) {
    let previousStart = promptStart - 1;
    while (previousStart > 0 && buffer.getLine(previousStart)?.isWrapped) previousStart -= 1;
    const previousPrompt = Array.from({ length: promptStart - previousStart }, (_, index) => buffer.getLine(previousStart + index)?.translateToString(true) ?? '').join('').trim();
    if (/^(~|\/).+\([^)]*\)\s*$/.test(previousPrompt)) promptStart = previousStart;
  }
  const rowsAboveCursor = cursorLine - promptStart;
  if (rowsAboveCursor === 0) return '\r\x1b[2K';
  return `\r\x1b[2K${'\x1b[1A\x1b[2K'.repeat(rowsAboveCursor)}\x1b[${rowsAboveCursor}B\r`;
}
