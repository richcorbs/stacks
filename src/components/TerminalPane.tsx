import type { Pane, Project, TerminalEntry } from '../types';
import { useTerminalSelectionCopy } from '../hooks/useTerminalSelectionCopy';
import { useTerminalPaneSearch } from '../hooks/useTerminalPaneSearch';
import { useTerminalPaneOptions } from '../hooks/useTerminalPaneOptions';
import { useTerminalPaneRestartRequest } from '../hooks/useTerminalPaneRestartRequest';
import { useTerminalPaneActivation } from '../hooks/useTerminalPaneActivation';
import { useTerminalPaneSession } from '../hooks/useTerminalPaneSession';
import { TerminalSearchOverlay } from './TerminalSearchOverlay';
import { PaneControls } from './PaneControls';

export function TerminalPane({ pane, terminal, project, active, maximized, visible, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, searchRequestNonce, restartRequestNonce, onFocus, onClose, onSplitPane, canToggleMaximize, onToggleMaximize }: {
  pane: Pane;
  terminal: TerminalEntry;
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
  onSplitPane: (direction: 'row' | 'column') => void;
  canToggleMaximize: boolean;
  onToggleMaximize: () => void;
}) {
  const search = useTerminalPaneSearch(pane.id, searchRequestNonce);
  const { hostRef, termRef, fitRef, restartPaneSessionIfDead } = useTerminalPaneSession({
    pane,
    terminal,
    project,
    active,
    visible,
    terminalFontSize,
    terminalFontFamily,
    terminalScrollback,
    onSearchResultsChange: search.onSearchResultsChange,
  });
  const { beginSelectionCopy } = useTerminalSelectionCopy(termRef, copyOnSelect);
  useTerminalPaneOptions({ paneId: pane.id, terminalFontSize, terminalFontFamily, terminalScrollback });
  useTerminalPaneRestartRequest(restartRequestNonce, restartPaneSessionIfDead);
  useTerminalPaneActivation({ paneId: pane.id, active, visible, maximized, termRef, fitRef, restartPaneSessionIfDead });

  return (
    <div
      className={`pane ${active ? 'active' : ''} ${maximized ? 'maximized' : ''}`}
      onMouseDown={() => {
        beginSelectionCopy();
        restartPaneSessionIfDead();
        if (!active) onFocus();
      }}
    >
      <PaneControls
        maximized={maximized}
        canToggleMaximize={canToggleMaximize}
        onSplitPane={onSplitPane}
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
