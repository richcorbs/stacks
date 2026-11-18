import { useEffect, useEffectEvent, type RefObject } from 'react';
import { subscribePiFileDrops } from '../../../pi/fileDropBroker';
import { formatDroppedPathReference, insertPathReferences } from '../../../pi/pathReferences';

/** Native file-drop routing into the Pi composer's last saved selection. */
export function usePiFileDrops({ terminalId, cwd, prompt, selectionRef, inputRef, setPrompt, setComposerError, setSelectedCommandIndex, setCompletionCursor, onFocusComposer }: {
  terminalId: string;
  cwd: string;
  prompt: string;
  selectionRef: RefObject<{ start: number; end: number }>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  setPrompt: (value: string) => void;
  setComposerError: (message: string | null) => void;
  setSelectedCommandIndex: (index: number) => void;
  setCompletionCursor: (cursor: number) => void;
  onFocusComposer: () => void;
}) {
  // File-drop delivery is an effect-owned subscription. Read the latest
  // committed draft through an Effect Event instead of writing a ref during render.
  const readPrompt = useEffectEvent(() => prompt);

  useEffect(() => subscribePiFileDrops(terminalId, (paths) => {
    if (paths.length === 0) {
      setComposerError('No filesystem items were included in the drop');
      return;
    }
    const references = paths.map((path) => formatDroppedPathReference(path, cwd));
    const edit = insertPathReferences(readPrompt(), selectionRef.current.start, selectionRef.current.end, references);
    selectionRef.current = { start: edit.cursor, end: edit.cursor };
    setPrompt(edit.value);
    setComposerError(null);
    setSelectedCommandIndex(-1);
    setCompletionCursor(edit.cursor);
    onFocusComposer();
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(selectionRef.current.start, selectionRef.current.end));
  }), [cwd, onFocusComposer, setComposerError, setCompletionCursor, setPrompt, setSelectedCommandIndex, terminalId, inputRef, selectionRef]);
}
