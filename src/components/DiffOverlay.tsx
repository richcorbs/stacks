import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { hasDiffReviewFeedback } from '../diffReview/prompt';
import type { DiffReviewComment, DiffReviewCommentSide, DiffReviewModel } from '../diffReview/types';
import { numberDiffLines, type NumberedDiffLine } from '../git/diffLines';

export function DiffOverlay({ review, fontSize, canSubmit, onSubmit, onClose }: {
  review: DiffReviewModel;
  fontSize: number;
  canSubmit: boolean;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const [overallOpen, setOverallOpen] = useState(Boolean(review.overallComment));
  const [commentMenuOpen, setCommentMenuOpen] = useState(false);
  const commentMenuRef = useRef<HTMLDivElement>(null);
  const commentButtonRef = useRef<HTMLButtonElement>(null);
  const [contentWidth, setContentWidth] = useState(0);
  const [visibleLineLimit, setVisibleLineLimit] = useState(2_000);
  const contentRef = useRef<HTMLDivElement>(null);
  const diff = review.openDiff;
  const numberedLines = useMemo(() => numberDiffLines(diff?.patch ?? ''), [diff?.patch]);
  const commentsByLocation = useMemo(() => {
    const locations = new Map<string, DiffReviewComment[]>();
    if (!diff) return locations;
    review.comments.forEach((comment) => {
      if (comment.filePath !== diff.path || comment.side === 'file' || comment.line == null) return;
      const key = `${comment.side}:${comment.line}`;
      locations.set(key, [...(locations.get(key) ?? []), comment]);
    });
    return locations;
  }, [diff, review.comments]);

  useEffect(() => setVisibleLineLimit(2_000), [diff?.patch, diff?.path]);
  useEffect(() => setCommentMenuOpen(false), [diff?.path]);

  useEffect(() => {
    if (!commentMenuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!commentMenuRef.current?.contains(event.target as Node)) setCommentMenuOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [commentMenuOpen]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const updateWidth = () => setContentWidth(content.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const addLineComment = useCallback((side: DiffReviewCommentSide, line: number) => {
    if (diff) review.addComment({ filePath: diff.path, side, line });
  }, [diff, review.addComment]);

  if (!diff) return null;
  const fileComments = review.comments.filter((comment) => comment.filePath === diff.path && comment.side === 'file');
  const reviewed = review.reviewedFiles.has(diff.path);
  const canSend = canSubmit && hasDiffReviewFeedback(review.overallComment, review.comments);


  return (
    <div className="diffOverlay" style={{
      '--diff-font-size': `${Math.max(8, fontSize - 2)}px`,
      '--diff-comment-font-size': `${Math.max(8, fontSize - 1)}px`,
    } as CSSProperties} role="region" aria-label={`Diff for ${diff.path}`}>
      <header className="diffReviewToolbar">
        <strong className="diffReviewPath" title={diff.path}>{diff.path}</strong>
        <label className="diffReviewedCheckbox">
          <input type="checkbox" checked={reviewed} onChange={() => review.toggleReviewed(diff.path)} />
          Reviewed
        </label>
        <div className="diffCommentDropdown" ref={commentMenuRef} onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setCommentMenuOpen(false);
        }} onKeyDown={(event) => {
          if (event.key === 'Escape' && commentMenuOpen) {
            event.stopPropagation();
            setCommentMenuOpen(false);
            commentButtonRef.current?.focus();
          }
        }}>
          <button type="button" ref={commentButtonRef} aria-expanded={commentMenuOpen} onClick={() => setCommentMenuOpen((open) => !open)}>Comment <span aria-hidden="true">▾</span></button>
          {commentMenuOpen && <div className="diffCommentOptions">
            <button type="button" onClick={() => {
              setCommentMenuOpen(false);
              commentButtonRef.current?.focus();
              review.addComment({ filePath: diff.path, side: 'file', line: null });
            }}>File comment</button>
            <button type="button" aria-pressed={overallOpen} onClick={() => {
              setCommentMenuOpen(false);
              commentButtonRef.current?.focus();
              setOverallOpen((open) => !open);
            }}>Overall comment</button>
          </div>}
        </div>
        <button type="button" className="diffSubmitReview" disabled={!canSend} title={!canSubmit ? 'Focus a Pi GUI terminal before submitting' : undefined} onClick={onSubmit}>Submit review</button>
        <button type="button" className="diffClose" onClick={onClose} aria-label="Close diff" title="Close diff">×</button>
      </header>
      {overallOpen && (
        <section className="diffReviewEditor diffOverallComment">
          <label htmlFor="diff-overall-comment">Comment on the whole change set</label>
          <textarea id="diff-overall-comment" autoFocus value={review.overallComment} onChange={(event) => review.setOverallComment(event.target.value)} placeholder="Leave overall feedback…" />
        </section>
      )}
      {fileComments.length > 0 && (
        <section className="diffFileComments">
          {fileComments.map((comment) => <CommentEditor key={comment.id} comment={comment} onUpdate={review.updateComment} onDelete={review.deleteComment} label="Comment on this file" />)}
        </section>
      )}
      <div className="diffOverlayContent" ref={contentRef}>
        <div className="diffCode">{numberedLines.slice(0, visibleLineLimit).map((line, index) => {
          const comments = [
            ...(line.oldLine == null ? [] : commentsByLocation.get(`old:${line.oldLine}`) ?? []),
            ...(line.newLine == null ? [] : commentsByLocation.get(`new:${line.newLine}`) ?? []),
          ];
          return <DiffLineRow
            key={index}
            line={line}
            comments={comments}
            contentWidth={contentWidth}
            onAdd={addLineComment}
            onUpdate={review.updateComment}
            onDelete={review.deleteComment}
          />;
        })}</div>
        {visibleLineLimit < numberedLines.length && <button className="diffLoadMore" type="button" onClick={() => setVisibleLineLimit((limit) => Math.min(limit + 2_000, numberedLines.length))}>Show 2,000 more lines ({numberedLines.length - visibleLineLimit} remaining)</button>}
      </div>
    </div>
  );
}

const DiffLineRow = memo(function DiffLineRow({ line, comments, contentWidth, onAdd, onUpdate, onDelete }: {
  line: NumberedDiffLine;
  comments: DiffReviewComment[];
  contentWidth: number;
  onAdd: (side: DiffReviewCommentSide, line: number) => void;
  onUpdate: (id: string, body: string) => void;
  onDelete: (id: string) => void;
}) {
  return <>
    <span className={diffLineClass(line.text)}>
      <LineNumber value={line.oldLine} side="old" onAdd={onAdd} />
      <LineNumber value={line.newLine} side="new" onAdd={onAdd} />
      <span className="diffLineText">{line.text || ' '}</span>
    </span>
    {comments.map((comment) => <div className="diffInlineComment" style={contentWidth ? { width: contentWidth } : undefined} key={comment.id}>
      <CommentEditor comment={comment} onUpdate={onUpdate} onDelete={onDelete} label={`${comment.side === 'old' ? 'Old' : 'New'} line ${comment.line}`} />
    </div>)}
  </>;
}, (previous, next) => previous.line === next.line
  && previous.contentWidth === next.contentWidth
  && previous.onAdd === next.onAdd
  && previous.onUpdate === next.onUpdate
  && previous.onDelete === next.onDelete
  && previous.comments.length === next.comments.length
  && previous.comments.every((comment, index) => comment === next.comments[index]));

function LineNumber({ value, side, onAdd }: { value: number | null; side: 'old' | 'new'; onAdd: (side: DiffReviewCommentSide, line: number) => void }) {
  return value == null
    ? <span className="diffLineNumber" aria-hidden="true" />
    : <button type="button" className="diffLineNumber diffCommentLineButton" title={`Comment on ${side} line ${value}`} onClick={() => onAdd(side, value)}>{value}</button>;
}

const CommentEditor = memo(function CommentEditor({ comment, onUpdate, onDelete, label }: {
  comment: DiffReviewComment;
  onUpdate: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  label: string;
}) {
  return <div className="diffReviewEditor">
    <div className="diffReviewEditorTitle"><label htmlFor={`diff-comment-${comment.id}`}>{label}</label><button type="button" onClick={() => onDelete(comment.id)} aria-label="Delete comment">×</button></div>
    <textarea id={`diff-comment-${comment.id}`} autoFocus={!comment.body} value={comment.body} onChange={(event) => onUpdate(comment.id, event.target.value)} placeholder="Leave a comment…" />
  </div>;
});

function diffLineClass(line: string) {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) return 'diffLine diffMeta';
  if (line.startsWith('@@')) return 'diffLine diffHunk';
  if (line.startsWith('+')) return 'diffLine diffAddition';
  if (line.startsWith('-')) return 'diffLine diffDeletion';
  return 'diffLine';
}
