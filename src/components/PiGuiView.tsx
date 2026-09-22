import { applicationEvents, showAppToast } from '../applicationEvents';
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import type { Project, TerminalEntry, WorkspaceEntry } from '../types';
import { applySlashCommand, boundaryForUnmovedHistoryArrow, isGuiBuiltinCommand, matchingSlashCommands, shouldCycleCommandHistory } from '../pi/commands';
import { subscribePiFileDrops } from '../pi/fileDropBroker';
import { activePathToken, applyPathCompletion, formatDroppedPathReference, insertPathReferences } from '../pi/pathReferences';
import type { PiCommand, PiModel, PiSessionContext } from '../pi/types';
import { hasVisiblePiStreamingText, visiblePiMessages } from '../pi/transcript';
import { listenForPiEditorText } from '../pi/editorTextEvent';
import { listenForPiPrompt } from '../pi/promptEvent';
import { canSendPiQuickResponse, sendPiQuickResponse, type PiQuickResponse } from '../pi/quickResponse';
import { usePiSession } from '../pi/usePiSession';
import { TerminalControls } from './TerminalControls';
import { PiMarkdown } from './PiMarkdown';
import { collectToolArgs, messageText, PiMessage, PiToolCard } from './PiTranscript';
import { isStructuredPiUiRequest, PiStructuredRequest } from './PiStructuredRequest';

