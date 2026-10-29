import { invoke } from '@tauri-apps/api/core';
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { buildDiffTree, visibleDiffRows, reconcileDiffHighlight, navigateDiffRows, type DiffNavigationKey, type DiffTreeNode } from '../git/diffTree';
import type { GitDiffFile, GitDiffFilesResponse, GitFileDiff } from '../types';
import type { DiffReviewModel } from '../diffReview/types';

export type DiffTreeNavigation = { navigate: (key: DiffNavigationKey) => boolean };

export function DiffTab({ activePath, comparisonTarget, refreshNonce, review, navigationRef }: {
  navigationRef?: Ref<DiffTreeNavigation>;
  activePath: string | null;
  comparisonTarget: string | null;
  refreshNonce: number;
  review: DiffReviewModel;
}) {
  const [files, setFiles] = useState<GitDiffFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const fileRequestGenerationRef = useRef(0);
  const treeRef = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState<string | null>(null);

  useEffect(() => {
    setFiles([]);
    setHighlight(null);
  }, [activePath, comparisonTarget]);

  useEffect(() => {
    fileRequestGenerationRef.current += 1;
    setLoadingFile(null);
    if (!activePath) {
      setFiles([]);
      setError(null);
      setLoading(false);
      return;
    }
    if (!comparisonTarget) {
      setFiles([]);
      setError('The comparison target is missing. Configure the project target branch or repair the card environment.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<GitDiffFilesResponse>('git_diff_files', { path: activePath, comparisonTarget })
      .then((response) => {
        if (cancelled) return;
        setFiles(response.files);
      })
      .catch((reason) => { if (!cancelled) setError(String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activePath, comparisonTarget, refreshNonce]);

  const displayError = activePath && !comparisonTarget
    ? 'The comparison target is missing. Configure the project target branch or repair the card environment.'
    : error;
  const tree = useMemo(() => buildDiffTree(files), [files]);
  const rows = useMemo(() => visibleDiffRows(tree, collapsed), [tree, collapsed]);
  const highlightedPath = reconcileDiffHighlight(rows, highlight);
  useEffect(() => {
    if (!loading) setHighlight(highlightedPath);
  }, [highlightedPath, loading]);

  useEffect(() => {
    const row = treeRef.current?.querySelector<HTMLElement>('[data-navigation-highlight="true"]');
    const explorer = treeRef.current?.closest<HTMLElement>('.cardDiffExplorer');
    if (!row || !explorer) return;
    const bounds = explorer.getBoundingClientRect();
    const item = row.getBoundingClientRect();
    if (item.top < bounds.top) explorer.scrollTop += item.top - bounds.top;
    else if (item.bottom > bounds.bottom) explorer.scrollTop += item.bottom - bounds.bottom;
  }, [highlightedPath]);

  function toggleFolder(path: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  useImperativeHandle(navigationRef, () => ({ navigate(key) {
    if (loading || displayError || !activePath || !highlightedPath) return false;
    const node = rows.find((row) => row.node.path === highlightedPath)!.node;
    if (key === 'Enter') {
      if (node.type === 'folder') toggleFolder(node.path);
      else {
        if (loadingFile) return false;
        void openFile(node.path);
      }
    } else if (node.type === 'folder' && ((key === 'h' && !collapsed.has(node.path)) || (key === 'l' && collapsed.has(node.path)))) {
      toggleFolder(node.path);
    } else setHighlight(navigateDiffRows(rows, highlightedPath, key));
    return true;
  } }));

  const commentCounts = useMemo(() => review.comments.reduce((counts, comment) => counts.set(comment.filePath, (counts.get(comment.filePath) ?? 0) + 1), new Map<string, number>()), [review.comments]);

  async function openFile(file: string) {
    if (!activePath || !comparisonTarget || loading || loadingFile) return;
    const generation = ++fileRequestGenerationRef.current;
    setLoadingFile(file);
    setError(null);
    try {
      const diff = await invoke<GitFileDiff>('git_file_diff', { path: activePath, file, comparisonTarget });
      if (fileRequestGenerationRef.current === generation) review.setOpenDiff(diff);
    } catch (reason) {
      if (fileRequestGenerationRef.current === generation) setError(String(reason));
    } finally {
      if (fileRequestGenerationRef.current === generation) setLoadingFile(null);
    }
  }

  if (!activePath) return <div className="superthreadState">Open a card environment in a Git repository.</div>;
  return <>
    {loading && files.length === 0 && <div className="superthreadState">Loading changed files…</div>}
    {displayError && <div className="superthreadState superthreadError">{displayError}</div>}
    {!loading && !displayError && files.length === 0 && <div className="superthreadState">No changed files.</div>}
    {!displayError && <div ref={treeRef} className="diffTree" role="tree" aria-label="Changed files">
      {tree.map((node) => <TreeNode key={node.path} node={node} depth={0} collapsed={collapsed} toggleFolder={toggleFolder} highlightedPath={highlightedPath} onHighlight={setHighlight} loadingFile={loadingFile} selectedFile={review.openDiff?.path ?? null} reviewedFiles={review.reviewedFiles} commentCounts={commentCounts} onOpenFile={openFile} onToggleReviewed={review.toggleReviewed} />)}
    </div>}
  </>;
}

function TreeNode({ node, depth, collapsed, toggleFolder, highlightedPath, onHighlight, loadingFile, selectedFile, reviewedFiles, commentCounts, onOpenFile, onToggleReviewed }: {
  node: DiffTreeNode;
  depth: number;
  collapsed: Set<string>;
  toggleFolder: (path: string) => void;
  highlightedPath: string | null;
  onHighlight: (path: string) => void;
  loadingFile: string | null;
  selectedFile: string | null;
  reviewedFiles: Set<string>;
  commentCounts: Map<string, number>;
  onOpenFile: (path: string) => void;
  onToggleReviewed: (path: string) => void;
}) {
  if (node.type === 'folder') {
    const isCollapsed = collapsed.has(node.path);
    return <div role="treeitem" aria-label={node.path} aria-current={highlightedPath === node.path ? 'location' : undefined} aria-expanded={!isCollapsed}>
      <button className="diffTreeRow diffFolderRow" data-navigation-highlight={highlightedPath === node.path} style={{ paddingLeft: 8 + depth * 14 }} type="button" onClick={() => { onHighlight(node.path); toggleFolder(node.path); }}>
        <span className={`superthreadDisclosure${isCollapsed ? '' : ' expanded'}`} />
        <span className="diffTreeName">{node.name}</span>
      </button>
      {!isCollapsed && <div role="group">{node.children.map((child) => <TreeNode key={child.path} node={child} depth={depth + 1} collapsed={collapsed} toggleFolder={toggleFolder} highlightedPath={highlightedPath} onHighlight={onHighlight} loadingFile={loadingFile} selectedFile={selectedFile} reviewedFiles={reviewedFiles} commentCounts={commentCounts} onOpenFile={onOpenFile} onToggleReviewed={onToggleReviewed} />)}</div>}
    </div>;
  }
  const reviewed = reviewedFiles.has(node.path);
  return <div
    className={`diffTreeRow diffFileRow${selectedFile === node.path ? ' selected' : ''}${reviewed ? ' reviewed' : ''}`}
    style={{ paddingLeft: 29 + depth * 14 }}
    role="treeitem"
    aria-label={node.path}
    aria-selected={selectedFile === node.path}
    aria-current={highlightedPath === node.path ? 'location' : undefined}
    data-navigation-highlight={highlightedPath === node.path}
    onClick={() => onHighlight(node.path)}
  >
    <button className="diffFileOpen" type="button" disabled={loadingFile !== null} onClick={() => { onHighlight(node.path); void onOpenFile(node.path); }} aria-label={`Open ${node.path}`}>
      <span className="diffTreeName">{node.name}</span>
      {Boolean(commentCounts.get(node.path)) && <span className="diffCommentCount">{commentCounts.get(node.path)}</span>}
      <span className={`diffFileStatus status${node.status}`}>{loadingFile === node.path ? '…' : node.status}</span>
    </button>
    <button className="diffReviewDot" type="button" aria-label={`${reviewed ? 'Mark unreviewed' : 'Mark reviewed'}: ${node.path}`} aria-pressed={reviewed} onClick={() => { onHighlight(node.path); onToggleReviewed(node.path); }}>
      <span aria-hidden="true" className="diffReviewedMark">●</span>
    </button>
  </div>;
}
