import { useEffect, useRef } from 'react';

export function useTerminalRestartRequest(restartRequestNonce: number, restartTerminalSessionIfDead: () => boolean) {
  const lastRestartRequestNonceRef = useRef(restartRequestNonce);

  useEffect(() => {
    if (restartRequestNonce <= 0 || restartRequestNonce === lastRestartRequestNonceRef.current) return;
    lastRestartRequestNonceRef.current = restartRequestNonce;
    restartTerminalSessionIfDead();
  }, [restartRequestNonce, restartTerminalSessionIfDead]);
}
