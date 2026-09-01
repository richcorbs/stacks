const PI_EDITOR_TEXT_EVENT = 'stacks:pi-editor-text';

type PiEditorTextRequest = {
  terminalId: string;
  text: string;
  acknowledge: () => void;
};

export function sendTextToPiEditor(terminalId: string, text: string) {
  let delivered = false;
  window.dispatchEvent(new CustomEvent<PiEditorTextRequest>(PI_EDITOR_TEXT_EVENT, {
    detail: { terminalId, text, acknowledge: () => { delivered = true; } },
  }));
  return delivered;
}

export function listenForPiEditorText(listener: (request: PiEditorTextRequest) => void) {
  const handleEvent = (event: Event) => listener((event as CustomEvent<PiEditorTextRequest>).detail);
  window.addEventListener(PI_EDITOR_TEXT_EVENT, handleEvent);
  return () => window.removeEventListener(PI_EDITOR_TEXT_EVENT, handleEvent);
}
