import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hasDiffReviewFeedback } from '../diffReview/prompt';
import type { DiffReviewComment, DiffReviewCommentSide, DiffReviewModel } from '../diffReview/types';
import { numberDiffLines, type NumberedDiffLine } from '../git/diffLines';

export function DiffOverlay({ review, canSubmit, onSubmit }: {
  review: DiffReviewModel;
  canSubmit: boolean;
  onSubmit: () => void;
}) {
  const [overallOpen, setOverallOpen] = useState(Boolean(review.overallComment));
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
    <div className="diffOverlay" role="region" aria-label={`Diff for ${diff.path}`}>
      <header className="diffReviewToolbar">
        <div className="diffReviewGlobalActions">
          <strong>Review changes</strong>
          <button type="button" className={overallOpen ? 'active' : ''} onClick={() => setOverallOpen((open) => !open)}>Overall comment</button>
          <button type="button" className="diffSubmitReview" disabled={!canSend} title={!canSubmit ? 'Focus a Pi GUI terminal before submitting' : undefined} onClick={onSubmit}>Submit review</button>
          <button type="button" onClick={() => review.setOpenDiff(null)} aria-label="Close diff">Close</button>
        </div>
        <div className="diffOverlayHeader">
          <strong>{diff.path}</strong>
          <button type="button" onClick={() => review.addComment({ filePath: diff.path, side: 'file', line: null })}>File comment</button>
          <button type="button" className={reviewed ? 'reviewed' : ''} onClick={() => review.toggleReviewed(diff.path)}>{reviewed ? 'Reviewed' : 'Mark reviewed'}</button>
        </div>
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
