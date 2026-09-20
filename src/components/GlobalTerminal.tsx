import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ResolvedAppSettings } from '../settingsModel';
import type { Project, TerminalEntry } from '../types';
import { collectLeafTerminalIds, setSplitRatio, splitLeaf } from '../utils';
import { createGlobalTab, globalPaneId, removeGlobalPane, removeGlobalTab, selectRelativeTab, type GlobalTerminalCommand, type GlobalTerminalState, type GlobalTerminalTab } from '../globalTerminalState';
import { loadGlobalTerminal, saveGlobalTerminal } from '../globalTerminalApi';
import { disposeTerminalSession, disposeTerminalSessions, focusTerminalSession, getTerminalSession, requestTerminalSessionsScrollToBottomAfterFit } from '../terminalSessionManager';
import { SplitView } from './WorkspaceTerminalTree';
import { ConfirmCloseTerminalDialog } from './ConfirmDialogs';
import { applicationEvents } from '../applicationEvents';

const encoder = new TextEncoder();
const project: Project = { id: 'global-terminal', name: 'Top-level terminal', path: '' };

type PendingClose = { kind: 'pane'; id: string } | { kind: 'tab'; id: string };

export function GlobalTerminal({ visible, newTabNonce, settings, onVisibleChange }: { visible: boolean; newTabNonce: number; settings: ResolvedAppSettings; onVisibleChange: (visible: boolean) => void }) {
  const [state, setState] = useState<GlobalTerminalState | null>(null);
  const [temporaryCwds, setTemporaryCwds] = useState<Record<string, string>>({});
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null);
  const [searchRequest, setSearchRequest] = useState<{ terminalId: string; nonce: number } | null>(null);
  const revisionRef = useRef(0);
  const saveChain = useRef(Promise.resolve());
  const queuedSignature = useRef('');
  const consumedNewTabNonce = useRef(0);

  useEffect(() => { loadGlobalTerminal().then((loaded) => { revisionRef.current = loaded.revision; queuedSignature.current = signature(loaded.tabs, loaded.selected_tab_id); setState(loaded); }).catch(console.error); }, []);

  useEffect(() => {
    if (!state) return;
    const nextSignature = signature(state.tabs, state.selected_tab_id);
    if (nextSignature === queuedSignature.current) return;
    queuedSignature.current = nextSignature;
    const snapshot = { tabs: state.tabs, selected: state.selected_tab_id };
    const timer = window.setTimeout(() => {
      saveChain.current = saveChain.current.then(async () => {
        const saved = await saveGlobalTerminal(snapshot.tabs, snapshot.selected, revisionRef.current);
        revisionRef.current = saved.revision;
      }).catch((error) => console.error('Could not save top-level terminal layout', error));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [state]);

  const selected = state?.tabs.find((tab) => tab.id === state.selected_tab_id) ?? null;
  const focusSelected = useCallback((reason: string) => {
    if (!visible || !selected) return;
    requestAnimationFrame(() => focusTerminalSession(selected.focused_pane_id, reason));
  }, [selected, visible]);
  useEffect(() => { focusSelected('top-level terminal shown or tab selected'); }, [focusSelected]);

  const addTab = useCallback(() => {
    const tab = createGlobalTab();
    setState((current) => current ? { ...current, tabs: [...current.tabs, tab], selected_tab_id: tab.id } : current);
    onVisibleChange(true);
  }, [onVisibleChange]);

  useEffect(() => {
    if (!state || newTabNonce <= consumedNewTabNonce.current) return;
    const count = newTabNonce - consumedNewTabNonce.current;
    consumedNewTabNonce.current = newTabNonce;
    for (let index = 0; index < count; index += 1) addTab();
  }, [addTab, newTabNonce, state]);

  const split = useCallback(async (direction: 'row' | 'column') => {
    if (!selected || !state) return;
    const pane = globalPaneId(selected.id);
    const cwd = await invoke<string | null>('pty_cwd', { terminalId: selected.focused_pane_id }).catch(() => null) || state.home_dir;
    setTemporaryCwds((current) => ({ ...current, [pane]: cwd }));
    setState((current) => current ? { ...current, tabs: current.tabs.map((tab) => tab.id === selected.id ? { ...tab, split_layout: splitLeaf(tab.split_layout, selected.focused_pane_id, pane, direction), focused_pane_id: pane, maximized_pane_id: tab.maximized_pane_id ? pane : null } : tab) } : current);
  }, [selected, state]);

  const requestClosePane = useCallback(() => {
    if (!selected) return;
    const panes = collectLeafTerminalIds(selected.split_layout);
    if (state?.tabs.length === 1 && panes.length === 1) return;
    setPendingClose({ kind: 'pane', id: selected.focused_pane_id });
  }, [selected, state?.tabs.length]);

  const handleCommand = useCallback((command: GlobalTerminalCommand) => {
    if (!state) return;
    if (command.type === 'new-tab') return addTab();
    if (command.type === 'select-tab' && command.number) {
      const tab = state.tabs[command.number - 1]; if (tab) setState({ ...state, selected_tab_id: tab.id }); return;
    }
    if (command.type === 'navigate-tab' && (command.direction === -1 || command.direction === 1)) return setState({ ...state, selected_tab_id: selectRelativeTab(state.tabs, state.selected_tab_id, command.direction) });
    if (!selected) return;
    if (command.type === 'split' && (command.direction === 'row' || command.direction === 'column')) void split(command.direction);
    else if (command.type === 'close') requestClosePane();
    else if (command.type === 'search') setSearchRequest({ terminalId: selected.focused_pane_id, nonce: Date.now() });
    else if (command.type === 'clear') { const session = getTerminalSession(selected.focused_pane_id); session?.term.clearSelection(); session?.term.clear(); session?.term.scrollToBottom(); }
    else if (command.type === 'toggle-maximize' && collectLeafTerminalIds(selected.split_layout).length > 1) {
      setState({ ...state, tabs: state.tabs.map((tab) => tab.id === selected.id ? { ...tab, maximized_pane_id: tab.maximized_pane_id ? null : tab.focused_pane_id } : tab) });
      requestTerminalSessionsScrollToBottomAfterFit([selected.focused_pane_id]);
    }
  }, [addTab, requestClosePane, selected, split, state]);

  useEffect(() => applicationEvents.subscribe('global-terminal-command', handleCommand), [handleCommand]);

  function closeConfirmed() {
    if (!state || !pendingClose) return;
    if (pendingClose.kind === 'tab') {
      const tab = state.tabs.find((item) => item.id === pendingClose.id);
      if (!tab || state.tabs.length === 1) return setPendingClose(null);
      const paneIds = collectLeafTerminalIds(tab.split_layout);
      paneIds.forEach((terminalId) => invoke('kill_pty', { terminalId }).catch(console.error));
      disposeTerminalSessions(paneIds);
      const next = removeGlobalTab(state.tabs, state.selected_tab_id, tab.id);
      setState({ ...state, tabs: next.tabs, selected_tab_id: next.selectedId });
    } else {
      invoke('kill_pty', { terminalId: pendingClose.id }).catch(console.error);
      disposeTerminalSession(pendingClose.id);
      const next = removeGlobalPane(state.tabs, state.selected_tab_id, pendingClose.id);
      setState({ ...state, tabs: next.tabs, selected_tab_id: next.selectedId });
    }
    setPendingClose(null);
  }

  if (!state) return visible ? <div className="globalTerminalOverlay"><div className="kanbanEmpty">Opening terminal…</div></div> : null;
  return <>
    <section className={`globalTerminalOverlay${visible ? ' visible' : ''}`} aria-hidden={!visible}>
      <nav className="globalTerminalTabs" aria-label="Top-level terminal tabs">
        {state.tabs.map((tab, index) => <span key={tab.id} className={tab.id === state.selected_tab_id ? 'active' : ''}>
          <button type="button" className="globalTerminalTabLabel" onClick={() => setState({ ...state, selected_tab_id: tab.id })}>{index + 1}</button>
          {state.tabs.length > 1 && <button type="button" className="globalTerminalTabClose" aria-label={`Close terminal tab ${index + 1}`} onClick={() => setPendingClose({ kind: 'tab', id: tab.id })}>×</button>}
        </span>)}
        <button type="button" className="globalTerminalAdd" aria-label="New terminal tab" title="New terminal tab (⇧⌘T)" onClick={addTab}>+</button>
        <button type="button" className="globalTerminalDismiss" aria-label="Hide top-level terminal" title="Hide top-level terminal (⌘T)" onClick={() => onVisibleChange(false)}><span aria-hidden="true">×</span></button>
      </nav>
      <div className="globalTerminalBody">
        {state.tabs.map((tab) => <GlobalTab key={tab.id} tab={tab} home={state.home_dir} selected={tab.id === state.selected_tab_id} visible={visible} settings={settings} temporaryCwds={temporaryCwds} searchRequest={searchRequest} canClose={state.tabs.length > 1 || collectLeafTerminalIds(tab.split_layout).length > 1} update={(change) => setState((current) => current ? { ...current, tabs: current.tabs.map((item) => item.id === tab.id ? change(item) : item) } : current)} onClose={(id) => setPendingClose({ kind: 'pane', id })} onSplit={(direction) => void split(direction)} />)}
      </div>
    </section>
    {pendingClose && <ConfirmCloseTerminalDialog onCancel={() => setPendingClose(null)} onConfirm={closeConfirmed} />}
  </>;
}

function GlobalTab({ tab, home, selected, visible, settings, temporaryCwds, searchRequest, canClose, update, onClose, onSplit }: { tab: GlobalTerminalTab; home: string; selected: boolean; visible: boolean; settings: ResolvedAppSettings; temporaryCwds: Record<string, string>; searchRequest: { terminalId: string; nonce: number } | null; canClose: boolean; update: (change: (tab: GlobalTerminalTab) => GlobalTerminalTab) => void; onClose: (id: string) => void; onSplit: (direction: 'row' | 'column') => void }) {
  const ids = useMemo(() => collectLeafTerminalIds(tab.split_layout), [tab.split_layout]);
  const terminals = useMemo(() => Object.fromEntries(ids.map((id): [string, TerminalEntry] => [id, { id, workspaceId: `global-terminal:${tab.id}`, cwd: temporaryCwds[id] ?? home }])), [home, ids, tab.id, temporaryCwds]);
  return <div className={`globalTerminalTab${selected ? ' active' : ''}`}><div className={`cardTerminalPane${ids.length > 1 ? ' multiple' : ''}`}>
    <SplitView node={tab.split_layout} terminalsById={terminals} workspace={{ id: `global-terminal:${tab.id}`, name: 'Top-level terminal', cwd: home }} project={{ ...project, path: home }} visible={visible && selected} canEditTerminal={false} canCloseTerminal={canClose} terminalFontSize={settings.terminal_font_size} terminalFontFamily={settings.terminal_font_family} terminalScrollback={settings.terminal_scrollback} copyOnSelect={settings.copy_on_select} activeTerminalId={tab.focused_pane_id} displayedMaximizedTerminalId={tab.maximized_pane_id} searchTerminalRequest={searchRequest} restartTerminalRequest={null} path="" onResizeSplit={(path, ratio) => update((current) => ({ ...current, split_layout: setSplitRatio(current.split_layout, path, ratio) }))} onFocus={(id) => update((current) => ({ ...current, focused_pane_id: id, maximized_pane_id: current.maximized_pane_id ? id : null }))} onClose={onClose} onSplitTerminal={(direction) => onSplit(direction)} onEditTerminal={() => {}} onInput={(terminalId, data) => invoke('write_pty', { terminalId, data: Array.from(encoder.encode(data)) }).catch(console.error)} canToggleMaximize={ids.length > 1} onToggleMaximize={(id) => { update((current) => ({ ...current, focused_pane_id: id, maximized_pane_id: current.maximized_pane_id ? null : id })); requestTerminalSessionsScrollToBottomAfterFit([id]); }} />
  </div></div>;
}

function signature(tabs: GlobalTerminalTab[], selected: string) { return JSON.stringify([tabs, selected]); }
