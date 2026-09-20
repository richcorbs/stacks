import { useSyncExternalStore } from 'react';
import type { Project, WorkspaceEntry } from '../types';
import type { WorkspaceShellController } from '../workspaceShellController';
import { SplitView } from './WorkspaceTerminalTree';

export function useWorkspaceShell(controller: WorkspaceShellController) {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}

export function WorkspaceShellView({ controller, workspace, project, visible, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect }: {
  controller: WorkspaceShellController;
  workspace: WorkspaceEntry;
  project: Project;
  visible: boolean;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
}) {
  const shell = useWorkspaceShell(controller);
  if (shell.tree.kind === 'empty') return <div className="kanbanEmpty">Terminal closed.</div>;
  return <div className={`cardTerminalPane${shell.paneIds.length > 1 ? ' multiple' : ''}`}>
    <SplitView
      node={shell.tree}
      terminalsById={shell.panes}
      workspace={workspace}
      project={project}
      visible={visible}
      canEditTerminal={false}
      terminalFontSize={terminalFontSize}
      terminalFontFamily={terminalFontFamily}
      terminalScrollback={terminalScrollback}
      copyOnSelect={copyOnSelect}
      activeTerminalId={shell.focusedPaneId}
      displayedMaximizedTerminalId={shell.maximizedPaneId}
      searchTerminalRequest={shell.searchRequest}
      restartTerminalRequest={shell.restartRequest}
      path=""
      onResizeSplit={(path, ratio) => controller.resize(path, ratio)}
      onFocus={(pane) => controller.focus(pane)}
      onClose={(pane) => controller.requestClose(pane)}
      onSplitTerminal={(direction, pane) => void controller.split(direction, pane)}
      onEditTerminal={() => {}}
      onInput={(terminalId, data) => controller.write(terminalId, data)}
      canToggleMaximize={shell.paneIds.length > 1}
      onToggleMaximize={(pane) => controller.toggleMaximize(pane)}
    />
  </div>;
}
