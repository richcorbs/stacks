import { useCallback, useRef, useState } from 'react';
import type { ToastDetail, ToastState } from '../types';

export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timeoutRef = useRef<number | undefined>(undefined);

  const showToast = useCallback((messageOrToast: string | ToastDetail, durationMs = 1200) => {
    if (timeoutRef.current !== undefined) window.clearTimeout(timeoutRef.current);
    setToast(typeof messageOrToast === 'string' ? { message: messageOrToast } : messageOrToast);
    timeoutRef.current = window.setTimeout(() => setToast(null), durationMs);
  }, []);

  return { toast, showToast };
}
