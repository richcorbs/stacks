import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createChatScroll } from '../../../pi/chatScroll';
import { hasVisiblePiStreamingText, INITIAL_RENDERED_PI_MESSAGES, nextPiMessageLimit, prependAnchoredScrollTop, visiblePiMessages } from '../../../pi/transcript';
import type { PiSessionModel } from '../../../pi/usePiSession';
import { collectToolArgs } from '../../PiTranscript';

/** Transcript viewport refs, reveal batching, and anchored scroll policy. */
export function usePiTranscriptScroll({ pi, terminalId, visible }: {
  pi: PiSessionModel;
  terminalId: string;
  visible: boolean;
}) {
  const [revealedMessageCount, setRevealedMessageCount] = useState(INITIAL_RENDERED_PI_MESSAGES);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRef = useRef<ReturnType<typeof createChatScroll> | null>(null);
  const knownSessionIdRef = useRef('');
  const pendingPrependAnchorRef = useRef<{ height: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const transcript = transcriptRef.current;
    if (!viewport || !transcript) return;
    const scroll = createChatScroll(viewport);
    chatScrollRef.current = scroll;
    const observer = new ResizeObserver(scroll.layout);
    observer.observe(viewport);
    observer.observe(transcript);
    scroll.layout();
    return () => {
      observer.disconnect();
      scroll.dispose();
      chatScrollRef.current = null;
    };
  }, []);

  useEffect(() => {
    setRevealedMessageCount(INITIAL_RENDERED_PI_MESSAGES);
    pendingPrependAnchorRef.current = null;
    knownSessionIdRef.current = '';
  }, [terminalId]);

  useEffect(() => {
    const sessionId = pi.context.sessionId;
    if (!sessionId) return;
    if (knownSessionIdRef.current && knownSessionIdRef.current !== sessionId) {
      setRevealedMessageCount(INITIAL_RENDERED_PI_MESSAGES);
      pendingPrependAnchorRef.current = null;
    }
    knownSessionIdRef.current = sessionId;
  }, [pi.context.sessionId]);

  useLayoutEffect(() => {
    const anchor = pendingPrependAnchorRef.current;
    const element = scrollRef.current;
    if (!anchor || !element) return;
    element.scrollTop = prependAnchoredScrollTop(anchor.height, anchor.top, element.scrollHeight);
    pendingPrependAnchorRef.current = null;
  }, [revealedMessageCount]);

  useLayoutEffect(() => {
    if (visible) chatScrollRef.current?.layout();
  }, [pi.isStreaming, pi.messages, pi.queuedFollowUps, pi.queuedSteering, pi.streamingText, pi.tools, pi.uiRequest, visible]);

  const { hiddenCount: hiddenMessageCount, messages: visibleMessages } = visiblePiMessages(pi.messages, revealedMessageCount);
  const historicalToolArgs = useMemo(() => collectToolArgs(pi.messages), [pi.messages]);
  const hasStreamingText = hasVisiblePiStreamingText(pi.streamingText);
  const hasActiveStreamingText = hasStreamingText && pi.isStreamingText;

  function loadOlderMessages() {
    const element = scrollRef.current;
    if (!element || hiddenMessageCount === 0) return;
    pendingPrependAnchorRef.current = { height: element.scrollHeight, top: element.scrollTop };
    chatScrollRef.current?.pause();
    setRevealedMessageCount((current) => nextPiMessageLimit(current, pi.messages.length));
  }

  return {
    scrollRef,
    transcriptRef,
    chatScrollRef: chatScrollRef as RefObject<ReturnType<typeof createChatScroll> | null>,
    hiddenMessageCount,
    visibleMessages,
    historicalToolArgs,
    hasStreamingText,
    hasActiveStreamingText,
    loadOlderMessages,
  };
}

export type PiTranscriptScrollModel = ReturnType<typeof usePiTranscriptScroll>;
