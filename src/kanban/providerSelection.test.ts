import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import { selectedKanbanProject } from './providerSelection';

const local = project('local');
const remote = project('remote');

describe('Kanban project filter selection', () => {
  it('returns the explicitly filtered project', () => {
    expect(selectedKanbanProject([remote, local], local.id)).toBe(local);
  });

  it('represents All projects and stale filters as no selected project', () => {
    expect(selectedKanbanProject([local, remote], null)).toBeNull();
    expect(selectedKanbanProject([local, remote], 'removed')).toBeNull();
  });

  it('does not guess a project', () => {
    expect(selectedKanbanProject([], null)).toBeNull();
  });
});

function project(id: string): Project {
  return { id, name: id, path: `/tmp/${id}`, workspaces: [], kanban_source: 'local' };
}
