import type { GitDiffFile } from '../types';

export type DiffTreeNode =
  | { type: 'folder'; name: string; path: string; children: DiffTreeNode[] }
  | { type: 'file'; name: string; path: string; status: GitDiffFile['status'] };

export type VisibleDiffRow = { node: DiffTreeNode; parent: string | null };
export type DiffNavigationKey = 'j' | 'k' | 'h' | 'l' | 'Enter';

export function visibleDiffRows(tree: DiffTreeNode[], collapsed: ReadonlySet<string>, parent: string | null = null): VisibleDiffRow[] {
  return tree.flatMap((node) => [
    { node, parent },
    ...(node.type === 'folder' && !collapsed.has(node.path) ? visibleDiffRows(node.children, collapsed, node.path) : []),
  ]);
}

export function reconcileDiffHighlight(rows: VisibleDiffRow[], path: string | null): string | null {
  while (path) {
    if (rows.some((row) => row.node.path === path)) return path;
    const slash = path.lastIndexOf('/');
    path = slash < 0 ? null : path.slice(0, slash);
  }
  return rows[0]?.node.path ?? null;
}

export function navigateDiffRows(rows: VisibleDiffRow[], path: string | null, key: 'j' | 'k' | 'h' | 'l'): string | null {
  const index = rows.findIndex((row) => row.node.path === path);
  if (index < 0) return rows[0]?.node.path ?? null;
  const { node, parent } = rows[index];
  if (key === 'j' || key === 'k') return rows[Math.max(0, Math.min(rows.length - 1, index + (key === 'j' ? 1 : -1)))].node.path;
  if (key === 'h') return parent ?? path;
  if (key === 'l' && node.type === 'folder' && rows[index + 1]?.parent === path) return rows[index + 1].node.path;
  return path;
}

type MutableFolder = { type: 'folder'; name: string; path: string; children: Array<MutableFolder | DiffTreeNode> };

export function buildDiffTree(files: GitDiffFile[]): DiffTreeNode[] {
  const root: MutableFolder = { type: 'folder', name: '', path: '', children: [] };
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    let folder = root;
    parts.slice(0, -1).forEach((name) => {
      const path = folder.path ? `${folder.path}/${name}` : name;
      let child = folder.children.find((node): node is MutableFolder => node.type === 'folder' && node.name === name);
      if (!child) {
        child = { type: 'folder', name, path, children: [] };
        folder.children.push(child);
      }
      folder = child;
    });
    folder.children.push({ type: 'file', name: parts.at(-1) ?? file.path, path: file.path, status: file.status });
  }
  const sort = (nodes: Array<MutableFolder | DiffTreeNode>): DiffTreeNode[] => nodes
    .map((node) => node.type === 'folder' ? { ...node, children: sort(node.children) } : node)
    .sort((left, right) => left.type === right.type ? left.name.localeCompare(right.name) : left.type === 'folder' ? -1 : 1);
  return sort(root.children);
}
