import { invoke } from '@tauri-apps/api/core';

export type RepositoryAccess = 'read' | 'exclusive';
export type ReleaseStageConfig = { id: string; name: string; run: string; verify?: string | null; repositoryAccess: RepositoryAccess; approval?: { instructions?: string | null } | null };
export type ReleaseConfig = { currentVersion: string; suggestedVersion?: string | null; validateVersion?: string | null; generateNotes?: string | null; preflight?: string | null; stages: ReleaseStageConfig[] };
export type ReleaseDraft = { valid: boolean; error: string | null; configPath: string; currentVersion: string | null; suggestedVersion: string | null; generatedNotes: string | null; targetBranch: string; sourceRevision: string | null; config: ReleaseConfig | null };
export type ReleaseStageState = { id: string; name: string; status: 'pending' | 'running' | 'awaitingApproval' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; attempt: number; attemptToken: string | null; startedAt: number | null; completedAt: number | null; error: string | null; logPath: string | null; log: string; truncated: boolean };
export type ReleaseOperation = { id: string; projectId: string; projectPath: string; repositoryIdentity: string; configPath: string; config: ReleaseConfig; previousVersion: string; version: string; notes: string; targetBranch: string; initialRevision: string; expectedRevision: string; status: string; stages: ReleaseStageState[]; createdAt: number; updatedAt: number; completedAt: number | null; revision: number };

export const inspectRelease = (projectId: string) => invoke<ReleaseDraft>('release_inspect', { projectId });
export const releaseHistory = (projectId: string) => invoke<ReleaseOperation[]>('release_history', { projectId });
export const startRelease = (projectId: string, version: string, notes: string) => invoke<ReleaseOperation>('release_start', { projectId, version, notes });
export const cancelRelease = (operationId: string) => invoke<ReleaseOperation>('release_cancel', { operationId });
export const retryRelease = (operationId: string) => invoke<ReleaseOperation>('release_retry', { operationId });
export const approveRelease = (operationId: string) => invoke<ReleaseOperation>('release_approve', { operationId });
export const abandonRelease = (operationId: string) => invoke<ReleaseOperation>('release_abandon', { operationId });
