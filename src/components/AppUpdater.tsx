import { ConfirmationBoundary } from './ConfirmationBoundary';
import { Fragment } from 'react';
import { showAppToast } from '../applicationEvents';
import { openExternalUrl } from '../externalLinks';
import { handleDialogShortcut } from './dialogShortcut';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { check, type Update, type DownloadEvent } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

const RELEASES_URL = 'https://github.com/richcorbs/stacks/releases';
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

type UpdateStatus = 'available' | 'downloading' | 'waiting' | 'confirmation' | 'error';

export function AppUpdater() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [status, setStatus] = useState<UpdateStatus>('available');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const checkingRef = useRef(false);
  const installingRef = useRef(false);

  const checkForUpdates = useCallback(async (manual = false) => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    try {
      const available = await check({ timeout: 15_000 });
      if (available) {
        setUpdate(available);
        setStatus('available');
        setError(null);
      } else if (manual) {
        showToast('Stacks is up to date');
      }
    } catch (checkError) {
      if (manual) {
        setUpdate(null);
        setStatus('error');
        setError(errorMessage(checkError));
      } else {
        console.warn('Could not check for Stacks updates:', checkError);
      }
    } finally {
      checkingRef.current = false;
    }
  }, []);

  useEffect(() => {
    const unlistenPromise = getCurrentWindow().listen('check-for-updates', () => checkForUpdates(true));
    let initialTimer: number | null = null;
    let interval: number | null = null;
    if (!import.meta.env.DEV) {
      initialTimer = window.setTimeout(() => checkForUpdates(false), 5_000);
      interval = window.setInterval(() => checkForUpdates(false), CHECK_INTERVAL_MS);
    }
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(console.error);
      if (initialTimer !== null) window.clearTimeout(initialTimer);
      if (interval !== null) window.clearInterval(interval);
    };
  }, [checkForUpdates]);

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
    update?.close().catch(console.error);
    setUpdate(null);
    setError(null);
  }

  if (!update && status !== 'error') return null;
  const releaseUrl = update ? `${RELEASES_URL}/tag/v${update.version}` : RELEASES_URL;

  const Boundary = status === 'confirmation' ? ConfirmationBoundary : Fragment;
  return <div className="modalBackdrop" onMouseDown={status === 'downloading' || status === 'confirmation' ? undefined : closeDialog}>
    <section className="modal updateModal" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title" onMouseDown={(event) => event.stopPropagation()} onKeyDownCapture={(event) => { handleDialogShortcut(event); if (status === 'confirmation' && event.key === 'Escape') { event.preventDefault(); closeDialog(); } }}>
      <header className="updateModalHeader">
        <h2 id="update-dialog-title">{status === 'error' ? 'Update unavailable' : `Stacks ${update?.version} is available`}</h2>
        <button className="updateReleaseNotesLink" type="button" disabled={status === 'downloading' || status === 'waiting'} onClick={() => void openExternalUrl(releaseUrl)}>Release Notes</button>
      </header>
      <div className="dialogBody">
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
        {status !== 'downloading' && <button data-confirm-cancel type="button" onClick={closeDialog}>Later</button>}
        {!update && status === 'error' && <button className="primaryAction" type="button" onClick={() => checkForUpdates(true).catch(console.error)}>Retry</button>}
        {update && (status === 'available' || status === 'error') && <>
          <button type="button" onClick={() => installUpdate(true).catch(console.error)}>Download. Restart later.</button>
          <button className="primaryAction" type="button" onClick={() => installUpdate().catch(console.error)}>UPDATE</button>
        </>}
        {status === 'confirmation' && <button className="primaryAction" type="button" onClick={() => restartDeferredUpdate().catch(console.error)}>Restart</button>}
      </div></Boundary>
    </section>
  </div>;
}

function showToast(message: string) {
  showAppToast(message);
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
