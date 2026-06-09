import type { Pane, Project, SplitNode, TerminalEntry } from '../types';
import { TerminalPane } from './TerminalPane';
import { SplitResizeHandle } from './SplitResizeHandle';

export function SplitView({ node, panesById, terminal, project, visible, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, activePaneId, displayedMaximizedPaneId, searchPaneRequest, restartPaneRequest, path, onResizeSplit, onFocus, onClose, onSplitPane, canToggleMaximize, onToggleMaximize }: {
  node: SplitNode;
  panesById: Record<string, Pane>;
  terminal: TerminalEntry;
  project: Project;
  visible: boolean;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  activePaneId: string | null;
  displayedMaximizedPaneId: string | null;
  searchPaneRequest: PaneRequest | null;
  restartPaneRequest: PaneRequest | null;
  path: string;
  onResizeSplit: (path: string, ratio: number) => void;
  onFocus: (paneId: string) => void;
  onClose: (paneId: string) => void;
  onSplitPane: (direction: 'row' | 'column', targetPaneId?: string) => void;
  canToggleMaximize: boolean;
  onToggleMaximize: (paneId: string) => void;
}) {
  const effectiveDisplayedMaximizedPaneId = displayedMaximizedPaneId && panesById[displayedMaximizedPaneId] ? displayedMaximizedPaneId : null;
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
        maximized={effectiveDisplayedMaximizedPaneId === pane.id}
        visible={visible}
        terminalFontSize={terminalFontSize}
        terminalFontFamily={terminalFontFamily}
        terminalScrollback={terminalScrollback}
        copyOnSelect={copyOnSelect}
        searchRequestNonce={searchPaneRequest?.paneId === pane.id ? searchPaneRequest.nonce : 0}
        restartRequestNonce={restartPaneRequest?.paneId === pane.id ? restartPaneRequest.nonce : 0}
        onFocus={() => onFocus(pane.id)}
        onClose={() => onClose(pane.id)}
        onSplitPane={(direction) => onSplitPane(direction, pane.id)}
        canToggleMaximize={canToggleMaximize}
        onToggleMaximize={() => onToggleMaximize(pane.id)}
      />
    );
  }
  const ratio = node.ratio ?? 0.5;
  return (
    <div className={`split split-${node.direction}`}>
      <div className="splitChild" style={{ flex: `${ratio} 1 0` }}>
        <SplitView node={node.first} panesById={panesById} terminal={terminal} project={project} visible={visible} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} activePaneId={activePaneId} displayedMaximizedPaneId={effectiveDisplayedMaximizedPaneId} searchPaneRequest={searchPaneRequest} restartPaneRequest={restartPaneRequest} path={path ? `${path}.first` : 'first'} onResizeSplit={onResizeSplit} onFocus={onFocus} onClose={onClose} onSplitPane={onSplitPane} canToggleMaximize={canToggleMaximize} onToggleMaximize={onToggleMaximize} />
      </div>
      <SplitResizeHandle direction={node.direction} onResize={(nextRatio) => onResizeSplit(path, nextRatio)} />
      <div className="splitChild" style={{ flex: `${1 - ratio} 1 0` }}>
        <SplitView node={node.second} panesById={panesById} terminal={terminal} project={project} visible={visible} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} activePaneId={activePaneId} displayedMaximizedPaneId={effectiveDisplayedMaximizedPaneId} searchPaneRequest={searchPaneRequest} restartPaneRequest={restartPaneRequest} path={path ? `${path}.second` : 'second'} onResizeSplit={onResizeSplit} onFocus={onFocus} onClose={onClose} onSplitPane={onSplitPane} canToggleMaximize={canToggleMaximize} onToggleMaximize={onToggleMaximize} />
      </div>
    </div>
  );
}

type PaneRequest = { paneId: string; nonce: number };

