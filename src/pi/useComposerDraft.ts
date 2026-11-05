import { useCallback, useLayoutEffect, useRef, useState, type SetStateAction } from 'react';

// Opt-in, session-only storage. Card pane IDs include both card and chat thread.
const drafts = new Map<string, { text: string }>();
const listeners = new Map<string, Set<() => void>>();
function notify(key: string) { listeners.get(key)?.forEach((listener) => listener()); }

/** The owner must remount the composer when its draft key changes. */
export function useComposerDraft(key?: string) {
  const [prompt, updatePrompt] = useState(() => key ? drafts.get(key)?.text ?? '' : '');
  const current = useRef(prompt);
  useLayoutEffect(() => {
    if (!key) return;
    const sync = () => {
      current.current = drafts.get(key)?.text ?? '';
      updatePrompt(current.current);
    };
    const subscribers = listeners.get(key) ?? new Set();
    listeners.set(key, subscribers);
    subscribers.add(sync);
    return () => {
      subscribers.delete(sync);
      if (!subscribers.size) listeners.delete(key);
    };
  }, [key]);
  const setPrompt = useCallback((value: SetStateAction<string>) => {
    const text = typeof value === 'function' ? value(current.current) : value;
    current.current = text;
    if (key) {
      if (text) drafts.set(key, { text });
      else drafts.delete(key);
      notify(key);
    }
    updatePrompt(text);
  }, [key]);

  function beginSubmission() {
    const original = current.current;
    const pending = key ? drafts.get(key) : undefined;
    // Clear the visible input, but retain the draft until the send succeeds,
    // including if the card is closed while the request is in flight.
    current.current = '';
    updatePrompt('');
    return (success: boolean) => {
      if (key && drafts.get(key) !== pending) return; // A newer edit owns the draft.
      if (success) {
        if (key) { drafts.delete(key); notify(key); }
      } else if (key) {
        notify(key);
      } else if (!current.current) {
        current.current = original;
        updatePrompt(original);
      }
    };
  }

  return { prompt, setPrompt, beginSubmission };
}
