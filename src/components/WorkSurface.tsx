import { Fragment, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { applicationEvents } from '../applicationEvents';
import { publishWorkPresence, type AgentThread } from '../appAttention';
import { publishCardTerminalContext, type CardTerminalContext } from '../cardTerminalCommands';
import { composeDiffReviewPrompt } from '../diffReview/prompt';
import { useDiffReview } from '../diffReview/useDiffReview';
import type { DiffReviewModel } from '../diffReview/types';
import { resolveWorkNavigation, workOwnerId, type WorkOwner, type WorkView } from '../directWork';
import { sendTextToPiEditor } from '../pi/editorTextEvent';
import { pasteCodeIntoTarget } from '../terminalCodePaste';
import type { WorkSurfaceSection } from '../workSurface';
import type { PasteIntoTerminal } from './PiMarkdown';
import { ProjectNotesView } from './ProjectNotesView';

export type WorkSurfaceAgent = {
  /** Agent pane id used for presence and diff-review submission. */
  id: string;
  thread?: AgentThread;
  render: (active: boolean, onPasteIntoTerminal?: PasteIntoTerminal) => ReactNode;
};

export type WorkSurfaceDiff = {
  reviewKey: string | null;
  canSubmit: boolean;
  render: (state: {
    active: boolean;
    review: DiffReviewModel;
    canSubmit: boolean;
    onSubmit: () => void;
    onClose: () => void;
  }) => ReactNode;
  errorMessage: string;
};

export type WorkSurfaceNotes = {
  projectId: string;
  focusRequest?: number;
};

export type WorkSurfaceTerminal = {
  focusedPaneId: string | null;
  paneIds: string[];
  cwd: string | null;
  maximized: boolean;
  services?: CardTerminalContext['services'];
  /** The Terminal tab can be selected. */
  available: boolean;
  /** The agent transcript may offer "paste into terminal". */
  pasteAvailable: boolean;
  pasteUnavailableReason?: string | null;
  render: (active: boolean) => ReactNode;
};

export type WorkSurfaceAdapter = {
  activeView: WorkView;
  /** Navigable tabs, in visual order (Cmd-] cycling). */
  available: WorkView[];
  /** Rendered tabs, including disabled ones (Cmd-# numbering). */
  displayed: WorkView[];
  /** Sections in render order; shared views are filled in by the surface. */
  sections: WorkSurfaceSection[];
  selectView: (view: WorkView) => boolean | Promise<boolean>;
  renderTabs: () => ReactNode;
  agent?: WorkSurfaceAgent;
  diff?: WorkSurfaceDiff;
  notes?: WorkSurfaceNotes;
  terminal: WorkSurfaceTerminal;
  onError: (message: string) => void;
};

export type WorkSurfaceProps = {
  owner: WorkOwner;
  tabs: WorkSurfaceAdapter;
  header: ReactNode;
  onRequestClose: () => void;
  className?: string;
  projectColor?: string;
  /** Host chrome immediately below the tab strip (e.g. the project action error). */
  status?: ReactNode;
  /** Host content after all tab sections (e.g. the card workflow footer). */
  children?: ReactNode;
  /** Dialogs and confirmations rendered outside the backdrop. */
  overlays?: ReactNode;
};

/**
 * The card detail dialog and the Project Workspace are the same screen. This
 * component owns the shared behaviour; each host supplies only the pieces that
 * genuinely differ through its adapter.
 */
export function WorkSurface({ owner, tabs, header, onRequestClose, className, projectColor, status, children, overlays }: WorkSurfaceProps) {
  const { activeView, available, displayed, sections, selectView, agent, diff, notes, terminal, onError } = tabs;
  const review = useDiffReview(diff?.reviewKey ?? null);
  const agentActive = activeView === 'agent';

  // Keep the paste callback identity stable: the memoized agent transcript must
  // not re-render every message because this surface did.
  const pasteRef = useRef<(code: string) => Promise<boolean>>(async () => false);
  pasteRef.current = (code) => pasteCodeIntoTarget(code, {
    paneId: terminal.focusedPaneId || terminal.paneIds[0] || '',
    unavailableReason: terminal.pasteAvailable ? null : terminal.pasteUnavailableReason ?? 'no terminal is open',
    switchToTerminal: () => selectView('terminal'),
  });
  const onPasteIntoTerminal = useCallback((code: string) => pasteRef.current(code), []);

  function submitDiffReview() {
    if (!diff || !agent) return;
    const prompt = composeDiffReviewPrompt(review.overallComment, review.comments);
    void selectView('agent');
    requestAnimationFrame(() => sendTextToPiEditor(agent.id, prompt).then((delivered) => {
      if (delivered) review.reset();
      else onError(diff.errorMessage);
    }));
  }

  function closeDiff() {
    review.reset();
    void selectView('agent');
  }

  useEffect(() => {
    const terminalId = activeView === 'agent' ? agent?.id
      : activeView === 'terminal' ? terminal.focusedPaneId ?? undefined : undefined;
    publishWorkPresence({ owner, view: activeView, agentThread: activeView === 'agent' ? agent?.thread : undefined, terminalId });
    return () => publishWorkPresence(null);
  }, [activeView, agent?.id, agent?.thread, owner, terminal.focusedPaneId]);

  useEffect(() => {
    publishCardTerminalContext({
      ownerId: workOwnerId(owner),
      active: activeView === 'terminal',
      focusedPaneId: activeView === 'terminal' ? terminal.focusedPaneId : null,
      paneIds: terminal.paneIds,
      cwd: terminal.cwd,
      maximized: terminal.maximized,
      services: terminal.services,
    });
    return () => publishCardTerminalContext(null);
  }, [activeView, owner, terminal.cwd, terminal.focusedPaneId, terminal.maximized, terminal.paneIds, terminal.services]);

  useEffect(() => {
    const handleTabShortcut = (shortcut: { number?: number; direction?: -1 | 1 }) => {
      const command = shortcut.number
        ? { type: 'number' as const, number: shortcut.number }
        : shortcut.direction ? { type: 'cycle' as const, direction: shortcut.direction } : null;
      if (!command) return;
      const target = resolveWorkNavigation(activeView, available, displayed, command);
      if (target) void selectView(target);
    };
    return applicationEvents.subscribe('card-tab-shortcut', handleTabShortcut);
  }, [activeView, available, displayed, selectView]);

  return <>
    <div className="modalBackdrop kanbanDetailBackdrop" onMouseDown={onRequestClose}>
      <article
        data-project-color={projectColor}
        className={`kanbanDetail cardWorkspace${agentActive ? ' chatActive' : ''}${className ? ` ${className}` : ''}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {header}
        {tabs.renderTabs()}
        {status}
        {sections.map((section) => {
          const active = section.view === activeView;
          if (section.view === 'agent') return agent
            ? <Fragment key="agent">{agent.render(active, terminal.pasteAvailable ? onPasteIntoTerminal : undefined)}</Fragment>
            : null;
          if (section.view === 'notes') return notes
            ? <ProjectNotesView key={notes.projectId} projectId={notes.projectId} active={active} focusRequest={notes.focusRequest} />
            : null;
          if (section.view === 'diff') return diff
            ? <Fragment key="diff">{diff.render({ active, review, canSubmit: diff.canSubmit, onSubmit: submitDiffReview, onClose: closeDiff })}</Fragment>
            : null;
          if (section.view === 'terminal') return <section key="terminal" className={`cardTerminalView cardView${active ? ' active' : ''}`}>{terminal.render(active)}</section>;
          return <Fragment key={section.view}>{section.content?.(active)}</Fragment>;
        })}
        {children}
      </article>
    </div>
    {overlays}
  </>;
}
