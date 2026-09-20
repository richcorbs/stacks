import { describe, expect, it, vi } from 'vitest';
import type { SplitNode } from './types';
import { WorkspaceShellController, type WorkspaceShellLayout, type WorkspaceShellPorts } from './workspaceShellController';

function createHarness(tree: SplitNode = { kind: 'leaf', terminalId: 'one' }, focus: string | null = 'one', temporary = false) {
  let id = 1;
  const layouts: WorkspaceShellLayout[] = [];
  const disposed: string[] = [];
  const scrolled: string[][] = [];
  const registered: Array<[string, string]> = [];
  const ports: WorkspaceShellPorts = {
    createPaneId: () => `new-${id++}`,
    createPane: (terminalId, options) => ({ id: terminalId, workspaceId: 'owner', cwd: options.cwd ?? '/work', temporary: options.temporary }),
    clearSession: vi.fn(),
    disposeAndKill: (terminalId) => disposed.push(terminalId),
    write: vi.fn(),
    scrollAfterFit: (ids) => scrolled.push(ids),
    persist: (layout) => layouts.push(layout),
    now: () => 10,
    temporary: temporary ? {
      resolveCwd: async () => '/live',
      registerStartupCommand: (terminalId, command) => registered.push([terminalId, command]),
      clearStartupCommand: vi.fn(),
      buildCommand: (command) => `run:${command}`,
    } : undefined,
  };
  const controller = new WorkspaceShellController('owner', { tree, focusedPaneId: focus }, ports);
  return { controller, ports, layouts, disposed, scrolled, registered };
}

const twoPaneTree: SplitNode = { kind: 'split', direction: 'row', first: { kind: 'leaf', terminalId: 'one' }, second: { kind: 'leaf', terminalId: 'two' } };

describe('WorkspaceShellController', () => {
  it('publishes typed snapshots and handles splits in both directions', async () => {
    const { controller, layouts } = createHarness();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    await controller.split('row');
    await controller.split('column');
    expect(controller.getSnapshot().paneIds).toEqual(['one', 'new-1', 'new-2']);
    expect(controller.getSnapshot().focusedPaneId).toBe('new-2');
    expect(layouts).toHaveLength(2);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('moves focus, follows focus while maximized, resizes, and restores maximize scroll', () => {
    const { controller, scrolled } = createHarness(twoPaneTree);
    controller.toggleMaximize('one');
    controller.focus('two');
    controller.resize('', .7);
    expect(controller.getSnapshot().maximizedPaneId).toBe('two');
    expect(controller.getSnapshot().tree).toMatchObject({ ratio: .7, manual: true });
    controller.toggleMaximize('two');
    expect(controller.getSnapshot().maximizedPaneId).toBeNull();
    expect(scrolled).toEqual([['one'], ['two']]);
  });

  it('selects the previous visual pane when a close is confirmed', () => {
    const tree: SplitNode = { kind: 'split', direction: 'row', first: twoPaneTree, second: { kind: 'leaf', terminalId: 'three' } };
    const { controller } = createHarness(tree, 'two');
    controller.close('two');
    expect(controller.getSnapshot().focusedPaneId).toBe('one');
  });

  it('requests and confirms close and supports an empty tree', () => {
    const { controller, disposed } = createHarness();
    controller.requestClose();
    expect(controller.getSnapshot().pendingClosePaneId).toBe('one');
    controller.cancelClose();
    expect(controller.getSnapshot().pendingClosePaneId).toBeNull();
    controller.close('one');
    expect(controller.getSnapshot().tree).toEqual({ kind: 'empty' });
    expect(controller.getSnapshot().focusedPaneId).toBeNull();
    expect(disposed).toEqual(['one']);
  });

  it('creates search/restart tokens and rejects commands for inactive or different owners', () => {
    const { controller, disposed } = createHarness();
    expect(controller.handleCommand('other', true, { type: 'restart' })).toBe(false);
    expect(controller.handleCommand('owner', false, { type: 'restart' })).toBe(false);
    expect(disposed).toEqual([]);
    controller.handleCommand('owner', true, { type: 'search' });
    controller.handleCommand('owner', true, { type: 'restart' });
    expect(controller.getSnapshot().searchRequest).toEqual({ terminalId: 'one', nonce: 10 });
    expect(controller.getSnapshot().restartRequest?.terminalId).toBe('one');
    expect(controller.getSnapshot().restartRequest!.nonce).toBeGreaterThan(10);
    expect(disposed).toEqual(['one']);
  });

  it('keeps temporary panes out of persistence and restores the exact previous layout and focus', async () => {
    const { controller, layouts, disposed, registered, scrolled } = createHarness(twoPaneTree, 'two', true);
    await controller.runTemporary(' echo hi ');
    const temporaryId = controller.getSnapshot().focusedPaneId!;
    expect(controller.getSnapshot().panes[temporaryId]).toMatchObject({ cwd: '/live', temporary: true });
    expect(controller.getSnapshot().maximizedPaneId).toBe(temporaryId);
    expect(registered).toEqual([[temporaryId, 'run:echo hi']]);
    expect(layouts).toEqual([]);
    controller.finishTemporary(temporaryId);
    expect(controller.getSnapshot().tree).toEqual(twoPaneTree);
    expect(controller.getSnapshot().focusedPaneId).toBe('two');
    expect(disposed).toEqual([temporaryId]);
    expect(scrolled.at(-1)).toEqual(['two']);
    expect(layouts).toEqual([]);
  });

  it('cleans up only a temporary session on disposal', async () => {
    const { controller, disposed } = createHarness(twoPaneTree, 'one', true);
    await controller.runTemporary('test');
    const temporaryId = controller.getSnapshot().focusedPaneId!;
    controller.dispose();
    expect(disposed).toEqual([temporaryId]);
    expect(disposed).not.toContain('one');
    expect(disposed).not.toContain('two');
  });

  it('cancels a temporary insertion whose CWD lookup finishes after disposal', async () => {
    const { controller, ports, registered } = createHarness(twoPaneTree, 'one', true);
    let resolveCwd!: (cwd: string) => void;
    ports.temporary!.resolveCwd = () => new Promise((resolve) => { resolveCwd = resolve; });
    const pending = controller.runTemporary('test');
    controller.dispose();
    resolveCwd('/late');
    expect(await pending).toBe(false);
    expect(controller.getSnapshot().tree).toEqual(twoPaneTree);
    expect(registered).toEqual([]);
  });
});
