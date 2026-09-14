import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import { selectedKanbanProject, shouldEnableSuperthreadProvider, visibleSuperthreadError } from './providerSelection';

const local = project('local', 'local');
const superthread = project('remote', 'superthread');

describe('Kanban provider selection', () => {
  it('disables Superthread access for a selected local project', () => {
    const selected = selectedKanbanProject([superthread, local], local.id);

    expect(selected).toBe(local);
    expect(shouldEnableSuperthreadProvider(selected, true)).toBe(false);
  });

  it('enables Superthread access immediately for a selected Superthread project', () => {
    const selected = selectedKanbanProject([local, superthread], superthread.id);

    expect(selected).toBe(superthread);
    expect(shouldEnableSuperthreadProvider(selected, true)).toBe(true);
  });

  it('keeps the provider disabled when the integration is disabled', () => {
    expect(shouldEnableSuperthreadProvider(superthread, false)).toBe(false);
  });

  it('only exposes synchronization errors on Superthread projects', () => {
    expect(visibleSuperthreadError(superthread, 'Sync failed')).toBe('Sync failed');
    expect(visibleSuperthreadError(local, 'Sync failed')).toBeNull();
  });
});

function project(id: string, source: 'local' | 'superthread'): Project {
  return { id, name: id, path: `/tmp/${id}`, workspaces: [], kanban_source: source };
}
