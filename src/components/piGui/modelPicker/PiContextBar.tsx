import type { PiSessionModel } from '../../../pi/usePiSession';
import { ContextUsage } from '../usage/PiContextUsage';
import type { PiModelPickerModel } from './usePiModelPicker';

export function PiContextBar({ pi, model }: { pi: PiSessionModel; model: PiModelPickerModel }) {
  return <div className="piGuiContext piGuiContextBar" aria-label="Pi session context">
    <ContextPicker
      kind="model"
      open={model.kind === 'model'}
      value={pi.context.modelName || pi.context.modelId || 'starting…'}
      title={[pi.context.provider, pi.context.modelId].filter(Boolean).join(' / ')}
      disabled={pi.starting}
      onToggle={() => model.toggle('model')}
    >
      {pi.effectiveModels.length === 0
        ? <div className="piContextPickerEmpty">No configured models</div>
        : pi.effectiveModels.map((candidate) => {
          const selected = candidate.id === pi.context.modelId && candidate.provider === pi.context.provider;
          return <button
            type="button"
            role="option"
            aria-selected={selected}
            className={selected ? 'selected' : ''}
            disabled={model.busy}
            key={`${candidate.provider}:${candidate.id}`}
            onClick={() => model.chooseModel(candidate).catch(() => {})}
          >
            <span><strong>{candidate.name || candidate.id}</strong><small>{candidate.provider} · {candidate.id}</small></span>
            <i aria-hidden="true">{selected ? '✓' : ''}</i>
          </button>;
        })}
    </ContextPicker>
    <ContextSeparator />
    <ContextPicker
      kind="thinking"
      open={model.kind === 'thinking'}
      value={pi.context.thinkingLevel || '—'}
      title={`Thinking effort: ${pi.context.thinkingLevel || 'unknown'}`}
      disabled={pi.starting}
      onToggle={() => model.toggle('thinking')}
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
            disabled={model.busy}
            key={level}
            onClick={() => model.chooseThinkingLevel(level).catch(() => {})}
          >
            <span><strong>{level}</strong></span>
            <i aria-hidden="true">{selected ? '✓' : ''}</i>
          </button>;
        })}
    </ContextPicker>
    {pi.context.contextPercent !== null && <><ContextSeparator /><ContextUsage context={pi.context} /></>}
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
