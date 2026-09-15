import type React from 'react';
import type { DialogState } from '../types';

type DialogFieldsProps = {
  dialog: DialogState;
  setDialog: React.Dispatch<React.SetStateAction<DialogState | null>>;
  firstInputRef: React.MutableRefObject<HTMLInputElement | null>;
};

export function DialogFields({ dialog, setDialog, firstInputRef }: DialogFieldsProps) {
  return <>
    <h2>{dialog.kind === 'project' ? 'Add Project' : 'Edit Project'}</h2>
    <label>Name<input ref={firstInputRef} value={dialog.name} onChange={(event) => setDialog({ ...dialog, name: event.target.value })} /></label>
    <label>Directory<input value={dialog.path} placeholder="/Users/rich/Code/my-project" onChange={(event) => setDialog({ ...dialog, path: event.target.value })} /></label>
    <label>Work board<select value={dialog.kanbanSource ?? 'local'} onChange={(event) => setDialog({ ...dialog, kanbanSource: event.target.value as 'superthread' | 'local' })}><option value="local">Local Stacks board</option><option value="superthread">Superthread</option></select></label>
    {dialog.kanbanSource === 'superthread' && <>
      <label>Superthread spaces <span>(comma-separated)</span><input value={dialog.superthreadSpaces ?? ''} placeholder="Product & Engineering" required onChange={(event) => setDialog({ ...dialog, superthreadSpaces: event.target.value })} /></label>
      <label>Superthread URL slug <span>(optional)</span><input value={dialog.superthreadWorkspaceSlug ?? ''} placeholder="arcasa" onChange={(event) => setDialog({ ...dialog, superthreadWorkspaceSlug: event.target.value })} /></label>
    </>}
    <label>Delivery workflow<select value={dialog.deliveryWorkflow ?? 'local_merge'} onChange={(event) => setDialog({ ...dialog, deliveryWorkflow: event.target.value as 'local_merge' | 'github_pull_request' })}><option value="local_merge">Local merge</option><option value="github_pull_request">GitHub pull request</option></select></label>
    <label>Target branch<input value={dialog.targetBranch ?? 'main'} required onChange={(event) => setDialog({ ...dialog, targetBranch: event.target.value })} /></label>
    {(dialog.deliveryWorkflow ?? 'local_merge') === 'github_pull_request' && <>
      <label className="checkboxLabel"><input type="checkbox" checked={dialog.supportsFeatureEnvironments ?? false} onChange={(event) => setDialog({ ...dialog, supportsFeatureEnvironments: event.target.checked })} />Supports feature environments</label>
      <label>Merge strategy<select value={dialog.githubMergeStrategy ?? 'merge'} onChange={(event) => setDialog({ ...dialog, githubMergeStrategy: event.target.value as 'merge' | 'squash' | 'rebase' })}><option value="merge">Merge commit</option><option value="squash">Squash</option><option value="rebase">Rebase</option></select></label>
      <label className="checkboxLabel"><input type="checkbox" checked={dialog.requirePassingCi ?? true} onChange={(event) => setDialog({ ...dialog, requirePassingCi: event.target.checked })} />Require passing CI</label>
      <label className="checkboxLabel"><input type="checkbox" checked={dialog.requireApproval ?? false} onChange={(event) => setDialog({ ...dialog, requireApproval: event.target.checked })} />Require approval</label>
    </>}
    <label>Start work command <span>(optional)</span><input value={dialog.startWorkCommand ?? ''} placeholder={dialog.kanbanSource === 'superthread' ? 'stwork {card_number}' : 'Uses built-in Git worktree setup'} onChange={(event) => setDialog({ ...dialog, startWorkCommand: event.target.value })} /></label>
    <label>Server command <span>(optional)</span><input value={dialog.serverCommand ?? ''} placeholder="bin/dev" onChange={(event) => setDialog({ ...dialog, serverCommand: event.target.value })} /></label>
    <label>Console command <span>(optional)</span><input value={dialog.consoleCommand ?? ''} placeholder="bin/rails console" onChange={(event) => setDialog({ ...dialog, consoleCommand: event.target.value })} /></label>
  </>;
}

export function dialogSubmitLabel(kind: DialogState['kind']) { return kind === 'project' ? 'Add Project' : 'Save'; }
