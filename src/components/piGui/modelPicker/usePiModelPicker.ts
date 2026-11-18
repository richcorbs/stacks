import { useEffect, useState } from 'react';
import type { PiModel } from '../../../pi/types';
import type { PiSessionModel } from '../../../pi/usePiSession';

/** Model/thinking selection and its outside-click dismissal. */
export function usePiModelPicker({ pi, onFocusComposer }: {
  pi: PiSessionModel;
  onFocusComposer: () => void;
}) {
  const [kind, setKind] = useState<'model' | 'thinking' | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest('.piContextPicker')) setKind(null);
    };
    const dismissWithEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setKind(null);
    };
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('keydown', dismissWithEscape);
    return () => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('keydown', dismissWithEscape);
    };
  }, []);

  async function chooseModel(model: PiModel) {
    setBusy(true);
    try {
      await pi.selectModel(model);
      setKind(null);
      onFocusComposer();
    } finally {
      setBusy(false);
    }
  }

  async function chooseThinkingLevel(level: string) {
    setBusy(true);
    try {
      await pi.selectThinkingLevel(level);
      setKind(null);
      onFocusComposer();
    } finally {
      setBusy(false);
    }
  }

  function toggle(next: 'model' | 'thinking') {
    setKind((current) => current === next ? null : next);
  }

  return { kind, busy, chooseModel, chooseThinkingLevel, toggle };
}

export type PiModelPickerModel = ReturnType<typeof usePiModelPicker>;
