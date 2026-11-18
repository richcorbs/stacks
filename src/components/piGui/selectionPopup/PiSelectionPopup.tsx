import type { PiSelectionPopupState } from './usePiSelectionPopup';

export function PiSelectionPopup({ selection, onCopy, onCopyToChat }: {
  selection: PiSelectionPopupState | null;
  onCopy: () => void;
  onCopyToChat: () => void;
}) {
  if (!selection) return null;
  return <div
    className={`piSelectionPopup ${selection.below ? 'below' : ''}`}
    style={{ left: selection.x, top: selection.y }}
    onMouseDown={(event) => event.preventDefault()}
  >
    <button type="button" title="Copy to clipboard" onClick={onCopy}>Copy</button>
    <button type="button" title="Copy to chat" onClick={onCopyToChat}>To chat</button>
  </div>;
}
