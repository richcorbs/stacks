import type { DiffReviewComment } from './types';

export function composeDiffReviewPrompt(overallComment: string, comments: DiffReviewComment[]) {
  const lines = ['Please address the following feedback', ''];
  if (overallComment.trim()) lines.push(overallComment.trim(), '');
  comments.filter((comment) => comment.body.trim()).forEach((comment, index) => {
    const location = comment.side === 'file' || comment.line == null
      ? `[git diff] ${comment.filePath}`
      : `[git diff] ${comment.filePath}:${comment.line} (${comment.side})`;
    lines.push(`${index + 1}. ${location}`, `   ${comment.body.trim()}`, '');
  });
  return lines.join('\n').trim();
}

export function hasDiffReviewFeedback(overallComment: string, comments: DiffReviewComment[]) {
  return Boolean(overallComment.trim() || comments.some((comment) => comment.body.trim()));
}
