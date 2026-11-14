import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const spikeDir = path.resolve(here, '..');
const root = path.resolve(spikeDir, '../..');
const corpusFiles = ['corpus.json', 'corpus-tui.json'];
if (process.env.PARITY_FUZZ === '1') corpusFiles.push('corpus-fuzz.json');
const mergedCorpus = { cases: [] };
for (const file of corpusFiles) {
  const next = JSON.parse(fs.readFileSync(path.join(here, file), 'utf8'));
  mergedCorpus.cases.push(...next.cases);
}
const corpusPath = path.join(here, 'corpus-merged.json');
fs.writeFileSync(corpusPath, JSON.stringify(mergedCorpus, null, 2));
const ghosttyPath = path.join(here, '.ghostty-run.json');
const xtermPath = path.join(here, '.xterm-run.json');
const keepRuns = process.env.PARITY_KEEP === '1';
const reportPath = path.join(here, 'report.json');

console.log('running libghostty-vt side...');
execFileSync('cargo', ['run', '--quiet', '--bin', 'parity', '--', corpusPath, ghosttyPath], {
  cwd: spikeDir,
  stdio: 'inherit',
});

const corpus = mergedCorpus;
const expected = JSON.parse(fs.readFileSync(ghosttyPath, 'utf8'));
if (!keepRuns) fs.rmSync(ghosttyPath, { force: true });

const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const actual = { cases: [] };
const differences = [];
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (error) => console.error('PAGE ERROR', error));
  await page.goto(`${server.resolvedUrls.local[0]}crates/stacks-terminal/parity/harness.html`);
  await page.waitForFunction(() => !!window.parity);
  const xtermPalette = await page.evaluate(() => {
    window.parity.init(80, 24);
    return window.parity.palette();
  });
  for (let index = 0; index < Math.max(expected.palette.length, xtermPalette.length); index += 1) {
    if (JSON.stringify(expected.palette[index]) !== JSON.stringify(xtermPalette[index])) {
      differences.push({ case: 'palette', field: `palette.${index}`, expected: expected.palette[index], actual: xtermPalette[index] });
    }
  }
  for (const testCase of corpus.cases) {
    const run = await page.evaluate(async (testCase) => {
      window.parity.init(testCase.cols, testCase.rows);
      const steps = [];
      for (const step of testCase.steps) {
        if (step.op === 'write') await window.parity.write(step.text);
        else if (step.op === 'write_base64') await window.parity.writeBytes(step.data);
        else if (step.op === 'resize') await window.parity.resize(step.cols, step.rows);
        else if (step.op === 'scroll') {
          window.parity.term?.scrollLines(step.delta);
        }
        steps.push({ name: step.name, snapshot: window.parity.snapshot() });
      }
      window.parity.dispose();
      return { name: testCase.name, cols: testCase.cols, rows: testCase.rows, steps };
    }, testCase);
    actual.cases.push(run);
  }
} finally {
  if (browser) await browser.close();
  await server.close();
}
if (keepRuns) fs.writeFileSync(xtermPath, JSON.stringify(actual));

const known = fs.existsSync(path.join(here, 'known-divergences.json'))
  ? JSON.parse(fs.readFileSync(path.join(here, 'known-divergences.json'), 'utf8'))
  : { allow: [] };

const allowedSeen = [];
function isAllowed(caseName, stepName, field) {
  for (const entry of known.allow || []) {
    if (entry.case !== caseName || (entry.step && entry.step !== stepName)) continue;
    if (entry.field && !field.startsWith(entry.field)) continue;
    if (entry.contains && !field.includes(entry.contains)) continue;
    if (!allowedSeen.some((seen) => seen.reason === entry.reason && seen.field === entry.field)) {
      allowedSeen.push({ case: caseName, step: stepName, field, reason: entry.reason });
    }
    return true;
  }
  return false;
}

function diff(expectedValue, actualValue, caseName, stepName, field, out) {
  if (out.length > 2000) return;
  if (expectedValue === actualValue) return;
  if (expectedValue && actualValue && typeof expectedValue === 'object' && typeof actualValue === 'object') {
    if (Array.isArray(expectedValue) !== Array.isArray(actualValue)) {
      out.push({ case: caseName, step: stepName, field, expected: expectedValue, actual: actualValue });
      return;
    }
    const keys = new Set([...Object.keys(expectedValue), ...Object.keys(actualValue)]);
    for (const key of keys) {
      diff(expectedValue[key], actualValue[key], caseName, stepName, `${field}.${key}`, out);
    }
    return;
  }
  if (isAllowed(caseName, stepName, field)) return;
  out.push({ case: caseName, step: stepName, field, expected: expectedValue, actual: actualValue });
}

for (const expCase of expected.cases) {
  const actCase = actual.cases.find((candidate) => candidate.name === expCase.name);
  if (!actCase) {
    differences.push({ case: expCase.name, field: 'case', expected: 'present', actual: 'missing' });
    continue;
  }
  for (let i = 0; i < Math.max(expCase.steps.length, actCase.steps.length); i += 1) {
    const expStep = expCase.steps[i];
    const actStep = actCase.steps[i];
    if (!expStep || !actStep) {
      differences.push({ case: expCase.name, step: expStep?.name ?? actStep?.name, field: 'step', expected: !!expStep, actual: !!actStep });
      continue;
    }
    const exp = { ...expStep.snapshot, cursor: { ...expStep.snapshot.cursor } };
    const act = { ...actStep.snapshot, cursor: { ...actStep.snapshot.cursor } };
    if (act.cursor.visible === null) {
      delete act.cursor.visible;
      delete exp.cursor.visible;
    }
    // Ghostty's render-state cursor is viewport-relative, so it is absent
    // when scrolled into history. xterm keeps reporting the active cursor.
    if (exp.scrollbar_offset + exp.rows !== exp.scrollbar_total) {
      delete exp.cursor;
      delete act.cursor;
    }
    diff(exp, act, expCase.name, expStep.name, 'snapshot', differences);
  }
}

const byCase = {};
for (const difference of differences) {
  byCase[difference.case] = (byCase[difference.case] || 0) + 1;
}
const report = {
  generatedAt: new Date().toISOString(),
  cases: corpus.cases.length,
  snapshots: expected.cases.reduce((sum, c) => sum + c.steps.length, 0),
  differenceCount: differences.length,
  knownDivergenceCount: allowedSeen.length,
  knownDivergencesApplied: allowedSeen,
  byCase,
  differences,
  knownDivergences: known,
};
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

console.log(`parity: ${report.cases} cases, ${report.snapshots} snapshots, ${differences.length} unknown differences, ${allowedSeen.length} recorded divergences`);
if (differences.length) {
  const shown = differences.slice(0, 30);
  for (const difference of shown) {
    console.log(`\n[${difference.case}] ${difference.step ?? ''} ${difference.field}`);
    console.log('  ghostty:', JSON.stringify(difference.expected));
    console.log('  xterm:  ', JSON.stringify(difference.actual));
  }
  if (differences.length > shown.length) console.log(`\n... ${differences.length - shown.length} more in ${reportPath}`);
  console.log(`\nreport: ${reportPath}`);
  process.exitCode = 1;
} else {
  console.log('parity: no unknown differences');
}
