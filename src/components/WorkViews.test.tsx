import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { WorkAgentView } from './WorkAgentView';
import { CardChatView } from './kanban/CardChatView';
import { PiGuiView } from './PiGuiView';
import type { KanbanCard } from '../kanban/types';
import { workAgentId, workOwnerId, type WorkOwner } from '../directWork';

vi.mock('./PiGuiView', () => ({ PiGuiView: () => null }));
const project = { id: 'p', name: 'Project', path: '/repo', workspaces: [] };
const card = { id: 'c', external_id: '297' } as KanbanCard;

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
});

it('keeps the card planning agent in the project path and switches identity for work', async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  const render = (thread: 'planning' | 'work') => <CardChatView card={card} project={project} cardPath="/worktree" thread={thread} active deploymentOutput="" />;
  await act(async () => { renderer = TestRenderer.create(render('planning')); });
  expect(renderer.root.findByType(PiGuiView).props.workspace.cwd).toBe('/repo');
  expect(renderer.root.findByType(PiGuiView).props.composerDraftKey).toBe(workAgentId({ kind: 'card', cardId: 'c' }, 'planning'));
  expect(renderer.root.findByType(PiGuiView).props.terminal.id).toBe(workAgentId({ kind: 'card', cardId: 'c' }, 'planning'));
  await act(async () => { renderer.update(render('work')); });
  expect(renderer.root.findByType(PiGuiView).props.workspace.cwd).toBe('/worktree');
  expect(renderer.root.findByType(PiGuiView).props.composerDraftKey).toBe(workAgentId({ kind: 'card', cardId: 'c' }, 'work'));
  expect(renderer.root.findByType(PiGuiView).props.terminal.id).toBe(workAgentId({ kind: 'card', cardId: 'c' }, 'work'));
  act(() => renderer.unmount());
});
