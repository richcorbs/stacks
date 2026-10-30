import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { WorkAgentView } from './WorkAgentView';
import { WorkServiceTerminal } from './WorkServiceTerminal';
import { CardChatView } from './kanban/CardChatView';
import { CardServiceTerminal } from './kanban/CardServiceTerminal';
import { PiGuiView } from './PiGuiView';
import { TerminalView } from './TerminalView';
import type { KanbanCard } from '../kanban/types';
import { workAgentId, workOwnerId, workTerminalId, type WorkOwner } from '../directWork';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock('./PiGuiView', () => ({ PiGuiView: () => null }));
vi.mock('./TerminalView', () => ({ TerminalView: () => null }));
const project = { id: 'p', name: 'Project', path: '/repo', workspaces: [] };
const card = { id: 'c', external_id: '297' } as KanbanCard;
const appearance = { terminalFontSize: 14, terminalFontFamily: 'monospace', terminalScrollback: 1000, copyOnSelect: true };

describe.each(['project', 'card'] as const)('%s workspace shared views', (kind) => {
  const owner: WorkOwner = kind === 'project' ? { kind, projectId: 'p' } : { kind, cardId: 'c' };
  const cwd = kind === 'project' ? '/repo' : '/worktree';
  const workspace = { id: workOwnerId(owner), name: kind, cwd };
  it('keeps agent identity and visibility stable across tab changes and remounts', async () => {
    const render = (active: boolean) => kind === 'card'
      ? <CardChatView card={card} project={project} cardPath={cwd} thread="work" active={active} deploymentOutput="output" />
      : <WorkAgentView terminal={{ id: workAgentId(owner), workspaceId: workspace.id, kind: 'pi', cwd }} workspace={workspace} project={project} active={active} label="Project Workspace agent" openingMessage="Opening Agent…" />;
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(render(true)); });
    const agent = () => renderer.root.findByType(PiGuiView);
    const instance = agent();
    expect(agent().props.terminal.id).toBe(workAgentId(owner));
    expect(agent().props.workspace.cwd).toBe(cwd);
    await act(async () => { renderer.update(render(false)); });
    expect(agent()).toBe(instance);
    expect(agent().props.visible).toBe(false);
    await act(async () => { renderer.update(render(true)); });
    expect(agent()).toBe(instance);
    act(() => renderer.unmount());
    await act(async () => { renderer = TestRenderer.create(render(true)); });
    expect(agent().props.terminal.id).toBe(workAgentId(owner));
    act(() => renderer.unmount());
  });

  it('preserves managed-service identity, input encoding, and restart state without view-owned cleanup', async () => {
    vi.mocked(invoke).mockClear();
    const render = (active: boolean, enabled = true) => kind === 'card'
      ? <CardServiceTerminal {...appearance} card={card} project={project} cardPath={cwd} mode="server" command="npm start" enabled={enabled} active={active} background={!active} restartRequestNonce={4} />
      : <WorkServiceTerminal {...appearance} workspace={workspace} terminalId={workTerminalId(owner, 'server')} project={project} mode="server" command="npm start" enabled={enabled} active={active} restartRequestNonce={4} />;
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(render(true)); });
    const terminal = () => renderer.root.findByType(TerminalView);
    const instance = terminal();
    expect(terminal().props.terminal).toEqual({ id: workTerminalId(owner, 'server'), workspaceId: workspace.id, cwd, command: 'npm start', temporary: true });
    expect(terminal().props.managedService).toBe(true);
    expect(terminal().props.restartRequestNonce).toBe(4);
    await act(async () => { terminal().props.onInput(workTerminalId(owner, 'server'), 'é\r'); });
    expect(invoke).toHaveBeenCalledWith('write_pty', { terminalId: workTerminalId(owner, 'server'), data: [195, 169, 13] });
    await act(async () => { renderer.update(render(false)); });
    expect(terminal()).toBe(instance);
    expect(terminal().props.visible).toBe(false);
    act(() => renderer.unmount());
    await act(async () => { renderer = TestRenderer.create(render(true)); });
    expect(terminal().props.terminal.id).toBe(workTerminalId(owner, 'server'));
    await act(async () => { renderer.update(render(true, false)); });
    expect(renderer.root.findAllByType(TerminalView)).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalledWith('kill_pty', expect.anything());
    act(() => renderer.unmount());
  });
});

it('keeps the card planning agent in the project path and switches identity for work', async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  const render = (thread: 'planning' | 'work') => <CardChatView card={card} project={project} cardPath="/worktree" thread={thread} active deploymentOutput="" />;
  await act(async () => { renderer = TestRenderer.create(render('planning')); });
  expect(renderer.root.findByType(PiGuiView).props.workspace.cwd).toBe('/repo');
  expect(renderer.root.findByType(PiGuiView).props.terminal.id).toBe(workAgentId({ kind: 'card', cardId: 'c' }, 'planning'));
  await act(async () => { renderer.update(render('work')); });
  expect(renderer.root.findByType(PiGuiView).props.workspace.cwd).toBe('/worktree');
  expect(renderer.root.findByType(PiGuiView).props.terminal.id).toBe(workAgentId({ kind: 'card', cardId: 'c' }, 'work'));
  act(() => renderer.unmount());
});
