import type { TerminalEntry, Project, SplitNode, WorkspaceEntry } from '../types';
import { TerminalView } from './TerminalView';
import { SplitResizeHandle } from './SplitResizeHandle';

export function SplitView({ node, terminalsById, workspace, project, visible, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, activeTerminalId, displayedMaximizedTerminalId, searchTerminalRequest, restartTerminalRequest, path, onResizeSplit, onFocus, onClose, onSplitTerminal, canToggleMaximize, onToggleMaximize }: {
  node: SplitNode;
  terminalsById: Record<string, TerminalEntry>;
  workspace: WorkspaceEntry;
  project: Project;
  visible: boolean;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  activeTerminalId: string | null;
  displayedMaximizedTerminalId: string | null;
  searchTerminalRequest: TerminalRequest | null;
  restartTerminalRequest: TerminalRequest | null;
  path: string;
  onResizeSplit: (path: string, ratio: number) => void;
  onFocus: (terminalId: string) => void;
  onClose: (terminalId: string) => void;
  onSplitTerminal: (direction: 'row' | 'column', targetTerminalId?: string) => void;
  canToggleMaximize: boolean;
  onToggleMaximize: (terminalId: string) => void;
}) {
  const effectiveDisplayedMaximizedTerminalId = displayedMaximizedTerminalId && terminalsById[displayedMaximizedTerminalId] ? displayedMaximizedTerminalId : null;
  if (node.kind === 'empty') return null;
  if (node.kind === 'leaf') {
    const terminal = terminalsById[node.terminalId];
    if (!terminal) return null;
    const isDisplayed = visible && (!effectiveDisplayedMaximizedTerminalId || effectiveDisplayedMaximizedTerminalId === terminal.id);
    return (
      <TerminalView
        terminal={terminal}
        workspace={workspace}
        project={project}
        active={isDisplayed && activeTerminalId === terminal.id}
        maximized={effectiveDisplayedMaximizedTerminalId === terminal.id}
        visible={isDisplayed}
        terminalFontSize={terminalFontSize}
        terminalFontFamily={terminalFontFamily}
        terminalScrollback={terminalScrollback}
        copyOnSelect={copyOnSelect}
        searchRequestNonce={searchTerminalRequest?.terminalId === terminal.id ? searchTerminalRequest.nonce : 0}
        restartRequestNonce={restartTerminalRequest?.terminalId === terminal.id ? restartTerminalRequest.nonce : 0}
        onFocus={() => onFocus(terminal.id)}
        onClose={() => onClose(terminal.id)}
        onSplitTerminal={(direction) => onSplitTerminal(direction, terminal.id)}
        canToggleMaximize={canToggleMaximize}
        onToggleMaximize={() => onToggleMaximize(terminal.id)}
      />
    );
  }
  const ratio = node.ratio ?? 0.5;
  return (
    <div className={`split split-${node.direction}`}>
      <div className="splitChild" style={{ flex: `${ratio} 1 0` }}>
        <SplitView node={node.first} terminalsById={terminalsById} workspace={workspace} project={project} visible={visible} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} activeTerminalId={activeTerminalId} displayedMaximizedTerminalId={effectiveDisplayedMaximizedTerminalId} searchTerminalRequest={searchTerminalRequest} restartTerminalRequest={restartTerminalRequest} path={path ? `${path}.first` : 'first'} onResizeSplit={onResizeSplit} onFocus={onFocus} onClose={onClose} onSplitTerminal={onSplitTerminal} canToggleMaximize={canToggleMaximize} onToggleMaximize={onToggleMaximize} />
      </div>
      <SplitResizeHandle direction={node.direction} onResize={(nextRatio) => onResizeSplit(path, nextRatio)} />
      <div className="splitChild" style={{ flex: `${1 - ratio} 1 0` }}>
        <SplitView node={node.second} terminalsById={terminalsById} workspace={workspace} project={project} visible={visible} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} activeTerminalId={activeTerminalId} displayedMaximizedTerminalId={effectiveDisplayedMaximizedTerminalId} searchTerminalRequest={searchTerminalRequest} restartTerminalRequest={restartTerminalRequest} path={path ? `${path}.second` : 'second'} onResizeSplit={onResizeSplit} onFocus={onFocus} onClose={onClose} onSplitTerminal={onSplitTerminal} canToggleMaximize={canToggleMaximize} onToggleMaximize={onToggleMaximize} />
      </div>
    </div>
  );
}

type TerminalRequest = { terminalId: string; nonce: number };

