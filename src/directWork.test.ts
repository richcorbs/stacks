import { describe, expect, it } from 'vitest';
import { directWorkInitialLayout, directWorkTabs, workAgentId, workOwnerId, workTerminalId } from './directWork';
import type { Project } from './types';

const project: Project = { id: 'one', name: 'One', path: '/one', workspaces: [], server_command: 'npm run dev', console_command: 'bin/console' };

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
    expect(directWorkTabs(project, true)).toEqual(['agent', 'diff', 'terminal', 'server', 'console']);
    expect(directWorkTabs({ ...project, server_command: '', console_command: undefined }, false)).toEqual(['agent', 'terminal']);
  });
});
