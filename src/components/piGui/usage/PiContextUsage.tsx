import type { PiSessionContext } from '../../../pi/types';

export function ContextUsage({ context }: { context: PiSessionContext }) {
  const percent = Math.max(0, Math.min(100, context.contextPercent ?? 0));
  const tokens = context.contextTokens === null ? 'unknown' : context.contextTokens.toLocaleString();
  const windowSize = context.contextWindow === null ? 'unknown' : context.contextWindow.toLocaleString();
  const tooltip = `${tokens} / ${windowSize} tokens · ${Math.round(percent)}%`;
  return <span className="piContextUsage" data-tooltip={tooltip} aria-label={`Context usage: ${tooltip}`}>
    <span className="piContextDonut" style={{ background: `conic-gradient(#a9b6c2 ${percent * 3.6}deg, #647484 0deg)` }} />
  </span>;
}
