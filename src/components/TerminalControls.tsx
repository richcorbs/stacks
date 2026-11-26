export type TerminalServiceControls = {
  serverConfigured: boolean;
  consoleConfigured: boolean;
  serverRunning: boolean;
  consoleRunning: boolean;
  serverError: string | null;
  consoleError: string | null;
  onStartServer: () => void;
  onStartConsole: () => void;
};

function ServiceButton({ label, running, error, glyph, onToggle }: {
  label: 'server' | 'console';
  running: boolean;
  error: string | null;
  glyph: 'server' | 'console';
  onToggle: () => void;
}) {
  const action = running ? 'Stop' : 'Start';
  return <button
    className={`terminalControlButton terminalServiceButton${running ? ' active' : ''}${error ? ' failed' : ''}`}
    type="button"
    title={`${action} ${label}${error ? ` — ${error}` : ''}`}
    aria-label={`${action} ${label}`}
    aria-pressed={running}
    onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
    onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(); }}
  >
    {glyph === 'server' ? <ServerGlyph /> : <SquareTerminalGlyph />}
  </button>;
}

function ServerGlyph() {
  return <svg className="terminalServiceIcon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
    <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
    <line x1="6" x2="6.01" y1="6" y2="6" />
    <line x1="6" x2="6.01" y1="18" y2="18" />
  </svg>;
}

function SquareTerminalGlyph() {
  return <svg className="terminalServiceIcon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m7 11 2-2-2-2" />
    <path d="M11 13h4" />
    <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
  </svg>;
}

export function TerminalControls({ maximized, canToggleMaximize, canClose = canToggleMaximize, canEdit = true, serviceControls, onSplitTerminal, onEditTerminal, onToggleMaximize, onClose }: {
  maximized: boolean;
  canToggleMaximize: boolean;
  canClose?: boolean;
  canEdit?: boolean;
  serviceControls?: TerminalServiceControls;
  onSplitTerminal: (direction: 'row' | 'column') => void;
  onEditTerminal: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}) {
  return (
    <div className="terminalControls" onMouseDown={(e) => e.stopPropagation()}>
      {serviceControls?.serverConfigured && <ServiceButton label="server" running={serviceControls.serverRunning} error={serviceControls.serverError} glyph="server" onToggle={serviceControls.onStartServer} />}
      {serviceControls?.consoleConfigured && <ServiceButton label="console" running={serviceControls.consoleRunning} error={serviceControls.consoleError} glyph="console" onToggle={serviceControls.onStartConsole} />}
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
      )}
      {canClose && <button
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
          </button>}

    </div>
  );
}
