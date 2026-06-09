export function PaneControls({ maximized, canToggleMaximize, onSplitPane, onToggleMaximize, onClose }: {
  maximized: boolean;
  canToggleMaximize: boolean;
  onSplitPane: (direction: 'row' | 'column') => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}) {
  return (
    <div className="paneControls" onMouseDown={(e) => e.stopPropagation()}>
      <button
        className="paneControlButton"
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
          onSplitPane('row');
        }}
      >
        <span className="splitIcon splitIconVertical" />
      </button>
      <button
        className="paneControlButton"
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
          onSplitPane('column');
        }}
      >
        <span className="splitIcon splitIconHorizontal" />
      </button>
      {canToggleMaximize && (
        <>
          <button
            className="paneControlButton"
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
            <span className="paneMaximizeIcon" />
          </button>
          <button
            className="paneControlButton paneCloseButton"
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
            <span className="paneCloseIcon">&times;</span>
          </button>
        </>
      )}
    </div>
  );
}
