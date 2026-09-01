import type { GitDiffFile } from '../types';

export type DiffTreeNode =
  | { type: 'folder'; name: string; path: string; children: DiffTreeNode[] }
  | { type: 'file'; name: string; path: string; status: GitDiffFile['status'] };

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
