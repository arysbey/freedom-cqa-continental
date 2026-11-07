import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { config } from '../server/config.js';

const git = process.env.CQA_GIT_EXECUTABLE || 'git';
const files = execFileSync(git, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const violations: string[] = [];
function bundledFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? bundledFiles(join(path, e.name)) : [join(path, e.name)]);
}
for (const file of bundledFiles('dist')) {
  const content = readFileSync(file, 'utf8');
  if ((config.apiKey && content.includes(config.apiKey)) || (config.organizerUrl && content.includes(config.organizerUrl)) || /AIza[A-Za-z0-9_-]{30,}/.test(content)) violations.push('frontend-bundle');
}
for (const file of files) {
  if (file === '.env.example') continue;
  if (/^(private|tmp|node_modules|dist|\.pnpm-store)\//.test(file) || /^\.env/.test(file) || /\.(sqlite|db|mp3|wav|m4a|pdf)$/.test(file)) violations.push(file);
  const content = readFileSync(file, 'utf8');
  if (config.apiKey && content.includes(config.apiKey)) violations.push(file);
  if (config.organizerUrl && content.includes(config.organizerUrl)) violations.push(file);
  if (/AIza[A-Za-z0-9_-]{30,}/.test(content)) violations.push(file);
}
assert.deepEqual([...new Set(violations)], [], 'Public file audit failed. Private content paths are not printed.');
console.log(JSON.stringify({ status: 'PASS', filesChecked: files.length, secretsPrinted: false, note: 'Local source audit only; publication not performed.' }));
