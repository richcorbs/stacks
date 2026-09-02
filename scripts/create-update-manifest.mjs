#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const [archivePath, signaturePath, outputPath = 'latest.json'] = process.argv.slice(2);
if (!archivePath || !signaturePath) {
  console.error('Usage: node scripts/create-update-manifest.mjs <archive> <signature> [output]');
  process.exit(1);
}
const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const tag = `v${version}`;
const notesPath = path.join(root, 'releases', `${tag}.md`);
const notes = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8').trim() : '';
const archiveName = path.basename(archivePath);
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'darwin-aarch64': {
      signature: fs.readFileSync(signaturePath, 'utf8').trim(),
      url: `https://github.com/richcorbs/stacks/releases/download/${tag}/${archiveName}`,
    },
  },
};
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Created ${outputPath} for ${tag}.`);
