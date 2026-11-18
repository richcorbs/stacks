// Bundle budget guard. Update these ceilings deliberately when adding features.
//
// Baseline before the Markdown renderer replacement:
//   markdown chunk: 354.22 kB, total JS: ~1,475 kB
// Current budget:
//   markdown chunk: <= 60 kB (the small marked + DOMPurify renderer is ~41 kB)
//   total JS:       <= 1,250 kB (current ~1,164 kB)
const MARKDOWN_CHUNK_CEILING = 60_000;
const TOTAL_JS_CEILING = 1_250_000;

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const assetsDirectory = fileURLToPath(new URL('../dist/assets/', import.meta.url));
const javascriptFiles = readdirSync(assetsDirectory).filter((name) => name.endsWith('.js'));
const sizes = javascriptFiles.map((name) => ({
  name,
  bytes: statSync(join(assetsDirectory, name)).size,
}));
const totalJsBytes = sizes.reduce((total, file) => total + file.bytes, 0);
const markdownChunks = sizes.filter((file) => /^markdown-[^/]+\.js$/.test(file.name));

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (markdownChunks.length !== 1) {
  fail(`Expected exactly one lazy markdown chunk, found ${markdownChunks.length}: ${markdownChunks.map((file) => file.name).join(', ')}`);
}

const markdownBytes = markdownChunks[0].bytes;
if (markdownBytes > MARKDOWN_CHUNK_CEILING) {
  fail(`Markdown chunk ${markdownChunks[0].name} is ${markdownBytes} bytes, over the ${MARKDOWN_CHUNK_CEILING}-byte budget.`);
}
if (totalJsBytes > TOTAL_JS_CEILING) {
  fail(`Total JavaScript is ${totalJsBytes} bytes, over the ${TOTAL_JS_CEILING}-byte budget.`);
}

console.log([
  `Bundle size OK: markdown ${markdownBytes} B (<= ${MARKDOWN_CHUNK_CEILING} B)`,
  `total JS ${totalJsBytes} B (<= ${TOTAL_JS_CEILING} B)`,
  `${sizes.length} chunks`,
].join('; '));