export function PiGuiView({ terminal, workspace, project, active, visible, maximized, canToggleMaximize, restartRequestNonce, initialPrompt, fontSize, onFocus, onClose, onSplitTerminal, onEditTerminal, onToggleMaximize }: {
  terminal: TerminalEntry;
  workspace: WorkspaceEntry;
  project: Project;
  active: boolean;
  visible: boolean;
  maximized: boolean;
  canToggleMaximize: boolean;
  restartRequestNonce: number;
  initialPrompt?: string;
  fontSize: number;
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
  const [prompt, setPrompt] = useState('');
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [pathSuggestions, setPathSuggestions] = useState<Array<{ path: string; isDir: boolean }>>([]);
  const [selectedPathIndex, setSelectedPathIndex] = useState(0);
  const [completionCursor, setCompletionCursor] = useState(0);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [extensionInput, setExtensionInput] = useState('');
  const [selectionPopup, setSelectionPopup] = useState<{ text: string; x: number; y: number; below: boolean } | null>(null);
  const [contextPicker, setContextPicker] = useState<'model' | 'thinking' | null>(null);
  const [contextPickerBusy, setContextPickerBusy] = useState(false);
  const [quickResponseSubmitting, setQuickResponseSubmitting] = useState(false);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const shouldStickToBottomRef = useRef(true);
  const previousVisibleRef = useRef(visible);
  const handledRestartNonceRef = useRef(0);
  const preventSummaryToggleRef = useRef(false);
  const historyIndexRef = useRef<number | null>(null);
  const historyDraftRef = useRef('');
  const initialPromptSentRef = useRef(false);
  const quickResponseInFlightRef = useRef(false);
  const selectionRef = useRef({ start: 0, end: 0 });
  const pathRequestRef = useRef(0);
  const quickResponseSessionEligible = canSendPiQuickResponse(pi);
  const quickResponseSessionEligibleRef = useRef(quickResponseSessionEligible);
  quickResponseSessionEligibleRef.current = quickResponseSessionEligible;

  useEffect(() => {
    pi.setViewOpen(active && visible);
    return () => pi.setViewOpen(false);
  }, [active, pi.setViewOpen, visible]);

  useEffect(() => {
    const becameVisible = visible && !previousVisibleRef.current;
    previousVisibleRef.current = visible;
    if (becameVisible && pi.stopped) pi.restart().catch(() => {});
  }, [pi.restart, pi.stopped, visible]);

  useEffect(() => {
    if (!visible || !initialPrompt || initialPromptSentRef.current || pi.starting || pi.stopped || pi.isStreaming || pi.messages.length > 0) return;
    initialPromptSentRef.current = true;
    pi.prompt(initialPrompt, []).catch((error) => {
      initialPromptSentRef.current = false;
      console.error('Could not start the Pi conversation', error);
    });
  }, [initialPrompt, pi.isStreaming, pi.messages.length, pi.prompt, pi.starting, pi.stopped, visible]);

  useEffect(() => {
    if (!restartRequestNonce || handledRestartNonceRef.current === restartRequestNonce) return;
    handledRestartNonceRef.current = restartRequestNonce;
    pi.restart().catch(() => {});
  }, [pi.restart, restartRequestNonce]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const resize = () => resizeComposerInput(input, shouldStickToBottomRef.current);
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
    if (inputRef.current) resizeComposerInput(inputRef.current, shouldStickToBottomRef.current);
  }, [fontSize, prompt]);

  useEffect(() => {
    if (!active || !visible || pi.starting || modalUiRequest) return;
    inputRef.current?.focus();
    const focusComposer = () => requestAnimationFrame(() => inputRef.current?.focus());
    const focusRequestedPane = (request: { terminalId?: string }) => {
      if (request.terminalId === terminal.id) inputRef.current?.focus();
    };
    window.addEventListener('focus', focusComposer);
    const unsubscribe = applicationEvents.subscribe('pane-focus-request', focusRequestedPane);
    return () => {
      window.removeEventListener('focus', focusComposer);
      unsubscribe();
    };
  }, [active, modalUiRequest, pi.starting, terminal.id, visible]);

  useEffect(() => {
    setExtensionInput(pi.uiRequest?.prefill || '');
  }, [pi.uiRequest]);

  useEffect(() => {
    if (!pi.editorTextRequest) return;
    setPrompt(pi.editorTextRequest.text);
    setSelectedCommandIndex(-1);
    if (active && visible) requestAnimationFrame(() => inputRef.current?.focus());
  }, [pi.editorTextRequest]);

  useEffect(() => listenForPiEditorText((request) => {
    if (request.terminalId !== terminal.id || !active || !visible) return;
    setPrompt(request.text);
    setSelectedCommandIndex(-1);
    request.acknowledge();
    requestAnimationFrame(() => inputRef.current?.focus());
  }), [active, terminal.id, visible]);

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

  useEffect(() => subscribePiFileDrops(terminal.id, (paths) => {
    if (paths.length === 0) {
      setComposerError('No filesystem items were included in the drop');
      return;
    }
    const references = paths.map((path) => formatDroppedPathReference(path, cwd));
    const edit = insertPathReferences(promptRef.current, selectionRef.current.start, selectionRef.current.end, references);
    selectionRef.current = { start: edit.cursor, end: edit.cursor };
    setPrompt(edit.value);
    setComposerError(null);
    setSelectedCommandIndex(-1);
    setCompletionCursor(edit.cursor);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(selectionRef.current.start, selectionRef.current.end);
    });
  }), [cwd, terminal.id]);

  useEffect(() => {
    const token = activePathToken(prompt, completionCursor);
    if (!token || matchingSlashCommands(pi.commands, prompt).length > 0) {
      pathRequestRef.current += 1;
      setPathSuggestions([]);
      return;
    }
    const request = ++pathRequestRef.current;
    const timer = window.setTimeout(() => {
      invoke<Array<{ path: string; isDir: boolean }>>('discover_pi_paths', { root: cwd, query: token.query, limit: 50 })
        .then((results) => {
          if (pathRequestRef.current !== request) return;
          setPathSuggestions(results);
          setSelectedPathIndex(0);
          setComposerError(null);
        })
        .catch((error) => {
          if (pathRequestRef.current !== request) return;
          setPathSuggestions([]);
          setComposerError(`Could not find workspace files: ${String(error)}`);
        });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [completionCursor, cwd, pi.commands, prompt]);

  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest('.piContextPicker')) setContextPicker(null);
      if (target?.closest('.piSelectionPopup')) return;
      preventSummaryToggleRef.current = false;
      setSelectionPopup(null);
    };
    const dismissWithEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextPicker(null);
    };
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('keydown', dismissWithEscape);
    return () => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('keydown', dismissWithEscape);
    };
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !visible || !shouldStickToBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [pi.isStreaming, pi.messages.length, pi.queuedFollowUps, pi.queuedSteering, pi.streamingText, pi.tools, pi.uiRequest, visible]);

  const matchingCommands = selectedCommandIndex >= 0 ? matchingSlashCommands(pi.commands, prompt) : [];
  const completionToken = activePathToken(prompt, completionCursor);
  const matchingPaths = matchingCommands.length === 0 && completionToken ? pathSuggestions : [];
  const hasStreamingText = hasVisiblePiStreamingText(pi.streamingText);
  const hasActiveStreamingText = hasStreamingText && pi.isStreamingText;

  function chooseCommand(command: PiCommand) {
    setPrompt(applySlashCommand(command));
    setSelectedCommandIndex(-1);
    setPathSuggestions([]);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function choosePath(path: { path: string; isDir: boolean }) {
    const token = activePathToken(prompt, completionCursor);
    if (!token) return;
    const edit = applyPathCompletion(prompt, token, path.path, path.isDir);
    setPrompt(edit.value);
    selectionRef.current = { start: edit.cursor, end: edit.cursor };
    setCompletionCursor(edit.cursor);
    setPathSuggestions([]);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(edit.cursor, edit.cursor);
    });
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
      if (active && visible && !modalUiRequest) requestAnimationFrame(() => inputRef.current?.focus());
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
    setPrompt('');
    setPathSuggestions([]);
    setComposerError(null);
    shouldStickToBottomRef.current = true;
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
    await send.catch(() => setPrompt(message));
  }

  function showSelectionPopup(event: React.MouseEvent<HTMLDivElement>) {
    const selection = window.getSelection();
    const text = selection?.toString() || '';
    const pane = paneRef.current;
    if (!selection || !text.trim() || selection.rangeCount === 0 || !pane) {
      setSelectionPopup(null);
      preventSummaryToggleRef.current = false;
      return;
    }
    const range = selection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer as Element
      : range.commonAncestorContainer.parentElement;
    if (!ancestor?.closest('.piGuiPane')) return;
    const anchorElement = selection.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode as Element : selection.anchorNode?.parentElement;
    const focusElement = selection.focusNode?.nodeType === Node.ELEMENT_NODE ? selection.focusNode as Element : selection.focusNode?.parentElement;
    preventSummaryToggleRef.current = Boolean(ancestor.closest('summary') || anchorElement?.closest('summary') || focusElement?.closest('summary'));
    const selectionRect = range.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    const centerX = selectionRect.width ? selectionRect.left + selectionRect.width / 2 : event.clientX;
    const showBelow = selectionRect.top - paneRect.top < 40;
    setSelectionPopup({
      text,
      x: Math.min(paneRect.width - 75, Math.max(75, centerX - paneRect.left)),
      y: showBelow ? selectionRect.bottom - paneRect.top + 6 : selectionRect.top - paneRect.top - 6,
      below: showBelow,
    });
  }

  function clearGuiSelection() {
    window.getSelection()?.removeAllRanges();
    preventSummaryToggleRef.current = false;
    setSelectionPopup(null);
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
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(cursor, cursor);
    });
  }

  async function copySelection() {
    if (!selectionPopup) return;
    try {
      await writeText(selectionPopup.text);
      clearGuiSelection();
      showAppToast('Copied to clipboard');
    } catch (error) {
      showAppToast(`Could not copy: ${String(error)}`);
    }
  }

  function copySelectionToChat() {
    if (!selectionPopup) return;
    setPrompt((current) => current ? `${current}\n\n${selectionPopup.text}` : selectionPopup.text);
    clearGuiSelection();
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function chooseModel(model: PiModel) {
    setContextPickerBusy(true);
    try {
      await pi.selectModel(model);
      setContextPicker(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      setContextPickerBusy(false);
    }
  }

  async function chooseThinkingLevel(level: string) {
    setContextPickerBusy(true);
    try {
      await pi.selectThinkingLevel(level);
      setContextPicker(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      setContextPickerBusy(false);
    }
  }

  const { hiddenCount: hiddenMessageCount, messages: visibleMessages } = visiblePiMessages(pi.messages);
  const historicalToolArgs = useMemo(() => collectToolArgs(pi.messages), [pi.messages]);

  return (
    <div
      ref={paneRef}
      className={`terminal piGuiPane ${active ? 'active' : ''} ${maximized ? 'maximized' : ''}`}
      data-pi-pane-id={terminal.id}
      style={{ '--pi-font-size': `${fontSize}px` } as React.CSSProperties}
      onMouseDown={() => {
        if (!active) onFocus();
      }}
      onMouseUp={showSelectionPopup}
      onClick={(event) => {
        if ((event.target as Element).closest('button, a, input, textarea, summary, .piSelectionPopup')) return;
        if (!window.getSelection()?.toString().trim()) inputRef.current?.focus();
      }}
      onClickCapture={(event) => {
        if (!preventSummaryToggleRef.current || !(event.target as Element).closest('summary')) return;
        event.preventDefault();
        event.stopPropagation();
        preventSummaryToggleRef.current = false;
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
      <div className="piGuiConversation" ref={scrollRef} onScroll={(event) => {
        const element = event.currentTarget;
        shouldStickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        setSelectionPopup(null);
      }}>
        {pi.starting && <div className="piGuiEmpty">Starting Pi…</div>}
        {!pi.starting && pi.messages.length === 0 && !pi.streamingText && (
          <div className="piGuiEmpty">
            <span className="piGuiEmptyMark">π</span>
            <strong>What should we work on?</strong>
            <small>Pi can read, edit, and run commands in this workspace.</small>
          </div>
        )}
        {hiddenMessageCount > 0 && <div className="piHistoryLimit">{hiddenMessageCount} older messages are hidden to keep this pane responsive.</div>}
        {visibleMessages.map((message, index) => <PiMessage key={`${message.timestamp || index}:${index}`} message={message} toolArgs={historicalToolArgs} />)}
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

      {pi.error && <div className="piGuiError"><span>{pi.error}</span><button type="button" onClick={() => pi.restart().catch(() => {})}>Restart Pi</button></div>}

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
              aria-selected={index === selectedPathIndex}
              className={index === selectedPathIndex ? 'selected' : ''}
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
            className={prompt.includes('\n') ? undefined : 'singleLine'}
            value={prompt}
            rows={1}
            placeholder={pi.isStreaming ? 'Steer Pi… (↩) · follow up (⌥↩)' : 'Ask Pi…'}
            disabled={pi.starting}
            onSelect={(event) => {
              const { selectionStart: start, selectionEnd: end } = event.currentTarget;
              selectionRef.current = { start, end };
              setCompletionCursor(end);
            }}
            onChange={(event) => {
              historyIndexRef.current = null;
              historyDraftRef.current = '';
              const cursor = event.target.selectionEnd;
              selectionRef.current = { start: event.target.selectionStart, end: cursor };
              setCompletionCursor(cursor);
              setPrompt(event.target.value);
              setSelectedCommandIndex(0);
              setComposerError(null);
            }}
            onKeyDown={(event) => {
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
                setSelectedPathIndex((current) => (current + direction + matchingPaths.length) % matchingPaths.length);
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
                  setCompletionCursor(boundary);
                  input.setSelectionRange(boundary, boundary);
                });
              }
              if (matchingPaths.length > 0 && !event.metaKey && !event.ctrlKey && !event.altKey && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
                event.preventDefault();
                choosePath(matchingPaths[Math.max(0, selectedPathIndex)]);
                return;
              }
              if (matchingCommands.length > 0 && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
                event.preventDefault();
                chooseCommand(matchingCommands[Math.max(0, selectedCommandIndex)]);
                return;
              }
              if (event.key === 'Escape' && matchingPaths.length > 0) {
                event.preventDefault();
                pathRequestRef.current += 1;
                setPathSuggestions([]);
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
        <div className="piGuiContext piGuiContextBar" aria-label="Pi session context">
          <ContextPicker
          kind="model"
          open={contextPicker === 'model'}
          value={pi.context.modelName || pi.context.modelId || 'starting…'}
          title={[pi.context.provider, pi.context.modelId].filter(Boolean).join(' / ')}
          disabled={pi.starting}
          onToggle={() => setContextPicker((current) => current === 'model' ? null : 'model')}
        >
          {pi.availableModels.length === 0
            ? <div className="piContextPickerEmpty">No configured models</div>
            : pi.availableModels.map((model) => {
              const selected = model.id === pi.context.modelId && model.provider === pi.context.provider;
              return <button
                type="button"
                role="option"
                aria-selected={selected}
                className={selected ? 'selected' : ''}
                disabled={contextPickerBusy}
                key={`${model.provider}:${model.id}`}
                onClick={() => chooseModel(model).catch(() => {})}
              >
                <span><strong>{model.name || model.id}</strong><small>{model.provider} · {model.id}</small></span>
                <i aria-hidden="true">{selected ? '✓' : ''}</i>
              </button>;
            })}
        </ContextPicker>
        <ContextSeparator />
        <ContextPicker
          kind="thinking"
          open={contextPicker === 'thinking'}
          value={pi.context.thinkingLevel || '—'}
          title={`Thinking effort: ${pi.context.thinkingLevel || 'unknown'}`}
          disabled={pi.starting}
          onToggle={() => setContextPicker((current) => current === 'thinking' ? null : 'thinking')}
        >
          {pi.availableThinkingLevels.length === 0
            ? <div className="piContextPickerEmpty">No effort options</div>
            : pi.availableThinkingLevels.map((level) => {
              const selected = level === pi.context.thinkingLevel;
              return <button
                type="button"
                role="option"
                aria-selected={selected}
                className={selected ? 'selected' : ''}
                disabled={contextPickerBusy}
                key={level}
                onClick={() => chooseThinkingLevel(level).catch(() => {})}
              >
                <span><strong>{level}</strong></span>
                <i aria-hidden="true">{selected ? '✓' : ''}</i>
              </button>;
            })}
        </ContextPicker>
          {pi.context.contextPercent !== null && <><ContextSeparator /><ContextUsage context={pi.context} /></>}
        </div>
        <div className="piGuiFooterBalance" aria-hidden="true" />
      </div>

      {selectionPopup && (
        <div
          className={`piSelectionPopup ${selectionPopup.below ? 'below' : ''}`}
          style={{ left: selectionPopup.x, top: selectionPopup.y }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <button type="button" title="Copy to clipboard" onClick={() => copySelection().catch(() => {})}>Copy</button>
          <button type="button" title="Copy to chat" onClick={copySelectionToChat}>To chat</button>
        </div>
      )}

      {modalUiRequest && (
        <div className="piExtensionOverlay" role="dialog" aria-modal="true" aria-label={modalUiRequest.title}>
          <div className="piExtensionDialog">
            <strong>{modalUiRequest.title}</strong>
            {modalUiRequest.message && <p>{modalUiRequest.message}</p>}
            {modalUiRequest.method === 'editor'
              ? <textarea autoFocus rows={7} value={extensionInput} onChange={(event) => setExtensionInput(event.target.value)} />
              : <input autoFocus value={extensionInput} onChange={(event) => setExtensionInput(event.target.value)} />}
            <div className="piExtensionActions">
              <button type="button" onClick={() => pi.respondToUiRequest(modalUiRequest.id, { cancelled: true }).catch(() => {})}>Cancel</button>
              <button className="primary" type="button" onClick={() => pi.respondToUiRequest(modalUiRequest.id, { value: extensionInput }).catch(() => {})}>Submit</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function PiPendingOutput({ isStreaming, hasActiveStreamingText, queuedSteering, queuedFollowUps }: {
  isStreaming: boolean;
  hasActiveStreamingText: boolean;
  queuedSteering: string[];
  queuedFollowUps: string[];
}) {
  return <>
    {isStreaming && !hasActiveStreamingText && (
      <div className="piWorkingIndicator" role="status" aria-label="Pi is thinking" aria-live="polite">
        <span className="piWorkingDots" aria-hidden="true"><i /><i /><i /></span>
      </div>
    )}
    {queuedSteering.map((message, index) => <PiQueuedMessage key={`steer:${message}:${index}`} kind="steering">{message}</PiQueuedMessage>)}
    {queuedFollowUps.map((message, index) => <PiQueuedMessage key={`follow-up:${message}:${index}`} kind="follow-up">{message}</PiQueuedMessage>)}
  </>;
}

export function PiQueuedMessage({ children, kind }: { children: string; kind: 'steering' | 'follow-up' }) {
  const steering = kind === 'steering';
  return <div
    className={`piMessage piMessageUser piQueuedMessage ${steering ? 'piQueuedSteering' : 'piQueuedFollowUp'}`}
    aria-label={steering ? 'Queued steering message' : 'Queued follow-up'}
  >
    <div className="piMessageText">
      <small>{steering ? 'Steering' : 'Follow up'}</small>
      <div className="piQueuedMessageContent piMarkdown"><PiMarkdown>{children}</PiMarkdown></div>
    </div>
  </div>;
}

function ContextPicker({ kind, open, value, title, disabled, onToggle, children }: {
  kind: 'model' | 'thinking';
  open: boolean;
  value: string;
  title: string;
  disabled: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const label = kind === 'model' ? 'model' : 'thinking effort';
  return <div className={`piContextPicker piContextPicker-${kind}`}>
    <button
      className="piContextPickerTrigger"
      type="button"
      title={`${title || value} · Change ${label}`}
      aria-label={`Change Pi ${label}. Current: ${value}`}
      aria-haspopup="listbox"
      aria-expanded={open}
      disabled={disabled}
      onClick={onToggle}
    >
      <span>{value}</span>
    </button>
    {open && <div className="piContextPickerMenu" role="listbox" aria-label={`Available Pi ${label} options`}>{children}</div>}
  </div>;
}

function ContextSeparator() {
  return <span className="piContextSeparator" aria-hidden="true">•</span>;
}

function ContextUsage({ context }: { context: PiSessionContext }) {
  const percent = Math.max(0, Math.min(100, context.contextPercent ?? 0));
  const tokens = context.contextTokens === null ? 'unknown' : context.contextTokens.toLocaleString();
  const windowSize = context.contextWindow === null ? 'unknown' : context.contextWindow.toLocaleString();
  const tooltip = `${tokens} / ${windowSize} tokens · ${Math.round(percent)}%`;
  return <span className="piContextUsage" data-tooltip={tooltip} aria-label={`Context usage: ${tooltip}`}>
    <span className="piContextDonut" style={{ background: `conic-gradient(#a9b6c2 ${percent * 3.6}deg, #647484 0deg)` }} />
  </span>;
}

function resizeComposerInput(input: HTMLTextAreaElement, stickToBottom = false) {
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
  if (stickToBottom && conversation) conversation.scrollTop = conversation.scrollHeight;
}
