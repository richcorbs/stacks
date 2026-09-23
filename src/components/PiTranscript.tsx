import { memo } from 'react';
import type { PiContentBlock, PiMessage as PiMessageData, PiPromptImage } from '../pi/types';
import { piDiffLineKind, piEditDiff, piToolSummary } from '../pi/toolPresentation';
import { PiMarkdown } from './PiMarkdown';

const messageIdentity = new WeakMap<PiMessageData, number>();
let nextMessageIdentity = 1;

export function piMessageKey(message: PiMessageData) {
  let identity = messageIdentity.get(message);
  if (!identity) {
    identity = nextMessageIdentity;
    nextMessageIdentity += 1;
    messageIdentity.set(message, identity);
  }
  return `pi-message:${identity}`;
}

export const PiSettledMessages = memo(function PiSettledMessages({ messages, toolArgs }: { messages: PiMessageData[]; toolArgs: Map<string, unknown> }) {
  return <>{messages.map((message) => <PiMessage
    key={piMessageKey(message)}
    message={message}
    toolArg={message.toolCallId ? toolArgs.get(message.toolCallId) : undefined}
  />)}</>;
});

export const PiMessage = memo(function PiMessage({ message, toolArg }: { message: PiMessageData; toolArg?: unknown }) {
  if (message.role === 'user') {
    const imageBlocks = Array.isArray(message.content)
      ? message.content.filter((block): block is PiContentBlock & PiPromptImage => block.type === 'image')
      : [];
    return <div className="piMessage piMessageUser"><div className="piMessageText piMarkdown">
      {imageBlocks.length > 0 && <div className="piMessageImages">{imageBlocks.map((block, index) => block.data
        ? <img key={index} src={`data:${String(block.mimeType)};base64,${String(block.data)}`} alt="Attached" />
        : <span className="piOmittedImage" key={index}>Image attachment</span>)}</div>}
      <PiMarkdown>{messageText(message.content)}</PiMarkdown>
    </div><MessageTimestamp timestamp={message.timestamp} /></div>;
  }
  if (message.role === 'assistant') {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const visibleBlocks = projectAssistantContent(blocks);
    if (visibleBlocks.length === 0) return null;
    return <div className="piMessage piMessageAssistant">
      {visibleBlocks.map((block, index) => {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
          return <div className="piMessageText piMarkdown" key={`text:${index}`}><PiMarkdown>{block.text}</PiMarkdown></div>;
        }
        if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
          return <details className="piThinking" key={`thinking:${index}`}><summary>Reasoning</summary><div className="piMarkdown"><PiMarkdown>{block.thinking}</PiMarkdown></div></details>;
        }
        return null;
      })}
      <MessageTimestamp timestamp={message.timestamp} />
    </div>;
  }
  if (message.role === 'toolResult') {
    return <PiToolCard
      name={message.toolName || 'tool'}
      args={toolArg ?? null}
      output={messageText(message.content)}
      status={message.isError ? 'error' : 'complete'}
      details={message.details}
    />;
  }
  return null;
});

const MIN_NEAR_DUPLICATE_TOKENS = 12;
const NEAR_DUPLICATE_TOKEN_SIMILARITY = 0.97;
const NEAR_DUPLICATE_TRIGRAM_SIMILARITY = 0.94;

/**
 * Produces a display-only view of one settled assistant turn. Pi can persist
 * substantially equivalent commentary and final text as separate blocks; in
 * that case the later wording wins without changing the raw transcript.
 */
export function projectAssistantContent(blocks: PiContentBlock[]) {
  const visibleBlocks = blocks.filter((block) =>
    (block.type === 'text' && typeof block.text === 'string' && block.text.trim())
    || (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()));
  return visibleBlocks.filter((block, index) => {
    if (block.type !== 'text' || typeof block.text !== 'string') return true;
    const earlierText = block.text;
    return !visibleBlocks.slice(index + 1).some((later) =>
      later.type === 'text'
      && typeof later.text === 'string'
      && substantiallyEquivalentText(earlierText, later.text));
  });
}

function substantiallyEquivalentText(left: string, right: string) {
  const leftTokens = normalizedTextTokens(left);
  const rightTokens = normalizedTextTokens(right);
  if (leftTokens.join(' ') === rightTokens.join(' ')) return true;
  if (leftTokens.length < MIN_NEAR_DUPLICATE_TOKENS || rightTokens.length < MIN_NEAR_DUPLICATE_TOKENS) return false;
  return diceSimilarity(leftTokens, rightTokens) >= NEAR_DUPLICATE_TOKEN_SIMILARITY
    && diceSimilarity(tokenTrigrams(leftTokens), tokenTrigrams(rightTokens)) >= NEAR_DUPLICATE_TRIGRAM_SIMILARITY;
}

function normalizedTextTokens(text: string) {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function tokenTrigrams(tokens: string[]) {
  return tokens.slice(0, -2).map((_, index) => tokens.slice(index, index + 3).join('\u0000'));
}

function diceSimilarity(left: string[], right: string[]) {
  const available = new Map<string, number>();
  for (const token of left) available.set(token, (available.get(token) ?? 0) + 1);
  let shared = 0;
  for (const token of right) {
    const count = available.get(token) ?? 0;
    if (count === 0) continue;
    shared += 1;
    available.set(token, count - 1);
  }
  return (2 * shared) / (left.length + right.length);
}

function MessageTimestamp({ timestamp }: { timestamp?: number }) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return <time className="piMessageTimestamp" dateTime={date.toISOString()} title={date.toLocaleString()}>
    {date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
  </time>;
}

export function PiToolCard({ name, args, output, status, details, live = false }: {
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
  return <details className={`piToolCard ${live ? '' : 'historical'} ${status}`} title={summary.title}>
    <summary><strong>{summary.label}</strong><span className="piToolStatus" /></summary>
    {diff ? <DiffView diff={diff} /> : <pre>{truncateDisplay(body)}</pre>}
  </details>;
}

function DiffView({ diff }: { diff: string }) {
  return <div className="piEditDiff">{truncateDisplay(diff).split('\n').map((line, index) => {
    const kind = piDiffLineKind(line);
    return <div className={`piDiffLine ${kind}`} key={`${index}:${line}`}><span>{line || ' '}</span></div>;
  })}</div>;
}

export function collectToolArgs(messages: PiMessageData[]) {
  const args = new Map<string, unknown>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'toolCall' && typeof block.id === 'string') args.set(block.id, block.arguments);
    }
  }
  return args;
}

export function messageText(content: unknown) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((item) => item?.type === 'text').map((item) => item.text || '').join('\n');
}

function formatToolDetails(args: unknown, output: string) {
  const input = args && typeof args === 'object' ? JSON.stringify(args, null, 2) : String(args || '');
  return [input, output].filter(Boolean).join('\n\n');
}

function truncateDisplay(value: string, limit = 50_000) {
  return value.length > limit ? `${value.slice(0, limit)}\n\n… ${value.length - limit} characters hidden` : value;
}
