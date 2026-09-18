import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ProjectNotesView } from './ProjectNotesView';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => new Promise(() => {})),
}));

describe('ProjectNotesView', () => {
  it('renders a raw multiline project scratch pad and stable inline status area', () => {
    const markup = renderToStaticMarkup(<ProjectNotesView projectId="one" active />);
    expect(markup).toContain('class="projectNotesView cardView active"');
    expect(markup).toContain('<textarea');
    expect(markup).toContain('aria-label="Project notes scratch pad"');
    expect(markup).toContain('class="projectNotesStatus loading"');
    expect(markup).toContain('Loading…');
  });
});
