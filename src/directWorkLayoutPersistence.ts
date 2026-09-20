import type { SplitNode } from './types';
import type { ProjectDirectWorkState } from './directWorkApi';
import { LayoutSaveCoordinator, type LayoutSaveSnapshot } from './kanban/layoutSaveCoordinator';

export type DirectWorkLayoutSnapshot = LayoutSaveSnapshot<{
  tree: SplitNode;
  focusedPaneId: string | null;
  paneIds: string[];
}>;

export function createDirectWorkLayoutPersistence(options: {
  initialRevision: number;
  initialSavedSignature: string;
  debounceMs?: number;
  save: (snapshot: DirectWorkLayoutSnapshot, expectedRevision: number) => Promise<ProjectDirectWorkState>;
  onError: (error: unknown) => void;
}) {
  return new LayoutSaveCoordinator<DirectWorkLayoutSnapshot, ProjectDirectWorkState>({
    initialLayoutRevision: options.initialRevision,
    initialSavedSignature: options.initialSavedSignature,
    debounceMs: options.debounceMs,
    save: async (snapshot, expectedRevision) => {
      const saved = await options.save(snapshot, expectedRevision);
      return { layoutRevision: saved.revision, value: saved };
    },
    onSaved: () => {},
    onError: options.onError,
  });
}
