import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { cleanupSelections, CleanupPreflightDialog } from './CleanupPreflightDialog';
import type { CleanupPreflight } from '../../kanban/types';

function entry(overrides: Partial<CleanupPreflight> = {}): CleanupPreflight {
  return {
    card_id: 'c1', card_number: '156', card_title: 'Safe cleanup', project_id: 'p1', project_name: 'Secret Project', completion_outcome: 'merged',
    workflow_revision: 2, environment_revision: 3, merged: true, blocked: false, override_available: false, has_resources: true,
    eligible: true, state: 'pending_cleanup', repository_id: '/secret/repo/.git', primary_checkout: '/secret/repo',
    recorded_target_branch: 'master', current_target_branch: 'main', target_revision: 'target-secret', source_path: '/secret/repo-card',
    source_exists: true, source_registered: true, source_branch: 'secret-card-branch', source_clean: true, source_head: 'source-secret',
    source_revision: 'source-secret', source_git_operation: false, merge_proof: 'exact ancestry secret', local_branch_disposition: 'delete exact tip',
    remote_branch_disposition: 'retained', resources: [{ resource_type: 'PTY', id: 'secret-terminal', disposition: 'stop' }],
    metadata: ['secret metadata'], blockers: ['secret blocker detail'], retained: ['secret retained detail'], orphan_warning: 'secret warning', ...overrides,
  };
}

function render(entries: CleanupPreflight[], bulk = false) {
  return renderToStaticMarkup(<CleanupPreflightDialog bulk={bulk} inventory={{ entries, eligible_merged: 0, blocked: 0, closed: 0, completed: 0 }} onCancel={vi.fn()} onConfirm={vi.fn()} />);
}

describe('CleanupPreflightDialog', () => {
  it('uses the same compact card row for single and bulk cleanup', () => {
    for (const html of [render([entry()]), render([entry()], true)]) {
      expect(html).toContain('#156 Safe cleanup');
      expect(html).toContain('Merged');
      expect(html).toContain('Not blocked');
      for (const hidden of ['Secret Project', '/secret/', 'target-secret', 'source-secret', 'secret-card-branch', 'secret-terminal', 'secret metadata', 'secret blocker', 'secret warning']) {
        expect(html).not.toContain(hidden);
      }
    }
  });

  it('offers Cleanup anyway only for overridable merged blockers', () => {
    expect(render([entry({ blocked: true, eligible: false, override_available: true })])).toContain('Cleanup anyway');
    expect(render([entry({ merged: false, blocked: true, eligible: false, override_available: false })])).not.toContain('Cleanup anyway');
    expect(render([entry({ blocked: true, eligible: false, override_available: false })])).not.toContain('Cleanup anyway');
  });

  it('shows mixed bulk statuses without implementation evidence', () => {
    const html = render([
      entry(),
      entry({ card_id: 'c2', card_number: '157', card_title: 'Dirty merged', blocked: true, eligible: false, override_available: true }),
      entry({ card_id: 'c3', card_number: '158', card_title: 'Advanced', merged: false, blocked: true, eligible: false }),
    ], true);
    expect(html).toContain('#157 Dirty merged');
    expect(html).toContain('#158 Advanced');
    expect(html).toContain('Not merged');
    expect((html.match(/Cleanup anyway/g) ?? [])).toHaveLength(1);
    expect(html).toContain('Clean up 1');

    const entries = [
      entry(),
      entry({ card_id: 'c2', blocked: true, eligible: false, override_available: true }),
      entry({ card_id: 'c3', blocked: true, eligible: false, override_available: false }),
    ];
    const selected = cleanupSelections(entries, new Set(['c2', 'c3']));
    expect(selected.map(({ card_id }) => card_id)).toEqual(['c1', 'c2']);
    expect(selected.map(({ cleanup_anyway }) => cleanup_anyway)).toEqual([false, true]);
  });
});
