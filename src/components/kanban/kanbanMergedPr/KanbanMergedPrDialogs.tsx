import type { CleanupInventory } from '../../../kanban/types';
import type { KanbanMergedPrModel } from './useKanbanMergedPr';
import type { KanbanCardServerModel } from '../kanbanCardServer/useKanbanCardServer';
import { BoardPrMergeDialog } from '../BoardPrMergeDialog';
import { ServerHandoffDialog } from '../ServerHandoffDialog';
import { CleanupPreflightDialog } from '../CleanupPreflightDialog';

/** Merge confirmation, server handoff, and cleanup preflight dialogs. */
export function KanbanMergedPrDialogs({ mergedPr, server }: {
  mergedPr: KanbanMergedPrModel;
  server: Pick<KanbanCardServerModel, 'serverHandoff' | 'setServerHandoff' | 'serverActionPending' | 'serverActionPendingRef' | 'runServerAction'>;
}) {
  const { prMerge, mergeCleanup, cleanupInventory, setCleanupInventory, closeMergeCleanup, confirmMergeCleanup, confirmBulkCleanup } = mergedPr;
  const { serverHandoff, setServerHandoff, serverActionPending, serverActionPendingRef, runServerAction } = server;
  return <>
    {prMerge.target && <BoardPrMergeDialog card={prMerge.target.card} busy={prMerge.busy} intent={prMerge.intent} error={prMerge.error}
      onCancel={prMerge.close} onConfirm={(intent) => { void prMerge.confirm(intent); }}
      onRetryCleanup={prMerge.canRetryCleanup ? () => { void prMerge.retryCleanup(); } : undefined} />}
    {serverHandoff && <ServerHandoffDialog
      externalId={serverHandoff.externalId}
      busy={serverActionPending}
      onCancel={() => { if (!serverActionPendingRef.current) setServerHandoff(null); }}
      onConfirm={() => {
        if (serverActionPendingRef.current) return;
        const targetCardId = serverHandoff.targetCardId;
        void runServerAction(targetCardId).finally(() => setServerHandoff(null));
      }}
    />}
    {mergeCleanup && <CleanupPreflightDialog inventory={mergeCleanup.inventory} onCancel={closeMergeCleanup} onConfirm={confirmMergeCleanup} />}
    {cleanupInventory && <CleanupPreflightDialog bulk inventory={cleanupInventory as CleanupInventory} onCancel={() => setCleanupInventory(null)} onConfirm={confirmBulkCleanup} />}
  </>;
}
