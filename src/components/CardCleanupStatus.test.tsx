import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CardCleanupStatus, cleanupPhaseLabel } from './CardCleanupStatus';

const operation = {
  status: 'failed' as const,
  phase: 'remove_worktree' as const,
  error_code: 'cleanup_remove_worktree_failed',
  error_detail: 'The path still exists but is no longer registered.',
  started_at: 1,
  updated_at: 2,
  completed_at: null,
};

describe('CardCleanupStatus', () => {
  it('shows the durable recovery phase and actionable failure', () => {
    const markup = renderToStaticMarkup(<CardCleanupStatus operation={operation} />);
    expect(markup).toContain('Cleanup failed');
    expect(markup).toContain('Removing source worktree');
    expect(markup).toContain(operation.error_detail);
    expect(markup).toContain('Retry cleanup');
  });

  it('hides completed operations while retaining all phase labels', () => {
    expect(renderToStaticMarkup(<CardCleanupStatus operation={{ ...operation, status: 'completed', completed_at: 3 }} />)).toBe('');
    expect(cleanupPhaseLabel('delete_remote_branch')).toBe('Deleting remote source branch');
  });
});
