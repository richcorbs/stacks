import { describe, expect, it } from 'vitest';
import { createGlobalTab, removeGlobalPane, removeGlobalTab, selectRelativeTab } from './globalTerminalState';


describe('global terminal state', () => {
  it('wraps tab navigation and derives positions from order', () => {
    const tabs = [createGlobalTab(), createGlobalTab(), createGlobalTab()];
    expect(selectRelativeTab(tabs, tabs[0].id, -1)).toBe(tabs[2].id);
    expect(selectRelativeTab(tabs, tabs[2].id, 1)).toBe(tabs[0].id);
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
