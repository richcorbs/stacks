import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { buildDiffTree, type DiffTreeNode } from '../git/diffTree';
import type { GitDiffFile, GitDiffFilesResponse, GitFileDiff, GitInfo } from '../types';
import type { DiffReviewModel } from '../diffReview/types';

export function DiffTab({ activePath, refreshNonce, review }: {
  activePath: string | null;
  refreshNonce: number;
  review: DiffReviewModel;
}) {
  const [files, setFiles] = useState<GitDiffFile[]>([]);
  const [sourceLabel, setSourceLabel] = useState('Working tree');
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const fileRequestGenerationRef = useRef(0);

  useEffect(() => {
    fileRequestGenerationRef.current += 1;
    setLoadingFile(null);
    if (!activePath) {
      setFiles([]);
      setGitInfo(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<GitInfo | null>('git_info', { path: activePath })
      .then((info) => { if (!cancelled) setGitInfo(info); })
      .catch(() => { if (!cancelled) setGitInfo(null); });
    invoke<GitDiffFilesResponse>('git_diff_files', { path: activePath })
      .then((response) => {
        if (cancelled) return;
        setFiles(response.files);
        setSourceLabel(response.source === 'pull-request' ? `PR #${response.pullRequestNumber}` : 'Working tree');
      })
      .catch((reason) => { if (!cancelled) setError(String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activePath, refreshNonce]);

  const tree = useMemo(() => buildDiffTree(files), [files]);
  const commentCounts = useMemo(() => review.comments.reduce((counts, comment) => counts.set(comment.filePath, (counts.get(comment.filePath) ?? 0) + 1), new Map<string, number>()), [review.comments]);

  async function openFile(file: string) {
    if (!activePath || loadingFile) return;
    const generation = ++fileRequestGenerationRef.current;
    setLoadingFile(file);
    setError(null);
    try {
      const diff = await invoke<GitFileDiff>('git_file_diff', { path: activePath, file });
      if (fileRequestGenerationRef.current === generation) review.setOpenDiff(diff);
    } catch (reason) {
      if (fileRequestGenerationRef.current === generation) setError(String(reason));
    } finally {
      if (fileRequestGenerationRef.current === generation) setLoadingFile(null);
    }
  }

  if (!activePath) return <div className="superthreadState">Select a workspace in a Git repository.</div>;
  return <>
    <div className="diffStatusHeader" title={activePath}>
      {gitInfo && <span className="diffBranch"> {gitInfo.branch}</span>}
      <span className="diffSourceLabel">{sourceLabel}</span>
      {sourceLabel === 'Working tree' && gitInfo && (gitInfo.created > 0 || gitInfo.changed > 0 || gitInfo.deleted > 0) && (
        <span className="diffGitStats" title="Files created / changed / deleted">
          {gitInfo.created > 0 && <span className="gitAdded">+{gitInfo.created}</span>}
          {gitInfo.changed > 0 && <span className="gitChanged">~{gitInfo.changed}</span>}
          {gitInfo.deleted > 0 && <span className="gitRemoved">-{gitInfo.deleted}</span>}
        </span>
      )}
      {sourceLabel !== 'Working tree' && files.length > 0 && <span className="diffFileCount">{files.length} {files.length === 1 ? 'file' : 'files'}</span>}
    </div>
    {loading && files.length === 0 && <div className="superthreadState">Loading changed files…</div>}
    {error && <div className="superthreadState superthreadError">{error}</div>}
    {!loading && !error && files.length === 0 && <div className="superthreadState">No changed files.</div>}
    <div className="diffTree" role="tree" aria-label="Changed files">
      {tree.map((node) => <TreeNode key={node.path} node={node} depth={0} collapsed={collapsed} setCollapsed={setCollapsed} loadingFile={loadingFile} reviewedFiles={review.reviewedFiles} commentCounts={commentCounts} onOpenFile={openFile} />)}
    </div>
  </>;
}

function TreeNode({ node, depth, collapsed, setCollapsed, loadingFile, reviewedFiles, commentCounts, onOpenFile }: {
  node: DiffTreeNode;
  depth: number;
  collapsed: Set<string>;
  setCollapsed: Dispatch<SetStateAction<Set<string>>>;
  loadingFile: string | null;
  reviewedFiles: Set<string>;
  commentCounts: Map<string, number>;
  onOpenFile: (path: string) => void;
}) {
  if (node.type === 'folder') {
    const isCollapsed = collapsed.has(node.path);
    return <div role="treeitem" aria-expanded={!isCollapsed}>
      <button className="diffTreeRow diffFolderRow" style={{ paddingLeft: 8 + depth * 14 }} type="button" onClick={() => setCollapsed((current) => {
        const next = new Set(current);
        if (next.has(node.path)) next.delete(node.path); else next.add(node.path);
        return next;
      })}>
        <span className={`superthreadDisclosure${isCollapsed ? '' : ' expanded'}`} />
        <span className="diffTreeName">{node.name}</span>
      </button>
      {!isCollapsed && <div role="group">{node.children.map((child) => <TreeNode key={child.path} node={child} depth={depth + 1} collapsed={collapsed} setCollapsed={setCollapsed} loadingFile={loadingFile} reviewedFiles={reviewedFiles} commentCounts={commentCounts} onOpenFile={onOpenFile} />)}</div>}
    </div>;
  }
  return <button
    className={`diffTreeRow diffFileRow${reviewedFiles.has(node.path) ? ' reviewed' : ''}`}
    style={{ paddingLeft: 29 + depth * 14 }}
    type="button"
    role="treeitem"
    disabled={loadingFile !== null}
    onClick={() => void onOpenFile(node.path)}
  >
    <span className="diffTreeName">{node.name}</span>
    {Boolean(commentCounts.get(node.path)) && <span className="diffCommentCount">{commentCounts.get(node.path)}</span>}
    {reviewedFiles.has(node.path) && <span className="diffReviewedMark" title="Reviewed">●</span>}
    <span className={`diffFileStatus status${node.status}`}>{loadingFile === node.path ? '…' : node.status}</span>
  </button>;
}
