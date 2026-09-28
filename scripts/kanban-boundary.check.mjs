import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const generator = new URL('./generate-kanban-boundary.mjs', import.meta.url);
const domain = readFileSync(new URL('../src-tauri/src/kanban/domain.rs', import.meta.url), 'utf8');
const commands = readFileSync(new URL('../src-tauri/src/kanban/commands.rs', import.meta.url), 'utf8');
const check = (env = {}) => spawnSync(process.execPath, [generator.pathname, '--check'], { encoding: 'utf8', env: { ...process.env, ...env } });

test('the checked wire fixture rejects added nullable fields, revision type changes and command request drift', () => {
  assert.equal(check().status, 0);
  const directory = mkdtempSync(join(tmpdir(), 'kanban-boundary-'));
  try {
    const path = join(directory, 'domain.rs');
    for (const changed of [
      domain.replace('pub struct BoardChange {', 'pub struct BoardChange {\n    pub new_state: Option<String>,'),
      domain.replace('pub board_revision: i64,\n}', 'pub board_revision: String,\n}'),
    ]) {
      writeFileSync(path, changed);
      assert.notEqual(check({ KANBAN_CONTRACT_DOMAIN: path }).status, 0);
    }
    const commandPath = join(directory, 'commands.rs');
    writeFileSync(commandPath, commands.replace('pub fn kanban_card_snapshot(id: String)', 'pub fn kanban_card_snapshot(card_id: String)'));
    assert.notEqual(check({ KANBAN_CONTRACT_COMMANDS: commandPath }).status, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
