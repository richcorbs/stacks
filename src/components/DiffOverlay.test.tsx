import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffReviewModel } from '../diffReview/types';
import { DiffOverlay } from './DiffOverlay';

function makeReview(overrides: Partial<DiffReviewModel> = {}): DiffReviewModel {
  return {
    openDiff: { path: 'src/git/diffLines.ts', patch: '@@ -1 +1 @@\n-old\n+new' },
    overallComment: '', comments: [], reviewedFiles: new Set(),
    setOpenDiff: vi.fn(), setOverallComment: vi.fn(), addComment: vi.fn(),
    updateComment: vi.fn(), deleteComment: vi.fn(), toggleReviewed: vi.fn(), reset: vi.fn(),
    ...overrides,
  };
}

let renderer: TestRenderer.ReactTestRenderer;
const onSubmit = vi.fn();
const onClose = vi.fn();
function render(review = makeReview(), canSubmit = true) {
  act(() => { renderer = TestRenderer.create(<DiffOverlay review={review} fontSize={14} canSubmit={canSubmit} onSubmit={onSubmit} onClose={onClose} />); });
  return renderer.root;
}
const button = (text: string) => renderer.root.findAllByType('button').find((node) => node.children.includes(text))!;
const iconButton = (label: string) => renderer.root.findByProps({ 'aria-label': label });

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => renderer?.unmount());
});

describe('DiffOverlay compact review header', () => {
  it('uses a single header with the file path, controlled Reviewed checkbox, and accessible close control', () => {
    const review = makeReview();
    const root = render(review);
    const header = root.findByType('header');
    expect(header.findAllByType('header')).toHaveLength(1);
    expect(header.findByType('strong').children).toEqual(['src/git/diffLines.ts']);
    expect(header.findByType('strong').props.title).toBe('src/git/diffLines.ts');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Review changes');
    expect(header.findByType('label').children).toContain('Reviewed');
    expect(header.findByType('input').props.checked).toBe(false);
    act(() => header.findByType('input').props.onChange());
    expect(review.toggleReviewed).toHaveBeenCalledWith('src/git/diffLines.ts');
    act(() => renderer.update(<DiffOverlay review={{ ...review, reviewedFiles: new Set(['src/git/diffLines.ts']) }} fontSize={14} canSubmit onSubmit={onSubmit} onClose={onClose} />));
    expect(header.findByType('input').props.checked).toBe(true);
    const close = root.findByProps({ 'aria-label': 'Close diff' });
    expect(close.children).toEqual(['×']);
    act(() => close.props.onClick());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders globe then file icon buttons with matching tooltips and no legacy dropdown', () => {
    const root = render();
    const header = root.findByType('header');
    const labels = header.findAllByType('button').map((node) => node.props['aria-label']).filter(Boolean);
    expect(labels).toEqual(['Overall comment', 'File comment', 'Close diff']);
    const overall = iconButton('Overall comment');
    const file = iconButton('File comment');
    expect(overall.props.title).toBe('Overall comment');
    expect(file.props.title).toBe('File comment');
    expect(overall.findAllByType('svg')).toHaveLength(1);
    expect(file.findAllByType('svg')).toHaveLength(1);
    expect(root.findAllByProps({ className: 'diffCommentDropdown' })).toHaveLength(0);
    expect(root.findAllByProps({ className: 'diffCommentOptions' })).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Comment ▾');
  });

  it('toggles the overall comment editor and reflects the state through aria-pressed', () => {
    const review = makeReview();
    const root = render(review);
    expect(iconButton('Overall comment').props['aria-pressed']).toBe(false);
    expect(root.findAllByProps({ id: 'diff-overall-comment' })).toHaveLength(0);
    act(() => iconButton('Overall comment').props.onClick());
    const textarea = root.findByProps({ id: 'diff-overall-comment' });
    act(() => textarea.props.onChange({ target: { value: 'Overall feedback' } }));
    expect(review.setOverallComment).toHaveBeenCalledWith('Overall feedback');
    expect(iconButton('Overall comment').props['aria-pressed']).toBe(true);
    act(() => iconButton('Overall comment').props.onClick());
    expect(root.findAllByProps({ id: 'diff-overall-comment' })).toHaveLength(0);
    expect(iconButton('Overall comment').props['aria-pressed']).toBe(false);
    expect(review.setOverallComment).toHaveBeenCalledTimes(1);
  });

  it('opens the overall editor when an overall comment already exists', () => {
    render(makeReview({ overallComment: 'Existing feedback' }));
    expect(renderer.root.findByProps({ id: 'diff-overall-comment' }).props.value).toBe('Existing feedback');
    expect(iconButton('Overall comment').props['aria-pressed']).toBe(true);
  });

  it('adds exactly one file-scoped comment for the open diff path per click', () => {
    const review = makeReview();
    const root = render(review);
    act(() => iconButton('File comment').props.onClick());
    expect(review.addComment).toHaveBeenCalledWith({ filePath: 'src/git/diffLines.ts', side: 'file', line: null });
    expect(review.addComment).toHaveBeenCalledTimes(1);
    act(() => iconButton('File comment').props.onClick());
    expect(review.addComment).toHaveBeenCalledTimes(2);
  });

  it.each([
    { canSubmit: true, overallComment: '', disabled: true },
    { canSubmit: true, overallComment: '  ', disabled: true },
    { canSubmit: false, overallComment: 'Feedback', disabled: true },
    { canSubmit: true, overallComment: 'Feedback', disabled: false },
  ])('preserves submission guards: %j', ({ canSubmit, overallComment, disabled }) => {
    render(makeReview({ overallComment }), canSubmit);
    const submit = button('Submit review');
    expect(submit.props.disabled).toBe(disabled);
    expect(submit.props.title).toBe(canSubmit ? undefined : 'Focus a Pi GUI terminal before submitting');
    if (!disabled) {
      act(() => submit.props.onClick());
      expect(onSubmit).toHaveBeenCalledOnce();
    }
  });

  it('allows submission with file feedback and preserves line-comment actions', () => {
    const review = makeReview({ comments: [{ id: 'file', filePath: 'src/git/diffLines.ts', side: 'file', line: null, body: 'File feedback' }] });
    const root = render(review);
    expect(button('Submit review').props.disabled).toBe(false);
    act(() => root.findByProps({ title: 'Comment on new line 1' }).props.onClick());
    expect(review.addComment).toHaveBeenCalledWith({ side: 'new', line: 1, filePath: 'src/git/diffLines.ts' });
    expect(root.findByProps({ id: 'diff-comment-file' }).props.value).toBe('File feedback');
  });
});
