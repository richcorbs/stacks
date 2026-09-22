import { describe, expect, it } from 'vitest';
import type { DialogState } from './types';
import { canonicalProjectSettings, projectSettingsEqual } from './projectSettings';

const remote = (patch: Partial<Extract<DialogState, { kind: 'editProject' }>> = {}): Extract<DialogState, { kind: 'editProject' }> => ({
  kind: 'editProject', projectId: 'p1', name: ' Project ', path: ' /repo ', kanbanSource: 'superthread',
  superthreadSpaces: ' Product ', superthreadApiTokenEnvVar: undefined, superthreadBoardId: ' board ',
  superthreadIncomingColumns: [{ id: ' second ', name: 'Old second' }, { id: 'first', name: 'Old first' }],
  superthreadDefaultIncomingColumnId: 'first', superthreadInProgressColumnId: 'progress', superthreadDoneColumnId: 'done',
  ...patch,
});

describe('canonical project settings', () => {
  it('normalizes defaults, optional strings, whitespace, and incoming ID order', () => {
    const hydrated = remote({
      name: 'Project', path: '/repo', superthreadApiTokenEnvVar: ' ST_TOKEN ', superthreadWorkspaceSlug: '   ',
      superthreadIncomingColumns: [{ id: 'first', name: 'Canonical first' }, { id: 'second', name: 'Canonical second' }, { id: 'first', name: 'Duplicate' }],
    });
    expect(projectSettingsEqual(remote(), hydrated)).toBe(true);
    expect(canonicalProjectSettings(hydrated).superthreadIncomingColumnIds).toEqual(['first', 'second']);
  });

  it('ignores provider hydration and presentation metadata', () => {
    const hydrated = remote({
      superthreadWorkspaceId: 'workspace', superthreadWorkspaceName: 'Canonical workspace', superthreadSpaceName: 'Canonical space',
      superthreadBindingId: 'binding', superthreadBoardName: 'Canonical board',
      superthreadIncomingColumns: [{ id: 'second', name: 'Canonical second' }, { id: 'first', name: 'Canonical first' }],
      superthreadInProgressColumnName: 'Doing', superthreadDoneColumnName: 'Done', deliveryWorkflowLocked: true,
    });
    expect(projectSettingsEqual(remote(), hydrated)).toBe(true);
  });

  it('treats explicit source, scope, mapping, credential, and slug edits as meaningful', () => {
    expect(projectSettingsEqual(remote(), remote({ kanbanSource: 'local' }))).toBe(false);
    expect(projectSettingsEqual(remote(), remote({ superthreadSpaceId: 'space' }))).toBe(false);
    expect(projectSettingsEqual(remote(), remote({ superthreadDoneColumnId: 'complete' }))).toBe(false);
    expect(projectSettingsEqual(remote(), remote({ superthreadApiTokenEnvVar: 'OTHER_TOKEN' }))).toBe(false);
    expect(projectSettingsEqual(remote(), remote({ superthreadWorkspaceSlug: 'workspace-slug' }))).toBe(false);
  });
});
