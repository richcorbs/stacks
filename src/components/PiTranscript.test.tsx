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

  it('renders only the later wording of duplicate text blocks in one assistant turn', async () => {
    const content = [
      { type: 'text' as const, text: 'Refinement is ready!' },
      { type: 'thinking' as const, thinking: 'Double-checking the answer.' },
      { type: 'text' as const, text: 'REFINEMENT is ready.' },
    ];
    const message: PiMessage = { role: 'assistant', content };
    let renderer!: TestRenderer.ReactTestRenderer;
    markdownRender.mockClear();

    await act(async () => {
      renderer = TestRenderer.create(<PiSettledMessages messages={[message]} toolArgs={new Map()} />);
    });

    expect(markdownRender.mock.calls.map(([text]) => text)).toEqual(['Double-checking the answer.', 'REFINEMENT is ready.']);
    expect(JSON.stringify(renderer.toJSON())).toContain('Reasoning');
    expect(message.content).toBe(content);
    expect(content).toHaveLength(3);
  });

  it('suppresses the earlier near-duplicate from the card 182 transcript', async () => {
    const earlier = 'When this happens, do you see **two identical user prompt bubbles with two agent runs**, or only a duplicated prompt bubble while the agent responds once? Also, what action triggers it most reliably (creating a card with refinement, opening a Needs refinement card, or reopening an existing refinement)?';
    const later = 'When this happens, do you see **two identical user prompt bubbles with two agent runs**, or only a duplicated prompt bubble while the agent responds once? What action triggers it most reliably: creating a card with refinement, opening a Needs refinement card, or reopening an existing refinement?';
    markdownRender.mockClear();

    await act(async () => {
      TestRenderer.create(<PiSettledMessages messages={[{
        role: 'assistant', content: [{ type: 'text', text: earlier }, { type: 'text', text: later }],
      }]} toolArgs={new Map()} />);
    });

    expect(markdownRender.mock.calls.map(([text]) => text)).toEqual([later]);
  });

  it('keeps meaningfully distinct commentary and final text in one assistant turn', async () => {
    const progress = 'I found the duplicate in rendering and am now checking transcript persistence.';
    const final = 'The rendering fix is complete. The persisted transcript remains unchanged.';
    markdownRender.mockClear();

    await act(async () => {
      TestRenderer.create(<PiSettledMessages messages={[{
        role: 'assistant', content: [{ type: 'text', text: progress }, { type: 'text', text: final }],
      }]} toolArgs={new Map()} />);
    });

    expect(markdownRender.mock.calls.map(([text]) => text)).toEqual([progress, final]);
  });

  it('does not collapse matching text from separate assistant turns', async () => {
    const repeated = 'Please confirm which action triggers the duplicate.';
    markdownRender.mockClear();

    await act(async () => {
      TestRenderer.create(<PiSettledMessages messages={[
        { role: 'assistant', content: [{ type: 'text', text: repeated }], timestamp: 1 },
        { role: 'assistant', content: [{ type: 'text', text: repeated }], timestamp: 2 },
      ]} toolArgs={new Map()} />);
    });

    expect(markdownRender.mock.calls.map(([text]) => text)).toEqual([repeated, repeated]);
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
