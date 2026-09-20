import { useEffect, useMemo, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { SplitNode } from '../types';
import { collectLeafTerminalIds } from '../utils';
import type { CardEnvironmentPane, KanbanCard } from './types';
import { saveKanbanEnvironmentLayout } from './api';
import { clearOneTimeStartupCommand, disposeTerminalSession, getTerminalSession, registerOneTimeStartupCommand, requestTerminalSessionsScrollToBottomAfterFit } from '../terminalSessionManager';
import { buildOneTimeCommandScript } from '../oneTimeCommand';
import { publishCardTerminalContext, type CardTerminalCommand } from '../cardTerminalCommands';
import { applicationEvents } from '../applicationEvents';
import { temporaryPaneCwd } from '../cardTerminalState';
import { cardTerminalId, cardWorkspaceId } from './cardWorkspace';
import { LayoutSaveCoordinator, type LayoutSaveSnapshot } from './layoutSaveCoordinator';
import type { CardView } from './cardView';
import { WorkspaceShellController } from '../workspaceShellController';
import { useWorkspaceShell } from '../components/WorkspaceShellView';

type CardLayoutSnapshot = LayoutSaveSnapshot<{
  splitLayout: SplitNode;
  focusedPaneId: string | null;
  panes: CardEnvironmentPane[];
}>;

export function useCardTerminalWorkspace({ card, cardPath, activeView, setActionError, onCardUpdatedRef, preserveRevisionValues, workflowRevisionRef, environmentRevisionRef, layoutRevisionRef }: {
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
  const cardPathRef = useRef(cardPath);
  cardPathRef.current = cardPath;
  const coordinatorRef = useRef<LayoutSaveCoordinator<CardLayoutSnapshot, KanbanCard> | null>(null);
  const controller = useMemo(() => new WorkspaceShellController(cardWorkspaceId(card.id), {
    tree: card.environment?.split_layout ?? { kind: 'leaf', terminalId: initialShellId },
    focusedPaneId: card.environment?.focused_pane_id ?? initialShellId,
  }, {
    createPaneId: () => cardTerminalId(card.id, `shell:${crypto.randomUUID()}`),
    createPane: (id, options) => ({ id, workspaceId: cardWorkspaceId(card.id), cwd: options.cwd ?? cardPathRef.current, temporary: options.temporary }),
    prepareSplit: (terminalId) => new Promise((resolve) => {
      const session = getTerminalSession(terminalId);
      if (session?.running) session.term.write(clearWrappedPrompt(session.term), resolve); else resolve();
    }),
    clearSession: (terminalId) => {
      const session = getTerminalSession(terminalId);
      session?.term.clearSelection(); session?.term.clear(); session?.term.scrollToBottom();
    },
    disposeAndKill: (terminalId) => {
      disposeTerminalSession(terminalId);
      invoke('kill_pty', { terminalId }).catch(console.error);
    },
    write: (terminalId, data) => invoke('write_pty', { terminalId, data: Array.from(new TextEncoder().encode(data)) }).catch(console.error),
    scrollAfterFit: requestTerminalSessionsScrollToBottomAfterFit,
    persist: (layout) => coordinatorRef.current?.submit({
      signature: layoutSignature(layout.tree, layout.focusedPaneId),
      value: {
        splitLayout: layout.tree,
        focusedPaneId: layout.focusedPaneId,
        panes: layout.panes.map((pane, index) => ({ id: pane.id, role: 'shell', kind: 'terminal', command: null, sort_order: index })),
      },
    }),
    temporary: {
      createPaneId: () => cardTerminalId(card.id, `temporary:${crypto.randomUUID()}`),
      resolveCwd: async (terminalId) => temporaryPaneCwd(await invoke<string | null>('pty_cwd', { terminalId }).catch(() => null), cardPathRef.current),
      registerStartupCommand: registerOneTimeStartupCommand,
      clearStartupCommand: clearOneTimeStartupCommand,
      buildCommand: buildOneTimeCommandScript,
    },
  }), [card.id, card.environment?.id]);
  const shell = useWorkspaceShell(controller);

  useEffect(() => {
    const environment = card.environment;
    if (!environment) return;
    const focused = environment.focused_pane_id ?? collectLeafTerminalIds(environment.split_layout)[0] ?? initialShellId;
    const signature = layoutSignature(environment.split_layout, focused);
    workflowRevisionRef.current = card.workflow_revision;
    environmentRevisionRef.current = environment.revision;
    layoutRevisionRef.current = environment.layout_revision;
    const coordinator = new LayoutSaveCoordinator<CardLayoutSnapshot, KanbanCard>({
      initialLayoutRevision: environment.layout_revision,
      initialSavedSignature: signature,
      save: async (snapshot, expectedLayoutRevision) => {
        const updated = await saveKanbanEnvironmentLayout(card.id, snapshot.value.splitLayout, snapshot.value.focusedPaneId, snapshot.value.panes, expectedLayoutRevision);
        if (!updated.environment) throw new Error('Layout save response is missing the card environment; reload the card.');
        return { layoutRevision: updated.environment.layout_revision, value: updated };
      },
      onSaved: (_snapshot, updated) => onCardUpdatedRef.current(preserveRevisionValues(updated)),
      onError: (error) => setActionError(error instanceof Error ? error.message : String(error)),
    });
    coordinatorRef.current = coordinator;
    controller.replaceLayout(environment.split_layout, focused);
    return () => { coordinator.dispose(); if (coordinatorRef.current === coordinator) coordinatorRef.current = null; };
  }, [card.id, card.environment?.id, controller]);

  useEffect(() => () => controller.dispose(), [controller]);

  function applyEnvironment(updated: KanbanCard) {
    if (!updated.environment) return;
    const focused = updated.environment.focused_pane_id ?? collectLeafTerminalIds(updated.environment.split_layout)[0] ?? initialShellId;
    coordinatorRef.current?.reset(updated.environment.layout_revision, layoutSignature(updated.environment.split_layout, focused));
    controller.replaceLayout(updated.environment.split_layout, focused);
  }

  useEffect(() => {
    publishCardTerminalContext({ cardId: card.id, active: activeView === 'terminal', focusedPaneId: activeView === 'terminal' ? shell.focusedPaneId : null, paneIds: shell.paneIds, cwd: cardPath, maximized: Boolean(shell.maximizedPaneId) });
    return () => publishCardTerminalContext(null);
  }, [activeView, card.id, cardPath, shell.focusedPaneId, shell.maximizedPaneId, shell.paneIds]);

  useEffect(() => {
    const handleSplit = (detail: { direction?: 'row' | 'column'; pane?: string }) => {
      if (activeView === 'terminal' && detail.direction) void controller.split(detail.direction, detail.pane);
    };
    const handleClose = (detail?: { pane?: string }) => {
      if (activeView === 'terminal') controller.requestClose(detail?.pane);
    };
    const handleCommand = (command: CardTerminalCommand) => controller.handleCommand(controller.ownerId, activeView === 'terminal', command);
    const unsubscribes = [
      applicationEvents.subscribe('card-terminal-split', handleSplit),
      applicationEvents.subscribe('card-terminal-close', handleClose),
      applicationEvents.subscribe('card-terminal-command', handleCommand),
    ];
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [activeView, controller]);

  return {
    controller,
    initialShellId,
    shellTree: shell.tree,
    shellTerminals: shell.panes,
    shellTerminalIds: shell.paneIds,
    focusedShellPane: shell.focusedPaneId ?? '',
    maximizedShellPane: shell.maximizedPaneId,
    searchShellRequest: shell.searchRequest,
    restartShellRequest: shell.restartRequest,
    pendingCloseShellPane: shell.pendingClosePaneId,
    setPendingCloseShellPane: (pane: string | null) => pane ? controller.requestClose(pane) : controller.cancelClose(),
    setSplitRatio: (path: string, ratio: number) => controller.resize(path, ratio),
    focusShellPane: (pane: string) => controller.focus(pane),
    toggleMaximize: (pane: string) => controller.toggleMaximize(pane),
    closeShellPane: (pane: string) => controller.close(pane),
    applyEnvironment,
    handleTerminalStopped: (pane: string) => controller.handleTerminalStopped(pane),
  };
}

function layoutSignature(tree: SplitNode, focusedPaneId: string | null) { return JSON.stringify([tree, focusedPaneId]); }

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
