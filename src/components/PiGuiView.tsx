import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import type { GitInfo, Project, TerminalEntry, WorkspaceEntry } from '../types';
import { applySlashCommand, isGuiBuiltinCommand, matchingSlashCommands, shouldCycleCommandHistory } from '../pi/commands';
import { subscribePiImageDrops } from '../pi/imageDropBroker';
import type { PiCommand, PiPromptImage, PiSessionContext } from '../pi/types';
import { hasVisiblePiStreamingText, visiblePiMessages } from '../pi/transcript';
import { listenForPiEditorText } from '../pi/editorTextEvent';
import { usePiSession } from '../pi/usePiSession';
import { TerminalControls } from './TerminalControls';
import { PiMarkdown } from './PiMarkdown';
import { collectToolArgs, messageText, PiMessage, PiToolCard } from './PiTranscript';

export function PiGuiView({ terminal, workspace, project, active, visible, maximized, canToggleMaximize, restartRequestNonce, onFocus, onClose, onSplitTerminal, onEditTerminal, onToggleMaximize }: {
  terminal: TerminalEntry;
  workspace: WorkspaceEntry;
  project: Project;
  active: boolean;
  visible: boolean;
  maximized: boolean;
  canToggleMaximize: boolean;
  restartRequestNonce: number;
  onFocus: () => void;
  onClose: () => void;
  onSplitTerminal: (direction: 'row' | 'column') => void;
  onEditTerminal: () => void;
  onToggleMaximize: () => void;
}) {
  const cwd = terminal.cwd || workspace.cwd || project.path;
  const [projectTrusted, setProjectTrusted] = useState(false);
  const pi = usePiSession(terminal.id, cwd, workspace.id, project.path);
  const [prompt, setPrompt] = useState('');
  const [composerFontSize, setComposerFontSize] = useState(15);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [attachments, setAttachments] = useState<Array<PiPromptImage & { name: string; byteSize: number }>>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [extensionInput, setExtensionInput] = useState('');
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [selectionPopup, setSelectionPopup] = useState<{ text: string; x: number; y: number; below: boolean } | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const previousVisibleRef = useRef(visible);
  const handledRestartNonceRef = useRef(0);
  const preventSummaryToggleRef = useRef(false);
  const historyIndexRef = useRef<number | null>(null);
  const historyDraftRef = useRef('');

  useEffect(() => {
    invoke<boolean>('pi_project_trusted', { cwd, projectPath: project.path }).then(setProjectTrusted).catch(() => setProjectTrusted(false));
  }, [cwd, project.path]);

  useEffect(() => {
    if (!visible) return;
    const refresh = () => invoke<GitInfo | null>('git_info', { path: cwd }).then(setGitInfo).catch(() => setGitInfo(null));
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => window.clearInterval(timer);
  }, [cwd, visible]);

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
  }, [composerFontSize, prompt]);

  useEffect(() => {
    if (!active || !visible || pi.starting || pi.uiRequest) return;
    inputRef.current?.focus();
    const focusComposer = () => requestAnimationFrame(() => inputRef.current?.focus());
    const focusRequestedPane = (event: Event) => {
      const request = (event as CustomEvent<{ terminalId?: string }>).detail;
      if (request?.terminalId === terminal.id) inputRef.current?.focus();
    };
    window.addEventListener('focus', focusComposer);
    window.addEventListener('pane-focus-request', focusRequestedPane);
    return () => {
      window.removeEventListener('focus', focusComposer);
      window.removeEventListener('pane-focus-request', focusRequestedPane);
    };
  }, [active, pi.starting, pi.uiRequest, terminal.id, visible]);

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

  useEffect(() => subscribePiImageDrops(terminal.id, (paths) => {
      if (!pi.context.supportsImages) {
        setAttachmentError('The selected model does not support image input');
        return;
      }
      setAttachmentError(null);
      Promise.allSettled(paths.slice(0, 5).map((path) => invoke<{ data: string; mimeType: string; name: string; byteSize: number }>('read_pi_image', { path })))
        .then((results) => {
          const images = results.flatMap((result) => result.status === 'fulfilled' ? [{ type: 'image' as const, ...result.value }] : []);
          const failure = results.find((result) => result.status === 'rejected');
          if (images.length) setAttachments((current) => [...current, ...images].slice(0, 5));
          if (failure?.status === 'rejected') setAttachmentError(failure.reason instanceof Error ? failure.reason.message : String(failure.reason));
        });
    }), [pi.context.supportsImages, terminal.id]);

  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest('.piSelectionPopup')) return;
      preventSummaryToggleRef.current = false;
      setSelectionPopup(null);
    };
    window.addEventListener('mousedown', dismiss);
    return () => window.removeEventListener('mousedown', dismiss);
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !visible || !shouldStickToBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [pi.isStreaming, pi.messages.length, pi.queuedFollowUps, pi.queuedSteering, pi.streamingText, pi.tools, visible]);

  const matchingCommands = selectedCommandIndex >= 0 ? matchingSlashCommands(pi.commands, prompt) : [];
  const hasStreamingText = hasVisiblePiStreamingText(pi.streamingText);
  const hasActiveStreamingText = hasStreamingText && pi.isStreamingText;

  function chooseCommand(command: PiCommand) {
    setPrompt(applySlashCommand(command));
    setSelectedCommandIndex(-1);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function adjustComposerFontSize(delta: number) {
    setComposerFontSize((current) => Math.min(24, Math.max(11, current + delta)));
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

  async function submit(behavior: 'prompt' | 'followUp' = 'prompt') {
    const message = prompt.trim();
    const slashName = message.startsWith('/') ? message.slice(1).split(/\s/, 1)[0] : '';
    const extensionCommand = pi.commands.some((command) => command.name === slashName && command.source === 'extension');
    const builtinCommand = isGuiBuiltinCommand(slashName);
    if ((!message && attachments.length === 0) || (pi.isStreaming && builtinCommand)) return;
    if (builtinCommand && attachments.length > 0) {
      setAttachmentError(`/${slashName} does not accept image attachments`);
      return;
    }
    const submittedAttachments = attachments;
    historyIndexRef.current = null;
    historyDraftRef.current = '';
    setPrompt('');
    setAttachments([]);
    setAttachmentError(null);
    shouldStickToBottomRef.current = true;
    const images = submittedAttachments.map(({ name: _name, byteSize: _byteSize, ...image }) => image);
    const send = builtinCommand
      ? pi.runBuiltinCommand(message)
      : pi.isStreaming && extensionCommand
        ? pi.prompt(message, images)
        : pi.isStreaming && behavior === 'followUp'
          ? pi.followUp(message, images)
          : pi.isStreaming
            ? pi.steer(message, images)
            : pi.prompt(message, images);
    await send.catch(() => {
      setPrompt(message);
      setAttachments(submittedAttachments);
    });
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
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: 'Copied to clipboard' } }));
    } catch (error) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: `Could not copy: ${String(error)}` } }));
    }
  }

  function copySelectionToChat() {
    if (!selectionPopup) return;
    setPrompt((current) => current ? `${current}\n\n${selectionPopup.text}` : selectionPopup.text);
    clearGuiSelection();
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function toggleProjectTrust() {
    const nextTrusted = !projectTrusted;
    const approved = window.confirm(nextTrusted
      ? `Trust project-local Pi settings and extensions for:\n\n${project.path}\n\nThis applies to its workspace directories and Git worktrees. Project extensions execute with your user permissions.`
      : `Revoke project-local Pi settings and extensions for:\n\n${project.path}?`);
    if (!approved) return;
    await invoke('set_pi_project_trusted', { cwd, projectPath: project.path, trusted: nextTrusted });
    setProjectTrusted(nextTrusted);
    await pi.restart();
  }

  const { hiddenCount: hiddenMessageCount, messages: visibleMessages } = visiblePiMessages(pi.messages);
  const historicalToolArgs = useMemo(() => collectToolArgs(pi.messages), [pi.messages]);

  return (
    <div
      ref={paneRef}
      className={`terminal piGuiPane ${active ? 'active' : ''} ${maximized ? 'maximized' : ''}`}
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
        broadcast={false}
        canBroadcast={false}
        onSplitTerminal={onSplitTerminal}
        onEditTerminal={onEditTerminal}
        onToggleBroadcast={() => {}}
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
        {pi.queuedSteering.map((message, index) => (
          <div className="piMessage piMessageUser piQueuedMessage piQueuedSteering" key={`steer:${message}:${index}`} aria-label="Queued steering message">
            <div className="piMessageText"><small>Steering</small><span>{message}</span></div>
          </div>
        ))}
        {pi.queuedFollowUps.map((message, index) => (
          <div className="piMessage piMessageUser piQueuedMessage piQueuedFollowUp" key={`follow-up:${message}:${index}`} aria-label="Queued follow-up">
            <div className="piMessageText"><small>Follow up</small><span>{message}</span></div>
          </div>
        ))}
        {pi.isStreaming && !hasActiveStreamingText && pi.tools.length === 0 && (
          <div className="piWorkingIndicator" role="status" aria-label="Pi is thinking" aria-live="polite">
            <span className="piWorkingDots" aria-hidden="true"><i /><i /><i /></span>
          </div>
        )}
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
          {attachments.length > 0 && <div className="piImageAttachments">
            {attachments.map((image, index) => <div className="piImageAttachment" key={`${image.name}:${index}`} title={image.name}>
              <img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} />
              <span>{image.name}</span>
              <button type="button" aria-label={`Remove ${image.name}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button>
            </div>)}
          </div>}
          {attachmentError && <div className="piAttachmentError">{attachmentError}</div>}
          <textarea
            ref={inputRef}
            className={prompt.includes('\n') ? undefined : 'singleLine'}
            value={prompt}
            rows={1}
            style={{ fontSize: `${composerFontSize}px` }}
            placeholder={attachments.length ? 'Ask Pi about the attached image…' : pi.isStreaming ? 'Steer Pi… (↩) · follow up (⌥↩)' : 'Ask Pi…'}
            disabled={pi.starting}
            onChange={(event) => {
              historyIndexRef.current = null;
              historyDraftRef.current = '';
              setPrompt(event.target.value);
              setSelectedCommandIndex(0);
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
              if (event.metaKey && !event.ctrlKey && !event.altKey && ['+', '=', '-', '_'].includes(event.key)) {
                event.preventDefault();
                event.stopPropagation();
                adjustComposerFontSize(event.key === '+' || event.key === '=' ? 1 : -1);
                return;
              }
              if (event.key === 'Enter' && event.altKey && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                submit('followUp').catch(console.error);
                return;
              }
              if (matchingCommands.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault();
                const direction = event.key === 'ArrowDown' ? 1 : -1;
                setSelectedCommandIndex((current) => (current + direction + matchingCommands.length) % matchingCommands.length);
                return;
              }
              if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                const direction = event.key === 'ArrowUp' ? -1 : 1;
                const shouldCycle = shouldCycleCommandHistory(prompt, event.currentTarget.selectionStart, direction, historyIndexRef.current !== null);
                if (shouldCycle && cyclePromptHistory(direction)) {
                  event.preventDefault();
                  return;
                }
              }
              if (matchingCommands.length > 0 && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
                event.preventDefault();
                chooseCommand(matchingCommands[Math.max(0, selectedCommandIndex)]);
                return;
              }
              if (event.key === 'Escape' && matchingCommands.length > 0) {
                event.preventDefault();
                setSelectedCommandIndex(-1);
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
            <button className="piComposerAction stop" type="button" onClick={() => pi.abort().catch(() => {})} title="Stop Pi">■</button>
          ) : (
            <button className="piComposerAction" type="button" disabled={(!prompt.trim() && attachments.length === 0) || pi.starting} onClick={() => submit().catch(console.error)} title="Send">↑</button>
          )}
        </div>
      </div>
      <div className="piGuiContext piGuiContextBar" aria-label="Pi session context">
        <ContextItem value={compactPath(cwd)} title={`Working directory: ${cwd}`} />
        <ContextSeparator />
        <ContextItem value={gitInfo?.branch || '—'} title={`Git branch: ${gitInfo?.branch || 'unknown'}`} />
        <ContextSeparator />
        <ContextItem value={pi.context.modelName || pi.context.modelId || 'starting…'} title={[pi.context.provider, pi.context.modelId].filter(Boolean).join(' / ')} />
        <ContextSeparator />
        <ContextItem value={pi.context.thinkingLevel || '—'} title={`Thinking effort: ${pi.context.thinkingLevel || 'unknown'}`} />
        <ContextSeparator />
        <button className="piTrustButton" type="button" title="Change project trust" onClick={() => toggleProjectTrust().catch(() => {})}>{projectTrusted ? 'trusted' : 'not trusted'}</button>
        {pi.context.contextPercent !== null && <><ContextSeparator /><ContextUsage context={pi.context} /></>}
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

      {pi.uiRequest && (
        <div className="piExtensionOverlay" role="dialog" aria-modal="true" aria-label={pi.uiRequest.title}>
          <div className="piExtensionDialog">
            <strong>{pi.uiRequest.title}</strong>
            {pi.uiRequest.message && <p>{pi.uiRequest.message}</p>}
            {pi.uiRequest.method === 'select' && (
              <div className="piExtensionOptions">
                {pi.uiRequest.options.map((option) => <button type="button" key={option} onClick={() => pi.respondToUiRequest({ value: option }).catch(() => {})}>{option}</button>)}
              </div>
            )}
            {(pi.uiRequest.method === 'input' || pi.uiRequest.method === 'editor') && (
              pi.uiRequest.method === 'editor'
                ? <textarea autoFocus rows={7} value={extensionInput} onChange={(event) => setExtensionInput(event.target.value)} />
                : <input autoFocus value={extensionInput} onChange={(event) => setExtensionInput(event.target.value)} />
            )}
            <div className="piExtensionActions">
              <button type="button" onClick={() => pi.respondToUiRequest(pi.uiRequest?.method === 'confirm' ? { confirmed: false } : { cancelled: true }).catch(() => {})}>Cancel</button>
              {pi.uiRequest.method === 'confirm' && <button className="primary" autoFocus type="button" onClick={() => pi.respondToUiRequest({ confirmed: true }).catch(() => {})}>Confirm</button>}
              {(pi.uiRequest.method === 'input' || pi.uiRequest.method === 'editor') && <button className="primary" type="button" onClick={() => pi.respondToUiRequest({ value: extensionInput }).catch(() => {})}>Submit</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ContextItem({ value, title }: { value: string; title?: string }) {
  return <span className="piContextItem" title={title || value}>{value}</span>;
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

function compactPath(path: string) {
  const home = path.match(/^\/Users\/[^/]+/i)?.[0];
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
