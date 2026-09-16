import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PiQueuedMessage } from './PiGuiView';

describe('PiGuiView queued messages', () => {
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
