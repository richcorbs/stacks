import { useEffect, useRef } from 'react';

export function useTerminalPaneRestartRequest(restartRequestNonce: number, restartPaneSessionIfDead: () => boolean) {
  const lastRestartRequestNonceRef = useRef(restartRequestNonce);

  useEffect(() => {
    if (restartRequestNonce <= 0 || restartRequestNonce === lastRestartRequestNonceRef.current) return;
    lastRestartRequestNonceRef.current = restartRequestNonce;
    restartPaneSessionIfDead();
  }, [restartRequestNonce, restartPaneSessionIfDead]);
}
