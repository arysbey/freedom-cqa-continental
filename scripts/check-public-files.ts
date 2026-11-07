import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { config } from '../server/config.js';
import { DatabaseSync } from 'node:sqlite';

const git = process.env.CQA_GIT_EXECUTABLE || 'git';
const files = execFileSync(git, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const violations: string[] = [];
const privateTokens: string[] = [];
if (existsSync(config.dbPath)) {
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT original_json FROM conversations').all() as Array<{ original_json: string }>;
    for (const row of rows) {
      const record = JSON.parse(row.original_json);
      if (typeof record.audio_url === 'string' && record.audio_url.length > 20) privateTokens.push(record.audio_url);
      if (record.channel === 'voice call' && Array.isArray(record.transcript)) for (const message of record.transcript) {
        if (typeof message.text === 'string' && message.text.length > 100) privateTokens.push(message.text);
      }
    }
  } catch { /* A new empty database has no imported private sources. */ }
  finally { db.close(); }
}
function bundledFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? bundledFiles(join(path, e.name)) : [join(path, e.name)]);
}
for (const file of bundledFiles('dist')) {
  const content = readFileSync(file, 'utf8');
  if ((config.apiKey && content.includes(config.apiKey)) || (config.organizerUrl && content.includes(config.organizerUrl)) || /AIza[A-Za-z0-9_-]{30,}/.test(content)) violations.push('frontend-bundle');
  if (privateTokens.some(token => content.includes(token))) violations.push('frontend-private-source');
}
for (const file of files) {
  if (file === '.env.example') continue;
  if (/^(private|tmp|node_modules|dist|\.pnpm-store)\//.test(file) || /^\.env/.test(file) || /\.(sqlite|db|mp3|wav|m4a|flac|ogg|opus|webm|wma|pdf|audio)$/.test(file)) violations.push(file);
  const content = readFileSync(file, 'utf8');
  if (config.apiKey && content.includes(config.apiKey)) violations.push(file);
  if (config.organizerUrl && content.includes(config.organizerUrl)) violations.push(file);
  if (/AIza[A-Za-z0-9_-]{30,}/.test(content)) violations.push(file);
  if (privateTokens.some(token => content.includes(token))) violations.push(file);
}
assert.deepEqual([...new Set(violations)], [], 'Public file audit failed. Private content paths are not printed.');
console.log(JSON.stringify({ status: 'PASS', filesChecked: files.length, secretsPrinted: false, note: 'Local source audit only; publication not performed.' }));
