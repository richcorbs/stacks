#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: npm run version -- <semver>');
  process.exit(1);
}

for (const file of ['package.json', 'package-lock.json']) {
  const filePath = path.join(root, file);
  const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  json.version = version;
  if (json.packages?.['']) json.packages[''].version = version;
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

const tauriPath = path.join(root, 'src-tauri/tauri.conf.json');
const tauri = JSON.parse(fs.readFileSync(tauriPath, 'utf8'));
tauri.version = version;
fs.writeFileSync(tauriPath, `${JSON.stringify(tauri, null, 2)}\n`);

const cargoPath = path.join(root, 'src-tauri/Cargo.toml');
const cargo = fs.readFileSync(cargoPath, 'utf8').replace(
  /(^\[package\][\s\S]*?^version\s*=\s*")[^"]+("$)/m,
  `$1${version}$2`,
);
fs.writeFileSync(cargoPath, cargo);
console.log(`Set Stacks version to ${version}. Run cargo check to update Cargo.lock.`);
