import fs from 'node:fs';

const rust = fs.readFileSync(new URL('../src-tauri/src/kanban/workflow.rs', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../src/kanban/workflowContract.generated.ts', import.meta.url), 'utf8');

const statusValues = [...rust.matchAll(/^\s+\w+ => "([a-z_]+)",$/gm)].slice(0, 8).map((match) => match[1]);
const statusBlock = rust.match(/pub const STATUS_METADATA:[\s\S]*?= \[([\s\S]*?)\n\];/)?.[1] ?? '';
const statusLabels = [...statusBlock.matchAll(/status: CardStatus::\w+,\s+label: "([^"]+)"/g)].map((match) => match[1]);
const actionBlock = rust.match(/string_enum!\(WorkflowAction \{([\s\S]*?)\}\);/)?.[1] ?? '';
const actions = [...actionBlock.matchAll(/=> "([a-z_]+)"/g)].map((match) => match[1]);

const generatedStatusBlock = source.match(/KANBAN_STATUS_METADATA = \[([\s\S]*?)\] as const/)?.[1] ?? '';
const generatedStatuses = [...generatedStatusBlock.matchAll(/\{ status: '([^']+)', label: '([^']+)' \}/g)]
  .map((match) => ({ status: match[1], label: match[2] }));
const generatedActionBlock = source.match(/KANBAN_WORKFLOW_ACTIONS = \[([\s\S]*?)\] as const/)?.[1] ?? '';
const generatedActions = [...generatedActionBlock.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
const expectedStatuses = statusValues.map((status, index) => ({ status, label: statusLabels[index] }));

if (statusValues.length !== 8 || statusLabels.length !== statusValues.length || actions.length === 0) {
  throw new Error('Could not parse the authoritative Rust Kanban workflow contract');
}
if (JSON.stringify(generatedStatuses) !== JSON.stringify(expectedStatuses) || JSON.stringify(generatedActions) !== JSON.stringify(actions)) {
  throw new Error('Stale Kanban frontend contract: ordered statuses, labels, or actions differ from Rust');
}
console.log('Kanban frontend contract matches Rust workflow domain.');
