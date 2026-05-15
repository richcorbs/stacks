import { SplitView } from './TerminalWorkspace';
import type { GitInfo, Pane, Project, SplitNode, TerminalEntry } from '../types';
import { effectiveMaximizedPaneId } from '../workspace/selectors';

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
  maximizedPaneId: string | null;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  searchPaneRequest: PaneRequest | null;
  restartPaneRequest: PaneRequest | null;
  onResizeSplit: (terminalId: string, path: string, ratio: number) => void;
  onFocusPane: (projectId: string, terminalId: string, paneId: string) => void;
  onClosePane: (paneId: string) => void;
  onSplitPane: (direction: 'row' | 'column') => void;
  hasActivePane: boolean;
};

export function MainWorkspace({
  activePath,
  gitInfo,
  workspaces,
  activeTerminalId,
  activePaneId,
  maximizedPaneId,
  terminalFontSize,
  terminalFontFamily,
  terminalScrollback,
  copyOnSelect,
  searchPaneRequest,
  restartPaneRequest,
  onResizeSplit,
  onFocusPane,
  onClosePane,
  onSplitPane,
  hasActivePane,
}: MainWorkspaceProps) {
  return (
    <main className="main">
      <Topbar activePath={activePath} gitInfo={gitInfo} hasActivePane={hasActivePane} onSplitPane={onSplitPane} />
      <section className="workspace">
        {workspaces.length > 0 ? (
          workspaces.map(({ project, terminal, panes, root }) => {
            const visible = terminal.id === activeTerminalId;
            const panesById = Object.fromEntries(panes.map((pane) => [pane.id, pane]));
            const visiblePaneIds = panes.map((pane) => pane.id);
            const visibleMaximizedPaneId = effectiveMaximizedPaneId(maximizedPaneId, visiblePaneIds);
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
                    maximizedPaneId={visible ? visibleMaximizedPaneId : null}
                    searchPaneRequest={searchPaneRequest}
                    restartPaneRequest={restartPaneRequest}
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

function Topbar({ activePath, gitInfo, hasActivePane, onSplitPane }: { activePath: string | null; gitInfo: GitInfo | null; hasActivePane: boolean; onSplitPane: (direction: 'row' | 'column') => void }) {
  return (
    <header className="topbar">
      <div>
        <div className="subtitle">{hasActivePane ? activePath : 'Select a terminal'}</div>
      </div>
      {hasActivePane && (
        <div className="branchDisplay">
        {gitInfo && (
          <>
            <span className="branchName"> {gitInfo.branch}</span>
            {(gitInfo.created > 0 || gitInfo.changed > 0 || gitInfo.deleted > 0) && (
              <span className="gitStats" title="Files created / changed / deleted">
                <span className="gitSeparator">•</span>
                {gitInfo.created > 0 && <span className="gitAdded">+{gitInfo.created}</span>}
                {gitInfo.changed > 0 && <span className="gitChanged">~{gitInfo.changed}</span>}
                {gitInfo.deleted > 0 && <span className="gitRemoved">-{gitInfo.deleted}</span>}
              </span>
            )}
          </>
        )}
        <span className="topbarSeparator">•</span>
        <span className="splitControls">
          <button className="splitButton" title="Split right (⌘D)" onClick={() => onSplitPane('row')} aria-label="Split right">
            <span className="splitIcon splitIconVertical" />
          </button>
          <button className="splitButton" title="Split down (⇧⌘D)" onClick={() => onSplitPane('column')} aria-label="Split down">
            <span className="splitIcon splitIconHorizontal" />
          </button>
        </span>
        </div>
      )}
    </header>
  );
}
