import { describe, expect, it } from 'vitest';
import { createGlobalTab, removeGlobalPane, removeGlobalTab, selectRelativePane, selectRelativeTab } from './globalTerminalState';


describe('global terminal state', () => {
  it('wraps tab navigation and derives positions from order', () => {
    const tabs = [createGlobalTab(), createGlobalTab(), createGlobalTab()];
    expect(selectRelativeTab(tabs, tabs[0].id, -1)).toBe(tabs[2].id);
    expect(selectRelativeTab(tabs, tabs[2].id, 1)).toBe(tabs[0].id);
  });
  it('navigates visual panes within a selected tab, wrapping and following maximization', () => {
    const first = createGlobalTab(); const other = createGlobalTab();
    const pane = first.focused_pane_id;
    const tab = { ...first, split_layout: { kind: 'split' as const, direction: 'row' as const, first: { kind: 'leaf' as const, terminalId: pane }, second: { kind: 'split' as const, direction: 'column' as const, first: { kind: 'leaf' as const, terminalId: 'two' }, second: { kind: 'leaf' as const, terminalId: 'three' } } }, maximized_pane_id: pane };
    const back = selectRelativePane(tab, -1);
    expect(back).toMatchObject({ focused_pane_id: 'three', maximized_pane_id: 'three' });
    expect(selectRelativePane(back, 1)).toMatchObject({ focused_pane_id: pane, maximized_pane_id: pane });
    expect(selectRelativePane(selectRelativePane(tab, 1), 1).focused_pane_id).toBe('three');
    expect(other.focused_pane_id).not.toBe(back.focused_pane_id);
    expect(selectRelativePane(other, 1)).toBe(other);
  });
  it('selects the tab to the right when closing, otherwise the left', () => {
    const tabs = [createGlobalTab(), createGlobalTab(), createGlobalTab()];
    expect(removeGlobalTab(tabs, tabs[1].id, tabs[1].id).selectedId).toBe(tabs[2].id);
    expect(removeGlobalTab(tabs, tabs[2].id, tabs[2].id).selectedId).toBe(tabs[1].id);
    expect(removeGlobalTab([tabs[0]], tabs[0].id, tabs[0].id).tabs).toHaveLength(1);
  });
  it('removes a tab with its last pane but protects the final pane of the final tab', () => {
    const tabs = [createGlobalTab(), createGlobalTab()];
    const pane = tabs[0].focused_pane_id;
    expect(removeGlobalPane(tabs, tabs[0].id, pane).tabs).toHaveLength(1);
    expect(removeGlobalPane([tabs[0]], tabs[0].id, pane).tabs).toHaveLength(1);
  });
});
