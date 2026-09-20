import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CleanupPreflightDialog } from './CleanupPreflightDialog';
import type { CleanupPreflight } from '../../kanban/types';

function entry(overrides: Partial<CleanupPreflight> = {}): CleanupPreflight {
  return {
    card_id: 'c1', card_title: 'Safe cleanup', project_id: 'p1', project_name: 'Project A', completion_outcome: 'merged',
    workflow_revision: 2, environment_revision: 3, eligible: true, state: 'pending_cleanup', repository_id: '/repo/.git',
    primary_checkout: '/repo', recorded_target_branch: 'master', current_target_branch: 'main', target_revision: 'target',
    source_path: '/repo-card', source_exists: true, source_registered: true, source_branch: 'card', source_clean: true,
    source_head: 'source', source_revision: 'source', source_git_operation: false, merge_proof: 'exact ancestry',
    local_branch_disposition: 'delete exact tip', remote_branch_disposition: 'retained', resources: [{ resource_type: 'PTY', id: 'terminal', disposition: 'stop' }],
    metadata: ['card environment', 'layout'], blockers: [], retained: ['remote branch'], orphan_warning: null, ...overrides,
  };
}

describe('CleanupPreflightDialog', () => {
  it('renders inspectable source, target, resource, branch, and metadata evidence', () => {
    const html = renderToStaticMarkup(<CleanupPreflightDialog inventory={{ entries: [entry()], eligible_merged: 1, blocked: 0, closed: 0, completed: 0 }} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(html).toContain('Cleanup preflight');
    expect(html).toContain('recorded master · current main');
    expect(html).toContain('exact ancestry');
    expect(html).toContain('PTY terminal');
    expect(html).toContain('card environment, layout');
  });

  it('disables confirmation and explains blockers and recorded orphan warnings', () => {
    const blocked = entry({ eligible: false, blockers: ['Worktree is dirty'], orphan_warning: 'Recorded path is no longer registered' });
    const html = renderToStaticMarkup(<CleanupPreflightDialog inventory={{ entries: [blocked], eligible_merged: 0, blocked: 1, closed: 0, completed: 0 }} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(html).toContain('Worktree is dirty');
    expect(html).toContain('Recorded path is no longer registered');
    expect(html).toMatch(/disabled=""[^>]*>.*Confirm cleanup/s);
  });

  it('keeps Done Closed report-only in bulk inventory', () => {
    const closed = entry({ card_id: 'closed', completion_outcome: 'closed', card_title: 'Closed card' });
    const html = renderToStaticMarkup(<CleanupPreflightDialog bulk inventory={{ entries: [closed], eligible_merged: 0, blocked: 0, closed: 1, completed: 0 }} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(html).toContain('Done · Closed report-only');
    expect(html).toContain('Clean up 0 eligible');
  });
});
