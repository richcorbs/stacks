import { Suspense } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Project } from '../../types';
import type { KanbanCard } from '../../kanban/types';
import type { CardServiceMode } from '../../kanban/cardWorkspace';
import { cardTerminalId, cardWorkspaceId } from '../../kanban/cardWorkspace';
import { serviceStoppedMessage } from '../../managedServices';
import { TerminalView } from '../TerminalView';

const encoder = new TextEncoder();

export function CardServiceTerminal({ mode, command, enabled, active, background = false, restartRequestNonce, card, project, cardPath, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect }: {
  mode: CardServiceMode;
  command: string;
  enabled: boolean;
  active: boolean;
  background?: boolean;
  restartRequestNonce: number;
  card: Pick<KanbanCard, 'id' | 'external_id'>;
  project: Project;
  cardPath: string;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
}) {
  return <section className={`cardServiceView cardView${active ? ' active' : ''}${background ? ' background' : ''}`} aria-label={`${mode} terminal`}>
    {enabled ? <Suspense fallback={<div className="kanbanEmpty">Starting {mode}…</div>}>
      <TerminalView
        terminal={{ id: cardTerminalId(card.id, mode), workspaceId: cardWorkspaceId(card.id), command, cwd: cardPath, temporary: true }}
        workspace={{ id: cardWorkspaceId(card.id), name: `Card #${card.external_id}`, cwd: cardPath }}
        project={project}
        active={active}
        visible={active}
        maximized={false}
        managedService
        terminalFontSize={terminalFontSize}
        terminalFontFamily={terminalFontFamily}
        terminalScrollback={terminalScrollback}
        copyOnSelect={copyOnSelect}
        searchRequestNonce={0}
        restartRequestNonce={restartRequestNonce}
        onFocus={() => {}}
        onClose={() => {}}
        onSplitTerminal={() => {}}
        onEditTerminal={() => {}}
        onInput={(terminalId, data) => invoke('write_pty', { terminalId, data: Array.from(encoder.encode(data)) }).catch(console.error)}
        canToggleMaximize={false}
        onToggleMaximize={() => {}}
      />
    </Suspense> : <div className="kanbanEmpty">{serviceStoppedMessage(mode)}</div>}
  </section>;
}
