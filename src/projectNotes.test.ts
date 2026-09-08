import { describe, expect, it } from 'vitest';
import { updateProjectNotes } from './projectNotes';
import type { Store } from './types';

const store: Store = {
  projects: [
    { id: 'one', name: 'One', path: '/one', notes: 'Old', workspaces: [] },
    { id: 'two', name: 'Two', path: '/two', notes: 'Keep', workspaces: [] },
  ],
};

describe('updateProjectNotes', () => {
  it('updates only the selected project notes', () => {
    const next = updateProjectNotes(store, 'one', 'Scratch pad');
    expect(next.projects.map((project) => project.notes)).toEqual(['Scratch pad', 'Keep']);
    expect(store.projects[0].notes).toBe('Old');
  });
});
