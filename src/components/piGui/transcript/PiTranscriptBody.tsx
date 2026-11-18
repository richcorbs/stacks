import type { PiSessionModel } from '../../../pi/usePiSession';
import { PiMarkdown } from '../../PiMarkdown';
import { PiSessionBoundaryEntry, PiSettledMessages, PiToolCard } from '../../PiTranscript';
import { isStructuredPiUiRequest, PiStructuredRequest } from '../../PiStructuredRequest';
import { PiPendingOutput } from '../pendingOutput/PiPendingOutput';
import type { PiTranscriptScrollModel } from './usePiTranscriptScroll';

/** Settled transcript, live stream, tools, structured requests, and queued output. */
export function PiTranscriptBody({ pi, transcript }: { pi: PiSessionModel; transcript: PiTranscriptScrollModel }) {
  return <div className="piGuiTranscript" ref={transcript.transcriptRef}>
    {pi.starting && <div className="piGuiEmpty">Starting Pi…</div>}
    {!pi.starting && pi.messages.length === 0 && !pi.streamingText && (
      <div className="piGuiEmpty">
        <span className="piGuiEmptyMark">π</span>
        <strong>What should we work on?</strong>
        <small>Pi can read, edit, and run commands in this workspace.</small>
      </div>
    )}
    {transcript.hiddenMessageCount > 0 && <div className="piHistoryLimit">
      <button type="button" onClick={transcript.loadOlderMessages}>Load older messages</button>
      <span>{transcript.hiddenMessageCount} earlier {transcript.hiddenMessageCount === 1 ? 'message' : 'messages'}</span>
    </div>}
    {pi.sessionBoundary && <PiSessionBoundaryEntry boundary={pi.sessionBoundary} />}
    <PiSettledMessages messages={transcript.visibleMessages} toolArgs={transcript.historicalToolArgs} />
    {transcript.hasStreamingText && (
      <div className="piMessage piMessageAssistant">
        <div className="piMessageText piMarkdown"><PiMarkdown>{pi.streamingText}</PiMarkdown>{transcript.hasActiveStreamingText && <span className="piStreamingCursor" />}</div>
      </div>
    )}
    {pi.tools.map((tool) => (
      <PiToolCard
        key={tool.id}
        name={tool.name}
        args={tool.args}
        output={tool.partialText}
        status={tool.status}
        live
      />
    ))}
    {isStructuredPiUiRequest(pi.uiRequest) && <PiStructuredRequest
      request={pi.uiRequest}
      onRespond={(requestId, response) => { pi.respondToUiRequest(requestId, response).catch(() => {}); }}
    />}
    <PiPendingOutput
      isStreaming={pi.isStreaming}
      hasActiveStreamingText={transcript.hasActiveStreamingText}
      queuedSteering={pi.queuedSteering}
      queuedFollowUps={pi.queuedFollowUps}
    />
  </div>;
}
