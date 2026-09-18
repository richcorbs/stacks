import type { WorkOwner, WorkView } from './directWork';

export type AgentThread = 'planning' | 'work';
export type AttentionKind = 'pi-complete' | 'pi-request' | 'process-exit';
export type AttentionTarget =
  | { view: 'agent'; agentThread?: AgentThread; terminalId: string }
  | { view: 'terminal' | 'server' | 'console'; terminalId: string };

export type AppAttention = {
  kind: AttentionKind;
  owner: WorkOwner;
  target: AttentionTarget;
  lifecycleKey: string;
};

export type WorkPresence = {
  owner: WorkOwner;
  view: WorkView;
  agentThread?: AgentThread;
  terminalId?: string;
};

export type NotificationRoute = {
  ownerKind: WorkOwner['kind'];
  cardId?: string;
  projectId?: string;
  targetView: AttentionTarget['view'];
  agentThread?: AgentThread;
  terminalId?: string;
};

let visiblePresence: WorkPresence | null = null;

export function parseWorkOwnerId(workspaceId: string): WorkOwner | null {
  if (workspaceId.startsWith('kanban-card:')) return { kind: 'card', cardId: workspaceId.slice('kanban-card:'.length) };
  if (workspaceId.startsWith('project-direct:')) return { kind: 'project', projectId: workspaceId.slice('project-direct:'.length) };
  return null;
}

export function publishWorkPresence(presence: WorkPresence | null) {
  visiblePresence = presence;
}

export function getVisibleWorkPresence() {
  return visiblePresence;
}

export function isAttentionVisible(attention: AppAttention, presence: WorkPresence | null) {
  if (!presence || presence.owner.kind !== attention.owner.kind) return false;
  if (attention.owner.kind === 'card' && (presence.owner.kind !== 'card' || presence.owner.cardId !== attention.owner.cardId)) return false;
  if (attention.owner.kind === 'project' && (presence.owner.kind !== 'project' || presence.owner.projectId !== attention.owner.projectId)) return false;
  if (attention.target.view === 'agent') {
    return presence.view === 'agent' && presence.agentThread === attention.target.agentThread && presence.terminalId === attention.target.terminalId;
  }
  return presence.view === attention.target.view && presence.terminalId === attention.target.terminalId;
}

export function attentionRoute(attention: AppAttention): NotificationRoute {
  return {
    ownerKind: attention.owner.kind,
    ...(attention.owner.kind === 'card' ? { cardId: attention.owner.cardId } : { projectId: attention.owner.projectId }),
    targetView: attention.target.view,
    agentThread: attention.target.view === 'agent' ? attention.target.agentThread : undefined,
    terminalId: attention.target.terminalId,
  };
}

export function routeFromExtra(extra: Record<string, unknown> | undefined): NotificationRoute | null {
  if (!extra || (extra.ownerKind !== 'card' && extra.ownerKind !== 'project')) return null;
  if (!['agent', 'terminal', 'server', 'console'].includes(String(extra.targetView))) return null;
  if (extra.ownerKind === 'card' && typeof extra.cardId !== 'string') return null;
  if (extra.ownerKind === 'project' && typeof extra.projectId !== 'string') return null;
  return {
    ownerKind: extra.ownerKind,
    cardId: typeof extra.cardId === 'string' ? extra.cardId : undefined,
    projectId: typeof extra.projectId === 'string' ? extra.projectId : undefined,
    targetView: extra.targetView as NotificationRoute['targetView'],
    agentThread: extra.agentThread === 'planning' || extra.agentThread === 'work' ? extra.agentThread : undefined,
    terminalId: typeof extra.terminalId === 'string' ? extra.terminalId : undefined,
  };
}

export function dispatchAppAttention(attention: AppAttention, dispatch: (event: Event) => boolean = (event) => window.dispatchEvent(event)) {
  dispatch(new CustomEvent<AppAttention>('app-attention', { detail: attention }));
}
