import { applicationEvents } from '../applicationEvents';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, TerminalEntry, WorkspaceEntry } from '../types';
import { projectColorAttribute } from '../projectColor';

import { usePiSession } from '../pi/usePiSession';
import { useComposerDraft } from '../pi/useComposerDraft';
import { TerminalControls } from './TerminalControls';
import { PiPendingOutput, PiQueuedMessage } from './piGui/pendingOutput/PiPendingOutput';
import { PiTranscriptBody } from './piGui/transcript/PiTranscriptBody';
import { isStructuredPiUiRequest } from './PiStructuredRequest';
import { PiMcpBanner, PiMcpCommandStatus } from './piGui/mcp/PiMcpBanner';
import { useMcpBannerDismissal, usePiMcpBanner } from './piGui/mcp/usePiMcpBanner';
import { PiContextBar } from './piGui/modelPicker/PiContextBar';
import { usePiModelPicker } from './piGui/modelPicker/usePiModelPicker';
import { PiSelectionPopup } from './piGui/selectionPopup/PiSelectionPopup';
import { usePiSelectionPopup } from './piGui/selectionPopup/usePiSelectionPopup';
import { usePiPathReferences } from './piGui/pathReferences/usePiPathReferences';
import { usePiFileDrops } from './piGui/fileDrops/usePiFileDrops';
import { PiComposer, PiQuickResponses } from './piGui/composer/PiComposer';
import { usePiComposer } from './piGui/composer/usePiComposer';
import { usePiComposerHistory } from './piGui/composer/usePiComposerHistory';
import { usePiComposerKeys } from './piGui/composer/usePiComposerKeys';
import { PiExtensionDialog } from './piGui/extensionDialog/PiExtensionDialog';
import { usePiTranscriptScroll } from './piGui/transcript/usePiTranscriptScroll';
import { usePiGuiLifecycle } from './piGui/lifecycle/usePiGuiLifecycle';

export { PiPendingOutput, PiQueuedMessage, PiMcpCommandStatus, useMcpBannerDismissal };

