import { useEffect, useMemo, useState } from 'react';
import type React from 'react';
import type { DialogState } from '../types';
import { fetchSuperthreadBoards, fetchSuperthreadLists, testSuperthreadMapping } from '../superthread/api';
import type { SuperthreadBoard, SuperthreadList } from '../superthread/types';

export function SuperthreadMappingFields({ dialog, setDialog }: {
  dialog: DialogState;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
}) {
  const [boards, setBoards] = useState<Array<Pick<SuperthreadBoard, 'id' | 'title'>>>([]);
  const [lists, setLists] = useState<SuperthreadList[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'testing'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!dialog.superthreadSpaces?.trim()) { setBoards([]); return; }
    let active = true;
    setState('loading'); setMessage(null);
    fetchSuperthreadBoards(dialog.superthreadSpaces, false, dialog.superthreadApiTokenEnvVar ?? 'ST_TOKEN').then((result) => {
      if (!active) return;
      setBoards(result.boards);
      if (result.warnings.length) setMessage(result.warnings.map((warning) => warning.message).join('; '));
    }).catch((error) => active && setMessage(String(error))).finally(() => active && setState('idle'));
    return () => { active = false; };
  }, [dialog.superthreadSpaces, dialog.superthreadApiTokenEnvVar]);

  useEffect(() => {
    if (!dialog.superthreadBoardId) { setLists([]); return; }
    let active = true;
    fetchSuperthreadLists(dialog.superthreadBoardId, dialog.superthreadApiTokenEnvVar ?? 'ST_TOKEN').then((value) => active && setLists(value)).catch((error) => active && setMessage(String(error)));
    return () => { active = false; };
  }, [dialog.superthreadBoardId, dialog.superthreadApiTokenEnvVar]);

  const listLabels = useMemo(() => disambiguatedLabels(lists), [lists]);
  const incomingIds = dialog.superthreadIncomingColumns?.map((column) => column.id) ?? [];
  const option = (list: SuperthreadList) => <option key={list.id} value={list.id}>{listLabels.get(list.id)}</option>;

  async function test() {
    setState('testing'); setMessage(null);
    try {
      const result = await testSuperthreadMapping({
        spaces: dialog.superthreadSpaces ?? '', api_token_env_var: dialog.superthreadApiTokenEnvVar ?? 'ST_TOKEN', board_id: dialog.superthreadBoardId ?? '', incoming_column_ids: incomingIds,
        default_incoming_column_id: dialog.superthreadDefaultIncomingColumnId ?? '', in_progress_column_id: dialog.superthreadInProgressColumnId ?? '',
        done_column_id: dialog.superthreadDoneColumnId ?? '',
      });
      setDialog({ ...dialog, superthreadBoardName: result.board_name, superthreadIncomingColumns: result.incoming_columns,
        superthreadInProgressColumnName: result.in_progress_column_name, superthreadDoneColumnName: result.done_column_name });
      setMessage('Configuration is valid. Current board and column names were refreshed in this draft.');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setState('idle'); }
  }

  return <>
    <label>Superthread board<select value={dialog.superthreadBoardId ?? ''} onChange={(event) => {
      const board = boards.find((item) => item.id === event.target.value);
      setDialog({ ...dialog, superthreadBoardId: event.target.value, superthreadBoardName: board?.title, superthreadIncomingColumns: [], superthreadDefaultIncomingColumnId: undefined, superthreadInProgressColumnId: undefined, superthreadDoneColumnId: undefined });
    }}><option value="">Select a board…</option>{boards.map((board) => <option key={board.id} value={board.id}>{board.title} · {board.id}</option>)}</select></label>
    <label>Incoming columns <span>(one or more)</span><select multiple value={incomingIds} size={Math.min(5, Math.max(2, lists.length))} onChange={(event) => {
      const ids = [...event.currentTarget.selectedOptions].map((item) => item.value);
      setDialog({ ...dialog, superthreadIncomingColumns: ids.map((id) => ({ id, name: lists.find((list) => list.id === id)?.title ?? id })),
        superthreadDefaultIncomingColumnId: ids.includes(dialog.superthreadDefaultIncomingColumnId ?? '') ? dialog.superthreadDefaultIncomingColumnId : ids[0] });
    }}>{lists.map(option)}</select></label>
    <label>Default incoming column<select value={dialog.superthreadDefaultIncomingColumnId ?? ''} onChange={(event) => setDialog({ ...dialog, superthreadDefaultIncomingColumnId: event.target.value })}><option value="">Select…</option>{lists.filter((list) => incomingIds.includes(list.id)).map(option)}</select></label>
    <label>In progress column<select value={dialog.superthreadInProgressColumnId ?? ''} onChange={(event) => setDialog({ ...dialog, superthreadInProgressColumnId: event.target.value, superthreadInProgressColumnName: lists.find((list) => list.id === event.target.value)?.title })}><option value="">Select…</option>{lists.map(option)}</select></label>
    <label>Stacks is done column<select value={dialog.superthreadDoneColumnId ?? ''} onChange={(event) => setDialog({ ...dialog, superthreadDoneColumnId: event.target.value, superthreadDoneColumnName: lists.find((list) => list.id === event.target.value)?.title })}><option value="">Select…</option>{lists.map(option)}</select></label>
    <div className="settingsInlineAction"><button type="button" disabled={state !== 'idle'} onClick={() => void test()}>{state === 'testing' ? 'Testing…' : 'Test configuration'}</button>{message && <span role="status">{message}</span>}</div>
  </>;
}

export function disambiguatedLabels(lists: SuperthreadList[]) {
  const counts = new Map<string, number>();
  for (const list of lists) counts.set(list.title.trim().toLocaleLowerCase(), (counts.get(list.title.trim().toLocaleLowerCase()) ?? 0) + 1);
  return new Map(lists.map((list) => [list.id, (counts.get(list.title.trim().toLocaleLowerCase()) ?? 0) > 1 ? `${list.title} · ${list.id}` : list.title]));
}
