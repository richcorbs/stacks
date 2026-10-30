import { Suspense } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Project, WorkspaceEntry } from '../types';
import { serviceStoppedMessage } from '../managedServices';
import { TerminalView } from './TerminalView';

const encoder = new TextEncoder();

/** Rendering never owns process cleanup: managed-service state and the session cache do. */
export function WorkServiceTerminal({ mode, command, enabled, active, background = false, restartRequestNonce, project, workspace, terminalId, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect }: {
  mode: 'server' | 'console'; command: string; enabled: boolean; active: boolean; background?: boolean;
  restartRequestNonce: number; project: Project; workspace: WorkspaceEntry; terminalId: string;
  terminalFontSize: number; terminalFontFamily: string; terminalScrollback: number; copyOnSelect: boolean;
}) {
  return <section className={`cardServiceView cardView${active ? ' active' : ''}${background ? ' background' : ''}`} aria-label={`${mode} terminal`}>
    {enabled ? <Suspense fallback={<div className="kanbanEmpty">Starting {mode}…</div>}>
      <TerminalView terminal={{ id: terminalId, workspaceId: workspace.id, command, cwd: workspace.cwd, temporary: true }}
        workspace={workspace} project={project} active={active} visible={active} maximized={false} managedService
        terminalFontSize={terminalFontSize} terminalFontFamily={terminalFontFamily} terminalScrollback={terminalScrollback} copyOnSelect={copyOnSelect}
        searchRequestNonce={0} restartRequestNonce={restartRequestNonce}
        onFocus={() => {}} onClose={() => {}} onSplitTerminal={() => {}} onEditTerminal={() => {}}
        onInput={(id, data) => invoke('write_pty', { terminalId: id, data: Array.from(encoder.encode(data)) }).catch(console.error)}
        canToggleMaximize={false} onToggleMaximize={() => {}} />
    </Suspense> : <div className="kanbanEmpty">{serviceStoppedMessage(mode)}</div>}
  </section>;
}
