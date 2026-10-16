import { invoke } from '@tauri-apps/api/core';
import { showAppToast } from './applicationEvents';

export function webUrl(url: string | null | undefined): string | undefined {
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return undefined;
    // The native command accepts lowercase HTTP/HTTPS schemes only.
    return url.replace(/^https?:/i, parsed.protocol);
  } catch {
    return undefined;
  }
}

export async function openExternalUrl(url: string | null | undefined): Promise<void> {
  const supported = webUrl(url);
  if (!supported) return;
  try {
    await invoke('open_url', { url: supported });
  } catch (error) {
    showAppToast(`Could not open link: ${String(error)}`, 5000);
  }
}
