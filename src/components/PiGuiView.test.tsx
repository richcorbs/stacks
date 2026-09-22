import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PiPendingOutput, PiQueuedMessage } from './PiGuiView';

describe('PiGuiView queued messages', () => {
  it('renders the thinking indicator before steering and follow-up messages', () => {
    const markup = renderToStaticMarkup(
      <PiPendingOutput
        isStreaming
        hasActiveStreamingText={false}
        queuedSteering={['**Steer** here']}
        queuedFollowUps={['Follow <em>up</em>']}
      />,
    );

    const thinkingIndex = markup.indexOf('aria-label="Pi is thinking"');
    const steeringIndex = markup.indexOf('aria-label="Queued steering message"');
    const followUpIndex = markup.indexOf('aria-label="Queued follow-up"');
    expect(thinkingIndex).toBeGreaterThanOrEqual(0);
    expect(thinkingIndex).toBeLessThan(steeringIndex);
    expect(steeringIndex).toBeLessThan(followUpIndex);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('<strong>Steer</strong> here');
    expect(markup).toContain('Follow <em>up</em>');
  });

  it('does not show the thinking indicator while assistant text is actively streaming', () => {
    const markup = renderToStaticMarkup(
      <PiPendingOutput
        isStreaming
        hasActiveStreamingText
        queuedSteering={['Still queued']}
        queuedFollowUps={[]}
      />,
    );

    expect(markup).not.toContain('aria-label="Pi is thinking"');
    expect(markup).toContain('aria-label="Queued steering message"');
  });

  it.each([
    ['steering' as const, 'Queued steering message', 'Steering', 'piQueuedSteering'],
    ['follow-up' as const, 'Queued follow-up', 'Follow up', 'piQueuedFollowUp'],
  ])('renders queued %s content with the shared mixed-content renderer', (kind, ariaLabel, label, className) => {
    const markup = renderToStaticMarkup(
      <PiQueuedMessage kind={kind}>**Markdown** and &lt;em&gt;HTML&lt;/em&gt;</PiQueuedMessage>,
    );

    expect(markup).toContain(`aria-label="${ariaLabel}"`);
    expect(markup).toContain(className);
    expect(markup).toContain(`<small>${label}</small>`);
    expect(markup).toContain('class="piQueuedMessageContent piMarkdown"');
    expect(markup).toContain('<strong>Markdown</strong> and <em>HTML</em>');
  });
});
