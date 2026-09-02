#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const lockVersion = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages[''].version;
const tauriVersion = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version;
const cargoText = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
const cargoVersion = cargoText.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
const versions = { packageVersion, lockVersion, tauriVersion, cargoVersion };
if (new Set(Object.values(versions)).size !== 1) {
  console.error('Version mismatch:', versions);
  process.exit(1);
}
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null;
if (tag && tag !== `v${packageVersion}`) {
  console.error(`Tag ${tag} does not match application version v${packageVersion}`);
  process.exit(1);
}
console.log(`Stacks version ${packageVersion} is consistent.`);
