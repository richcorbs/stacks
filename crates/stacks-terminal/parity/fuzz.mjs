// Deterministic VT fuzz corpus. Generated file is ignored; seed is fixed so a
// failure is reproducible.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let state = 0x3185eed;
function rnd() {
  state ^= state << 13; state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5; state >>>= 0;
  return state / 0x100000000;
}
function pick(values) { return values[Math.floor(rnd() * values.length)]; }
function int(min, max) { return min + Math.floor(rnd() * (max - min + 1)); }

const text = [
  'hello', 'world', 'abcdefghijklmnopqrstuvwxyz', '0123456789',
  '世界', '界世', '🙂', 'e\u0301', 'Z', '·', '✓', 'Ω', '한글',
  'line one\r\nline two', '\r\n', '\r', '\b', '\t', '  ',
];
const sgr = [
  '\x1b[0m', '\x1b[1m', '\x1b[2m', '\x1b[3m', '\x1b[4m', '\x1b[7m', '\x1b[8m', '\x1b[9m',
  '\x1b[31m', '\x1b[42m', '\x1b[91m', '\x1b[104m', '\x1b[39m', '\x1b[49m',
];
const csi = [
  '\x1b[H', '\x1b[2J', '\x1b[K', '\x1b[1A', '\x1b[2B', '\x1b[3C', '\x1b[4D',
  '\x1b[5G', '\x1b[3;7H', '\x1b[2;5r', '\x1b[?6h', '\x1b[?6l',
  '\x1b[?7l', '\x1b[?7h', '\x1b[?25l', '\x1b[?25h', '\x1b[?2004h', '\x1b[?2004l',
  '\x1b[?1049h', '\x1b[?1049l', '\x1b[s', '\x1b[u',
  '\x1b]2;fuzz-title\x1b\\', '\x07', '\x1b]52;c;ZnV6eg==\x07',
];

function token() {
  const roll = rnd();
  if (roll < 0.48) return pick(text);
  if (roll < 0.70) return pick(sgr);
  if (roll < 0.92) return pick(csi);
  if (roll < 0.96) return `\x1b[38;5;${int(0, 255)}m`;
  return `\x1b[48;2;${int(0, 255)};${int(0, 255)};${int(0, 255)}m`;
}

const cases = [];
for (let c = 0; c < 35; c += 1) {
  const cols = int(12, 60);
  const rows = int(4, 20);
  const steps = [];
  for (let s = 0; s < 14; s += 1) {
    const roll = rnd();
    if (roll < 0.12) {
      const newCols = int(8, 60);
      const newRows = int(3, 20);
      steps.push({ name: `step-${s}`, op: 'resize', cols: newCols, rows: newRows });
    } else if (roll < 0.19) {
      steps.push({ name: `step-${s}`, op: 'scroll', delta: int(-8, 8) });
    } else {
      const pieces = [];
      const count = int(1, 8);
      for (let i = 0; i < count; i += 1) pieces.push(token());
      steps.push({ name: `step-${s}`, op: 'write', text: pieces.join('') });
    }
  }
  cases.push({ name: `fuzz-${c}`, cols, rows, steps });
}
fs.writeFileSync(path.join(here, 'corpus-fuzz.json'), JSON.stringify({ cases }, null, 2));
console.log(`fuzz: wrote ${cases.length} cases (seed 0x3185eed)`);
