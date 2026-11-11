// Counts authored CSS, not vendor imports. Optional argument: stylesheet path.
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { parseCss } from '../src/test/cssParser.mjs';

const css = readFileSync(process.argv[2] || new URL('../src/styles.css', import.meta.url), 'utf8');
const root = postcss.parse(css);
let important = 0;
let inlineUiDelta = 0;
let bareFontSize = 0;
let bareIncludingShorthands = 0;
root.walkDecls((decl) => {
  if (decl.important) important++;
  if (!['font', 'font-size'].includes(decl.prop)) return;
  if (decl.value.includes('--ui-font-delta')) inlineUiDelta++;
  if (/^(?:\d+\s+)?\d+px(?:\b|\/)/.test(decl.value)) {
    bareIncludingShorthands++;
    if (decl.prop === 'font-size') bareFontSize++;
  }
});
const selectors = new Map();
for (const rule of parseCss(css)) {
  for (const selector of postcss.list.comma(rule.selector)) {
    const key = JSON.stringify([rule.context, selector]);
    selectors.set(key, (selectors.get(key) || 0) + 1);
  }
}
const raw = css.replace(/\/\*[\s\S]*?\*\//g, '');
const layers = root.nodes.find((node) => node.name === 'layer' && !node.nodes)?.params ?? null;
console.log(JSON.stringify({
  lines: css.trimEnd().split('\n').length,
  important,
  inlineUiDelta,
  bareFontSize,
  bareIncludingShorthands,
  notOccurrences: (raw.match(/:not\(/g) || []).length,
  longestAdjacentNotChain: Math.max(0, ...[...raw.matchAll(/(?::not\([^()]*\))+/g)].map((match) => (match[0].match(/:not/g) || []).length)),
  duplicateSelectorsInContext: [...selectors.values()].filter((count) => count > 1).length,
  layers,
}, null, 2));
