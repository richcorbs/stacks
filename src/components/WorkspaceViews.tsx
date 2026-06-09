import { SplitView } from './TerminalWorkspace';
import type { Pane, Project, SplitNode, TerminalEntry } from '../types';
import { effectiveDisplayedMaximizedPaneId } from '../workspace/selectors';

type TerminalWorkspaceModel = {
  project: Project;
  terminal: TerminalEntry;
  panes: Pane[];
  root: SplitNode | undefined;
};

type PaneRequest = { paneId: string; nonce: number };

export function WorkspaceViews({
  workspaces,
  activeTerminalId,
  activePaneId,
  maximizedTerminalId,
  terminalFontSize,
  terminalFontFamily,
  terminalScrollback,
  copyOnSelect,
  searchPaneRequest,
  restartPaneRequest,
  onResizeSplit,
  onFocusPane,
  onClosePane,
  canToggleMaximizedTerminal,
  onToggleMaximizedTerminal,
  onSplitPane,
}: {
  workspaces: TerminalWorkspaceModel[];
  activeTerminalId: string | null;
  activePaneId: string | null;
  maximizedTerminalId: string | null;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  searchPaneRequest: PaneRequest | null;
  restartPaneRequest: PaneRequest | null;
  onResizeSplit: (terminalId: string, path: string, ratio: number) => void;
  onFocusPane: (projectId: string, terminalId: string, paneId: string) => void;
  onClosePane: (paneId: string) => void;
  canToggleMaximizedTerminal: (terminalId: string) => boolean;
  onToggleMaximizedTerminal: (paneId: string) => void;
  onSplitPane: (direction: 'row' | 'column', targetPaneId?: string) => void;
}) {
  if (workspaces.length === 0) {
    return <div className="empty">Create or select a workspace. Shortcuts: ⌘O project, ⌘N workspace, ⌘D split terminal.</div>;
  }

  return workspaces.map(({ project, terminal, panes, root }) => {
    const visible = terminal.id === activeTerminalId;
    const panesById = Object.fromEntries(panes.map((pane) => [pane.id, pane]));
    const visiblePaneIds = panes.map((pane) => pane.id);
    const terminalFocusedPaneId = focusedPaneForTerminal(terminal.id, activePaneId, visiblePaneIds);
    const visibleMaximizedPaneId = effectiveDisplayedMaximizedPaneId(maximizedTerminalId, terminal.id, terminalFocusedPaneId, visiblePaneIds);
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
            terminalFontSize={terminalFontSize}
            terminalFontFamily={terminalFontFamily}
            terminalScrollback={terminalScrollback}
            copyOnSelect={copyOnSelect}
            activePaneId={visible ? activePaneId : null}
            displayedMaximizedPaneId={visible ? visibleMaximizedPaneId : null}
            searchPaneRequest={searchPaneRequest}
            restartPaneRequest={restartPaneRequest}
            path=""
            onResizeSplit={(path, ratio) => onResizeSplit(terminal.id, path, ratio)}
            onFocus={(paneId) => onFocusPane(project.id, terminal.id, paneId)}
            onClose={onClosePane}
            onSplitPane={onSplitPane}
            canToggleMaximize={canToggleMaximizedTerminal(terminal.id)}
            onToggleMaximize={onToggleMaximizedTerminal}
          />
        )}
      </div>
    );
  });
}

function focusedPaneForTerminal(terminalId: string, activePaneId: string | null, paneIds: string[]) {
  if (activePaneId?.startsWith(`${terminalId}:`) && paneIds.includes(activePaneId)) return activePaneId;
  return paneIds[0] ?? null;
}
