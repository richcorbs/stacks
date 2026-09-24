import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { KanbanCardSummary } from '../../kanban/types';
import { CardDetailLoadingShell } from './CardDetailLoadingShell';

const summary = { id: 'superthread:192', external_id: '192', title: 'Open promptly', status: 'approved' } as KanbanCardSummary;

describe('CardDetailLoadingShell', () => {
  it('shows a dismissible board-known title and status with detail-only placeholders, not actionable detail', () => {
    const markup = renderToStaticMarkup(<CardDetailLoadingShell card={summary} error={null} onRetry={() => {}} onClose={() => {}} />);
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('Close card details');
    expect(markup).toContain('Open promptly');
    expect(markup).toContain('Ready to merge');
    expect(markup).toContain('kanbanDetailSkeleton');
    expect(markup).not.toContain('Edit card');
  });

  it('replaces the skeleton with an error, Retry and Close on a failed read', () => {
    const markup = renderToStaticMarkup(<CardDetailLoadingShell card={summary} error="Database unavailable" onRetry={() => {}} onClose={() => {}} />);
    expect(markup).toContain('Could not load card details: Database unavailable');
    expect(markup).toContain('Retry');
    expect(markup).toContain('Close');
    expect(markup).not.toContain('kanbanDetailSkeleton');
  });
});
