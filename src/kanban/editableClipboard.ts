export type EditableClipboardControl = Pick<
  HTMLInputElement | HTMLTextAreaElement,
  'focus' | 'selectionEnd' | 'selectionStart' | 'setSelectionRange' | 'value'
>;

type ClipboardKeyEvent = {
  altKey: boolean;
  ctrlKey: boolean;
  currentTarget: EditableClipboardControl;
  key: string;
  metaKey: boolean;
  preventDefault: () => void;
  shiftKey: boolean;
  stopPropagation: () => void;
};

type EditableClipboardOptions = {
  event: ClipboardKeyEvent;
  isCurrent?: () => boolean;
  readText: () => Promise<string>;
  requestFrame: (callback: () => void) => unknown;
  setValue: (value: string) => void;
  showError: (message: string) => void;
  writeText: (text: string) => Promise<void>;
};

export type SelectionReplacement = {
  selectionEnd: number;
  selectionStart: number;
  value: string;
};

export function replaceSelection(value: string, selectionStart: number, selectionEnd: number, replacement: string): SelectionReplacement {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const caret = start + replacement.length;
  return {
    value: `${value.slice(0, start)}${replacement}${value.slice(end)}`,
    selectionStart: caret,
    selectionEnd: caret,
  };
}

export function editableClipboardShortcut(event: Pick<ClipboardKeyEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>): 'copy' | 'cut' | 'paste' | null {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  const key = event.key.toLocaleLowerCase();
  if (key === 'c') return 'copy';
  if (key === 'x') return 'cut';
  if (key === 'v') return 'paste';
  return null;
}

export async function handleEditableClipboardKeyDown({
  event,
  isCurrent = () => true,
  readText,
  requestFrame,
  setValue,
  showError,
  writeText,
}: EditableClipboardOptions): Promise<boolean> {
  const action = editableClipboardShortcut(event);
  if (!action) return false;

  event.preventDefault();
  event.stopPropagation();

  const control = event.currentTarget;
  const value = control.value;
  const selectionStart = control.selectionStart ?? 0;
  const selectionEnd = control.selectionEnd ?? selectionStart;
  const selection = value.slice(selectionStart, selectionEnd);

  try {
    if (action === 'copy') {
      if (selection) await writeText(selection);
      return true;
    }

    if (action === 'cut') {
      if (!selection) return true;
      await writeText(selection);
      if (!isCurrent()) return true;
      applyReplacement(control, replaceSelection(value, selectionStart, selectionEnd, ''), setValue, requestFrame, isCurrent);
      return true;
    }

    const clipboardText = await readText();
    if (!isCurrent()) return true;
    applyReplacement(control, replaceSelection(value, selectionStart, selectionEnd, clipboardText), setValue, requestFrame, isCurrent);
    return true;
  } catch (error) {
    showError(`Could not ${action}: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
}

function applyReplacement(
  control: EditableClipboardControl,
  replacement: SelectionReplacement,
  setValue: (value: string) => void,
  requestFrame: (callback: () => void) => unknown,
  isCurrent: () => boolean,
) {
  setValue(replacement.value);
  requestFrame(() => {
    if (!isCurrent()) return;
    control.focus();
    control.setSelectionRange(replacement.selectionStart, replacement.selectionEnd);
  });
}
