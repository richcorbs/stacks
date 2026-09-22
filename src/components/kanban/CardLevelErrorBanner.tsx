import { AsyncButtonLabel } from '../AsyncButtonLabel';

export type CardLevelError = {
  message: string;
  action: 'reload' | 'retry_refresh' | null;
};

function isRevisionConflict(message: string) {
  const normalized = message.toLocaleLowerCase();
  return normalized.includes('environment changed') || normalized.includes('layout changed');
}

export function collectCardLevelErrors({ actionError, detailLoadError, detailRefreshError, recoveryError, agentFailure }: {
  actionError: string | null;
  detailLoadError: string | null;
  detailRefreshError?: string | null;
  recoveryError?: string | null;
  agentFailure?: string | null;
}): CardLevelError[] {
  const errors = new Map<string, CardLevelError>();
  const add = (message: string | null | undefined, action: CardLevelError['action'], displayMessage = message) => {
    if (!message || !displayMessage) return;
    const existing = errors.get(message);
    errors.set(message, { message: existing?.message ?? displayMessage, action: existing?.action ?? action });
  };

  add(actionError, actionError && isRevisionConflict(actionError) ? 'reload' : null);
  add(detailLoadError, 'reload', detailLoadError && `Card details could not be loaded: ${detailLoadError}`);
  add(detailRefreshError, 'retry_refresh', detailRefreshError && `Card details could not be refreshed: ${detailRefreshError}`);
  add(recoveryError, null);
  add(agentFailure, null, agentFailure && `Work agent failed: ${agentFailure}`);
  return [...errors.values()];
}

export function CardLevelErrorBanner({ errors, reloading, onReload, onRetryRefresh }: {
  errors: CardLevelError[];
  reloading: boolean;
  onReload: () => void;
  onRetryRefresh?: () => void;
}) {
  if (errors.length === 0) return null;
  const messages = errors.map(({ message }) => <span key={message}>{message}</span>);

  return <div className="cardLevelErrorBanner" role="alert">
    <div className="cardLevelErrorMessages">{messages}</div>
    {errors.some(({ action }) => action === 'retry_refresh') && <button type="button" onClick={onRetryRefresh}>Retry refresh</button>}
    {errors.some(({ action }) => action === 'reload') && <button type="button" disabled={reloading} onClick={onReload}>
      <AsyncButtonLabel idle="Reload card" busy="Reloading…" isBusy={reloading} />
    </button>}
  </div>;
}
