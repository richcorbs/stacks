import type { GitInfo, TerminalEntry, Project, SplitNode, WorkspaceEntry } from '../types';
import { WorkspaceTopbar } from './WorkspaceTopbar';
import { WorkspaceViews } from './WorkspaceViews';

type WorkspaceViewModel = {
  project: Project;
  workspace: WorkspaceEntry;
  terminals: TerminalEntry[];
  root: SplitNode | undefined;
};

type TerminalRequest = { terminalId: string; nonce: number };

type MainWorkspaceProps = {
  activePath: string | null;
  activeProjectName: string | null;
  activeWorkspaceName: string | null;
  gitInfo: GitInfo | null;
  workspaces: WorkspaceViewModel[];
  activeWorkspaceId: string | null;
  activeTerminalId: string | null;
  maximizedWorkspaceId: string | null;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  searchTerminalRequest: TerminalRequest | null;
  restartTerminalRequest: TerminalRequest | null;
  onResizeSplit: (workspaceId: string, path: string, ratio: number) => void;
  onFocusTerminal: (projectId: string, workspaceId: string, terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  canToggleMaximizedTerminal: (workspaceId: string) => boolean;
  onToggleMaximizedTerminal: (terminalId: string) => void;
  onSplitTerminal: (direction: 'row' | 'column', targetTerminalId?: string) => void;
  hasActiveTerminal: boolean;
  onToggleSidebar: () => void;
};

export function MainWorkspace({
  activePath,
  activeProjectName,
  activeWorkspaceName,
  gitInfo,
  workspaces,
  activeWorkspaceId,
  activeTerminalId,
  maximizedWorkspaceId,
  terminalFontSize,
  terminalFontFamily,
  terminalScrollback,
  copyOnSelect,
  searchTerminalRequest,
  restartTerminalRequest,
  onResizeSplit,
  onFocusTerminal,
  onCloseTerminal,
  canToggleMaximizedTerminal,
  onToggleMaximizedTerminal,
  onSplitTerminal,
  hasActiveTerminal,
  onToggleSidebar,
}: MainWorkspaceProps) {
  return (
    <main className="main">
      <WorkspaceTopbar
        activePath={activePath}
        activeProjectName={activeProjectName}
        activeWorkspaceName={activeWorkspaceName}
        gitInfo={gitInfo}
        hasActiveTerminal={hasActiveTerminal}
        onToggleSidebar={onToggleSidebar}
      />
      <section className="workspace">
        <WorkspaceViews
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          activeTerminalId={activeTerminalId}
          maximizedWorkspaceId={maximizedWorkspaceId}
          terminalFontSize={terminalFontSize}
          terminalFontFamily={terminalFontFamily}
          terminalScrollback={terminalScrollback}
          copyOnSelect={copyOnSelect}
          searchTerminalRequest={searchTerminalRequest}
          restartTerminalRequest={restartTerminalRequest}
          onResizeSplit={onResizeSplit}
          onFocusTerminal={onFocusTerminal}
          onCloseTerminal={onCloseTerminal}
          canToggleMaximizedTerminal={canToggleMaximizedTerminal}
          onToggleMaximizedTerminal={onToggleMaximizedTerminal}
          onSplitTerminal={onSplitTerminal}
        />
      </section>
    </main>
  );
}
