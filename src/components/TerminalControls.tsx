export function TerminalControls({ maximized, canToggleMaximize, canEdit = true, onSplitTerminal, onEditTerminal, onToggleMaximize, onClose }: {
  maximized: boolean;
  canToggleMaximize: boolean;
  canEdit?: boolean;
  onSplitTerminal: (direction: 'row' | 'column') => void;
  onEditTerminal: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}) {
  return (
    <div className="terminalControls" onMouseDown={(e) => e.stopPropagation()}>
      <button
        className="terminalControlButton"
        type="button"
        title="Split pane right (⌘D)"
        aria-label="Split pane right"
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
        title="Split pane down (⇧⌘D)"
        aria-label="Split pane down"
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
      {canEdit && <button
        className="terminalControlButton"
        type="button"
        title="Edit pane"
        aria-label="Edit pane"
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onEditTerminal();
        }}
      >
        <span className="terminalEditIcon">✎</span>
      </button>}
      {canToggleMaximize && (
        <>
          <button
            className="terminalControlButton"
            type="button"
            title={maximized ? 'Restore pane (⇧⌘↩)' : 'Maximize pane (⇧⌘↩)'}
            aria-label={maximized ? 'Restore pane' : 'Maximize pane'}
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
            title="Close pane (⌘W)"
            aria-label="Close pane"
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
