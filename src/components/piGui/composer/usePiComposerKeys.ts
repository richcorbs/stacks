import type { ChangeEvent, KeyboardEvent, RefObject, SyntheticEvent } from 'react';
import { boundaryForUnmovedHistoryArrow, shouldCycleCommandHistory } from '../../../pi/commands';
import { handleComposerClipboard } from '../../../pi/composerClipboard';
import type { PiPathReferencesModel } from '../pathReferences/usePiPathReferences';
import type { PiComposerModel } from './usePiComposer';
import type { PiComposerHistoryModel } from './usePiComposerHistory';

/** Composer change/select/keyboard handling, including clipboard and completion keys. */
export function usePiComposerKeys({ composer, history, paths, setPrompt, setComposerError, inputRef, selectionRef, cutCaretRef }: {
  composer: PiComposerModel;
  history: PiComposerHistoryModel;
  paths: PiPathReferencesModel;
  setPrompt: (value: string | ((current: string) => string)) => void;
  setComposerError: (message: string | null) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  selectionRef: RefObject<{ start: number; end: number }>;
  cutCaretRef: RefObject<number | null>;
}) {
  const {
    matchingCommands, matchingPaths, selectedCommandIndex, setSelectedCommandIndex,
    chooseCommand, choosePath, submit, pasteIntoComposer,
  } = composer;
  const { cyclePromptHistory, exitPromptHistory, resetHistory } = history;

  function handleSelect(event: SyntheticEvent<HTMLTextAreaElement>) {
    const { selectionStart: start, selectionEnd: end } = event.currentTarget;
    selectionRef.current = { start, end };
    paths.setCompletionCursor(end);
  }

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    resetHistory();
    const cursor = event.target.selectionEnd;
    selectionRef.current = { start: event.target.selectionStart, end: cursor };
    paths.setCompletionCursor(cursor);
    setPrompt(event.target.value);
    setSelectedCommandIndex(0);
    setComposerError(null);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (handleComposerClipboard(event, (value, caret) => {
      resetHistory();
      selectionRef.current = { start: caret, end: caret };
      cutCaretRef.current = caret;
      paths.setCompletionCursor(caret);
      setPrompt(value);
      setSelectedCommandIndex(0);
      setComposerError(null);
    }, (error) => setComposerError(`Could not ${event.key.toLowerCase() === 'x' ? 'cut' : 'copy'}: ${String(error)}`))) return;
    if (event.ctrlKey && !event.metaKey && !event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      event.stopPropagation();
      cyclePromptHistory(event.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'v') {
      event.preventDefault();
      event.stopPropagation();
      pasteIntoComposer().catch(console.error);
      return;
    }
    if (event.key === 'Enter' && event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      submit('followUp').catch(console.error);
      return;
    }
    if (matchingPaths.length > 0 && !event.metaKey && !event.ctrlKey && !event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      paths.setSelectedIndex((current) => (current + direction + matchingPaths.length) % matchingPaths.length);
      return;
    }
    if (matchingCommands.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setSelectedCommandIndex((current) => (current + direction + matchingCommands.length) % matchingCommands.length);
      return;
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const input = event.currentTarget;
      const direction = event.key === 'ArrowUp' ? -1 : 1;
      const value = input.value;
      const selectionStart = input.selectionStart;
      const selectionEnd = input.selectionEnd;
      if (shouldCycleCommandHistory(value, direction, selectionStart, selectionEnd)) {
        if (cyclePromptHistory(direction)) event.preventDefault();
        return;
      }
      if (selectionStart === selectionEnd) requestAnimationFrame(() => {
        if (inputRef.current !== input || document.activeElement !== input || input.value !== value) return;
        const boundary = boundaryForUnmovedHistoryArrow(
          value,
          direction,
          selectionStart,
          selectionEnd,
          input.selectionStart,
          input.selectionEnd,
        );
        if (boundary === null) return;
        selectionRef.current = { start: boundary, end: boundary };
        paths.setCompletionCursor(boundary);
        input.setSelectionRange(boundary, boundary);
      });
    }
    if (matchingPaths.length > 0 && !event.metaKey && !event.ctrlKey && !event.altKey && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
      event.preventDefault();
      choosePath(matchingPaths[Math.max(0, paths.selectedIndex)]);
      return;
    }
    if (matchingCommands.length > 0 && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
      event.preventDefault();
      chooseCommand(matchingCommands[Math.max(0, selectedCommandIndex)]);
      return;
    }
    if (event.key === 'Escape' && matchingPaths.length > 0) {
      event.preventDefault();
      paths.dismiss();
      return;
    }
    if (event.key === 'Escape' && matchingCommands.length > 0) {
      event.preventDefault();
      setSelectedCommandIndex(-1);
      return;
    }
    if (event.key === 'Escape' && exitPromptHistory()) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit().catch(console.error);
    }
  }

  return { handleSelect, handleChange, handleKeyDown };
}

export type PiComposerKeysModel = ReturnType<typeof usePiComposerKeys>;
