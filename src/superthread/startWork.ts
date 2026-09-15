import type { Store } from '../types';

type CreateWorkspaceInput = { projectId: string; name: string; setupCommand?: string; firstPaneKind: 'terminal' | 'pi' };

export function buildLocalWorkspaceInput(store: Store, projectId: string, cardNumber: string, cardTitle: string): CreateWorkspaceInput {
  if (!/^\d+$/.test(cardNumber)) throw new Error('Invalid card number');
  const project = store.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error('Selected project not found');
  const normalizedTitle = cardTitle.replace(/\s+/g, ' ').trim();
  const slug = normalizedTitle.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'work';
  const branch = `stacks/card-${cardNumber}-${slug}`;
  const worktree = `${project.path.replace(/\/$/, '')}-card-${cardNumber}`;
  const builtInCommand = `git worktree add -b ${shellEscape(branch)} ${shellEscape(worktree)} && cd ${shellEscape(worktree)}`;
  const setupCommand = project.start_work_command?.trim()
    ? renderTemplate(project.start_work_command, cardNumber, shellEscape(normalizedTitle))
        .replaceAll('{branch}', shellEscape(branch))
        .replaceAll('{worktree}', shellEscape(worktree))
    : builtInCommand;
  return { projectId, name: `${cardNumber} ${normalizedTitle}`.slice(0, 160), setupCommand, firstPaneKind: 'pi' };
}

export function buildSuperthreadWorkspaceInput(
  store: Store,
  projectId: string,
  cardNumber: string,
  cardTitle: string,
  commandTemplate: string,
): CreateWorkspaceInput {
  if (!/^\d+$/.test(cardNumber)) throw new Error('Invalid card number');
  const project = store.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error('Selected project not found');
  const normalizedTitle = cardTitle.replace(/\s+/g, ' ').trim();
  if (!normalizedTitle) throw new Error('Card title cannot be empty');
  const command = renderTemplate(commandTemplate, cardNumber, shellEscape(normalizedTitle)).trim();
  if (!command) throw new Error('Start-work command cannot be empty');
  return {
    projectId: project.id,
    name: `${cardNumber} ${normalizedTitle}`.slice(0, 160),
    setupCommand: command,
    firstPaneKind: 'pi',
  };
}

function renderTemplate(template: string, cardNumber: string, cardTitle: string) {
  return template
    .replaceAll('{card_number}', cardNumber)
    .replaceAll('{card_title}', cardTitle);
}

function shellEscape(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
