#!/usr/bin/env node
// Create a throwaway copy of the real Stacks database with synthetic backlog
// cards, for card #322 LIST startup/virtualization measurements.
//
// Usage:
//   node scripts/seed-gpui-list-fixture.mjs [--cards 2000] [--out /tmp/list.sqlite3]
//
// The copy is made from the shipped database with SQLite's `.backup`, so the
// live WAL is not touched. This never mutates the real workflow.sqlite3.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const source = path.resolve(
  flag(
    '--source',
    path.join(os.homedir(), 'Library/Application Support/stacks/workflow.sqlite3'),
  ).replace(/^~/, os.homedir()),
);
if (!fs.existsSync(source)) throw new Error(`missing Stacks database: ${source}`);
const count = Number(flag('--cards', '2000'));
if (!Number.isInteger(count) || count < 1) throw new Error('--cards must be a positive integer');
const out = path.resolve(
  flag('--out', path.join(os.tmpdir(), `stacks-gpui-list-${count}.sqlite3`)),
);
if (fs.existsSync(out)) fs.rmSync(out);
for (const suffix of ['-wal', '-shm']) fs.rmSync(`${out}${suffix}`, { force: true });

execFileSync('sqlite3', [source], {
  input: `.backup '${out.replaceAll("'", "''")}'\n`,
});

const projectId =
  execFileSync('sqlite3', [
    out,
    "SELECT id FROM projects WHERE name='Stacks' ORDER BY sort_order LIMIT 1;",
  ])
    .toString()
    .trim() ||
  execFileSync('sqlite3', [out, 'SELECT id FROM projects ORDER BY sort_order LIMIT 1;'])
    .toString()
    .trim();
if (!projectId) throw new Error('database has no project to own synthetic cards');

const sql = `
WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ${count})
INSERT INTO kanban_cards (
  id, external_provider, external_id, title, status, project_id,
  created_at, updated_at, sort_order, in_scope
)
SELECT
  'perf:' || x,
  'local:perf',
  printf('9%05d', x),
  'Synthetic backlog card ' || x,
  'needs_refinement',
  '${projectId.replaceAll("'", "''")}',
  unixepoch(),
  unixepoch(),
  100000 + x,
  1
FROM n;
`;
execFileSync('sqlite3', [out], { input: `${sql}\n` });
const total = execFileSync('sqlite3', [out, 'SELECT COUNT(*) FROM kanban_cards WHERE in_scope=1;'])
  .toString()
  .trim();
console.log(JSON.stringify({ database: out, synthetic_cards: count, in_scope_cards: Number(total) }, null, 2));
