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
const openComments = () => act(() => button('Comment ').props.onClick());

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
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

  it('preserves both comment actions and overall comment editing without clearing feedback', () => {
    const review = makeReview();
    render(review);
    expect(button('File comment')).toBeUndefined();
    openComments();
    expect(button('Comment ').props['aria-expanded']).toBe(true);
    act(() => button('File comment').props.onClick());
    expect(review.addComment).toHaveBeenCalledWith({ filePath: 'src/git/diffLines.ts', side: 'file', line: null });
    expect(button('Comment ').props['aria-expanded']).toBe(false);
    openComments();
    act(() => button('Overall comment').props.onClick());
    const textarea = renderer.root.findByProps({ id: 'diff-overall-comment' });
    act(() => textarea.props.onChange({ target: { value: 'Overall feedback' } }));
    expect(review.setOverallComment).toHaveBeenCalledWith('Overall feedback');
    openComments();
    expect(button('Overall comment').props['aria-pressed']).toBe(true);
    act(() => button('Overall comment').props.onClick());
    expect(renderer.root.findAllByType('textarea')).toHaveLength(0);
    expect(review.setOverallComment).toHaveBeenCalledTimes(1);
  });

  it('dismisses the dropdown on Escape, focus departure, and outside pointer interaction', () => {
    render();
    openComments();
    const stopPropagation = vi.fn();
    act(() => renderer.root.findByProps({ className: 'diffCommentDropdown' }).props.onKeyDown({ key: 'Escape', stopPropagation }));
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(button('Comment ').props['aria-expanded']).toBe(false);
    openComments();
    act(() => renderer.root.findByProps({ className: 'diffCommentDropdown' }).props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }));
    expect(button('Comment ').props['aria-expanded']).toBe(false);
    openComments();
    const dismiss = vi.mocked(document.addEventListener).mock.calls.at(-1)![1] as (event: { target: null }) => void;
    act(() => dismiss({ target: null }));
    expect(button('Comment ').props['aria-expanded']).toBe(false);
    expect(document.removeEventListener).toHaveBeenCalledWith('pointerdown', dismiss);
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
