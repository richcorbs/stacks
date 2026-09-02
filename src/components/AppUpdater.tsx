import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { check, type Update, type DownloadEvent } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

const RELEASES_URL = 'https://github.com/richcorbs/stacks/releases';
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

type UpdateStatus = 'available' | 'downloading' | 'error';

export function AppUpdater() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [status, setStatus] = useState<UpdateStatus>('available');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const checkingRef = useRef(false);

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

  async function installUpdate() {
    if (!update) return;
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
      await update.downloadAndInstall(onDownload);
      await invoke('save_current_window_state');
      await relaunch();
    } catch (installError) {
      setStatus('error');
      setError(errorMessage(installError));
    }
  }

  function closeDialog() {
    update?.close().catch(console.error);
    setUpdate(null);
    setError(null);
  }

  if (!update && status !== 'error') return null;
  const releaseUrl = update ? `${RELEASES_URL}/tag/v${update.version}` : RELEASES_URL;

  return <div className="modalBackdrop" onMouseDown={status === 'downloading' ? undefined : closeDialog}>
    <section className="modal updateModal" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
      <h2 id="update-dialog-title">{status === 'error' ? 'Update check failed' : `Stacks ${update?.version} is available`}</h2>
      {status === 'available' && <>
        <p>You currently have version {update?.currentVersion}.</p>
        {update?.body && <div className="updateReleaseNotes">{update.body}</div>}
      </>}
      {status === 'downloading' && <p>Downloading and installing update{progress === null ? '…' : `… ${progress}%`}</p>}
      {error && <p className="dialogSubmitError">{error}</p>}
      <div className="modalActions">
        {status !== 'downloading' && <button type="button" onClick={closeDialog}>Later</button>}
        <button type="button" disabled={status === 'downloading'} onClick={() => invoke('open_url', { url: releaseUrl }).catch(console.error)}>Release Notes</button>
        {update && status !== 'downloading' && <button className="primaryAction" type="button" onClick={() => installUpdate().catch(console.error)}>Update Now</button>}
      </div>
    </section>
  </div>;
}

function showToast(message: string) {
  window.dispatchEvent(new CustomEvent('app-toast', { detail: { message } }));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
