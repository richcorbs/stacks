/**
 * Split-tree maths now lives in `src/splitTree.ts`. The names stay exported here
 * so existing callers and `utils.test.ts` remain the public contract.
 */
export {
  collectLeafTerminalIds,
  collectLeafTerminals,
  normalizeSplitNode,
  relativePaneId,
  splitLeaf,
  setLeafCommand,
  setLeafPaneKind,
  setSplitRatio,
  removeLeaf,
  rebalanceSplits,
  buildGridSplit,
} from './splitTree';

/** Parse only a bare three-part version, optionally prefixed with one v/V. */
export function normalizeReleaseVersion(value: string): string | null {
  const match = /^[vV]?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match && match[0] === value ? match.slice(1).map((part) => BigInt(part).toString()).join('.') : null;
}

export function nextPatchVersion(latest: string): string | null {
  const version = normalizeReleaseVersion(latest);
  if (!version) return null;
  const [major, minor, patch] = version.split('.');
  return `${major}.${minor}.${BigInt(patch) + 1n}`;
}

export function basename(path: string) {
  return path.replace(/\/$/, '').split('/').pop() || path;
}

export function parseDragData(value: string) {
  const parts = value.split(':');
  if (parts[0] === 'project' && parts[1]) return { kind: 'project' as const, projectId: parts[1] };
  if (parts[0] === 'terminal' && parts[1] && parts[2]) return { kind: 'workspace' as const, projectId: parts[1], workspaceId: parts[2] };
  return null;
}
