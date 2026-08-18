import type { GitInfo, MaximizedWorkspaceIds, TerminalEntry, Project, SplitNode, WorkspaceEntry } from '../types';
import { WorkspaceStatusbar } from './WorkspaceStatusbar';
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
  maximizedWorkspaceIds: MaximizedWorkspaceIds;
  broadcastWorkspaceIds: Record<string, boolean>;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  searchTerminalRequest: TerminalRequest | null;
  restartTerminalRequest: TerminalRequest | null;
  onResizeSplit: (workspaceId: string, path: string, ratio: number) => void;
  onFocusTerminal: (projectId: string, workspaceId: string, terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onToggleBroadcast: (workspaceId: string) => void;
  onEditTerminal: (workspaceId: string, terminalId: string) => void;
  onInput: (terminalId: string, data: string) => void;
  canToggleMaximizedTerminal: (workspaceId: string) => boolean;
  onToggleMaximizedTerminal: (terminalId: string) => void;
  onSplitTerminal: (direction: 'row' | 'column', targetTerminalId?: string) => void;
  hasActiveTerminal: boolean;
  onToggleSidebar: () => void;
  onToggleSuperthread: () => void;
  superthreadVisible: boolean;
  superthreadEnabled: boolean;
};

export function MainWorkspace({
  activePath,
  activeProjectName,
  activeWorkspaceName,
  gitInfo,
  workspaces,
  activeWorkspaceId,
  activeTerminalId,
  maximizedWorkspaceIds,
  broadcastWorkspaceIds,
  terminalFontSize,
  terminalFontFamily,
  terminalScrollback,
  copyOnSelect,
  searchTerminalRequest,
  restartTerminalRequest,
  onResizeSplit,
  onFocusTerminal,
  onCloseTerminal,
  onToggleBroadcast,
  onEditTerminal,
  onInput,
  canToggleMaximizedTerminal,
  onToggleMaximizedTerminal,
  onSplitTerminal,
  hasActiveTerminal,
  onToggleSidebar,
  onToggleSuperthread,
  superthreadVisible,
  superthreadEnabled,
}: MainWorkspaceProps) {
  return (
    <main className="main">
      <WorkspaceTopbar
        activeProjectName={activeProjectName}
        activeWorkspaceName={activeWorkspaceName}
        hasActiveTerminal={hasActiveTerminal}
        onToggleSidebar={onToggleSidebar}
        onToggleSuperthread={onToggleSuperthread}
        superthreadVisible={superthreadVisible}
        superthreadEnabled={superthreadEnabled}
      />
      <section className="workspace">
        <WorkspaceViews
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          activeTerminalId={activeTerminalId}
          maximizedWorkspaceIds={maximizedWorkspaceIds}
          broadcastWorkspaceIds={broadcastWorkspaceIds}
          terminalFontSize={terminalFontSize}
          terminalFontFamily={terminalFontFamily}
          terminalScrollback={terminalScrollback}
          copyOnSelect={copyOnSelect}
          searchTerminalRequest={searchTerminalRequest}
          restartTerminalRequest={restartTerminalRequest}
          onResizeSplit={onResizeSplit}
          onFocusTerminal={onFocusTerminal}
          onCloseTerminal={onCloseTerminal}
          onToggleBroadcast={onToggleBroadcast}
          onEditTerminal={onEditTerminal}
          onInput={onInput}
          canToggleMaximizedTerminal={canToggleMaximizedTerminal}
          onToggleMaximizedTerminal={onToggleMaximizedTerminal}
          onSplitTerminal={onSplitTerminal}
        />
      </section>
      {hasActiveTerminal && <WorkspaceStatusbar activePath={activePath} gitInfo={gitInfo} />}
    </main>
  );
}
