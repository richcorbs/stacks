import { PiMarkdown } from '../../PiMarkdown';

export function PiPendingOutput({ isStreaming, hasActiveStreamingText, queuedSteering, queuedFollowUps }: {
  isStreaming: boolean;
  hasActiveStreamingText: boolean;
  queuedSteering: string[];
  queuedFollowUps: string[];
}) {
  return <>
    {isStreaming && !hasActiveStreamingText && (
      <div className="piWorkingIndicator" role="status" aria-label="Pi is thinking" aria-live="polite">
        <span className="piWorkingDots" aria-hidden="true"><i /><i /><i /></span>
      </div>
    )}
    {queuedSteering.map((message, index) => <PiQueuedMessage key={`steer:${message}:${index}`} kind="steering">{message}</PiQueuedMessage>)}
    {queuedFollowUps.map((message, index) => <PiQueuedMessage key={`follow-up:${message}:${index}`} kind="follow-up">{message}</PiQueuedMessage>)}
  </>;
}

export function PiQueuedMessage({ children, kind }: { children: string; kind: 'steering' | 'follow-up' }) {
  const steering = kind === 'steering';
  return <div
    className={`piMessage piMessageUser piQueuedMessage ${steering ? 'piQueuedSteering' : 'piQueuedFollowUp'}`}
    aria-label={steering ? 'Queued steering message' : 'Queued follow-up'}
  >
    <div className="piMessageText">
      <small>{steering ? 'Steering' : 'Follow up'}</small>
      <div className="piQueuedMessageContent piMarkdown"><PiMarkdown>{children}</PiMarkdown></div>
    </div>
  </div>;
}
