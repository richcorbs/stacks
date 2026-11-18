import { useRef, type RefObject } from 'react';
import type { PiMessage } from '../../../pi/types';
import { messageText } from '../../PiTranscript';

/** Composer prompt history navigation over settled user messages. */
export function usePiComposerHistory({ prompt, setPrompt, messages, inputRef, setSelectedCommandIndex }: {
  prompt: string;
  setPrompt: (value: string) => void;
  messages: PiMessage[];
  inputRef: RefObject<HTMLTextAreaElement | null>;
  setSelectedCommandIndex: (index: number) => void;
}) {
  const historyIndexRef = useRef<number | null>(null);
  const historyDraftRef = useRef('');

  function cyclePromptHistory(direction: -1 | 1) {
    const history = messages
      .filter((message) => message.role === 'user')
      .map((message) => messageText(message.content).trim())
      .filter(Boolean);
    if (history.length === 0) return false;

    let index = historyIndexRef.current;
    let nextPrompt: string;
    if (direction === -1) {
      if (index === null) {
        historyDraftRef.current = prompt;
        index = history.length - 1;
      } else {
        index = Math.max(0, index - 1);
      }
      nextPrompt = history[index];
    } else {
      if (index === null) return false;
      if (index < history.length - 1) {
        index += 1;
        nextPrompt = history[index];
      } else {
        index = null;
        nextPrompt = historyDraftRef.current;
      }
    }
    historyIndexRef.current = index;
    setPrompt(nextPrompt);
    setSelectedCommandIndex(-1);
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(nextPrompt.length, nextPrompt.length));
    return true;
  }

  function exitPromptHistory() {
    if (historyIndexRef.current === null) return false;
    const draft = historyDraftRef.current;
    historyIndexRef.current = null;
    historyDraftRef.current = '';
    setPrompt(draft);
    setSelectedCommandIndex(-1);
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(draft.length, draft.length));
    return true;
  }

  function resetHistory() {
    historyIndexRef.current = null;
    historyDraftRef.current = '';
  }

  return { cyclePromptHistory, exitPromptHistory, resetHistory };
}

export type PiComposerHistoryModel = ReturnType<typeof usePiComposerHistory>;
