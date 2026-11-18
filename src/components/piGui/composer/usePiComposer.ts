import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { applySlashCommand, isGuiBuiltinCommand, isMcpStatusCommand, matchingSlashCommands } from '../../../pi/commands';
import { activePathToken, applyPathCompletion } from '../../../pi/pathReferences';
import { canSendPiQuickResponse, sendPiQuickResponse, type PiQuickResponse } from '../../../pi/quickResponse';
import { listenForPiEditorText } from '../../../pi/editorTextEvent';
import type { PiCommand } from '../../../pi/types';
import type { PiSessionModel } from '../../../pi/usePiSession';
import type { createChatScroll } from '../../../pi/chatScroll';
import type { PiPathReferencesModel } from '../pathReferences/usePiPathReferences';
import type { PiComposerHistoryModel } from './usePiComposerHistory';

/** Composer state, submission, autosize, history, and editor-text integration. */
export function usePiComposer({ pi, composerDraftKey, prompt, setPrompt, beginSubmission, paths, history, selectedCommandIndex, setSelectedCommandIndex, inputRef, selectionRef, cutCaretRef, paneRef, chatScrollRef, setComposerError, onFocusComposer, onMcpCommandStatus, active, visible, terminalId, fontSize }: {
  pi: PiSessionModel;
  composerDraftKey?: string;
  prompt: string;
  setPrompt: (value: string | ((current: string) => string)) => void;
  beginSubmission: () => ((success: boolean) => void);
  paths: PiPathReferencesModel;
  history: PiComposerHistoryModel;
  selectedCommandIndex: number;
  setSelectedCommandIndex: (index: number | ((current: number) => number)) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  selectionRef: RefObject<{ start: number; end: number }>;
  cutCaretRef: RefObject<number | null>;
  paneRef: RefObject<HTMLDivElement | null>;
  chatScrollRef: RefObject<ReturnType<typeof createChatScroll> | null>;
  setComposerError: (message: string | null) => void;
  onFocusComposer: () => void;
  onMcpCommandStatus: (visible: boolean) => void;
  active: boolean;
  visible: boolean;
  terminalId: string;
  fontSize: number;
}) {
  const [quickResponseSubmitting, setQuickResponseSubmitting] = useState(false);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const resize = () => {
      resizeComposerInput(input);
      chatScrollRef.current?.layout();
    };
    resize();
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(resize);
    });
    if (input.parentElement) observer.observe(input.parentElement);
    if (paneRef.current) {
      observer.observe(paneRef.current);
      const conversation = paneRef.current.querySelector<HTMLElement>(':scope > .piGuiConversation');
      if (conversation) observer.observe(conversation);
    }
    return () => {
      cancelAnimationFrame(resizeFrame);
      observer.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    if (inputRef.current) resizeComposerInput(inputRef.current);
    chatScrollRef.current?.layout();
  }, [fontSize, prompt]);

  useLayoutEffect(() => {
    if (cutCaretRef.current === null) return;
    const caret = cutCaretRef.current;
    cutCaretRef.current = null;
    inputRef.current?.setSelectionRange(caret, caret);
  }, [prompt]);

  useLayoutEffect(() => {
    if (!pi.editorTextRequest) return;
    setPrompt(pi.editorTextRequest.text);
    setSelectedCommandIndex(-1);
    if (active && visible) onFocusComposer();
  }, [pi.editorTextRequest, onFocusComposer]);

  useLayoutEffect(() => {
    return listenForPiEditorText((request) => {
      if (request.terminalId !== terminalId || !active || !visible) return;
      setPrompt(request.text);
      setSelectedCommandIndex(-1);
      request.acknowledge();
      onFocusComposer();
    });
  }, [active, onFocusComposer, terminalId, visible]);

  const matchingCommands = selectedCommandIndex >= 0 ? matchingSlashCommands(pi.commands, prompt) : [];
  const completionToken = activePathToken(prompt, paths.completionCursor);
  const matchingPaths = matchingCommands.length === 0 && completionToken ? paths.suggestions : [];

  function chooseCommand(command: PiCommand) {
    setPrompt(applySlashCommand(command));
    setSelectedCommandIndex(-1);
    paths.clearSuggestions();
    onFocusComposer();
  }

  function choosePath(path: { path: string; isDir: boolean }) {
    const token = activePathToken(prompt, paths.completionCursor);
    if (!token) return;
    const edit = applyPathCompletion(prompt, token, path.path, path.isDir);
    setPrompt(edit.value);
    selectionRef.current = { start: edit.cursor, end: edit.cursor };
    paths.setCompletionCursor(edit.cursor);
    paths.clearSuggestions();
    onFocusComposer();
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(edit.cursor, edit.cursor));
  }

  const quickResponseSessionEligible = canSendPiQuickResponse(pi);
  const quickResponseInFlightRef = useRef(false);
  const quickResponseSessionEligibleRef = useRef(quickResponseSessionEligible);
  quickResponseSessionEligibleRef.current = quickResponseSessionEligible;

  async function submitQuickResponse(message: PiQuickResponse) {
    if (!quickResponseSessionEligibleRef.current || quickResponseInFlightRef.current) return;
    quickResponseInFlightRef.current = true;
    setQuickResponseSubmitting(true);
    try {
      await sendPiQuickResponse(message, {
        isEligible: () => quickResponseSessionEligibleRef.current,
        dismissStructuredUiRequest: pi.dismissStructuredUiRequest,
        prompt: pi.prompt,
      });
    } finally {
      quickResponseInFlightRef.current = false;
      setQuickResponseSubmitting(false);
      onFocusComposer();
    }
  }

  async function submit(behavior: 'prompt' | 'followUp' = 'prompt') {
    const message = prompt.trim();
    const slashName = message.startsWith('/') ? message.slice(1).split(/\s/, 1)[0] : '';
    const extensionCommand = pi.commands.some((command) => command.name === slashName && command.source === 'extension');
    const builtinCommand = isGuiBuiltinCommand(slashName);
    if (!message || (pi.isStreaming && builtinCommand)) return;
    // Claim inline controls synchronously so a click cannot race this submit.
    // Pi receives cancellation; the text remains an ordinary prompt/steer/follow-up.
    const structuredRequestDismissal = pi.dismissStructuredUiRequest();
    history.resetHistory();
    const finishSubmission = composerDraftKey ? beginSubmission() : null;
    if (!finishSubmission) setPrompt('');
    paths.clearSuggestions();
    setComposerError(null);
    onMcpCommandStatus(isMcpStatusCommand(message));
    chatScrollRef.current?.resume();
    await structuredRequestDismissal.catch(() => {});
    const send = builtinCommand
      ? pi.runBuiltinCommand(message)
      : pi.isStreaming && extensionCommand
        ? pi.prompt(message, [])
        : pi.isStreaming && behavior === 'followUp'
          ? pi.followUp(message, [])
          : pi.isStreaming
            ? pi.steer(message, [])
            : pi.prompt(message, []);
    await send.then(() => finishSubmission?.(true), () => {
      if (finishSubmission) finishSubmission(false);
      else setPrompt(message);
    });
  }

  async function pasteIntoComposer() {
    const input = inputRef.current;
    const selectionStart = input?.selectionStart ?? prompt.length;
    const selectionEnd = input?.selectionEnd ?? selectionStart;
    const text = await readText();
    if (!text) return;
    let cursor = selectionStart + text.length;
    setPrompt((current) => {
      const start = Math.min(selectionStart, current.length);
      const end = Math.min(Math.max(selectionEnd, start), current.length);
      cursor = start + text.length;
      return `${current.slice(0, start)}${text}${current.slice(end)}`;
    });
    setSelectedCommandIndex(0);
    onFocusComposer();
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(cursor, cursor));
  }

  return {
    matchingCommands,
    matchingPaths,
    selectedCommandIndex,
    setSelectedCommandIndex,
    quickResponseSessionEligible,
    quickResponseSubmitting,
    chooseCommand,
    choosePath,
    submit,
    submitQuickResponse,
    pasteIntoComposer,
  };
}

export type PiComposerModel = ReturnType<typeof usePiComposer>;

export function resizeComposerInput(input: HTMLTextAreaElement) {
  const pane = input.closest<HTMLElement>('.piGuiPane');
  const conversation = pane?.querySelector<HTMLElement>(':scope > .piGuiConversation');
  const currentHeight = Math.max(23, input.offsetHeight);
  let availableGrowth = 0;
  if (conversation) {
    const style = getComputedStyle(conversation);
    const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    availableGrowth = Math.max(0, conversation.clientHeight - verticalPadding);
  }
  const maxHeight = Math.max(23, currentHeight + availableGrowth);
  input.style.height = 'auto';
  const height = Math.min(input.scrollHeight, maxHeight);
  input.style.maxHeight = `${maxHeight}px`;
  input.style.height = `${height}px`;
  input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
}
