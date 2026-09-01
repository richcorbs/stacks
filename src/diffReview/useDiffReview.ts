import { useCallback, useEffect, useState } from 'react';
import type { GitFileDiff } from '../types';
import type { DiffReviewComment, DiffReviewModel } from './types';

export function useDiffReview(reviewKey: string | null): DiffReviewModel {
  const [openDiff, setOpenDiff] = useState<GitFileDiff | null>(null);
  const [overallComment, setOverallComment] = useState('');
  const [comments, setComments] = useState<DiffReviewComment[]>([]);
  const [reviewedFiles, setReviewedFiles] = useState<Set<string>>(() => new Set());

  const reset = useCallback(() => {
    setOpenDiff(null);
    setOverallComment('');
    setComments([]);
    setReviewedFiles(new Set());
  }, []);

  useEffect(() => reset(), [reviewKey, reset]);

  return {
    openDiff,
    overallComment,
    comments,
    reviewedFiles,
    setOpenDiff,
    setOverallComment,
    addComment: (comment) => setComments((current) => [...current, { ...comment, id: crypto.randomUUID(), body: '' }]),
    updateComment: (id, body) => setComments((current) => current.map((comment) => comment.id === id ? { ...comment, body } : comment)),
    deleteComment: (id) => setComments((current) => current.filter((comment) => comment.id !== id)),
    toggleReviewed: (filePath) => setReviewedFiles((current) => {
      const next = new Set(current);
      if (next.has(filePath)) next.delete(filePath); else next.add(filePath);
      return next;
    }),
    reset,
  };
}