export function PiGuiView({ terminal, workspace, project, active, visible, maximized, canToggleMaximize, restartRequestNonce, fontSize, composerDraftKey, onFocus, onClose, onSplitTerminal, onEditTerminal, onToggleMaximize }: {
  terminal: TerminalEntry;
  workspace: WorkspaceEntry;
  project: Project;
  active: boolean;
  visible: boolean;
  maximized: boolean;
  canToggleMaximize: boolean;
  restartRequestNonce: number;
  fontSize: number;
  composerDraftKey?: string;
  onFocus: () => void;
  onClose: () => void;
  onSplitTerminal: (direction: 'row' | 'column') => void;
  onEditTerminal: () => void;
  onToggleMaximize: () => void;
}) {
  const cwd = terminal.cwd || workspace.cwd || project.path;
  const pi = usePiSession(terminal.id, cwd, workspace.id, project.id, project.path);
  const modalUiRequest = pi.uiRequest && !isStructuredPiUiRequest(pi.uiRequest) ? pi.uiRequest : null;
  const { prompt, setPrompt, beginSubmission } = useComposerDraft(composerDraftKey);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [composerError, setComposerError] = useState<string | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const selectionRef = useRef({ start: 0, end: 0 });
  const cutCaretRef = useRef<number | null>(null);
  const mcp = usePiMcpBanner({ terminalId: terminal.id, cwd, project, pi, setComposerError });
  const transcript = usePiTranscriptScroll({ pi, terminalId: terminal.id, visible });

  usePiGuiLifecycle({ pi, terminalId: terminal.id, projectId: project.id, active, visible, restartRequestNonce });

  const composerFocusAllowed = active && visible && !pi.starting && !modalUiRequest && !mcp.confirmTrust && !mcp.confirmRestart;
  // scheduleComposerFocus is also called by UI handlers, and the ref read must
  // happen inside the deferred animation frame. That is not an effect-owned
  // subscription, so it stays mutable focus state rather than an Effect Event.
  const composerFocusAllowedRef = useRef(composerFocusAllowed);
  composerFocusAllowedRef.current = composerFocusAllowed;
  const scheduleComposerFocus = useCallback(() => {
    if (!composerFocusAllowed) return;
    requestAnimationFrame(() => {
      // Recheck current state: a dialog or pane switch can happen before this frame.
      if (!composerFocusAllowedRef.current) return;
      inputRef.current?.focus();
    });
  }, [composerFocusAllowed]);

  const modelPicker = usePiModelPicker({ pi, onFocusComposer: scheduleComposerFocus });
  const selection = usePiSelectionPopup({ paneRef, setPrompt, onFocusComposer: scheduleComposerFocus });
  useEffect(() => {
    scheduleComposerFocus();
    const focusRequestedPane = (request: { terminalId?: string }) => {
      if (request.terminalId === terminal.id) scheduleComposerFocus();
    };
    window.addEventListener('focus', scheduleComposerFocus);
    const unsubscribe = applicationEvents.subscribe('pane-focus-request', focusRequestedPane);
    return () => {
      window.removeEventListener('focus', scheduleComposerFocus);
      unsubscribe();
    };
  }, [scheduleComposerFocus, terminal.id]);

  useEffect(() => {
    if (!modalUiRequest && !mcp.confirmTrust && !mcp.confirmRestart) scheduleComposerFocus();
  }, [mcp.confirmRestart, mcp.confirmTrust, modalUiRequest, scheduleComposerFocus]);

  const paths = usePiPathReferences({ prompt, cwd, commands: pi.commands, setComposerError });
  usePiFileDrops({
    terminalId: terminal.id,
    cwd,
    prompt,
    selectionRef,
    inputRef,
    setPrompt,
    setComposerError,
    setSelectedCommandIndex,
    setCompletionCursor: paths.setCompletionCursor,
    onFocusComposer: scheduleComposerFocus,
  });

  const history = usePiComposerHistory({
    prompt,
    setPrompt,
    messages: pi.messages,
    inputRef,
    setSelectedCommandIndex,
  });
  const composer = usePiComposer({
    pi,
    composerDraftKey,
    prompt,
    setPrompt,
    beginSubmission,
    paths,
    history,
    selectedCommandIndex,
    setSelectedCommandIndex,
    inputRef,
    selectionRef,
    cutCaretRef,
    paneRef,
    chatScrollRef: transcript.chatScrollRef,
    setComposerError,
    onFocusComposer: scheduleComposerFocus,
    onMcpCommandStatus: mcp.setCommandVisible,
    active,
    visible,
    terminalId: terminal.id,
    fontSize,
  });
  const composerKeys = usePiComposerKeys({
    composer,
    history,
    paths,
    setPrompt,
    setComposerError,
    inputRef,
    selectionRef,
    cutCaretRef,
  });


  return (
    <div
      ref={paneRef}
      data-project-color={projectColorAttribute(project)}
      className={`terminal piGuiPane ${active ? 'active' : ''} ${maximized ? 'maximized' : ''}`}
      data-pi-pane-id={terminal.id}
      style={{ '--pi-font-size': `${fontSize}px` } as React.CSSProperties}
      onMouseDown={() => {
        if (!active) onFocus();
      }}
      onMouseUp={selection.showSelectionPopup}
      onClick={(event) => {
        if ((event.target as Element).closest('button, a, input, textarea, summary, .piSelectionPopup')) return;
        if (!window.getSelection()?.toString().trim()) inputRef.current?.focus();
      }}
      onClickCapture={(event) => {
        if (!selection.preventSummaryToggleRef.current || !(event.target as Element).closest('summary')) return;
        event.preventDefault();
        event.stopPropagation();
        selection.preventSummaryToggleRef.current = false;
      }}
    >
      <TerminalControls
        maximized={maximized}
        canToggleMaximize={canToggleMaximize}
        onSplitTerminal={onSplitTerminal}
        onEditTerminal={onEditTerminal}
        onToggleMaximize={onToggleMaximize}
        onClose={onClose}
      />
      <div className="piGuiConversation" ref={transcript.scrollRef} onScroll={() => {
        transcript.chatScrollRef.current?.scroll();
        selection.clearSelection();
      }} onWheel={(event) => {
        // Capture scroll-away intent even when a streaming layout change occurs
        // in the same frame as the user's wheel/trackpad input.
        if (event.deltaY < 0) transcript.chatScrollRef.current?.pause();
      }}>
        <PiTranscriptBody pi={pi} transcript={transcript} />
      </div>

      <PiMcpBanner
        model={mcp}
        project={project}
        cwd={cwd}
        terminalId={terminal.id}
        starting={pi.starting}
        mcpStatus={pi.mcpStatus}
        extensionNotice={pi.extensionNotice}
        onDismiss={() => { mcp.dismissBanner(); scheduleComposerFocus(); }}
        onDismissCommand={() => { mcp.setCommandVisible(false); scheduleComposerFocus(); }}
      />
      {pi.error && <div className="piGuiError"><span>{pi.error}</span><button type="button" onClick={mcp.requestRestart}>Restart Pi</button></div>}

      <PiComposer
        pi={pi}
        prompt={prompt}
        composerDraftKey={composerDraftKey}
        composerError={composerError}
        composer={composer}
        paths={paths}
        keys={composerKeys}
        inputRef={inputRef}
      />
      <div className="piGuiFooter">
        <PiQuickResponses
          eligible={composer.quickResponseSessionEligible}
          submitting={composer.quickResponseSubmitting}
          onRespond={(response) => composer.submitQuickResponse(response).catch(console.error)}
        />
        <PiContextBar pi={pi} model={modelPicker} />
        <div className="piGuiFooterBalance" aria-hidden="true" />
      </div>

      <PiSelectionPopup selection={selection.selectionPopup} onCopy={() => selection.copySelection().catch(() => {})} onCopyToChat={selection.copySelectionToChat} />

      <PiExtensionDialog
        request={modalUiRequest}
        onRespond={(id, response) => { pi.respondToUiRequest(id, response).catch(() => {}); }}
      />
    </div>
  );
}
