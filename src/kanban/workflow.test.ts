import { describe, expect, it } from 'vitest';
import { adjacentKanbanStatus, isManagedSuperthreadList, reorderKanbanCardIds } from './workflow';

describe('Kanban workflow', () => {
  it('imports execution columns from every board', () => {
    expect(isManagedSuperthreadList('Roadmap', 'Doing')).toBe(true);
    expect(isManagedSuperthreadList('Other board', ' in REVIEW ')).toBe(true);
    expect(isManagedSuperthreadList('Dev - Active', 'QA')).toBe(true);
    expect(isManagedSuperthreadList('Roadmap', 'Done')).toBe(false);
    expect(isManagedSuperthreadList('OBSOLETE - Product Roadmap - Active', 'Doing')).toBe(false);
  });

  it('only imports Backlog and To Do from Dev - Active', () => {
    expect(isManagedSuperthreadList('Dev - Active', 'Backlog')).toBe(true);
    expect(isManagedSuperthreadList(' dev - ACTIVE ', 'To Do')).toBe(true);
    expect(isManagedSuperthreadList('Roadmap', 'Backlog')).toBe(false);
    expect(isManagedSuperthreadList('Other board', 'To Do')).toBe(false);
  });

  it('moves through the local workflow in order', () => {
    expect(adjacentKanbanStatus('needs_refinement', 1)).toBe('ready');
    expect(adjacentKanbanStatus('needs_human', -1)).toBe('agent_working');
    expect(adjacentKanbanStatus('merged', 1)).toBeNull();
  });

  it('reorders cards without changing their column membership', () => {
    expect(reorderKanbanCardIds(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(reorderKanbanCardIds(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a']);
  });
});
