import type { GitInfo, Pane, Project, SplitNode, TerminalEntry } from '../types';
import { WorkspaceTopbar } from './WorkspaceTopbar';
import { WorkspaceViews } from './WorkspaceViews';

type TerminalWorkspaceModel = {
  project: Project;
  terminal: TerminalEntry;
  panes: Pane[];
  root: SplitNode | undefined;
};

type PaneRequest = { paneId: string; nonce: number };

type MainWorkspaceProps = {
  activePath: string | null;
  gitInfo: GitInfo | null;
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
  hasActivePane: boolean;
};

export function MainWorkspace({
  activePath,
  gitInfo,
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
  hasActivePane,
}: MainWorkspaceProps) {
  return (
    <main className="main">
      <WorkspaceTopbar activePath={activePath} gitInfo={gitInfo} hasActivePane={hasActivePane} />
      <section className="workspace">
        <WorkspaceViews
          workspaces={workspaces}
          activeTerminalId={activeTerminalId}
          activePaneId={activePaneId}
          maximizedTerminalId={maximizedTerminalId}
          terminalFontSize={terminalFontSize}
          terminalFontFamily={terminalFontFamily}
          terminalScrollback={terminalScrollback}
          copyOnSelect={copyOnSelect}
          searchPaneRequest={searchPaneRequest}
          restartPaneRequest={restartPaneRequest}
          onResizeSplit={onResizeSplit}
          onFocusPane={onFocusPane}
          onClosePane={onClosePane}
          canToggleMaximizedTerminal={canToggleMaximizedTerminal}
          onToggleMaximizedTerminal={onToggleMaximizedTerminal}
          onSplitPane={onSplitPane}
        />
      </section>
    </main>
  );
}
