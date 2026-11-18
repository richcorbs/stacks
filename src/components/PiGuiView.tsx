import { applicationEvents } from '../applicationEvents';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Project, TerminalEntry, WorkspaceEntry } from '../types';
import { projectColorAttribute } from '../projectColor';

import { hasVisiblePiStreamingText, INITIAL_RENDERED_PI_MESSAGES, nextPiMessageLimit, prependAnchoredScrollTop, visiblePiMessages } from '../pi/transcript';
import { listenForPiPrompt } from '../pi/promptEvent';
import { usePiSession } from '../pi/usePiSession';
import { useComposerDraft } from '../pi/useComposerDraft';
import { createChatScroll } from '../pi/chatScroll';
import { TerminalControls } from './TerminalControls';
import { PiMarkdown } from './PiMarkdown';
import { collectToolArgs, PiSessionBoundaryEntry, PiSettledMessages, PiToolCard } from './PiTranscript';
import { isStructuredPiUiRequest, PiStructuredRequest } from './PiStructuredRequest';
import { PiPendingOutput, PiQueuedMessage } from './piGui/pendingOutput/PiPendingOutput';
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
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow().listen<string>('superthread-credential-rotated', (event) => {
      if (event.payload === project.id) pi.restart().catch(console.error);
    }).then((cleanup) => { unlisten = cleanup; }).catch(console.error);
    return () => unlisten?.();
  }, [pi.restart, project.id]);
  const modalUiRequest = pi.uiRequest && !isStructuredPiUiRequest(pi.uiRequest) ? pi.uiRequest : null;
  const { prompt, setPrompt, beginSubmission } = useComposerDraft(composerDraftKey);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [revealedMessageCount, setRevealedMessageCount] = useState(INITIAL_RENDERED_PI_MESSAGES);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRef = useRef<ReturnType<typeof createChatScroll> | null>(null);
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const transcript = transcriptRef.current;
    if (!viewport || !transcript) return;
    const scroll = createChatScroll(viewport);
    chatScrollRef.current = scroll;
    const observer = new ResizeObserver(scroll.layout);
    observer.observe(viewport);
    observer.observe(transcript);
    scroll.layout();
    return () => {
      observer.disconnect();
      scroll.dispose();
      chatScrollRef.current = null;
    };
  }, []);
  const previousVisibleRef = useRef(visible);
  const handledRestartNonceRef = useRef(0);
  const selectionRef = useRef({ start: 0, end: 0 });
  const cutCaretRef = useRef<number | null>(null);
  const knownSessionIdRef = useRef('');
  const pendingPrependAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const mcp = usePiMcpBanner({ terminalId: terminal.id, cwd, project, pi, setComposerError });

  useEffect(() => {
    pi.setViewOpen(active && visible);
    return () => pi.setViewOpen(false);
  }, [active, pi.setViewOpen, visible]);

  useEffect(() => {
    setRevealedMessageCount(INITIAL_RENDERED_PI_MESSAGES);
    pendingPrependAnchorRef.current = null;
    knownSessionIdRef.current = '';
  }, [terminal.id]);

  useEffect(() => {
    const sessionId = pi.context.sessionId;
    if (!sessionId) return;
    if (knownSessionIdRef.current && knownSessionIdRef.current !== sessionId) {
      setRevealedMessageCount(INITIAL_RENDERED_PI_MESSAGES);
      pendingPrependAnchorRef.current = null;
    }
    knownSessionIdRef.current = sessionId;
  }, [pi.context.sessionId]);

  useLayoutEffect(() => {
    const anchor = pendingPrependAnchorRef.current;
    const element = scrollRef.current;
    if (!anchor || !element) return;
    element.scrollTop = prependAnchoredScrollTop(anchor.height, anchor.top, element.scrollHeight);
    pendingPrependAnchorRef.current = null;
  }, [revealedMessageCount]);

  useEffect(() => {
    const becameVisible = visible && !previousVisibleRef.current;
    previousVisibleRef.current = visible;
    if (becameVisible && pi.stopped) pi.restart().catch(() => {});
  }, [pi.restart, pi.stopped, visible]);

  useEffect(() => {
    if (!restartRequestNonce || handledRestartNonceRef.current === restartRequestNonce) return;
    handledRestartNonceRef.current = restartRequestNonce;
    pi.restart().catch(() => {});
  }, [pi.restart, restartRequestNonce]);

  const composerFocusAllowed = active && visible && !pi.starting && !modalUiRequest && !mcp.confirmTrust && !mcp.confirmRestart;
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

  useEffect(() => listenForPiPrompt((request) => {
    if (request.terminalId !== terminal.id || pi.starting || pi.isStreaming) return;
    if (pi.stopped) {
      pi.restart().catch((error) => {
        request.failed();
        console.error('Could not restart Pi for automated prompt', error);
      });
      return;
    }
    if (!request.claim()) return;
    pi.prompt(request.text, [])
      .then(request.accepted)
      .catch((error) => {
        request.failed();
        console.error('Could not run Pi prompt', error);
      });
  }), [pi.isStreaming, pi.prompt, pi.restart, pi.starting, pi.stopped, terminal.id]);

  const paths = usePiPathReferences({ prompt, cwd, commands: pi.commands, setComposerError });
  usePiFileDrops({
    terminalId: terminal.id,
    cwd,
    promptRef,
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
    chatScrollRef,
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

  useLayoutEffect(() => {
    if (visible) chatScrollRef.current?.layout();
  }, [pi.isStreaming, pi.messages, pi.queuedFollowUps, pi.queuedSteering, pi.streamingText, pi.tools, pi.uiRequest, visible]);

  const { hiddenCount: hiddenMessageCount, messages: visibleMessages } = visiblePiMessages(pi.messages, revealedMessageCount);
  const historicalToolArgs = useMemo(() => collectToolArgs(pi.messages), [pi.messages]);

  function loadOlderMessages() {
    const element = scrollRef.current;
    if (!element || hiddenMessageCount === 0) return;
    pendingPrependAnchorRef.current = { height: element.scrollHeight, top: element.scrollTop };
    chatScrollRef.current?.pause();
    setRevealedMessageCount((current) => nextPiMessageLimit(current, pi.messages.length));
  }

  const hasStreamingText = hasVisiblePiStreamingText(pi.streamingText);
  const hasActiveStreamingText = hasStreamingText && pi.isStreamingText;

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
      <div className="piGuiConversation" ref={scrollRef} onScroll={() => {
        chatScrollRef.current?.scroll();
        selection.clearSelection();
      }} onWheel={(event) => {
        // Capture scroll-away intent even when a streaming layout change occurs
        // in the same frame as the user's wheel/trackpad input.
        if (event.deltaY < 0) chatScrollRef.current?.pause();
      }}>
        <div className="piGuiTranscript" ref={transcriptRef}>
        {pi.starting && <div className="piGuiEmpty">Starting Pi…</div>}
        {!pi.starting && pi.messages.length === 0 && !pi.streamingText && (
          <div className="piGuiEmpty">
            <span className="piGuiEmptyMark">π</span>
            <strong>What should we work on?</strong>
            <small>Pi can read, edit, and run commands in this workspace.</small>
          </div>
        )}
        {hiddenMessageCount > 0 && <div className="piHistoryLimit">
          <button type="button" onClick={loadOlderMessages}>Load older messages</button>
          <span>{hiddenMessageCount} earlier {hiddenMessageCount === 1 ? 'message' : 'messages'}</span>
        </div>}
        {pi.sessionBoundary && <PiSessionBoundaryEntry boundary={pi.sessionBoundary} />}
        <PiSettledMessages messages={visibleMessages} toolArgs={historicalToolArgs} />
        {hasStreamingText && (
          <div className="piMessage piMessageAssistant">
            <div className="piMessageText piMarkdown"><PiMarkdown>{pi.streamingText}</PiMarkdown>{hasActiveStreamingText && <span className="piStreamingCursor" />}</div>
          </div>
        )}
        {pi.tools.map((tool) => (
          <PiToolCard
            key={tool.id}
            name={tool.name}
            args={tool.args}
            output={tool.partialText}
            status={tool.status}
            live
          />
        ))}
        {isStructuredPiUiRequest(pi.uiRequest) && <PiStructuredRequest
          request={pi.uiRequest}
          onRespond={(requestId, response) => { pi.respondToUiRequest(requestId, response).catch(() => {}); }}
        />}
        <PiPendingOutput
          isStreaming={pi.isStreaming}
          hasActiveStreamingText={hasActiveStreamingText}
          queuedSteering={pi.queuedSteering}
          queuedFollowUps={pi.queuedFollowUps}
        />
        </div>
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
