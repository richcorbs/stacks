import { SplitView } from './WorkspaceTerminalTree';
import type { TerminalEntry, Project, SplitNode, WorkspaceEntry } from '../types';
import { effectiveDisplayedMaximizedTerminalId } from '../workspace/selectors';

type WorkspaceViewModel = {
  project: Project;
  workspace: WorkspaceEntry;
  terminals: TerminalEntry[];
  root: SplitNode | undefined;
};

type TerminalRequest = { terminalId: string; nonce: number };

export function WorkspaceViews({
  workspaces,
  activeWorkspaceId,
  activeTerminalId,
  maximizedWorkspaceId,
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
  onInput,
  canToggleMaximizedTerminal,
  onToggleMaximizedTerminal,
  onSplitTerminal,
}: {
  workspaces: WorkspaceViewModel[];
  activeWorkspaceId: string | null;
  activeTerminalId: string | null;
  maximizedWorkspaceId: string | null;
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
  onInput: (terminalId: string, data: string) => void;
  canToggleMaximizedTerminal: (workspaceId: string) => boolean;
  onToggleMaximizedTerminal: (terminalId: string) => void;
  onSplitTerminal: (direction: 'row' | 'column', targetTerminalId?: string) => void;
}) {
  if (workspaces.length === 0) {
    return <div className="empty">Create or select a workspace. Shortcuts: ⌘O project, ⌘N workspace, ⌘D split terminal.</div>;
  }

  return workspaces.map(({ project, workspace, terminals, root }) => {
    const visible = workspace.id === activeWorkspaceId;
    const terminalsById = Object.fromEntries(terminals.map((terminal) => [terminal.id, terminal]));
    const visibleTerminalIds = terminals.map((terminal) => terminal.id);
    const terminalFocusedTerminalId = focusedTerminalForWorkspace(workspace.id, activeTerminalId, visibleTerminalIds);
    const visibleMaximizedTerminalId = effectiveDisplayedMaximizedTerminalId(maximizedWorkspaceId, workspace.id, terminalFocusedTerminalId, visibleTerminalIds);
    return (
      <div
        key={workspace.id}
        className={`terminalWorkspace ${visible ? 'visible' : ''}`}
        aria-hidden={!visible}
      >
        {root && (
          <SplitView
            node={root}
            terminalsById={terminalsById}
            workspace={workspace}
            project={project}
            visible={visible}
            broadcast={Boolean(broadcastWorkspaceIds[workspace.id])}
            terminalFontSize={terminalFontSize}
            terminalFontFamily={terminalFontFamily}
            terminalScrollback={terminalScrollback}
            copyOnSelect={copyOnSelect}
            activeTerminalId={visible ? activeTerminalId : null}
            displayedMaximizedTerminalId={visible ? visibleMaximizedTerminalId : null}
            searchTerminalRequest={searchTerminalRequest}
            restartTerminalRequest={restartTerminalRequest}
            path=""
            onResizeSplit={(path, ratio) => onResizeSplit(workspace.id, path, ratio)}
            onFocus={(terminalId) => onFocusTerminal(project.id, workspace.id, terminalId)}
            onClose={onCloseTerminal}
            onSplitTerminal={onSplitTerminal}
            onToggleBroadcast={onToggleBroadcast}
            onInput={onInput}
            canToggleMaximize={canToggleMaximizedTerminal(workspace.id)}
            onToggleMaximize={onToggleMaximizedTerminal}
          />
        )}
      </div>
    );
  });
}

function focusedTerminalForWorkspace(workspaceId: string, activeTerminalId: string | null, terminalIds: string[]) {
  if (activeTerminalId?.startsWith(`${workspaceId}:`) && terminalIds.includes(activeTerminalId)) return activeTerminalId;
  return terminalIds[0] ?? null;
}
