import { describe, expect, it } from 'vitest';
import type { TerminalEntry } from '../types';
import { diffReviewTargetPane } from './targetPane';

const terminal: TerminalEntry = { id: 'workspace:terminal', workspaceId: 'workspace' };
const pi: TerminalEntry = { id: 'workspace:pi', workspaceId: 'workspace', kind: 'pi' };
const otherPi: TerminalEntry = { id: 'workspace:other-pi', workspaceId: 'workspace', kind: 'pi' };

describe('diffReviewTargetPane', () => {
  it('prefers the active Pi pane', () => {
    expect(diffReviewTargetPane([pi, otherPi], otherPi.id)?.id).toBe(otherPi.id);
  });

  it('finds a Pi pane when a terminal is active', () => {
    expect(diffReviewTargetPane([terminal, pi], terminal.id)?.id).toBe(pi.id);
  });

  it('does not target temporary or missing Pi panes', () => {
    expect(diffReviewTargetPane([{ ...pi, temporary: true }], terminal.id)).toBeNull();
    expect(diffReviewTargetPane([terminal], terminal.id)).toBeNull();
  });
});
