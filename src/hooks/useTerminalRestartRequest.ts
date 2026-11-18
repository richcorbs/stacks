import { useEffect, useEffectEvent, useRef } from 'react';

export function useTerminalRestartRequest(restartRequestNonce: number, restartTerminalSessionIfDead: () => boolean) {
  // Previous-value bookkeeping: only a *new* nonce may trigger a restart.
  const lastRestartRequestNonceRef = useRef(restartRequestNonce);
  const restartIfDead = useEffectEvent(restartTerminalSessionIfDead);

  useEffect(() => {
    if (restartRequestNonce <= 0 || restartRequestNonce === lastRestartRequestNonceRef.current) return;
    lastRestartRequestNonceRef.current = restartRequestNonce;
    restartIfDead();
    // The restart callback is effect-owned and may change identity every render.
    // Reading it through an Effect Event avoids re-running this nonce effect.
  }, [restartRequestNonce]);
}
