import { describe, expect, it, vi } from 'vitest';

const showAppToast = vi.fn();
const writeText = vi.fn();
const focusTerminalSession = vi.fn();
const sendTerminalInput = vi.fn();
const bracketedPastePayload = vi.fn((text: string, bracketed: boolean) => bracketed ? `\u001b[200~${text}\u001b[201~` : text);

vi.mock('./applicationEvents', () => ({ showAppToast: (...args: unknown[]) => showAppToast(...args) }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: (...args: unknown[]) => writeText(...args) }));
vi.mock('./terminalSessionManager', () => ({ focusTerminalSession: (...args: unknown[]) => focusTerminalSession(...args) }));
vi.mock('./terminalInput', () => ({
  bracketedPastePayload: (text: string, bracketed: boolean) => bracketedPastePayload(text, bracketed),
  sendTerminalInput: (...args: unknown[]) => sendTerminalInput(...args),
}));

import { pasteCodeIntoTarget } from './terminalCodePaste';

function session(bracketedPasteMode: boolean) {
  return { term: { modes: { bracketedPasteMode } } };
}

describe('pasteCodeIntoTarget', () => {
  it('copies, reveals the terminal, pastes as bracketed paste, and focuses', async () => {
    showAppToast.mockClear();
    writeText.mockResolvedValue(undefined);
    sendTerminalInput.mockImplementation(async (_id, text, options) => { options.payload(text, session(true)); return true; });
    const switchToTerminal = vi.fn(() => true);

    const ok = await pasteCodeIntoTarget('echo "one"\necho "two"', { paneId: 'pane-1', switchToTerminal });

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('echo "one"\necho "two"');
    // Never a trailing newline: that would execute the snippet.
    expect(sendTerminalInput.mock.calls[0][1]).toBe('echo "one"\necho "two"');
    expect(switchToTerminal).toHaveBeenCalledOnce();
    expect(focusTerminalSession).toHaveBeenCalledWith('pane-1', 'code-block-paste');
    expect(showAppToast).toHaveBeenLastCalledWith('Pasted into terminal');
  });

  it('warns that multi-line code may execute when bracketed paste is off', async () => {
    showAppToast.mockClear();
    writeText.mockResolvedValue(undefined);
    sendTerminalInput.mockImplementation(async (_id, text, options) => { options.payload(text, session(false)); return true; });

    expect(await pasteCodeIntoTarget('a\nb', { paneId: 'pane-1', switchToTerminal: () => true })).toBe(true);
    expect(showAppToast).toHaveBeenLastCalledWith('Pasted into terminal — multi-line code may execute');
  });

  it('does nothing but explain when the terminal is unavailable', async () => {
    showAppToast.mockClear();
    const switchToTerminal = vi.fn(() => true);

    expect(await pasteCodeIntoTarget('x', { paneId: 'pane-1', unavailableReason: 'this card has no environment yet', switchToTerminal }))
      .toBe(false);
    expect(switchToTerminal).not.toHaveBeenCalled();
    expect(sendTerminalInput).not.toHaveBeenCalled();
    expect(showAppToast).toHaveBeenLastCalledWith('Could not paste into terminal: this card has no environment yet');
  });

  it('does nothing when no pane is open', async () => {
    showAppToast.mockClear();
    expect(await pasteCodeIntoTarget('x', { paneId: '', switchToTerminal: () => true })).toBe(false);
    expect(showAppToast).toHaveBeenLastCalledWith('Could not paste into terminal: no terminal is open');
  });

  it('still pastes when the clipboard write fails', async () => {
    showAppToast.mockClear();
    writeText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    sendTerminalInput.mockImplementation(async (_id, text, options) => { options.payload(text, session(true)); return true; });

    expect(await pasteCodeIntoTarget('x', { paneId: 'pane-1', switchToTerminal: () => true })).toBe(true);
    expect(showAppToast).toHaveBeenCalledWith('Could not copy to clipboard: clipboard unavailable');
  });

  it('reports a shell that never becomes ready', async () => {
    showAppToast.mockClear();
    writeText.mockResolvedValue(undefined);
    sendTerminalInput.mockResolvedValue(false);
    expect(await pasteCodeIntoTarget('x', { paneId: 'pane-1', switchToTerminal: () => true })).toBe(false);
    expect(showAppToast).toHaveBeenLastCalledWith('Could not paste into terminal: the shell is not running');
  });
});
