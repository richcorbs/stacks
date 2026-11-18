import { applicationEvents } from '../applicationEvents';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import type { Project, TerminalEntry, WorkspaceEntry } from '../types';
import { projectColorAttribute } from '../projectColor';
import { applySlashCommand, boundaryForUnmovedHistoryArrow, isGuiBuiltinCommand, isMcpStatusCommand, matchingSlashCommands, shouldCycleCommandHistory } from '../pi/commands';
import { handleComposerClipboard } from '../pi/composerClipboard';
import { activePathToken, applyPathCompletion } from '../pi/pathReferences';
import type { PiCommand } from '../pi/types';
import { hasVisiblePiStreamingText, INITIAL_RENDERED_PI_MESSAGES, nextPiMessageLimit, prependAnchoredScrollTop, visiblePiMessages } from '../pi/transcript';
import { listenForPiEditorText } from '../pi/editorTextEvent';
import { listenForPiPrompt } from '../pi/promptEvent';
import { canSendPiQuickResponse, sendPiQuickResponse, type PiQuickResponse } from '../pi/quickResponse';
import { usePiSession } from '../pi/usePiSession';
import { useComposerDraft } from '../pi/useComposerDraft';
import { createChatScroll } from '../pi/chatScroll';
import { TerminalControls } from './TerminalControls';
import { handleDialogShortcut } from './dialogShortcut';
import { PiMarkdown } from './PiMarkdown';
import { collectToolArgs, messageText, PiSessionBoundaryEntry, PiSettledMessages, PiToolCard } from './PiTranscript';
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
  const [extensionInput, setExtensionInput] = useState('');
  const [quickResponseSubmitting, setQuickResponseSubmitting] = useState(false);
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
  const historyIndexRef = useRef<number | null>(null);
  const historyDraftRef = useRef('');
  const quickResponseInFlightRef = useRef(false);
  const selectionRef = useRef({ start: 0, end: 0 });
  const cutCaretRef = useRef<number | null>(null);
  const knownSessionIdRef = useRef('');
  const pendingPrependAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const mcp = usePiMcpBanner({ terminalId: terminal.id, cwd, project, pi, setComposerError });

  const quickResponseSessionEligible = canSendPiQuickResponse(pi);
  const quickResponseSessionEligibleRef = useRef(quickResponseSessionEligible);
  quickResponseSessionEligibleRef.current = quickResponseSessionEligible;

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

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const resize = () => {
      resizeComposerInput(input);
      chatScrollRef.current?.layout();
    };
    resize();
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(resize);
    });
    if (input.parentElement) observer.observe(input.parentElement);
    if (paneRef.current) {
      observer.observe(paneRef.current);
      const conversation = paneRef.current.querySelector<HTMLElement>(':scope > .piGuiConversation');
      if (conversation) observer.observe(conversation);
    }
    return () => {
      cancelAnimationFrame(resizeFrame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (inputRef.current) resizeComposerInput(inputRef.current);
    chatScrollRef.current?.layout();
  }, [fontSize, prompt]);

  useLayoutEffect(() => {
    if (cutCaretRef.current === null) return;
    const caret = cutCaretRef.current;
    cutCaretRef.current = null;
    inputRef.current?.setSelectionRange(caret, caret);
  }, [prompt]);

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

  useEffect(() => {
    setExtensionInput(pi.uiRequest?.prefill || '');
  }, [pi.uiRequest]);

  useEffect(() => {
    if (!pi.editorTextRequest) return;
    setPrompt(pi.editorTextRequest.text);
    setSelectedCommandIndex(-1);
    if (active && visible) scheduleComposerFocus();
  }, [pi.editorTextRequest, scheduleComposerFocus]);

  useEffect(() => listenForPiEditorText((request) => {
    if (request.terminalId !== terminal.id || !active || !visible) return;
    setPrompt(request.text);
    setSelectedCommandIndex(-1);
    request.acknowledge();
    scheduleComposerFocus();
  }), [active, scheduleComposerFocus, terminal.id, visible]);

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


  useLayoutEffect(() => {
    if (visible) chatScrollRef.current?.layout();
  }, [pi.isStreaming, pi.messages, pi.queuedFollowUps, pi.queuedSteering, pi.streamingText, pi.tools, pi.uiRequest, visible]);

  const matchingCommands = selectedCommandIndex >= 0 ? matchingSlashCommands(pi.commands, prompt) : [];
  const completionToken = activePathToken(prompt, paths.completionCursor);
  const matchingPaths = matchingCommands.length === 0 && completionToken ? paths.suggestions : [];
  const hasStreamingText = hasVisiblePiStreamingText(pi.streamingText);
  const hasActiveStreamingText = hasStreamingText && pi.isStreamingText;

  function chooseCommand(command: PiCommand) {
    setPrompt(applySlashCommand(command));
    setSelectedCommandIndex(-1);
    paths.clearSuggestions();
    scheduleComposerFocus();
  }

  function choosePath(path: { path: string; isDir: boolean }) {
    const token = activePathToken(prompt, paths.completionCursor);
    if (!token) return;
    const edit = applyPathCompletion(prompt, token, path.path, path.isDir);
    setPrompt(edit.value);
    selectionRef.current = { start: edit.cursor, end: edit.cursor };
    paths.setCompletionCursor(edit.cursor);
    paths.clearSuggestions();
    scheduleComposerFocus();
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(edit.cursor, edit.cursor));
  }

  function cyclePromptHistory(direction: -1 | 1) {
    const history = pi.messages
      .filter((message) => message.role === 'user')
      .map((message) => messageText(message.content).trim())
      .filter(Boolean);
    if (history.length === 0) return false;

    let index = historyIndexRef.current;
    let nextPrompt: string;
    if (direction === -1) {
      if (index === null) {
        historyDraftRef.current = prompt;
        index = history.length - 1;
      } else {
        index = Math.max(0, index - 1);
      }
      nextPrompt = history[index];
    } else {
      if (index === null) return false;
      if (index < history.length - 1) {
        index += 1;
        nextPrompt = history[index];
      } else {
        index = null;
        nextPrompt = historyDraftRef.current;
      }
    }
    historyIndexRef.current = index;
    setPrompt(nextPrompt);
    setSelectedCommandIndex(-1);
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(nextPrompt.length, nextPrompt.length));
    return true;
  }

  function exitPromptHistory() {
    if (historyIndexRef.current === null) return false;
    const draft = historyDraftRef.current;
    historyIndexRef.current = null;
    historyDraftRef.current = '';
    setPrompt(draft);
    setSelectedCommandIndex(-1);
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(draft.length, draft.length));
    return true;
  }

  async function submitQuickResponse(message: PiQuickResponse) {
    if (!quickResponseSessionEligibleRef.current || quickResponseInFlightRef.current) return;
    quickResponseInFlightRef.current = true;
    setQuickResponseSubmitting(true);
    try {
      await sendPiQuickResponse(message, {
        isEligible: () => quickResponseSessionEligibleRef.current,
        dismissStructuredUiRequest: pi.dismissStructuredUiRequest,
        prompt: pi.prompt,
      });
    } finally {
      quickResponseInFlightRef.current = false;
      setQuickResponseSubmitting(false);
      scheduleComposerFocus();
    }
  }

  async function submit(behavior: 'prompt' | 'followUp' = 'prompt') {
    const message = prompt.trim();
    const slashName = message.startsWith('/') ? message.slice(1).split(/\s/, 1)[0] : '';
    const extensionCommand = pi.commands.some((command) => command.name === slashName && command.source === 'extension');
    const builtinCommand = isGuiBuiltinCommand(slashName);
    if (!message || (pi.isStreaming && builtinCommand)) return;
    // Claim inline controls synchronously so a click cannot race this submit.
    // Pi receives cancellation; the text remains an ordinary prompt/steer/follow-up.
    const structuredRequestDismissal = pi.dismissStructuredUiRequest();
    historyIndexRef.current = null;
    historyDraftRef.current = '';
    const finishSubmission = composerDraftKey ? beginSubmission() : null;
    if (!finishSubmission) setPrompt('');
    paths.clearSuggestions();
    setComposerError(null);
    mcp.setCommandVisible(isMcpStatusCommand(message));
    chatScrollRef.current?.resume();
    await structuredRequestDismissal.catch(() => {});
    const send = builtinCommand
      ? pi.runBuiltinCommand(message)
      : pi.isStreaming && extensionCommand
        ? pi.prompt(message, [])
        : pi.isStreaming && behavior === 'followUp'
          ? pi.followUp(message, [])
          : pi.isStreaming
            ? pi.steer(message, [])
            : pi.prompt(message, []);
    await send.then(() => finishSubmission?.(true), () => {
      if (finishSubmission) finishSubmission(false);
      else setPrompt(message);
    });
  }

  async function pasteIntoComposer() {
    const input = inputRef.current;
    const selectionStart = input?.selectionStart ?? prompt.length;
    const selectionEnd = input?.selectionEnd ?? selectionStart;
    const text = await readText();
    if (!text) return;
    let cursor = selectionStart + text.length;
    setPrompt((current) => {
      const start = Math.min(selectionStart, current.length);
      const end = Math.min(Math.max(selectionEnd, start), current.length);
      cursor = start + text.length;
      return `${current.slice(0, start)}${text}${current.slice(end)}`;
    });
    setSelectedCommandIndex(0);
    scheduleComposerFocus();
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(cursor, cursor));
  }

  const { hiddenCount: hiddenMessageCount, messages: visibleMessages } = visiblePiMessages(pi.messages, revealedMessageCount);
  const historicalToolArgs = useMemo(() => collectToolArgs(pi.messages), [pi.messages]);

  function loadOlderMessages() {
    const element = scrollRef.current;
    if (!element || hiddenMessageCount === 0) return;
    pendingPrependAnchorRef.current = { height: element.scrollHeight, top: element.scrollTop };
    chatScrollRef.current?.pause();
    setRevealedMessageCount((current) => nextPiMessageLimit(current, pi.messages.length));
  }

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

      <div className="piComposer">
        <div className="piComposerRow">
          <div className="piComposerContent">
          {matchingCommands.length > 0 && <div className="piCommandMenu" role="listbox" aria-label="Pi commands">
            {matchingCommands.map((command, index) => <button
              type="button"
              role="option"
              aria-selected={index === selectedCommandIndex}
              className={index === selectedCommandIndex ? 'selected' : ''}
              key={`${command.source}:${command.name}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseCommand(command)}
            >
              <span><strong>/{command.name}</strong>{command.description && <small>{command.description}</small>}</span>
              <em>{command.source}{command.location ? ` · ${command.location}` : ''}</em>
            </button>)}
          </div>}
          {matchingPaths.length > 0 && <div className="piCommandMenu piPathMenu" role="listbox" aria-label="Workspace files">
            {matchingPaths.map((path, index) => <button
              type="button"
              role="option"
              aria-selected={index === paths.selectedIndex}
              className={index === paths.selectedIndex ? 'selected' : ''}
              key={`${path.isDir ? 'directory' : 'file'}:${path.path}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choosePath(path)}
            >
              <span><strong>{path.path}{path.isDir ? '/' : ''}</strong></span>
              <em>{path.isDir ? 'directory' : 'file'}</em>
            </button>)}
          </div>}
          {composerError && <div className="piComposerError">{composerError}</div>}
          <textarea
            ref={inputRef}
            data-card-composer={composerDraftKey ? '' : undefined}
            className={prompt.includes('\n') ? undefined : 'singleLine'}
            value={prompt}
            rows={1}
            placeholder={pi.isStreaming ? 'Steer Pi… (↩) · follow up (⌥↩)' : 'Ask Pi…'}
            disabled={pi.starting}
            onSelect={(event) => {
              const { selectionStart: start, selectionEnd: end } = event.currentTarget;
              selectionRef.current = { start, end };
              paths.setCompletionCursor(end);
            }}
            onChange={(event) => {
              historyIndexRef.current = null;
              historyDraftRef.current = '';
              const cursor = event.target.selectionEnd;
              selectionRef.current = { start: event.target.selectionStart, end: cursor };
              paths.setCompletionCursor(cursor);
              setPrompt(event.target.value);
              setSelectedCommandIndex(0);
              setComposerError(null);
            }}
            onKeyDown={(event) => {
              if (handleComposerClipboard(event, (value, caret) => {
                historyIndexRef.current = null;
                historyDraftRef.current = '';
                selectionRef.current = { start: caret, end: caret };
                cutCaretRef.current = caret;
                paths.setCompletionCursor(caret);
                setPrompt(value);
                setSelectedCommandIndex(0);
                setComposerError(null);
              }, (error) => setComposerError(`Could not ${event.key.toLowerCase() === 'x' ? 'cut' : 'copy'}: ${String(error)}`))) return;
              if (event.ctrlKey && !event.metaKey && !event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                event.preventDefault();
                event.stopPropagation();
                cyclePromptHistory(event.key === 'ArrowUp' ? -1 : 1);
                return;
              }
              if (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'v') {
                event.preventDefault();
                event.stopPropagation();
                pasteIntoComposer().catch(console.error);
                return;
              }
              if (event.key === 'Enter' && event.altKey && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                submit('followUp').catch(console.error);
                return;
              }
              if (matchingPaths.length > 0 && !event.metaKey && !event.ctrlKey && !event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault();
                const direction = event.key === 'ArrowDown' ? 1 : -1;
                paths.setSelectedIndex((current) => (current + direction + matchingPaths.length) % matchingPaths.length);
                return;
              }
              if (matchingCommands.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault();
                const direction = event.key === 'ArrowDown' ? 1 : -1;
                setSelectedCommandIndex((current) => (current + direction + matchingCommands.length) % matchingCommands.length);
                return;
              }
              if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                const input = event.currentTarget;
                const direction = event.key === 'ArrowUp' ? -1 : 1;
                const value = input.value;
                const selectionStart = input.selectionStart;
                const selectionEnd = input.selectionEnd;
                if (shouldCycleCommandHistory(value, direction, selectionStart, selectionEnd)) {
                  if (cyclePromptHistory(direction)) event.preventDefault();
                  return;
                }
                if (selectionStart === selectionEnd) requestAnimationFrame(() => {
                  if (inputRef.current !== input || document.activeElement !== input || input.value !== value) return;
                  const boundary = boundaryForUnmovedHistoryArrow(
                    value,
                    direction,
                    selectionStart,
                    selectionEnd,
                    input.selectionStart,
                    input.selectionEnd,
                  );
                  if (boundary === null) return;
                  selectionRef.current = { start: boundary, end: boundary };
                  paths.setCompletionCursor(boundary);
                  input.setSelectionRange(boundary, boundary);
                });
              }
              if (matchingPaths.length > 0 && !event.metaKey && !event.ctrlKey && !event.altKey && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
                event.preventDefault();
                choosePath(matchingPaths[Math.max(0, paths.selectedIndex)]);
                return;
              }
              if (matchingCommands.length > 0 && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
                event.preventDefault();
                chooseCommand(matchingCommands[Math.max(0, selectedCommandIndex)]);
                return;
              }
              if (event.key === 'Escape' && matchingPaths.length > 0) {
                event.preventDefault();
                paths.dismiss();
                return;
              }
              if (event.key === 'Escape' && matchingCommands.length > 0) {
                event.preventDefault();
                setSelectedCommandIndex(-1);
                return;
              }
              if (event.key === 'Escape' && exitPromptHistory()) {
                event.preventDefault();
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit().catch(console.error);
              }
            }}
          />
          </div>
          {pi.isStreaming ? (
            <button className="piComposerAction stop" type="button" onClick={() => pi.abort().catch(() => {})} title="Stop Pi" aria-label="Stop Pi"><span className="piStopSquare" aria-hidden="true" /></button>
          ) : (
            <button className="piComposerAction" type="button" disabled={!prompt.trim() || pi.starting} onClick={() => submit().catch(console.error)} title="Send" aria-label="Send"><svg className="piSendArrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M4.5 6.5 8 3l3.5 3.5" /></svg></button>
          )}
        </div>
      </div>
      <div className="piGuiFooter">
        <div className="piQuickResponses" aria-label="Quick responses">
          <button type="button" disabled={!quickResponseSessionEligible || quickResponseSubmitting} onClick={() => submitQuickResponse('yes').catch(console.error)}>YES</button>
          <button type="button" disabled={!quickResponseSessionEligible || quickResponseSubmitting} onClick={() => submitQuickResponse('no').catch(console.error)}>NO</button>
          <button type="button" disabled={!quickResponseSessionEligible || quickResponseSubmitting} onClick={() => submitQuickResponse('what do you recommend?').catch(console.error)}>RECOMMEND</button>
        </div>
        <PiContextBar pi={pi} model={modelPicker} />
        <div className="piGuiFooterBalance" aria-hidden="true" />
      </div>

      <PiSelectionPopup selection={selection.selectionPopup} onCopy={() => selection.copySelection().catch(() => {})} onCopyToChat={selection.copySelectionToChat} />

      {modalUiRequest && (
        <div className="piExtensionOverlay" role="dialog" aria-modal="true" aria-label={modalUiRequest.title} onKeyDown={handleDialogShortcut}>
          <div className="piExtensionDialog">
            <strong>{modalUiRequest.title}</strong>
            <div className="dialogBody">
            {modalUiRequest.message && <p>{modalUiRequest.message}</p>}
            {modalUiRequest.method === 'editor'
              ? <textarea autoFocus rows={7} value={extensionInput} onChange={(event) => setExtensionInput(event.target.value)} />
              : <input autoFocus value={extensionInput} onChange={(event) => setExtensionInput(event.target.value)} />}
            </div>
            <div className="piExtensionActions">
              <button type="button" onClick={() => pi.respondToUiRequest(modalUiRequest.id, { cancelled: true }).catch(() => {})}>Cancel</button>
              <button className="primary" data-dialog-primary type="button" onClick={() => pi.respondToUiRequest(modalUiRequest.id, { value: extensionInput }).catch(() => {})}>Submit</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function resizeComposerInput(input: HTMLTextAreaElement) {
  const pane = input.closest<HTMLElement>('.piGuiPane');
  const conversation = pane?.querySelector<HTMLElement>(':scope > .piGuiConversation');
  const currentHeight = Math.max(23, input.offsetHeight);
  let availableGrowth = 0;
  if (conversation) {
    const style = getComputedStyle(conversation);
    const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    availableGrowth = Math.max(0, conversation.clientHeight - verticalPadding);
  }
  const maxHeight = Math.max(23, currentHeight + availableGrowth);
  input.style.height = 'auto';
  const height = Math.min(input.scrollHeight, maxHeight);
  input.style.maxHeight = `${maxHeight}px`;
  input.style.height = `${height}px`;
  input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
}
