import { useCallback, useRef, useState } from 'react';

export function useToast() {
  const [toast, setToast] = useState<string | null>(null);
  const timeoutRef = useRef<number | undefined>(undefined);

  const showToast = useCallback((message: string, durationMs = 1200) => {
    if (timeoutRef.current !== undefined) window.clearTimeout(timeoutRef.current);
    setToast(message);
    timeoutRef.current = window.setTimeout(() => setToast(null), durationMs);
  }, []);

  return { toast, showToast };
}
