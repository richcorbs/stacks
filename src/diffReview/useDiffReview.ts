import { useCallback, useEffect, useMemo, useState } from 'react';
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

  const addComment = useCallback((comment: Omit<DiffReviewComment, 'id' | 'body'>) => {
    setComments((current) => current.some((item) => item.filePath === comment.filePath && item.side === comment.side && item.line === comment.line)
      ? current
      : [...current, { ...comment, id: crypto.randomUUID(), body: '' }]);
  }, []);
  const updateComment = useCallback((id: string, body: string) => {
    setComments((current) => current.map((comment) => comment.id === id ? { ...comment, body } : comment));
  }, []);
  const deleteComment = useCallback((id: string) => {
    setComments((current) => current.filter((comment) => comment.id !== id));
  }, []);
  const toggleReviewed = useCallback((filePath: string) => {
    setReviewedFiles((current) => {
      const next = new Set(current);
      if (next.has(filePath)) next.delete(filePath); else next.add(filePath);
      return next;
    });
  }, []);

  useEffect(() => reset(), [reviewKey, reset]);

  return useMemo(() => ({
    openDiff,
    overallComment,
    comments,
    reviewedFiles,
    setOpenDiff,
    setOverallComment,
    addComment,
    updateComment,
    deleteComment,
    toggleReviewed,
    reset,
  }), [addComment, comments, deleteComment, openDiff, overallComment, reset, reviewedFiles, toggleReviewed, updateComment]);
}
