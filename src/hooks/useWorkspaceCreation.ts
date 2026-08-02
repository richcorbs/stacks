import { useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type React from 'react';
import type { SplitNode, Store, TerminalEntry } from '../types';
import type { SaveStoreNow } from './useDebouncedSave';
import {
  clearOneTimeStartupCommand,
  disposeTerminalSessions,
  registerOneTimeStartupCommand,
} from '../terminalSessionManager';
import {
  planWorkspaceCreation,
  type CreateWorkspace,
  type CreateWorkspaceInput,
  type RollbackWorkspace,
  type WorkspaceCreation,
} from '../workspace/createWorkspace';

type WorkspaceCreationOptions = {
  store: Store;
  setStore: React.Dispatch<React.SetStateAction<Store>>;
  saveStoreNow: SaveStoreNow;
  selectWorkspace: (projectId: string, workspaceId: string | null) => void;
  focusTerminal: (workspaceId: string, terminalId: string) => void;
  removeTerminalState: (workspaceId: string) => void;
  setTerminalsByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, TerminalEntry[]>>>;
  setSplitRootsByWorkspaceId: React.Dispatch<React.SetStateAction<Record<string, SplitNode>>>;
  setSidebarFocusedWorkspaceId: React.Dispatch<React.SetStateAction<string | null>>;
};

export type WorkspaceCreationCommands = {
  createWorkspace: CreateWorkspace;
  rollbackWorkspace: RollbackWorkspace;
};

export function useWorkspaceCreation(options: WorkspaceCreationOptions): WorkspaceCreationCommands {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const storeRef = useRef(options.store);
  storeRef.current = options.store;
  const operationQueueRef = useRef<Promise<void>>(Promise.resolve());

  const enqueue = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const result = operationQueueRef.current.catch(() => undefined).then(operation);
    operationQueueRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  const removeRuntimeWorkspace = useCallback((creation: WorkspaceCreation) => {
    const terminalIds = creation.terminals.map((terminal) => terminal.id);
    terminalIds.forEach(clearOneTimeStartupCommand);
    disposeTerminalSessions(terminalIds);
    terminalIds.forEach((terminalId) => invoke('kill_pty', { terminalId }).catch(() => {}));
    optionsRef.current.removeTerminalState(creation.workspace.id);
  }, []);

  const createWorkspace = useCallback<CreateWorkspace>((input: CreateWorkspaceInput) => enqueue(async () => {
    const workspaceId = await invoke<string>('new_id');
    const previousStore = storeRef.current;
    const creation = planWorkspaceCreation(previousStore, input, workspaceId);
    storeRef.current = creation.store;
    const oneTimeStartupCommand = input.oneTimeStartupCommand?.trim();
    if (oneTimeStartupCommand) {
      registerOneTimeStartupCommand(creation.focusedTerminalId, oneTimeStartupCommand);
    }

    // Apply the complete workspace transition without an intervening await,
    // then make it durable before reporting completion to the caller.
    const current = optionsRef.current;
    current.setStore(creation.store);
    current.setTerminalsByWorkspaceId((all) => ({
      ...all,
      [creation.workspace.id]: creation.terminals,
    }));
    current.setSplitRootsByWorkspaceId((all) => ({
      ...all,
      [creation.workspace.id]: creation.root,
    }));
    current.selectWorkspace(creation.projectId, creation.workspace.id);
    current.setSidebarFocusedWorkspaceId(creation.workspace.id);
    current.focusTerminal(creation.workspace.id, creation.focusedTerminalId);

    try {
      await current.saveStoreNow(creation.store);
      return creation;
    } catch (error) {
      storeRef.current = previousStore;
      current.setStore(previousStore);
      removeRuntimeWorkspace(creation);
      throw error;
    }
  }), [enqueue, removeRuntimeWorkspace]);

  const rollbackWorkspace = useCallback<RollbackWorkspace>((creation) => enqueue(async () => {
    const currentStore = storeRef.current;
    const nextStore: Store = {
      projects: currentStore.projects.map((project) => project.id === creation.projectId
        ? { ...project, workspaces: project.workspaces.filter((workspace) => workspace.id !== creation.workspace.id) }
        : project),
    };
    storeRef.current = nextStore;
    optionsRef.current.setStore(nextStore);
    removeRuntimeWorkspace(creation);
    await optionsRef.current.saveStoreNow(nextStore);
  }), [enqueue, removeRuntimeWorkspace]);

  return { createWorkspace, rollbackWorkspace };
}
