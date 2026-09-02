import type { Store } from '../types';
import type { CreateWorkspaceInput } from '../workspace/createWorkspace';

export function buildSuperthreadWorkspaceInput(
  store: Store,
  projectId: string,
  cardNumber: string,
  cardTitle: string,
  templates: { command: string; workspaceName: string },
): CreateWorkspaceInput {
  if (!/^\d+$/.test(cardNumber)) throw new Error('Invalid card number');
  const project = store.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error('Selected project not found');
  const normalizedTitle = cardTitle.replace(/\s+/g, ' ').trim();
  if (!normalizedTitle) throw new Error('Card title cannot be empty');
  const name = renderTemplate(templates.workspaceName, cardNumber, normalizedTitle)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  const command = renderTemplate(templates.command, cardNumber, shellEscape(normalizedTitle)).trim();
  if (!name) throw new Error('Workspace naming template produced an empty name');
  if (!command) throw new Error('Start-work command cannot be empty');
  return {
    projectId: project.id,
    name,
    oneTimeStartupCommand: command,
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
