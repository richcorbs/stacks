import { afterEach, describe, expect, it, vi } from 'vitest';
import TestRenderer, { act } from 'react-test-renderer';
import { BoardHealthPanel } from './BoardHealthPanel';
import { fetchBoardHealth } from '../kanban/api';
import { renderedText } from '../../tests/renderedText';
import type { BoardHealthReport } from '../kanban/types';

vi.mock('../kanban/api', () => ({
  fetchBoardHealth: vi.fn(),
  cleanupBoardHealthEnvironment: vi.fn(),
}));

function report(findings: BoardHealthReport['findings'] = []): BoardHealthReport {
  return { findings, repaired: 0, board_revision: 4, scanned_at: 1 };
}

describe('BoardHealthPanel', () => {
  afterEach(() => vi.clearAllMocks());

  it('reports repaired findings with their evidence and applicable action', async () => {
    vi.mocked(fetchBoardHealth).mockResolvedValue(report([
      {
        invariant: 'finalized_parent_without_children', card_id: 'local:66', card_title: 'Stale parent', status: 'needs_human',
        project_id: 'p', environment_id: null, environment_revision: null, workflow_revision: 2,
        summary: 'A finalized aggregate has no linked children.', reasons: ['hierarchy_finalized was set after the card children were removed.'],
        repaired: true, action: null, action_label: null,
      },
      {
        invariant: 'environment_worktree_missing', card_id: 'local:92', card_title: 'Old Done card', status: 'done',
        project_id: 'p', environment_id: 'env', environment_revision: 3, workflow_revision: 5,
        summary: 'The card environment worktree is gone.', reasons: ['The recorded branch tip is an ancestor of main.'],
        repaired: false, action: 'cleanup_environment', action_label: 'Clean up environment',
      },
    ]));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<BoardHealthPanel />); });
    const text = renderedText(renderer.root);
    expect(text).toContain('Stale parent');
    expect(text).toContain('Finalized parent without children');
    expect(text).toContain('Repaired automatically.');
    expect(text).toContain('Old Done card');
    expect(text).toContain('Orphaned environment');
    expect(text).toContain('Clean up environment');
    expect(text).toContain('Reported only; nothing was changed.');
  });

  it('shows a clean result when the pass has no findings', async () => {
    vi.mocked(fetchBoardHealth).mockResolvedValue(report());
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<BoardHealthPanel />); });
    expect(renderedText(renderer.root)).toContain('No stale cards or orphaned resources found.');
  });
});
