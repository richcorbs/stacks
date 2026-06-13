import type { TerminalEntry, Project, WorkspaceEntry } from '../types';
import { useTerminalSelectionCopy } from '../hooks/useTerminalSelectionCopy';
import { useTerminalSearch } from '../hooks/useTerminalSearch';
import { useTerminalOptions } from '../hooks/useTerminalOptions';
import { useTerminalRestartRequest } from '../hooks/useTerminalRestartRequest';
import { useTerminalActivation } from '../hooks/useTerminalActivation';
import { useTerminalSession } from '../hooks/useTerminalSession';
import { TerminalSearchOverlay } from './TerminalSearchOverlay';
import { TerminalControls } from './TerminalControls';

export function TerminalView({ terminal, workspace, project, active, maximized, visible, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, searchRequestNonce, restartRequestNonce, onFocus, onClose, onSplitTerminal, canToggleMaximize, onToggleMaximize }: {
  terminal: TerminalEntry;
  workspace: WorkspaceEntry;
  project: Project;
  active: boolean;
  maximized: boolean;
  visible: boolean;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  searchRequestNonce: number;
  restartRequestNonce: number;
  onFocus: () => void;
  onClose: () => void;
  onSplitTerminal: (direction: 'row' | 'column') => void;
  canToggleMaximize: boolean;
  onToggleMaximize: () => void;
}) {
  const search = useTerminalSearch(terminal.id, searchRequestNonce);
  const { hostRef, termRef, fitRef, restartTerminalSessionIfDead } = useTerminalSession({
    terminal,
    workspace,
    project,
    active,
    visible,
    terminalFontSize,
    terminalFontFamily,
    terminalScrollback,
    onSearchResultsChange: search.onSearchResultsChange,
  });
  const { beginSelectionCopy } = useTerminalSelectionCopy(termRef, copyOnSelect);
  useTerminalOptions({ terminalId: terminal.id, terminalFontSize, terminalFontFamily, terminalScrollback });
  useTerminalRestartRequest(restartRequestNonce, restartTerminalSessionIfDead);
  useTerminalActivation({ terminalId: terminal.id, active, visible, maximized, termRef, fitRef, restartTerminalSessionIfDead });

  return (
    <div
      className={`terminal ${active ? 'active' : ''} ${maximized ? 'maximized' : ''}`}
      onMouseDown={() => {
        beginSelectionCopy();
        restartTerminalSessionIfDead();
        if (!active) onFocus();
      }}
    >
      <TerminalControls
        maximized={maximized}
        canToggleMaximize={canToggleMaximize}
        onSplitTerminal={onSplitTerminal}
        onToggleMaximize={onToggleMaximize}
        onClose={onClose}
      />
      {search.searchOpen && (
        <TerminalSearchOverlay
          value={search.searchTerm}
          resultText={search.searchResultText}
          onChange={search.setSearchTerm}
          onNext={search.onNext}
          onPrevious={search.onPrevious}
          onClose={search.onClose}
        />
      )}
      <div className="terminalHostFrame">
        <div className="terminalHost" ref={hostRef} />
      </div>
    </div>
  );
}
