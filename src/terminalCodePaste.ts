import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { showAppToast } from './applicationEvents';
import { normalizeClipboardText } from './clipboard';
import { bracketedPastePayload, sendTerminalInput } from './terminalInput';
import { focusTerminalSession } from './terminalSessionManager';

export const CODE_PASTE_TIMEOUT_MS = 10_000;

export type PasteCodeOptions = {
  /** The pane to receive the snippet, or empty when no terminal is available. */
  paneId: string | null | undefined;
  /**
   * Why the terminal cannot be targeted, when it cannot — e.g. a card without an
   * environment, where the Terminal tab is not enabled yet. Reported verbatim.
   */
  unavailableReason?: string | null;
  /** Reveal the terminal view; false when the view is not available right now. */
  switchToTerminal: () => Promise<boolean> | boolean;
  timeoutMs?: number;
};

/**
 * One "paste into terminal" action, shared by the card chat and the project
 * workspace agent: copy the snippet, reveal the terminal, write it to the focused
 * shell pane as a bracketed paste, and focus it.
 *
 * Nothing is written without a target and a running shell, and a failure always
 * says why rather than leaving a button that appeared to do nothing.
 */
export async function pasteCodeIntoTarget(code: string, options: PasteCodeOptions): Promise<boolean> {
  if (options.unavailableReason) {
    showAppToast(`Could not paste into terminal: ${options.unavailableReason}`);
    return false;
  }
  const paneId = options.paneId ?? '';
  if (!paneId) {
    showAppToast('Could not paste into terminal: no terminal is open');
    return false;
  }
  const snippet = normalizeClipboardText(code);
  try {
    await writeText(snippet);
  } catch (error) {
    // The paste can still land in the shell; report the clipboard failure and continue.
    showAppToast(`Could not copy to clipboard: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!await options.switchToTerminal()) {
    showAppToast('Could not paste into terminal: the Terminal tab is unavailable');
    return false;
  }
  let bracketedPaste = false;
  const sent = await sendTerminalInput(paneId, snippet, {
    timeoutMs: options.timeoutMs ?? CODE_PASTE_TIMEOUT_MS,
    payload: (text, session) => {
      bracketedPaste = session.term.modes.bracketedPasteMode;
      return bracketedPastePayload(text, bracketedPaste);
    },
  });
  if (!sent) {
    showAppToast('Could not paste into terminal: the shell is not running');
    return false;
  }
  focusTerminalSession(paneId, 'code-block-paste');
  showAppToast(bracketedPaste
    ? 'Pasted into terminal'
    : 'Pasted into terminal — multi-line code may execute');
  return true;
}
