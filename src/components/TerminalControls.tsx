export function TerminalControls({ maximized, canToggleMaximize, broadcast, canBroadcast, onSplitTerminal, onToggleBroadcast, onToggleMaximize, onClose }: {
  maximized: boolean;
  canToggleMaximize: boolean;
  broadcast: boolean;
  canBroadcast: boolean;
  onSplitTerminal: (direction: 'row' | 'column') => void;
  onToggleBroadcast: () => void;
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
      {canBroadcast && (
        <button
          className={`terminalControlButton terminalBroadcastButton ${broadcast ? 'active' : ''}`}
          type="button"
          title={broadcast ? 'Stop broadcasting input to all terminals' : 'Broadcast input to all terminals'}
          aria-label={broadcast ? 'Stop broadcasting input to all terminals' : 'Broadcast input to all terminals'}
          aria-pressed={broadcast}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleBroadcast();
          }}
        >
          <svg className="terminalBroadcastIcon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4.9 19.1a10 10 0 0 1 0-14.2" />
            <path d="M7.8 16.2a6 6 0 0 1 0-8.5" />
            <circle cx="12" cy="12" r="2" />
            <path d="M16.2 7.8a6 6 0 0 1 0 8.5" />
            <path d="M19.1 4.9a10 10 0 0 1 0 14.2" />
          </svg>
        </button>
      )}
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
