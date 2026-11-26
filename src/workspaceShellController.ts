import type { SplitNode, TerminalEntry } from './types';
import { closePane, collectLeafTerminalIds, focusPane, relativePaneId, removeLeaves, resolveFocusedPaneId, resolveMaximizedPaneId, setSplitRatio, splitLeaf, toggleMaximizedPane } from './splitTree';

export type WorkspaceShellRequest = { terminalId: string; nonce: number };
export type WorkspaceShellPane = TerminalEntry;
export type WorkspaceShellServicePane = { terminalId: string; command: string; cwd: string | null };

export type WorkspaceShellSnapshot = {
  tree: SplitNode;
  panes: Record<string, WorkspaceShellPane>;
  paneIds: string[];
  focusedPaneId: string | null;
  maximizedPaneId: string | null;
  pendingClosePaneId: string | null;
  searchRequest: WorkspaceShellRequest | null;
  restartRequest: WorkspaceShellRequest | null;
};

export type WorkspaceShellLayout = Pick<WorkspaceShellSnapshot, 'tree' | 'focusedPaneId'> & {
  panes: WorkspaceShellPane[];
};

export type WorkspaceShellCommand =
  | { type: 'split'; direction: 'row' | 'column'; paneId?: string }
  | { type: 'search' }
  | { type: 'clear' }
  | { type: 'restart' }
  | { type: 'stop' }
  | { type: 'close' }
  | { type: 'focus'; paneId: string }
  | { type: 'navigate-pane'; direction: -1 | 1 }
  | { type: 'toggle-maximize' }
  | { type: 'run-one-time'; command: string };

export type WorkspaceShellTemporaryCapability = {
  createPaneId?: () => string;
  resolveCwd: (focusedPaneId: string) => Promise<string | null>;
  registerStartupCommand: (terminalId: string, command: string) => void;
  clearStartupCommand: (terminalId: string) => void;
  buildCommand: (command: string) => string;
};

export type WorkspaceShellPorts = {
  createPaneId: () => string;
  createPane: (terminalId: string, options: { temporary: boolean; cwd?: string | null; command?: string | null; managedService?: boolean }) => WorkspaceShellPane;
  prepareSplit?: (terminalId: string) => Promise<void>;
  clearSession: (terminalId: string) => void;
  disposeAndKill: (terminalId: string) => void;
  write: (terminalId: string, data: string) => void;
  scrollAfterFit: (terminalIds: string[]) => void;
  persist: (layout: WorkspaceShellLayout) => void;
  now?: () => number;
  temporary?: WorkspaceShellTemporaryCapability;
};

type TemporaryRun = { terminalId: string; previousTree: SplitNode; previousFocus: string | null };

/** Framework-independent state and command owner for a terminal workspace shell. */
export class WorkspaceShellController {
  readonly ownerId: string;
  private readonly ports: WorkspaceShellPorts;
  private listeners = new Set<() => void>();
  private temporaryRun: TemporaryRun | null = null;
  private temporaryCwd: string | null = null;
  private readonly servicePanes = new Map<string, WorkspaceShellServicePane>();
  private nonce = 0;
  private disposed = false;
  private snapshot: WorkspaceShellSnapshot;

