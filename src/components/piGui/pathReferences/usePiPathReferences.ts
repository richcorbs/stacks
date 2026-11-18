import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { activePathToken } from '../../../pi/pathReferences';
import type { PiCommand } from '../../../pi/types';
import { matchingSlashCommands } from '../../../pi/commands';

/** `@` path discovery for the composer's active token. */
export function usePiPathReferences({ prompt, cwd, commands, setComposerError }: {
  prompt: string;
  cwd: string;
  commands: PiCommand[];
  setComposerError: (message: string | null) => void;
}) {
  const [suggestions, setSuggestions] = useState<Array<{ path: string; isDir: boolean }>>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [completionCursor, setCompletionCursor] = useState(0);
  const requestRef = useRef(0);

  useEffect(() => {
    const token = activePathToken(prompt, completionCursor);
    if (!token || matchingSlashCommands(commands, prompt).length > 0) {
      requestRef.current += 1;
      setSuggestions([]);
      return;
    }
    const request = ++requestRef.current;
    const timer = window.setTimeout(() => {
      invoke<Array<{ path: string; isDir: boolean }>>('discover_pi_paths', { root: cwd, query: token.query, limit: 50 })
        .then((results) => {
          if (requestRef.current !== request) return;
          setSuggestions(results);
          setSelectedIndex(0);
          setComposerError(null);
        })
        .catch((error) => {
          if (requestRef.current !== request) return;
          setSuggestions([]);
          setComposerError(`Could not find workspace files: ${String(error)}`);
        });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [completionCursor, commands, cwd, prompt, setComposerError]);

  function clearSuggestions() {
    setSuggestions([]);
  }

  function dismiss() {
    requestRef.current += 1;
    setSuggestions([]);
  }

  return {
    suggestions,
    selectedIndex,
    setSelectedIndex,
    completionCursor,
    setCompletionCursor,
    clearSuggestions,
    dismiss,
  };
}

export type PiPathReferencesModel = ReturnType<typeof usePiPathReferences>;
