import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { PiMessage } from '../pi/types';

const { markdownRender } = vi.hoisted(() => ({ markdownRender: vi.fn() }));
vi.mock('./PiMarkdown', () => ({
  PiMarkdown: ({ children }: { children: string }) => {
    markdownRender(children);
    return <span>{children}</span>;
  },
}));

import { collectToolArgs, PiSettledMessages } from './PiTranscript';

describe('Pi settled transcript rendering', () => {
  it('does not rerender visible settled Markdown when older history is prepended', async () => {
    const newest: PiMessage = { role: 'assistant', content: [{ type: 'text', text: 'newest' }], timestamp: 2 };
    const older: PiMessage = { role: 'assistant', content: [{ type: 'text', text: 'older' }], timestamp: 1 };
    let renderer!: TestRenderer.ReactTestRenderer;
    markdownRender.mockClear();

    await act(async () => {
      renderer = TestRenderer.create(<PiSettledMessages messages={[newest]} toolArgs={new Map()} />);
    });
    expect(markdownRender).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.update(<PiSettledMessages messages={[older, newest]} toolArgs={new Map()} />);
    });
    expect(markdownRender.mock.calls.map(([text]) => text)).toEqual(['newest', 'older']);
  });

  it('resolves a visible tool result from a tool call outside the rendered window', async () => {
    const call: PiMessage = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'outside-window.md' } }],
      timestamp: 1,
    };
    const result: PiMessage = {
      role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: 'contents', timestamp: 2,
    };
    const allArgs = collectToolArgs([call, result]);
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<PiSettledMessages messages={[result]} toolArgs={allArgs} />);
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('outside-window.md');
  });
});
