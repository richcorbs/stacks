import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DiffReviewModel } from '../diffReview/types';
import { DiffTab } from './DiffTab';

const review: DiffReviewModel = {
  openDiff: null,
  overallComment: '',
  comments: [],
  reviewedFiles: new Set(),
  setOpenDiff: vi.fn(),
  setOverallComment: vi.fn(),
  addComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
  toggleReviewed: vi.fn(),
  reset: vi.fn(),
};

describe('DiffTab', () => {
  it('uses a generic branch source label rather than PR discovery', () => {
    const markup = renderToStaticMarkup(<DiffTab activePath="/repo" comparisonTarget="refs/heads/main" refreshNonce={0} review={review} />);
    expect(markup).toContain('Branch changes');
    expect(markup).not.toContain('PR #');
    expect(markup).not.toContain('Working tree');
  });

  it('shows an actionable error when comparison metadata is missing', () => {
    const markup = renderToStaticMarkup(<DiffTab activePath="/repo" comparisonTarget={null} refreshNonce={0} review={review} />);
    expect(markup).toContain('comparison target is missing');
    expect(markup).toContain('repair the card environment');
    expect(markup).not.toContain('aria-label="Changed files"');
  });
});
