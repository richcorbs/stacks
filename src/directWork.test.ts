import { describe, expect, it } from 'vitest';
import { directWorkInitialLayout, directWorkTabs, displayedDirectWorkTabs, workAgentId, workOwnerId, workTerminalId } from './directWork';
import type { Project } from './types';

const project: Project = { id: 'one', name: 'One', path: '/one', workspaces: [] };

describe('Direct project work identity and tabs', () => {
  it('uses a stable project namespace isolated from cards and other projects', () => {
    const owner = { kind: 'project' as const, projectId: 'one' };
    expect(workOwnerId(owner)).toBe('project-direct:one');
    expect(workAgentId(owner)).toBe('project-direct:one:agent');
    expect(workTerminalId(owner, 'shell')).toBe('project-direct:one:terminal:shell');
    expect(workTerminalId({ kind: 'project', projectId: 'two' }, 'shell')).not.toBe(workTerminalId(owner, 'shell'));
    expect(workAgentId({ kind: 'card', cardId: 'local:1' })).toBe('kanban-card:local:1:work');
    expect(directWorkInitialLayout('one')).toEqual({ kind: 'leaf', terminalId: 'project-direct:one:terminal:shell' });
  });

  it('orders only the views available to the project', () => {
    expect(directWorkTabs(project, true)).toEqual(['agent', 'notes', 'diff', 'terminal']);
    expect(directWorkTabs(project, false)).toEqual(['agent', 'notes', 'terminal']);
    expect(directWorkTabs({ ...project, releases_enabled: true }, true)).toEqual(['agent', 'notes', 'diff', 'terminal', 'release']);
    expect(displayedDirectWorkTabs({ ...project, releases_enabled: true })).toEqual(['agent', 'notes', 'diff', 'terminal', 'release']);
    expect(displayedDirectWorkTabs(project)).toEqual(['agent', 'notes', 'diff', 'terminal']);
  });
});
