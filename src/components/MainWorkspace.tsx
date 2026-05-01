import { SplitView } from './TerminalWorkspace';
import type { GitInfo, Pane, Project, SplitNode, TerminalEntry } from '../types';

type TerminalWorkspaceModel = {
  project: Project;
  terminal: TerminalEntry;
  panes: Pane[];
  root: SplitNode | undefined;
};

type MainWorkspaceProps = {
  activePath: string | null;
  gitInfo: GitInfo | null;
  workspaces: TerminalWorkspaceModel[];
  activeTerminalId: string | null;
  activePaneId: string | null;
  maximizedPaneId: string | null;
  onResizeSplit: (terminalId: string, path: string, ratio: number) => void;
  onFocusPane: (projectId: string, terminalId: string, paneId: string) => void;
  onClosePane: (paneId: string) => void;
};

export function MainWorkspace({
  activePath,
  gitInfo,
  workspaces,
  activeTerminalId,
  activePaneId,
  maximizedPaneId,
  onResizeSplit,
  onFocusPane,
  onClosePane,
}: MainWorkspaceProps) {
  return (
    <main className="main">
      <Topbar activePath={activePath} gitInfo={gitInfo} />
      <section className="workspace">
        {workspaces.length > 0 ? (
          workspaces.map(({ project, terminal, panes, root }) => {
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
                    onResizeSplit={(path, ratio) => onResizeSplit(terminal.id, path, ratio)}
                    onFocus={(paneId) => onFocusPane(project.id, terminal.id, paneId)}
                    onClose={onClosePane}
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
  );
}

function Topbar({ activePath, gitInfo }: { activePath: string | null; gitInfo: GitInfo | null }) {
  return (
    <header className="topbar">
      <div>
        <div className="subtitle">{activePath || 'Add a project to get started'}</div>
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
  );
}
