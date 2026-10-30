import { lazy, Suspense, type ReactNode } from 'react';
import type { PaneEntry, Project, WorkspaceEntry } from '../types';

const PiGuiView = lazy(() => import('./PiGuiView').then((module) => ({ default: module.PiGuiView })));

/** Ownership, agent thread, and working directory are supplied by the entry point. */
export function WorkAgentView({ terminal, workspace, project, active, label, openingMessage, children }: {
  terminal: PaneEntry; workspace: WorkspaceEntry; project: Project; active: boolean;
  label: string; openingMessage: string; children?: ReactNode;
}) {
  return <section className={`cardChatView cardView${active ? ' active' : ''}`} aria-label={label}><div className="cardChat">
    {children}
    <Suspense fallback={<div className="kanbanEmpty">{openingMessage}</div>}>
      <PiGuiView key={terminal.id} terminal={terminal} workspace={workspace} project={project} active={active} visible={active} maximized={false} canToggleMaximize={false} restartRequestNonce={0} fontSize={13} onFocus={() => {}} onClose={() => {}} onSplitTerminal={() => {}} onEditTerminal={() => {}} onToggleMaximize={() => {}} />
    </Suspense>
  </div></section>;
}
