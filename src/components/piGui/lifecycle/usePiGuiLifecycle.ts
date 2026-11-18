import { useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listenForPiPrompt } from '../../../pi/promptEvent';
import type { PiSessionModel } from '../../../pi/usePiSession';

/** Pi pane process-lifecycle wiring that is independent of composer/transcript state. */
export function usePiGuiLifecycle({ pi, terminalId, projectId, active, visible, restartRequestNonce }: {
  pi: PiSessionModel;
  terminalId: string;
  projectId: string;
  active: boolean;
  visible: boolean;
  restartRequestNonce: number;
}) {
  const previousVisibleRef = useRef(visible);
  const handledRestartNonceRef = useRef(0);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow().listen<string>('superthread-credential-rotated', (event) => {
      if (event.payload === projectId) pi.restart().catch(console.error);
    }).then((cleanup) => { unlisten = cleanup; }).catch(console.error);
    return () => unlisten?.();
  }, [pi.restart, projectId]);

  useEffect(() => {
    pi.setViewOpen(active && visible);
    return () => pi.setViewOpen(false);
  }, [active, pi.setViewOpen, visible]);

  useEffect(() => {
    const becameVisible = visible && !previousVisibleRef.current;
    previousVisibleRef.current = visible;
    if (becameVisible && pi.stopped) pi.restart().catch(() => {});
  }, [pi.restart, pi.stopped, visible]);

  useEffect(() => {
    if (!restartRequestNonce || handledRestartNonceRef.current === restartRequestNonce) return;
    handledRestartNonceRef.current = restartRequestNonce;
    pi.restart().catch(() => {});
  }, [pi.restart, restartRequestNonce]);

  useEffect(() => listenForPiPrompt((request) => {
    if (request.terminalId !== terminalId || pi.starting || pi.isStreaming) return;
    if (pi.stopped) {
      pi.restart().catch((error) => {
        request.failed();
        console.error('Could not restart Pi for automated prompt', error);
      });
      return;
    }
    if (!request.claim()) return;
    pi.prompt(request.text, [])
      .then(request.accepted)
      .catch((error) => {
        request.failed();
        console.error('Could not run Pi prompt', error);
      });
  }), [pi.isStreaming, pi.prompt, pi.restart, pi.starting, pi.stopped, terminalId]);
}
