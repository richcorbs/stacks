import { ConfirmationBoundary } from './ConfirmationBoundary';
import { Fragment } from 'react';
import { useApplicationEvents } from '../applicationEvents';
import { openExternalUrl } from '../externalLinks';
import { handleDialogShortcut } from './dialogShortcut';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { check, type Update, type DownloadEvent } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

const RELEASES_URL = 'https://github.com/richcorbs/stacks/releases';
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const MIN_CHECKING_DISPLAY_MS = 600;

type UpdateStatus = 'available' | 'checking' | 'current' | 'downloading' | 'waiting' | 'confirmation' | 'error';

const SETTLED_TITLES: Partial<Record<UpdateStatus, string>> = {
  checking: 'Checking for updates…',
  current: 'Stacks is up to date',
  error: 'Update unavailable',
};

export function AppUpdater() {
  const events = useApplicationEvents();
  const [update, setUpdate] = useState<Update | null>(null);
  const [status, setStatus] = useState<UpdateStatus>('available');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const checkingRef = useRef(false);
  const installingRef = useRef(false);
  const checkStartedAtRef = useRef(0);
  /** Set when a manual check is dismissed so the settled "up to date" state stays closed. */
  const dismissedCheckRef = useRef(false);
  const minDisplayTimerRef = useRef<number | null>(null);

  const clearMinDisplayTimer = useCallback(() => {
    if (minDisplayTimerRef.current === null) return;
    window.clearTimeout(minDisplayTimerRef.current);
    minDisplayTimerRef.current = null;
  }, []);

  const checkForUpdates = useCallback(async (manual = false) => {
    if (checkingRef.current || installingRef.current) return;
    checkingRef.current = true;
    if (manual) {
      clearMinDisplayTimer();
      dismissedCheckRef.current = false;
      checkStartedAtRef.current = Date.now();
      setStatus('checking');
      setError(null);
    }
    try {
      const available = await check({ timeout: 15_000 });
      if (available) {
        setUpdate((previous) => {
          if (previous && previous !== available) previous.close().catch(console.error);
          return available;
        });
        setStatus('available');
        setError(null);
        return;
      }
      // Background checks stay silent when nothing is available.
      if (!manual) return;
      const settleCurrent = () => {
        minDisplayTimerRef.current = null;
        if (dismissedCheckRef.current) return;
        setUpdate((previous) => {
          previous?.close().catch(console.error);
          return null;
        });
        // A newer check owns the dialog if it started while this one settled.
        setStatus((current) => current === 'checking' ? 'current' : current);
      };
      const remaining = Math.max(0, MIN_CHECKING_DISPLAY_MS - (Date.now() - checkStartedAtRef.current));
      if (remaining > 0) {
        minDisplayTimerRef.current = window.setTimeout(settleCurrent, remaining);
      } else {
        settleCurrent();
      }
    } catch (checkError) {
      if (manual) {
        setUpdate((previous) => {
          previous?.close().catch(console.error);
          return null;
        });
        setStatus('error');
        setError(errorMessage(checkError));
      } else {
        console.warn('Could not check for Stacks updates:', checkError);
      }
    } finally {
      checkingRef.current = false;
    }
  }, [clearMinDisplayTimer]);

  useEffect(() => {
    const requestManualCheck = () => { void checkForUpdates(true); };
    const unlistenPromise = getCurrentWindow().listen('check-for-updates', requestManualCheck);
    const unsubscribe = events.subscribe('check-for-updates', requestManualCheck);
    let initialTimer: number | null = null;
    let interval: number | null = null;
    if (!import.meta.env.DEV) {
      initialTimer = window.setTimeout(() => checkForUpdates(false), 5_000);
      interval = window.setInterval(() => checkForUpdates(false), CHECK_INTERVAL_MS);
    }
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(console.error);
      unsubscribe();
      if (initialTimer !== null) window.clearTimeout(initialTimer);
      if (interval !== null) window.clearInterval(interval);
    };
  }, [checkForUpdates, events]);

  useEffect(() => clearMinDisplayTimer, [clearMinDisplayTimer]);

  async function installUpdate(deferred = false) {
    if (!update || installingRef.current) return;
    installingRef.current = true;
    setStatus('downloading');
    setError(null);
    let downloaded = 0;
    let total: number | undefined;
    const onDownload = (event: DownloadEvent) => {
      if (event.event === 'Started') total = event.data.contentLength;
      if (event.event === 'Progress') downloaded += event.data.chunkLength;
      setProgress(total ? Math.min(100, Math.round(downloaded / total * 100)) : null);
    };
    try {
      if (deferred) {
        await update.download(onDownload);
        setStatus('waiting');
        setProgress(100);
        return;
      }
      await update.downloadAndInstall(onDownload);
      await invoke('save_current_window_state');
      await relaunch();
    } catch (installError) {
      setStatus('error');
      setError(errorMessage(installError));
    } finally {
      installingRef.current = false;
    }
  }

  useEffect(() => {
    if (status !== 'waiting') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const snapshot = await invoke<{ idle: boolean }>('app_idle_snapshot');
        if (!cancelled && snapshot.idle) setStatus('confirmation');
      } catch (idleError) {
        console.warn('Could not query Stacks runtime idleness:', idleError);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [status]);

  async function restartDeferredUpdate() {
    if (!update || installingRef.current) return;
    installingRef.current = true;
    try {
      const snapshot = await invoke<{ idle: boolean }>('app_idle_snapshot');
      if (!snapshot.idle) { setStatus('waiting'); return; }
      const current = await check({ timeout: 15_000 });
      if (!current || current.version !== update.version || !isNewer(update.version, update.currentVersion)) {
        await update.close().catch(() => {});
        setUpdate(null);
        setStatus('error');
        setError('This downloaded update is no longer current. Please check for updates again.');
        return;
      }
      await update.install();
      await invoke('save_current_window_state');
      await relaunch();
    } catch (restartError) {
      setStatus('error');
      setError(errorMessage(restartError));
    } finally {
      installingRef.current = false;
    }
  }

  function closeDialog() {
    if (status === 'checking') {
      dismissedCheckRef.current = true;
      clearMinDisplayTimer();
    }
    update?.close().catch(console.error);
    setUpdate(null);
    setStatus('available');
    setError(null);
  }

  if (!update && !['error', 'checking', 'current'].includes(status)) return null;
  const releaseUrl = update ? `${RELEASES_URL}/tag/v${update.version}` : RELEASES_URL;
  const title = SETTLED_TITLES[status] ?? `Stacks ${update?.version} is available`;
  const showReleaseNotes = status !== 'checking' && status !== 'current';
  const dismissOnEscape = status === 'confirmation' || status === 'checking' || status === 'current';

  const Boundary = status === 'confirmation' ? ConfirmationBoundary : Fragment;
  return <div className="modalBackdrop" onMouseDown={status === 'downloading' || status === 'confirmation' ? undefined : closeDialog}>
    <section className="modal updateModal" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title" onMouseDown={(event) => event.stopPropagation()} onKeyDownCapture={(event) => {
      handleDialogShortcut(event);
      if (dismissOnEscape && event.key === 'Escape') { event.preventDefault(); closeDialog(); }
    }}>
      <header className="updateModalHeader">
        <h2 id="update-dialog-title">{title}</h2>
        {showReleaseNotes && <button className="updateReleaseNotesLink" type="button" disabled={status === 'downloading' || status === 'waiting'} onClick={() => void openExternalUrl(releaseUrl)}>Release Notes</button>}
      </header>
      <div className="dialogBody">
      {status === 'checking' && <p>Looking for a newer version of Stacks.</p>}
      {status === 'current' && <p>Stacks is running the latest version.</p>}
      {status === 'available' && <>
        <p>You currently have version {update?.currentVersion}.</p>
        {update?.body && <div className="updateReleaseNotes">{update.body}</div>}
      </>}
      {status === 'downloading' && <p>Downloading and installing update{progress === null ? '…' : `… ${progress}%`}</p>}
      {status === 'waiting' && <p>Update downloaded and verified. Waiting for Stacks to become idle…</p>}
      {status === 'confirmation' && <p>Restart with a new version of Stacks?</p>}
      {error && <p className="dialogSubmitError">{error}</p>}
      </div>
      <Boundary><div className="modalActions">
        {status === 'checking' && <button data-card-action="secondary" type="button" onClick={closeDialog}>Cancel</button>}
        {status === 'current' && <button data-card-action="primary" className="primaryAction" type="button" onClick={closeDialog}>Close</button>}
        {status !== 'downloading' && status !== 'checking' && status !== 'current' && <button data-card-action="secondary" data-confirm-cancel type="button" onClick={closeDialog}>Later</button>}
        {!update && status === 'error' && <button data-card-action="primary" className="primaryAction" type="button" onClick={() => checkForUpdates(true).catch(console.error)}>Retry</button>}
        {update && (status === 'available' || status === 'error') && <>
          <button data-card-action="secondary" type="button" onClick={() => installUpdate(true).catch(console.error)}>Download. Restart later.</button>
          <button data-card-action="primary" className="primaryAction" type="button" onClick={() => installUpdate().catch(console.error)}>UPDATE</button>
        </>}
        {status === 'confirmation' && <button data-card-action="primary" className="primaryAction" type="button" onClick={() => restartDeferredUpdate().catch(console.error)}>Restart</button>}
      </div></Boundary>
    </section>
  </div>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isNewer(version: string, current: string) {
  const parse = (value: string) => value.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const next = parse(version);
  const running = parse(current);
  for (let index = 0; index < Math.max(next.length, running.length); index += 1) {
    if ((next[index] ?? 0) !== (running[index] ?? 0)) return (next[index] ?? 0) > (running[index] ?? 0);
  }
  return false;
}
