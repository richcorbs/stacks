import type { Project } from '../../../types';
import { ConfirmationBoundary } from '../../ConfirmationBoundary';
import type { PiMcpBannerModel } from './usePiMcpBanner';

export function PiMcpBanner({ model, project, cwd, terminalId, starting, mcpStatus, extensionNotice, onDismiss, onDismissCommand }: {
  model: PiMcpBannerModel;
  project: Project;
  cwd: string;
  terminalId: string;
  starting: boolean;
  mcpStatus: 'unknown' | 'connected' | 'failed';
  extensionNotice: string | null;
  onDismiss: () => void;
  onDismissCommand: () => void;
}) {
  const {
    bannerDismissed, commandVisible, active, sessionNames, local, confirmRestart, setConfirmRestart,
    confirmTrust, setConfirmTrust, trustChanged, requestRestart, trustDirectory,
  } = model;

  return <>
    {commandVisible && <PiMcpCommandStatus status={mcpStatus} notice={extensionNotice} onDismiss={onDismissCommand} />}
    {!bannerDismissed && (project.enable_mcp || active) && <div className="piMcpStatus" role="status">
      <button className="piMcpDismiss" type="button" aria-label="Dismiss MCP status" title="Dismiss MCP status" onMouseDown={(event) => event.preventDefault()} onClick={onDismiss}>×</button>
      <span>{active === null ? 'MCP status pending.' : active ? `MCP extension enabled in this Pi session (server status: ${mcpStatus}).` : 'MCP off in this Pi session.'} Enabled global servers in ~/.pi/agent/mcp.json may load when MCP is active.
        {project.enable_mcp && local && (!local.trusted && local.local_config_present ? ' Project .pi/mcp.json is skipped because this directory is untrusted.' : !local.local_config_present ? ' No .pi/mcp.json in this session’s working directory; worktrees do not inherit one.' : '')}
        {' '}Run /mcp in Pi for connection status. Do not paste credentials into a card chat.
        {local?.trusted && local.local_config_present && ' Project config present and trusted.'}
        {extensionNotice && <> {extensionNotice}</>}
        {sessionNames !== null && sessionNames !== (project.mcp_env_names ?? '') && ' Approved environment names changed; restart Pi to apply them.'}
        {trustChanged && ' Trust changed; restart Pi to apply it.'}</span>
      {project.enable_mcp && local?.local_config_present && !local.trusted && <button type="button" onClick={() => setConfirmTrust(true)}>Trust this directory for Pi</button>}
      {active !== null && (active !== (project.enable_mcp ?? false) || trustChanged || (sessionNames !== null && sessionNames !== (project.mcp_env_names ?? ''))) && <button type="button" disabled={starting} onClick={requestRestart}>Restart Pi to apply setting</button>}
    </div>}
    {confirmTrust && <ConfirmationBoundary key={cwd}><div onKeyDown={(e) => { if (e.key === 'Escape') setConfirmTrust(false); }} className="piMcpRestartConfirm" role="alertdialog" aria-label="Trust this directory for Pi?"><span>Trust grants Pi access to project-local settings and resources, not only MCP servers. Trust this working directory?</span><button type="button" onClick={() => setConfirmTrust(false)}>Cancel</button><button type="button" onClick={trustDirectory} data-card-action="embedded-primary" className="primaryAction">Trust directory</button></div></ConfirmationBoundary>}
    {confirmRestart && <ConfirmationBoundary key={terminalId}><div onKeyDown={(e) => { if (e.key === 'Escape') setConfirmRestart(false); }} className="piMcpRestartConfirm" role="alertdialog" aria-label="Restart active Pi session?"><span>Pi is running or has pending work. Restarting will interrupt it; the saved conversation will be resumed. Restart now?</span><button type="button" onClick={() => setConfirmRestart(false)}>Cancel</button><button type="button" onClick={() => { setConfirmRestart(false); void model.requestRestart(); }} data-card-action="embedded-primary" className="primaryAction">Restart Pi</button></div></ConfirmationBoundary>}
  </>;
}

export function PiMcpCommandStatus({ status, notice, onDismiss }: { status: 'unknown' | 'connected' | 'failed'; notice: string | null; onDismiss: () => void }) {
  return <div className="piMcpCommandStatus" role="status" aria-live="polite">
    <span>MCP connection: {status}.{notice ? ` ${notice}` : ' Waiting for Pi status; check the MCP configuration if this does not update.'}</span>
    <button type="button" aria-label="Dismiss MCP command status" onMouseDown={(event) => event.preventDefault()} onClick={onDismiss}>×</button>
  </div>;
}
