import type { GitFileDiff } from '../types';

export type DiffReviewCommentSide = 'old' | 'new' | 'file';

export type DiffReviewComment = {
  id: string;
  filePath: string;
  side: DiffReviewCommentSide;
  line: number | null;
  body: string;
};

export type DiffReviewModel = {
  openDiff: GitFileDiff | null;
  overallComment: string;
  comments: DiffReviewComment[];
  reviewedFiles: Set<string>;
  setOpenDiff: (diff: GitFileDiff | null) => void;
  setOverallComment: (value: string) => void;
  addComment: (comment: Omit<DiffReviewComment, 'id' | 'body'>) => void;
  updateComment: (id: string, body: string) => void;
  deleteComment: (id: string) => void;
  toggleReviewed: (filePath: string) => void;
  reset: () => void;
};
