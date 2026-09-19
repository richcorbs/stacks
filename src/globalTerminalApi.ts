import { invoke } from '@tauri-apps/api/core';
import type { GlobalTerminalState, GlobalTerminalTab } from './globalTerminalState';

export const loadGlobalTerminal = () => invoke<GlobalTerminalState>('global_terminal_load_or_create');
export const saveGlobalTerminal = (tabs: GlobalTerminalTab[], selectedTabId: string, expectedRevision: number) =>
  invoke<GlobalTerminalState>('global_terminal_save', { tabs, selectedTabId, expectedRevision });
