import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfirmation } from '../components/ConfirmDialogs';
import { handleDialogShortcut } from '../components/dialogShortcut';
import { runDoneCleanup, type DoneCleanupDependencies } from '../kanban/doneCleanup';

/** App-owned, all-project cleanup: selection changes must not dismiss its dialogs. */
export function useDoneCleanup(dependencies: Omit<DoneCleanupDependencies, 'confirm' | 'report'>) {
  const { confirm, dialog } = useConfirmation();
  const [reportDetail, setReportDetail] = useState<string | null>(null);
  const pendingReport = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  const dismissReport = useCallback(() => {
    const resolve = pendingReport.current;
    pendingReport.current = null;
    setReportDetail(null);
    resolve?.();
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const resolve = pendingReport.current;
      pendingReport.current = null;
      resolve?.();
    };
  }, []);
  const cleanUpDone = useCallback(async () => {
    if (running.current || !mounted.current) return;
    running.current = true;
    try {
      await runDoneCleanup({
        ...dependencies,
        confirm: async (detail) => mounted.current
          && await confirm('Clean up Done cards', detail, 'Delete local copies') && mounted.current,
        report: (detail) => {
          if (!mounted.current) return Promise.resolve();
          return new Promise<void>((resolve) => {
            pendingReport.current = resolve;
            setReportDetail(detail);
          });
        },
      });
    } finally { running.current = false; }
  }, [dependencies, confirm]);
  const dialogs = <div className="doneCleanupDialogs">
    {dialog}
    {reportDetail !== null && <div className="modalBackdrop" onMouseDown={dismissReport}>
      <div className="modal doneCleanupReport" role="dialog" aria-modal="true" aria-label="Done card cleanup"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          handleDialogShortcut(event, true);
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            dismissReport();
          }
        }}>
        <h2>Done card cleanup</h2>
        <p>{reportDetail}</p>
        <div className="modalActions"><button autoFocus className="primaryAction" onClick={dismissReport}>OK</button></div>
      </div>
    </div>}
  </div>;
  return { cleanUpDone, dialogs, dialogOpen: Boolean(dialog) || reportDetail !== null };
}
