import { lazy, Suspense } from 'react';
import type { TerminalEntry, Project, SplitNode, WorkspaceEntry } from '../types';
import { TerminalView } from './TerminalView';
import { SplitResizeHandle } from './SplitResizeHandle';

const PiGuiView = lazy(() => import('./PiGuiView').then((module) => ({ default: module.PiGuiView })));

export function SplitView({ node, terminalsById, workspace, project, visible, broadcast, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, activeTerminalId, displayedMaximizedTerminalId, searchTerminalRequest, restartTerminalRequest, path, onResizeSplit, onFocus, onClose, onSplitTerminal, onEditTerminal, onToggleBroadcast, onInput, canToggleMaximize, onToggleMaximize }: {
  node: SplitNode;
  terminalsById: Record<string, TerminalEntry>;
  workspace: WorkspaceEntry;
  project: Project;
  visible: boolean;
  broadcast: boolean;
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
  onEditTerminal: (workspaceId: string, terminalId: string) => void;
  onToggleBroadcast: (workspaceId: string) => void;
  onInput: (terminalId: string, data: string) => void;
  canToggleMaximize: boolean;
  onToggleMaximize: (terminalId: string) => void;
}) {
  const effectiveDisplayedMaximizedTerminalId = displayedMaximizedTerminalId && terminalsById[displayedMaximizedTerminalId] ? displayedMaximizedTerminalId : null;
  if (node.kind === 'empty') return null;
  if (node.kind === 'leaf') {
    const terminal = terminalsById[node.terminalId];
    if (!terminal) return null;
    const isDisplayed = visible && (!effectiveDisplayedMaximizedTerminalId || effectiveDisplayedMaximizedTerminalId === terminal.id);
    const paneKind = node.paneKind ?? terminal.kind ?? 'terminal';
    if (paneKind === 'pi') {
      return (
        <Suspense fallback={<div className="terminal piGuiPane"><div className="piGuiEmpty">Loading Pi GUI…</div></div>}>
        <PiGuiView
          terminal={terminal}
          workspace={workspace}
          project={project}
          active={isDisplayed && activeTerminalId === terminal.id}
          maximized={effectiveDisplayedMaximizedTerminalId === terminal.id}
          visible={isDisplayed}
          canToggleMaximize={canToggleMaximize}
          restartRequestNonce={restartTerminalRequest?.terminalId === terminal.id ? restartTerminalRequest.nonce : 0}
          fontSize={terminalFontSize}
          onFocus={() => onFocus(terminal.id)}
          onClose={() => onClose(terminal.id)}
          onSplitTerminal={(direction) => onSplitTerminal(direction, terminal.id)}
          onEditTerminal={() => onEditTerminal(workspace.id, terminal.id)}
          onToggleMaximize={() => onToggleMaximize(terminal.id)}
        />
        </Suspense>
      );
    }
    return (
      <TerminalView
        terminal={terminal}
        workspace={workspace}
        project={project}
        active={isDisplayed && activeTerminalId === terminal.id}
        maximized={effectiveDisplayedMaximizedTerminalId === terminal.id}
        visible={isDisplayed}
        broadcast={broadcast}
        canBroadcast={Object.values(terminalsById).filter((pane) => pane.kind !== 'pi').length > 1}
        terminalFontSize={terminalFontSize}
        terminalFontFamily={terminalFontFamily}
        terminalScrollback={terminalScrollback}
        copyOnSelect={copyOnSelect}
        searchRequestNonce={searchTerminalRequest?.terminalId === terminal.id ? searchTerminalRequest.nonce : 0}
        restartRequestNonce={restartTerminalRequest?.terminalId === terminal.id ? restartTerminalRequest.nonce : 0}
        onFocus={() => onFocus(terminal.id)}
        onClose={() => onClose(terminal.id)}
        onSplitTerminal={(direction) => onSplitTerminal(direction, terminal.id)}
        onEditTerminal={() => onEditTerminal(workspace.id, terminal.id)}
        onToggleBroadcast={() => onToggleBroadcast(workspace.id)}
        onInput={onInput}
        canToggleMaximize={canToggleMaximize}
        onToggleMaximize={() => onToggleMaximize(terminal.id)}
      />
    );
  }
  const ratio = node.ratio ?? 0.5;
  return (
    <div className={`split split-${node.direction}`}>
      <div className="splitChild" style={{ flex: `${ratio} 1 0` }}>
        <SplitView node={node.first} terminalsById={terminalsById} workspace={workspace} project={project} visible={visible} broadcast={broadcast} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} activeTerminalId={activeTerminalId} displayedMaximizedTerminalId={effectiveDisplayedMaximizedTerminalId} searchTerminalRequest={searchTerminalRequest} restartTerminalRequest={restartTerminalRequest} path={path ? `${path}.first` : 'first'} onResizeSplit={onResizeSplit} onFocus={onFocus} onClose={onClose} onSplitTerminal={onSplitTerminal} onEditTerminal={onEditTerminal} onToggleBroadcast={onToggleBroadcast} onInput={onInput} canToggleMaximize={canToggleMaximize} onToggleMaximize={onToggleMaximize} />
      </div>
      <SplitResizeHandle direction={node.direction} onResize={(nextRatio) => onResizeSplit(path, nextRatio)} />
      <div className="splitChild" style={{ flex: `${1 - ratio} 1 0` }}>
        <SplitView node={node.second} terminalsById={terminalsById} workspace={workspace} project={project} visible={visible} broadcast={broadcast} terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect} activeTerminalId={activeTerminalId} displayedMaximizedTerminalId={effectiveDisplayedMaximizedTerminalId} searchTerminalRequest={searchTerminalRequest} restartTerminalRequest={restartTerminalRequest} path={path ? `${path}.second` : 'second'} onResizeSplit={onResizeSplit} onFocus={onFocus} onClose={onClose} onSplitTerminal={onSplitTerminal} onEditTerminal={onEditTerminal} onToggleBroadcast={onToggleBroadcast} onInput={onInput} canToggleMaximize={canToggleMaximize} onToggleMaximize={onToggleMaximize} />
      </div>
    </div>
  );
}

type TerminalRequest = { terminalId: string; nonce: number };

