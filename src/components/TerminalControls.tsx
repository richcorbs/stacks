export function TerminalControls({ maximized, canToggleMaximize, onSplitTerminal, onToggleMaximize, onClose }: {
  maximized: boolean;
  canToggleMaximize: boolean;
  onSplitTerminal: (direction: 'row' | 'column') => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}) {
  return (
    <div className="terminalControls" onMouseDown={(e) => e.stopPropagation()}>
      <button
        className="terminalControlButton"
        type="button"
        title="Split terminal right (⌘D)"
        aria-label="Split terminal right"
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onSplitTerminal('row');
        }}
      >
        <span className="splitIcon splitIconVertical" />
      </button>
      <button
        className="terminalControlButton"
        type="button"
        title="Split terminal down (⇧⌘D)"
        aria-label="Split terminal down"
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onSplitTerminal('column');
        }}
      >
        <span className="splitIcon splitIconHorizontal" />
      </button>
      {canToggleMaximize && (
        <>
          <button
            className="terminalControlButton"
            type="button"
            title={maximized ? 'Restore workspace (⇧⌘↩)' : 'Maximize workspace (⇧⌘↩)'}
            aria-label={maximized ? 'Restore workspace' : 'Maximize workspace'}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleMaximize();
            }}
          >
            <span className="terminalMaximizeIcon" />
          </button>
          <button
            className="terminalControlButton terminalCloseButton"
            type="button"
            title="Close terminal (⌘W)"
            aria-label="Close terminal"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }}
          >
            <span className="terminalCloseIcon">&times;</span>
          </button>
        </>
      )}
    </div>
  );
}
