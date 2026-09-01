import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { GitInfo, Project, TerminalEntry, WorkspaceEntry } from '../types';
import { subscribePiImageDrops } from '../pi/imageDropBroker';
import type { PiContentBlock, PiMessage as PiMessageData, PiPromptImage } from '../pi/types';
import { visiblePiMessages } from '../pi/transcript';
import { piDiffLineKind, piEditDiff, piToolSummary } from '../pi/toolPresentation';
import { usePiSession } from '../pi/usePiSession';
import { TerminalControls } from './TerminalControls';

export function PiGuiView({ terminal, workspace, project, active, visible, maximized, canToggleMaximize, restartRequestNonce, onFocus, onClose, onSplitTerminal, onToggleMaximize }: {
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
  onToggleMaximize: () => void;
}) {
  const cwd = terminal.cwd || workspace.cwd || project.path;
  const [projectTrusted, setProjectTrusted] = useState(false);
  const pi = usePiSession(terminal.id, cwd);
  const [prompt, setPrompt] = useState('');
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
  const skipNextComposerFocusRef = useRef(false);

  useEffect(() => {
    invoke<boolean>('pi_project_trusted', { cwd }).then(setProjectTrusted).catch(() => setProjectTrusted(false));
  }, [cwd]);

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
    const resize = () => resizeComposerInput(input);
    resize();
    let previousWidth = input.parentElement?.clientWidth ?? 0;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === previousWidth) return;
      previousWidth = entry.contentRect.width;
      resize();
    });
    if (input.parentElement) observer.observe(input.parentElement);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (inputRef.current) resizeComposerInput(inputRef.current);
  }, [prompt]);

  useEffect(() => {
    if (!active || pi.uiRequest) return;
    if (skipNextComposerFocusRef.current) {
      skipNextComposerFocusRef.current = false;
      return;
    }
    inputRef.current?.focus();
  }, [active, pi.uiRequest]);

  useEffect(() => {
    setExtensionInput(pi.uiRequest?.prefill || '');
  }, [pi.uiRequest]);

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
  }, [pi.messages.length, pi.streamingText, pi.tools, visible]);

  async function submit() {
    const message = prompt.trim();
    if ((!message && attachments.length === 0) || pi.isStreaming) return;
    const submittedAttachments = attachments;
    setPrompt('');
    setAttachments([]);
    setAttachmentError(null);
    shouldStickToBottomRef.current = true;
    await pi.prompt(message, submittedAttachments.map(({ name: _name, byteSize: _byteSize, ...image }) => image)).catch(() => {
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
    if (!ancestor?.closest('.piGuiConversation')) return;
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
      ? `Trust project-local Pi settings and extensions in:\n\n${cwd}\n\nProject extensions execute with your user permissions.`
      : `Revoke project-local Pi settings and extensions for:\n\n${cwd}?`);
    if (!approved) return;
    await invoke('set_pi_project_trusted', { cwd, trusted: nextTrusted });
    setProjectTrusted(nextTrusted);
    await pi.restart();
  }

  const { hiddenCount: hiddenMessageCount, messages: visibleMessages } = visiblePiMessages(pi.messages);
  const historicalToolArgs = collectToolArgs(pi.messages);

  return (
    <div
      ref={paneRef}
      className={`terminal piGuiPane ${active ? 'active' : ''} ${maximized ? 'maximized' : ''}`}
      onMouseDown={(event) => {
        if (active) return;
        skipNextComposerFocusRef.current = Boolean((event.target as Element).closest('.piGuiConversation'));
        onFocus();
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
        canEdit={false}
        onSplitTerminal={onSplitTerminal}
        onEditTerminal={() => {}}
        onToggleBroadcast={() => {}}
        onToggleMaximize={onToggleMaximize}
        onClose={onClose}
      />
      <header className="piGuiHeader">
        <div className="piGuiContext" aria-label="Pi session context">
          <ContextItem label="cwd" value={compactPath(cwd)} title={cwd} />
          <ContextItem label="branch" value={gitInfo?.branch || '—'} />
          <ContextItem label="model" value={pi.context.modelName || pi.context.modelId || 'starting…'} title={[pi.context.provider, pi.context.modelId].filter(Boolean).join(' / ')} />
          <ContextItem label="effort" value={pi.context.thinkingLevel || '—'} />
          <button className="piTrustButton" type="button" title="Change project trust" onClick={() => toggleProjectTrust().catch(() => {})}><small>project</small>{projectTrusted ? 'trusted' : 'not trusted'}</button>
        </div>
      </header>

      <div className="piGuiConversation" ref={scrollRef} onMouseUp={showSelectionPopup} onScroll={(event) => {
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
        {pi.streamingText && (
          <div className="piMessage piMessageAssistant">
            <div className="piMessageText piMarkdown"><Markdown remarkPlugins={[remarkGfm]}>{pi.streamingText}</Markdown><span className="piStreamingCursor" /></div>
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
        {pi.error && <div className="piGuiError"><span>{pi.error}</span><button type="button" onClick={() => pi.restart().catch(() => {})}>Restart Pi</button></div>}
      </div>

      <div className="piComposer">
        <div className="piComposerContent">
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
            value={prompt}
            rows={1}
            placeholder={attachments.length ? 'Ask Pi about the attached image…' : pi.isStreaming ? 'Pi is working…' : 'Ask Pi…'}
            disabled={pi.starting}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
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

function ContextItem({ label, value, title }: { label: string; value: string; title?: string }) {
  return <span className="piContextItem" title={title || `${label}: ${value}`}><small>{label}</small>{value}</span>;
}

function PiMessage({ message, toolArgs }: { message: PiMessageData; toolArgs: Map<string, unknown> }) {
  if (message.role === 'user') {
    const imageBlocks = Array.isArray(message.content)
      ? message.content.filter((block): block is PiContentBlock & PiPromptImage => block.type === 'image')
      : [];
    return <div className="piMessage piMessageUser"><div className="piMessageText">
      {imageBlocks.length > 0 && <div className="piMessageImages">{imageBlocks.map((block, index) => block.data
        ? <img key={index} src={`data:${String(block.mimeType)};base64,${String(block.data)}`} alt="Attached" />
        : <span className="piOmittedImage" key={index}>Image attachment</span>)}</div>}
      {messageText(message.content)}
    </div></div>;
  }
  if (message.role === 'assistant') {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const visibleBlocks = blocks.filter((block) => block.type === 'text' || block.type === 'thinking');
    if (visibleBlocks.length === 0) return null;
    return <div className="piMessage piMessageAssistant">
      {visibleBlocks.map((block, index) => {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
          return <div className="piMessageText piMarkdown" key={`text:${index}`}><Markdown remarkPlugins={[remarkGfm]}>{block.text}</Markdown></div>;
        }
        if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
          return <details className="piThinking" key={`thinking:${index}`}><summary>Reasoning</summary><div className="piMarkdown"><Markdown remarkPlugins={[remarkGfm]}>{block.thinking}</Markdown></div></details>;
        }
        return null;
      })}
    </div>;
  }
  if (message.role === 'toolResult') {
    return <PiToolCard
      name={message.toolName || 'tool'}
      args={message.toolCallId ? toolArgs.get(message.toolCallId) : null}
      output={messageText(message.content)}
      status={message.isError ? 'error' : 'complete'}
      details={message.details}
    />;
  }
  return null;
}

function PiToolCard({ name, args, output, status, details, live = false }: {
  name: string;
  args: unknown;
  output: string;
  status: 'running' | 'complete' | 'error';
  details?: unknown;
  live?: boolean;
}) {
  const normalizedName = name.toLowerCase();
  const summary = piToolSummary(normalizedName, args, live && status === 'running');
  const diff = normalizedName === 'edit' && status !== 'error' ? piEditDiff(details, args) : null;
  const body = normalizedName === 'bash' ? output : formatToolDetails(args, output);
  return (
    <details className={`piToolCard ${live ? '' : 'historical'} ${status}`} title={summary.title}>
      <summary>
        <span className="piToolStatus" />
        <strong>{summary.label}</strong>
      </summary>
      {diff
        ? <DiffView diff={diff} />
        : <pre>{truncateDisplay(body)}</pre>}
    </details>
  );
}

function DiffView({ diff }: { diff: string }) {
  return <div className="piEditDiff">{truncateDisplay(diff).split('\n').map((line, index) => {
    const kind = piDiffLineKind(line);
    return <div className={`piDiffLine ${kind}`} key={`${index}:${line}`}><span>{line || ' '}</span></div>;
  })}</div>;
}

function collectToolArgs(messages: PiMessageData[]) {
  const args = new Map<string, unknown>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'toolCall' && typeof block.id === 'string') args.set(block.id, block.arguments);
    }
  }
  return args;
}

function messageText(content: unknown) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((item) => item?.type === 'text').map((item) => item.text || '').join('\n');
}

function formatToolDetails(args: unknown, output: string) {
  const input = args && typeof args === 'object' ? JSON.stringify(args, null, 2) : String(args || '');
  return [input, output].filter(Boolean).join('\n\n');
}

function resizeComposerInput(input: HTMLTextAreaElement) {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
  input.style.overflowY = input.scrollHeight > 150 ? 'auto' : 'hidden';
}

function truncateDisplay(value: string, limit = 50_000) {
  return value.length > limit ? `${value.slice(0, limit)}\n\n… ${value.length - limit} characters hidden` : value;
}

function compactPath(path: string) {
  const home = path.match(/^\/Users\/[^/]+/i)?.[0];
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
