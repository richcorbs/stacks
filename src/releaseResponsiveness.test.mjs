import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const board = readFileSync(new URL('./components/kanban/KanbanBoardView.tsx', import.meta.url), 'utf8');
const tab = readFileSync(new URL('./components/ReleaseTab.tsx', import.meta.url), 'utf8');
const backend = readFileSync(new URL('../src-tauri/src/release.rs', import.meta.url), 'utf8');

describe('release UI responsiveness', () => {
  it('opens the release project picker without inspecting each project first', () => {
    expect(board).toMatch(/setProjectPickerPurpose\('release'\); setProjectSwitcherOpen\(true\);/);
    expect(board).toMatch(/projects=\{projectPickerPurpose === 'release' \? projects\.filter\(\(project\) => project\.releases_enabled\) : projects\}/);
    expect(board).not.toContain('Promise.all(projects.filter((candidate) => candidate.releases_enabled)');
  });

  it('runs all release IPC commands off the UI event loop', () => {
    const commands = [...backend.matchAll(/#\[tauri::command(?:\(async\))?\]\s*pub fn (release_\w+)/g)];
    expect(commands).toHaveLength(10);
    for (const [declaration] of commands) expect(declaration).toContain('#[tauri::command(async)]');
  });

  it('shows loading and pending-action feedback while provider calls run', () => {
    expect(tab).toContain('Loading release configuration, repository state, and provider status…');
    expect(tab).toContain('{busyLabel && <p className="releaseProgress" role="status">');
    expect(tab).toContain('Retry loading');
  });
});
