import type { SplitNode, TerminalEntry } from './types';
import { collectLeafTerminalIds, removeLeaf, setSplitRatio, splitLeaf } from './utils';

export type WorkspaceShellRequest = { terminalId: string; nonce: number };
export type WorkspaceShellPane = TerminalEntry;

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
  createPane: (terminalId: string, options: { temporary: boolean; cwd?: string | null }) => WorkspaceShellPane;
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
    this.update({ focusedPaneId: paneId, maximizedPaneId: this.snapshot.maximizedPaneId ? paneId : null });
    return true;
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
    const closingIndex = this.snapshot.paneIds.indexOf(paneId);
    const remaining = this.snapshot.paneIds.filter((id) => id !== paneId);
    const previousPaneId = remaining.length > 0 ? remaining[(closingIndex - 1 + remaining.length) % remaining.length] : null;
    this.update({
      tree: removeLeaf(this.snapshot.tree, paneId) ?? { kind: 'empty' },
      focusedPaneId: previousPaneId,
      maximizedPaneId: null,
      pendingClosePaneId: null,
    });
    return true;
  }

  toggleMaximize(paneId = this.snapshot.focusedPaneId) {
    if (!paneId || !this.snapshot.paneIds.includes(paneId) || this.snapshot.paneIds.length < 2) return false;
    this.update({ focusedPaneId: paneId, maximizedPaneId: this.snapshot.maximizedPaneId ? null : paneId });
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
    const validFocus = focusedPaneId && paneIds.includes(focusedPaneId) ? focusedPaneId : paneIds[0] ?? null;
    const panes = Object.fromEntries(paneIds.map((id) => [id, this.ports.createPane(id, { temporary: id === this.temporaryRun?.terminalId, cwd: id === this.temporaryRun?.terminalId ? this.temporaryCwd : undefined })]));
    return { tree, panes, paneIds, focusedPaneId: validFocus, maximizedPaneId: maximizedPaneId && paneIds.includes(maximizedPaneId) ? maximizedPaneId : null, pendingClosePaneId, searchRequest, restartRequest };
  }

  private setSnapshot(snapshot: WorkspaceShellSnapshot, persist: boolean) {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
    if (persist && !this.temporaryRun) this.ports.persist({ tree: snapshot.tree, focusedPaneId: snapshot.focusedPaneId, panes: snapshot.paneIds.map((id) => snapshot.panes[id]) });
  }
}
