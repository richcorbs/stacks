import { AsyncButtonLabel } from '../AsyncButtonLabel';

export type CardLevelError = {
  message: string;
  requiresReload: boolean;
};

function isRevisionConflict(message: string) {
  const normalized = message.toLocaleLowerCase();
  return normalized.includes('environment changed') || normalized.includes('layout changed');
}

export function collectCardLevelErrors({ actionError, detailLoadError, recoveryError, agentFailure }: {
  actionError: string | null;
  detailLoadError: string | null;
  recoveryError?: string | null;
  agentFailure?: string | null;
}): CardLevelError[] {
  const errors = new Map<string, CardLevelError>();
  const add = (message: string | null | undefined, requiresReload: boolean, displayMessage = message) => {
    if (!message || !displayMessage) return;
    const existing = errors.get(message);
    errors.set(message, {
      message: existing?.message ?? displayMessage,
      requiresReload: requiresReload || Boolean(existing?.requiresReload),
    });
  };

  add(actionError, Boolean(actionError && isRevisionConflict(actionError)));
  add(detailLoadError, true, detailLoadError && `Card details could not be loaded: ${detailLoadError}`);
  add(recoveryError, false);
  add(agentFailure, false, agentFailure && `Work agent failed: ${agentFailure}`);
  return [...errors.values()];
}

export function CardLevelErrorBanner({ errors, reloading, onReload }: {
  errors: CardLevelError[];
  reloading: boolean;
  onReload: () => void;
}) {
  if (errors.length === 0) return null;
  const messages = errors.map(({ message }) => <span key={message}>{message}</span>);

  return <div className="cardLevelErrorBanner" role="alert">
    <div className="cardLevelErrorMessages">{messages}</div>
    {errors.some(({ requiresReload }) => requiresReload) && <button type="button" disabled={reloading} onClick={onReload}>
      <AsyncButtonLabel idle="Reload card" busy="Reloading…" isBusy={reloading} />
    </button>}
  </div>;
}
