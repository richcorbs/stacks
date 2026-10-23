import type { KeyboardEvent } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

/** Only the focused composer opts in; all other editing shortcuts remain native. */
export function handleComposerClipboard(
  event: KeyboardEvent<HTMLTextAreaElement>,
  onCut: (value: string, caret: number) => void,
  onError: (error: unknown) => void,
): boolean {
  const key = event.key.toLowerCase();
  const input = event.currentTarget;
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
    || (key !== 'c' && key !== 'x') || event.nativeEvent.isComposing
    || input.ownerDocument.activeElement !== input) return false;

  event.preventDefault();
  event.stopPropagation();
  const { value, selectionStart: start, selectionEnd: end } = input;
  // Do not overwrite the clipboard when there is no selection.
  if (start === end) return true;

  void writeText(value.slice(start, end)).then(() => {
    if (key !== 'x') return;
    // Clipboard IPC is async: never delete a newer draft or a changed selection,
    // or move focus back from another terminal/dialog after the write completes.
    if (input.ownerDocument.activeElement !== input || input.value !== value
      || input.selectionStart !== start || input.selectionEnd !== end) return;
    onCut(value.slice(0, start) + value.slice(end), start);
  }).catch(onError);
  return true;
}
