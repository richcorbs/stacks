import { invoke } from '@tauri-apps/api/core';

export type RepositoryAccess = 'read' | 'exclusive';
export type ReleaseStageConfig = { id: string; name: string; run: string; verify?: string | null; repositoryAccess: RepositoryAccess; approval?: { instructions?: string | null } | null };
export type ReleaseConfig = { currentVersion: string; suggestedVersion?: string | null; validateVersion?: string | null; generateNotes?: string | null; preflight?: string | null; reconciliation?: { protocolVersion: number; command: string } | null; stages: ReleaseStageConfig[] };
export type ReleaseIdentity = { id: unknown; tag: string; revision: string | null; title: string; notes: string; target: string; draft: boolean; prerelease: boolean; url: string | null };
export type ReleaseReconciliation = { protocolVersion: number; disposition: 'available' | 'resumablePrepared' | 'resumableDraft' | 'published' | 'conflict' | 'recoveryRequired'; requestedVersion: string; latestPublishedVersion: string | null; sourceRevision: string | null; headRevision: string | null; preparedRevision: string | null; preparedParent: string | null; approvedPaths: string[]; localTagRevision: string | null; remoteTagRevision: string | null; release: ReleaseIdentity | null; expectedAssets: string[]; existingAssets: Array<{ name: string; size?: number; digest?: string | null }>; missingAssets: string[]; extraAssets: string[]; conflictingAssets: string[]; artifact: unknown; identity: unknown; issues: string[]; permittedActions: string[]; provenStages: string[] };
export type ReleaseDraft = { valid: boolean; error: string | null; configPath: string; currentVersion: string | null; suggestedVersion: string | null; generatedNotes: string | null; targetBranch: string; sourceRevision: string | null; config: ReleaseConfig | null; reconciliation: ReleaseReconciliation | null };
export type ReleasePreviewRefresh = { notes: string; reconciliation: ReleaseReconciliation };
export type ReleaseStageState = { id: string; name: string; status: 'pending' | 'running' | 'awaitingApproval' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; attempt: number; attemptToken: string | null; startedAt: number | null; completedAt: number | null; error: string | null; logPath: string | null; log: string; truncated: boolean };
export type ReleaseOperation = { id: string; projectId: string; projectPath: string; repositoryIdentity: string; configPath: string; config: ReleaseConfig; previousVersion: string; version: string; notes: string; targetBranch: string; initialRevision: string; expectedRevision: string; preparedRevision: string | null; preparedParent: string | null; approvedPaths: string[]; reconciliation: ReleaseReconciliation | null; identityFingerprint: string; artifactEvidence: unknown; releaseUrl: string | null; adopted: boolean; status: string; stages: ReleaseStageState[]; createdAt: number; updatedAt: number; completedAt: number | null; revision: number };

export const inspectRelease = (projectId: string) => invoke<ReleaseDraft>('release_inspect', { projectId });
export const reconcileReleasePreview = (projectId: string, version: string, notes: string) => invoke<ReleasePreviewRefresh>('release_reconcile_preview', { projectId, version, notes });
export const releaseHistory = (projectId: string) => invoke<ReleaseOperation[]>('release_history', { projectId });
export const startRelease = (projectId: string, version: string, notes: string) => invoke<ReleaseOperation>('release_start', { projectId, version, notes });
export const cancelRelease = (operationId: string) => invoke<ReleaseOperation>('release_cancel', { operationId });
export const retryRelease = (operationId: string) => invoke<ReleaseOperation>('release_retry', { operationId });
export const approveRelease = (operationId: string) => invoke<ReleaseOperation>('release_approve', { operationId });
export const refreshRelease = (operationId: string) => invoke<ReleaseOperation>('release_refresh', { operationId });
export const recoverPreparedRelease = (operationId: string) => invoke<ReleaseOperation>('release_recover_prepared', { operationId });
export const abandonRelease = (operationId: string) => invoke<ReleaseOperation>('release_abandon', { operationId });
