import { memo } from 'react';
import type { PiContentBlock, PiMessage as PiMessageData, PiPromptImage } from '../pi/types';
import { piDiffLineKind, piEditDiff, piToolSummary } from '../pi/toolPresentation';
import { PiMarkdown } from './PiMarkdown';

export const PiMessage = memo(function PiMessage({ message, toolArgs }: { message: PiMessageData; toolArgs: Map<string, unknown> }) {
  if (message.role === 'user') {
    const imageBlocks = Array.isArray(message.content)
      ? message.content.filter((block): block is PiContentBlock & PiPromptImage => block.type === 'image')
      : [];
    return <div className="piMessage piMessageUser"><div className="piMessageText">
      {imageBlocks.length > 0 && <div className="piMessageImages">{imageBlocks.map((block, index) => block.data
        ? <img key={index} src={`data:${String(block.mimeType)};base64,${String(block.data)}`} alt="Attached" />
        : <span className="piOmittedImage" key={index}>Image attachment</span>)}</div>}
      {messageText(message.content)}
    </div><MessageTimestamp timestamp={message.timestamp} /></div>;
  }
  if (message.role === 'assistant') {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const visibleBlocks = blocks.filter((block) => block.type === 'text' || block.type === 'thinking');
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
      args={message.toolCallId ? toolArgs.get(message.toolCallId) : null}
      output={messageText(message.content)}
      status={message.isError ? 'error' : 'complete'}
      details={message.details}
    />;
  }
  return null;
});

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
