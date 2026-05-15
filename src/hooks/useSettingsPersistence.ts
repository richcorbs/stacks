import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { clampTerminalFontSize } from '../settings';
import type { ResolvedAppSettings } from '../settingsModel';
import { toPersistedAppSettings } from '../settingsModel';

export function usePersistentSidebarWidth(loaded: boolean, sidebarWidth: number, delayMs = 250) {
  useEffect(() => {
    if (!loaded) return;
    window.localStorage.setItem('stacks.sidebarWidth', String(sidebarWidth));
    const timeout = window.setTimeout(() => {
      invoke('save_sidebar_width', { width: Math.round(sidebarWidth) }).catch(console.error);
    }, delayMs);
    return () => window.clearTimeout(timeout);
  }, [loaded, sidebarWidth, delayMs]);
}

export function usePersistentTerminalFontSize(loaded: boolean, terminalFontSize: number, delayMs = 250) {
  useEffect(() => {
    if (!loaded) return;
    const timeout = window.setTimeout(() => {
      invoke('save_terminal_font_size', { fontSize: clampTerminalFontSize(terminalFontSize) }).catch(console.error);
    }, delayMs);
    return () => window.clearTimeout(timeout);
  }, [loaded, terminalFontSize, delayMs]);
}

export function usePersistentAppSettings(loaded: boolean, settings: ResolvedAppSettings, delayMs = 250) {
  useEffect(() => {
    if (!loaded) return;
    const timeout = window.setTimeout(() => {
      invoke('save_app_settings', { next: toPersistedAppSettings(settings) }).catch(console.error);
    }, delayMs);
    return () => window.clearTimeout(timeout);
  }, [loaded, settings, delayMs]);
}