  constructor(ownerId: string, layout: { tree: SplitNode; focusedPaneId: string | null }, ports: WorkspaceShellPorts) {
    this.ownerId = ownerId;
    this.ports = ports;
    this.snapshot = this.makeSnapshot(layout.tree, layout.focusedPaneId, null, null, null, null);
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  replaceLayout(tree: SplitNode, focusedPaneId: string | null) {
    if (this.temporaryRun) this.finishTemporary(this.temporaryRun.terminalId, false);
    this.setSnapshot(this.makeSnapshot(tree, focusedPaneId, null, null, null, null), false);
  }

  focus(paneId: string) {
    if (!this.snapshot.paneIds.includes(paneId)) return false;
    // Service panes are ephemeral runners, never part of the persisted shell layout.
    this.update(focusPane(paneId, this.snapshot.maximizedPaneId), !this.servicePanes.has(paneId));
    return true;
  }

  /** Mount a service pane in the tree, or remount the existing one with a fresh process. */
  startServicePane(config: WorkspaceShellServicePane, direction: 'row' | 'column' = 'row') {
    const existed = this.snapshot.paneIds.includes(config.terminalId);
    this.servicePanes.set(config.terminalId, config);
    const nonce = this.nextNonce();
    if (existed) {
      // Recreate the pane entry so a changed command is not hidden behind the cached one.
      this.update({
        tree: this.snapshot.tree,
        focusedPaneId: config.terminalId,
        restartRequest: { terminalId: config.terminalId, nonce },
      }, false);
    } else {
      const target = this.snapshot.focusedPaneId && this.snapshot.paneIds.includes(this.snapshot.focusedPaneId)
        ? this.snapshot.focusedPaneId : this.snapshot.paneIds.at(-1);
      this.update({
        tree: target ? splitLeaf(this.snapshot.tree, target, config.terminalId, direction, null) : { kind: 'leaf', terminalId: config.terminalId },
        focusedPaneId: config.terminalId,
        maximizedPaneId: null,
        restartRequest: { terminalId: config.terminalId, nonce },
      }, false);
    }
    this.ports.scrollAfterFit([config.terminalId]);
    return !existed;
  }

  setServicePane(config: WorkspaceShellServicePane) {
    this.servicePanes.set(config.terminalId, config);
  }

  navigatePane(direction: -1 | 1) {
    const next = relativePaneId(this.snapshot.tree, this.snapshot.focusedPaneId, direction);
    return next ? this.focus(next) : false;
  }

  async split(direction: 'row' | 'column', requestedPaneId?: string) {
    const target = requestedPaneId && this.snapshot.paneIds.includes(requestedPaneId)
      ? requestedPaneId
      : this.snapshot.focusedPaneId && this.snapshot.paneIds.includes(this.snapshot.focusedPaneId)
        ? this.snapshot.focusedPaneId : this.snapshot.paneIds.at(-1);
    if (!target) return false;
    await this.ports.prepareSplit?.(target);
    if (!this.snapshot.paneIds.includes(target)) return false;
    const paneId = this.ports.createPaneId();
    this.update({
      tree: splitLeaf(this.snapshot.tree, target, paneId, direction),
      focusedPaneId: paneId,
      maximizedPaneId: this.snapshot.maximizedPaneId ? paneId : null,
    });
    return true;
  }

  resize(path: string, ratio: number) { this.update({ tree: setSplitRatio(this.snapshot.tree, path, ratio) }); }

  requestClose(paneId = this.snapshot.focusedPaneId) {
    if (!paneId || !this.snapshot.paneIds.includes(paneId)) return false;
    this.update({ pendingClosePaneId: paneId }, false);
    return true;
  }

  cancelClose() { this.update({ pendingClosePaneId: null }, false); }

  close(paneId: string) {
    if (this.temporaryRun?.terminalId === paneId) {
      this.finishTemporary(paneId);
      this.cancelClose();
      return true;
    }
    if (!this.snapshot.paneIds.includes(paneId)) return false;
    this.ports.disposeAndKill(paneId);
    this.update({ ...closePane(this.snapshot.tree, paneId), maximizedPaneId: null, pendingClosePaneId: null });
    return true;
  }

  toggleMaximize(paneId = this.snapshot.focusedPaneId) {
    if (!paneId || !this.snapshot.paneIds.includes(paneId) || this.snapshot.paneIds.length < 2) return false;
    this.update(toggleMaximizedPane(paneId, this.snapshot.maximizedPaneId));
    this.ports.scrollAfterFit([paneId]);
    return true;
  }

  search() {
    const terminalId = this.snapshot.focusedPaneId;
    if (!terminalId) return;
    this.update({ searchRequest: { terminalId, nonce: this.nextNonce() } }, false);
  }

  clear() { if (this.snapshot.focusedPaneId) this.ports.clearSession(this.snapshot.focusedPaneId); }

  restart() {
    const terminalId = this.snapshot.focusedPaneId;
    if (!terminalId) return;
    this.ports.disposeAndKill(terminalId);
    this.update({ restartRequest: { terminalId, nonce: this.nextNonce() } }, false);
  }

  stop() { if (this.snapshot.focusedPaneId) this.ports.disposeAndKill(this.snapshot.focusedPaneId); }
  write(terminalId: string, data: string) { if (this.snapshot.paneIds.includes(terminalId)) this.ports.write(terminalId, data); }

  async runTemporary(command: string) {
    const capability = this.ports.temporary;
    const focused = this.snapshot.focusedPaneId;
    const trimmed = command.trim();
    if (!capability || !focused || !trimmed || this.temporaryRun) return false;
    const cwd = await capability.resolveCwd(focused);
    if (!cwd || this.disposed || this.temporaryRun || !this.snapshot.paneIds.includes(focused)) return false;
    const terminalId = capability.createPaneId?.() ?? this.ports.createPaneId();
    this.temporaryRun = { terminalId, previousTree: this.snapshot.tree, previousFocus: focused };
    this.temporaryCwd = cwd;
    capability.registerStartupCommand(terminalId, capability.buildCommand(trimmed));
    this.update({
      tree: splitLeaf(this.snapshot.tree, focused, terminalId, 'row', null),
      focusedPaneId: terminalId,
      maximizedPaneId: terminalId,
    }, false);
    this.ports.scrollAfterFit([terminalId]);
    return true;
  }

  finishTemporary(terminalId: string, restore = true) {
    const run = this.temporaryRun;
    if (!run || run.terminalId !== terminalId) return false;
    this.temporaryRun = null;
    this.temporaryCwd = null;
    this.ports.temporary?.clearStartupCommand(terminalId);
    this.ports.disposeAndKill(terminalId);
    if (restore) {
      this.setSnapshot(this.makeSnapshot(run.previousTree, run.previousFocus, null, null, null, null), false);
      if (run.previousFocus) this.ports.scrollAfterFit([run.previousFocus]);
    }
    return true;
  }

  handleTerminalStopped(terminalId: string) {
    if (this.temporaryRun?.terminalId === terminalId) setTimeout(() => this.finishTemporary(terminalId), 0);
  }

  handleCommand(ownerId: string, active: boolean, command: WorkspaceShellCommand) {
    if (!active || ownerId !== this.ownerId) return false;
    if (command.type === 'split') void this.split(command.direction, command.paneId);
    else if (command.type === 'focus') this.focus(command.paneId);
    else if (command.type === 'navigate-pane') this.navigatePane(command.direction);
    else if (command.type === 'search') this.search();
    else if (command.type === 'clear') this.clear();
    else if (command.type === 'restart') this.restart();
    else if (command.type === 'stop') this.stop();
    else if (command.type === 'close') {
      const pane = this.snapshot.focusedPaneId;
      if (pane && !this.finishTemporary(pane)) this.requestClose(pane);
    } else if (command.type === 'toggle-maximize') this.toggleMaximize();
    else if (command.type === 'run-one-time') void this.runTemporary(command.command);
    return true;
  }

  dispose() {
    if (this.temporaryRun) this.finishTemporary(this.temporaryRun.terminalId, false);
    this.disposed = true;
    this.listeners.clear();
  }

  private nextNonce() { this.nonce = Math.max(this.nonce + 1, this.ports.now?.() ?? Date.now()); return this.nonce; }

  private update(patch: Partial<WorkspaceShellSnapshot>, persist = true) {
    const tree = patch.tree ?? this.snapshot.tree;
    const focusedPaneId = patch.focusedPaneId !== undefined ? patch.focusedPaneId : this.snapshot.focusedPaneId;
    const next = this.makeSnapshot(
      tree, focusedPaneId,
      patch.maximizedPaneId !== undefined ? patch.maximizedPaneId : this.snapshot.maximizedPaneId,
      patch.pendingClosePaneId !== undefined ? patch.pendingClosePaneId : this.snapshot.pendingClosePaneId,
      patch.searchRequest !== undefined ? patch.searchRequest : this.snapshot.searchRequest,
      patch.restartRequest !== undefined ? patch.restartRequest : this.snapshot.restartRequest,
    );
    this.setSnapshot(next, persist);
  }

  private makeSnapshot(tree: SplitNode, focusedPaneId: string | null, maximizedPaneId: string | null, pendingClosePaneId: string | null, searchRequest: WorkspaceShellRequest | null, restartRequest: WorkspaceShellRequest | null): WorkspaceShellSnapshot {
    const paneIds = collectLeafTerminalIds(tree);
    const panes = Object.fromEntries(paneIds.map((id) => {
      const service = this.servicePanes.get(id);
      return [id, this.ports.createPane(id, {
        temporary: id === this.temporaryRun?.terminalId,
        cwd: service?.cwd ?? (id === this.temporaryRun?.terminalId ? this.temporaryCwd : undefined),
        command: service?.command,
        managedService: Boolean(service),
      })];
    }));
    return { tree, panes, paneIds, focusedPaneId: resolveFocusedPaneId(tree, focusedPaneId), maximizedPaneId: resolveMaximizedPaneId(tree, maximizedPaneId), pendingClosePaneId, searchRequest, restartRequest };
  }

  private setSnapshot(snapshot: WorkspaceShellSnapshot, persist: boolean) {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
    if (!persist || this.temporaryRun) return;
    const persistedTree = removeLeaves(snapshot.tree, new Set(this.servicePanes.keys())) ?? { kind: 'empty' };
    const persistedPaneIds = collectLeafTerminalIds(persistedTree);
    const persistedFocus = snapshot.focusedPaneId && persistedPaneIds.includes(snapshot.focusedPaneId)
      ? snapshot.focusedPaneId : persistedPaneIds[0] ?? null;
    this.ports.persist({ tree: persistedTree, focusedPaneId: persistedFocus, panes: persistedPaneIds.map((id) => snapshot.panes[id]) });
  }
}
