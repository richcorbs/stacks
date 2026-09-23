import { useEffect, useLayoutEffect } from 'react';
import type { Project } from '../../types';
import type { KanbanCardSummary } from '../../kanban/types';
import { owningProject } from '../../kanban/projectScope';
import { useCardServices, type CardServices } from '../../kanban/useCardServices';
import { CardServiceTerminal } from './CardServiceTerminal';

export function cardServerAvailability(card: KanbanCardSummary, projects: Project[]) {
  const project = owningProject(card, projects);
  const command = project?.server_command?.trim() ?? '';
  const cardPath = card.environment?.worktree_path ?? null;
  const eligible = !card.hierarchy_finalized && Boolean(cardPath && command && project);
  return { eligible, project, command, cardPath };
}

function BoardCardServerHost({ card, projects, detailOpen, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, onServices }: {
  card: KanbanCardSummary;
  projects: Project[];
  detailOpen: boolean;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  onServices: (cardId: string, services: CardServices | null) => void;
}) {
  const availability = cardServerAvailability(card, projects);
  const consoleCommand = !card.hierarchy_finalized ? availability.project?.console_command?.trim() ?? '' : '';
  const services = useCardServices(
    card.id,
    availability.cardPath,
    availability.eligible ? availability.command : '',
    consoleCommand,
  );

  useLayoutEffect(() => {
    onServices(card.id, services);
  }, [card.id, onServices, services.consoleActive, services.consoleEnabled, services.consoleRestartNonce, services.consoleRunning, services.consoleStarting, services.serverActive, services.serverEnabled, services.serverRestartNonce, services.serverRunning, services.serverStarting, services.toggle]);

  useEffect(() => () => onServices(card.id, null), [card.id, onServices]);

  // Keep an off-screen, measurable owner while detail is closed. TerminalView
  // reattaches the cached xterm element to the visible detail host on handoff.
  if (!availability.eligible || !availability.project || !availability.cardPath || !services.serverEnabled || detailOpen) return null;
  return <div className="boardCardServerHost" aria-hidden="true">
    <CardServiceTerminal
      mode="server"
      command={availability.command}
      enabled
      active={false}
      background
      restartRequestNonce={services.serverRestartNonce}
      card={card}
      project={availability.project}
      cardPath={availability.cardPath}
      terminalFontSize={terminalFontSize}
      terminalFontFamily={terminalFontFamily}
      terminalScrollback={terminalScrollback}
      copyOnSelect={copyOnSelect}
    />
  </div>;
}

export function BoardCardServerServices({ cards, projects, detailCardId, terminalFontSize, terminalFontFamily, terminalScrollback, copyOnSelect, onServices }: {
  cards: KanbanCardSummary[];
  projects: Project[];
  detailCardId: string | null;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  copyOnSelect: boolean;
  onServices: (cardId: string, services: CardServices | null) => void;
}) {
  return <>{cards.map((card) => <BoardCardServerHost
    key={card.id}
    card={card}
    projects={projects}
    detailOpen={detailCardId === card.id}
    terminalFontSize={terminalFontSize}
    terminalFontFamily={terminalFontFamily}
    terminalScrollback={terminalScrollback}
    copyOnSelect={copyOnSelect}
    onServices={onServices}
  />)}</>;
}
