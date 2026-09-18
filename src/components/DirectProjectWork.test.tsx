import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PROJECT_WORKSPACE_AGENT_LABEL, PROJECT_WORKSPACE_VIEWS_LABEL, ProjectWorkspaceHeader } from './ProjectWorkspaceChrome';
import { DirectWorkGitMetadata } from './DirectWorkGitMetadata';

function classIndex(markup: string, className: string) {
  return markup.indexOf(`class="${className}`);
}

describe('Project Workspace presentation', () => {
  it('identifies the opened view and its close and view accessibility labels', () => {
    const markup = renderToStaticMarkup(<ProjectWorkspaceHeader
      project={{ id: 'one', name: 'One', path: '/one', workspaces: [] }}
      gitState={{ kind: 'not-git' }}
      onClose={() => {}}
    />);

    expect(markup).toContain('<span>Project Workspace</span>');
    expect(markup).toContain('aria-label="Close Project Workspace"');
    expect(PROJECT_WORKSPACE_VIEWS_LABEL).toBe('Project Workspace views');
    expect(PROJECT_WORKSPACE_AGENT_LABEL).toBe('Project Workspace Agent');
  });
});

describe('DirectWorkGitMetadata', () => {
  it('renders the shared branch presentation, separator, and all Git counts in order', () => {
    const markup = renderToStaticMarkup(<DirectWorkGitMetadata gitState={{
      kind: 'git',
      info: { branch: 'feature/a-very-long-direct-work-branch-name', created: 2, changed: 3, deleted: 4 },
    }} />);

    expect(markup).toContain('class="kanbanDetailRepositoryMeta"');
    expect(markup).toContain('<svg class="kanbanCardHeaderBranchSymbol"');
    expect(markup).toContain('class="kanbanCardHeaderBranchName">feature/a-very-long-direct-work-branch-name</span>');
    expect(markup).toContain('class="kanbanDetailRepositorySeparator" aria-hidden="true">•</span>');
    expect(classIndex(markup, 'kanbanCardHeaderBranch')).toBeLessThan(classIndex(markup, 'kanbanDetailRepositorySeparator'));
    expect(classIndex(markup, 'kanbanDetailRepositorySeparator')).toBeLessThan(classIndex(markup, 'directWorkGitSummary'));
    expect(markup).toContain('class="gitAdded">+2</span>');
    expect(markup).toContain('class="gitChanged">~3</span>');
    expect(markup).toContain('class="gitRemoved">-4</span>');
    expect(markup).not.toContain('');
  });

  it('keeps all zero counts visible for a clean repository', () => {
    const markup = renderToStaticMarkup(<DirectWorkGitMetadata gitState={{
      kind: 'git',
      info: { branch: 'main', created: 0, changed: 0, deleted: 0 },
    }} />);

    expect(markup).toContain('class="gitAdded">+0</span>');
    expect(markup).toContain('class="gitChanged">~0</span>');
    expect(markup).toContain('class="gitRemoved">-0</span>');
  });

  it.each([
    ['loading', null, 'Checking Git status…'],
    ['non-Git', { kind: 'not-git' as const }, 'Not a Git repository'],
    ['error', { kind: 'error' as const, message: 'command failed' }, 'Git status unavailable'],
  ])('renders the %s fallback without repository separators', (_label, gitState, expected) => {
    const markup = renderToStaticMarkup(<DirectWorkGitMetadata gitState={gitState} />);

    expect(markup).toContain(expected);
    expect(markup).not.toContain('kanbanDetailRepositorySeparator');
    expect(markup).not.toContain('kanbanCardHeaderBranch');
    expect(markup).not.toContain('directWorkGitSummary');
  });
});
