import { useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { showAppToast } from '../../../applicationEvents';
import { normalizeClipboardText } from '../../../clipboard';

export type PiSelectionPopupState = { text: string; x: number; y: number; below: boolean };

/** Transcript text-selection popup and its copy actions. */
export function usePiSelectionPopup({ paneRef, setPrompt, onFocusComposer }: {
  paneRef: RefObject<HTMLDivElement | null>;
  setPrompt: (update: (current: string) => string) => void;
  onFocusComposer: () => void;
}) {
  const [selectionPopup, setSelectionPopup] = useState<PiSelectionPopupState | null>(null);
  const preventSummaryToggleRef = useRef(false);

  useEffect(() => {
    const dismiss = (event: globalThis.MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest('.piSelectionPopup')) return;
      preventSummaryToggleRef.current = false;
      setSelectionPopup(null);
    };
    window.addEventListener('mousedown', dismiss);
    return () => window.removeEventListener('mousedown', dismiss);
  }, []);

  function showSelectionPopup(event: MouseEvent<HTMLDivElement>) {
    const selection = window.getSelection();
    const text = selection?.toString() || '';
    const pane = paneRef.current;
    if (!selection || !text.trim() || selection.rangeCount === 0 || !pane) {
      setSelectionPopup(null);
      preventSummaryToggleRef.current = false;
      return;
    }
    const range = selection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer as Element
      : range.commonAncestorContainer.parentElement;
    if (!ancestor?.closest('.piGuiPane')) return;
    const anchorElement = selection.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode as Element : selection.anchorNode?.parentElement;
    const focusElement = selection.focusNode?.nodeType === Node.ELEMENT_NODE ? selection.focusNode as Element : selection.focusNode?.parentElement;
    preventSummaryToggleRef.current = Boolean(ancestor.closest('summary') || anchorElement?.closest('summary') || focusElement?.closest('summary'));
    const selectionRect = range.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    const centerX = selectionRect.width ? selectionRect.left + selectionRect.width / 2 : event.clientX;
    const showBelow = selectionRect.top - paneRect.top < 40;
    setSelectionPopup({
      text,
      x: Math.min(paneRect.width - 75, Math.max(75, centerX - paneRect.left)),
      y: showBelow ? selectionRect.bottom - paneRect.top + 6 : selectionRect.top - paneRect.top - 6,
      below: showBelow,
    });
  }

  function clearSelection() {
    window.getSelection()?.removeAllRanges();
    preventSummaryToggleRef.current = false;
    setSelectionPopup(null);
  }

  async function copySelection() {
    if (!selectionPopup) return;
    try {
      await writeText(normalizeClipboardText(selectionPopup.text));
      clearSelection();
      showAppToast('Copied to clipboard');
    } catch (error) {
      showAppToast(`Could not copy: ${String(error)}`);
    } finally {
      onFocusComposer();
    }
  }

  function copySelectionToChat() {
    if (!selectionPopup) return;
    setPrompt((current) => current ? `${current}\n\n${selectionPopup.text}` : selectionPopup.text);
    clearSelection();
    onFocusComposer();
  }

  return { selectionPopup, showSelectionPopup, clearSelection, copySelection, copySelectionToChat, preventSummaryToggleRef };
}
