/** Local read-only release audit. Reports counts and categories, never private values. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.js';

const git = (args: string[], input?: string) => execFileSync('git', args, { encoding: 'utf8', input, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const publicFiles = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
const privateValues = new Set<string>();
for (const value of [config.apiKey, config.organizerUrl]) if (value) privateValues.add(value);
let realCalls = 0; let realUtterances = 0; let audioUrls = 0; let databaseRead = false;
if (existsSync(config.dbPath)) {
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT original_json FROM conversations').all() as Array<{ original_json: string }>;
    for (const row of rows) {
      const record = JSON.parse(row.original_json) as { channel?: string; audio_url?: unknown; transcript?: Array<{ text?: unknown }> };
      if (typeof record.audio_url === 'string' && record.audio_url.length > 20) { privateValues.add(record.audio_url); audioUrls++; }
      if (record.channel !== 'voice call') continue;
      realCalls++;
      for (const message of record.transcript ?? []) if (typeof message.text === 'string' && message.text.length >= 24) { privateValues.add(message.text); realUtterances++; }
    }
    databaseRead = true;
  } finally { db.close(); }
}
const fingerprints = [...privateValues].flatMap(value => [value, JSON.stringify(value).slice(1, -1)]);
const findings: Record<string, number> = Object.create(null);
const flag = (category: string) => { findings[category] = (findings[category] ?? 0) + 1; };
const forbiddenPath = (path: string) => /^(?:private|tmp|dist|node_modules|\.pnpm-store)\//i.test(path) || /^\.env(?:\.|$)/i.test(path) && path !== '.env.example' || /\.(?:sqlite(?:-.+)?|db|mp3|wav|m4a|flac|ogg|opus|webm|wma|pdf|audio)$/i.test(path);
function scan(content: string, scope: string) {
  if (fingerprints.some(value => content.includes(value))) flag(`${scope}:known-private-value`);
  if (/AIza[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) flag(`${scope}:credential-pattern`);
  const urls = content.match(/https?:\/\/[^\s"'`<>\\]+/g) ?? [];
  if (urls.some(url => /[?&](?:x-amz-signature|x-goog-signature|signature|sig|access_token|token)=[A-Za-z0-9_%+-]{24,}/i.test(url))) flag(`${scope}:signed-url-pattern`);
}
for (const path of publicFiles) {
  if (forbiddenPath(path)) flag('working-source:private-path');
  scan(readFileSync(path, 'utf8'), 'working-source');
}

// Inspect immutable blobs reachable from every local branch, not only HEAD files.
const objectLines = git(['rev-list', '--objects', '--all']).trim().split('\n').filter(Boolean);
const objectIds = objectLines.map(line => line.split(' ')[0]);
for (const line of objectLines) {
  const separator = line.indexOf(' ');
  if (separator >= 0 && forbiddenPath(line.slice(separator + 1))) flag('git-history:private-path');
}
const blobs = git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], `${objectIds.join('\n')}\n`).trim().split('\n').filter(line => line.endsWith(' blob')).map(line => line.split(' ')[0]);
const batch = execFileSync('git', ['cat-file', '--batch'], { input: `${blobs.join('\n')}\n`, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
let offset = 0;
for (let blobIndex = 0; blobIndex < blobs.length; blobIndex++) {
  const newline = batch.indexOf(10, offset);
  if (newline < 0) throw new Error('GIT_OBJECT_STREAM_INVALID');
  const size = Number(batch.subarray(offset, newline).toString('utf8').split(' ')[2]);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('GIT_OBJECT_STREAM_INVALID');
  offset = newline + 1;
  scan(batch.subarray(offset, offset + size).toString('utf8'), 'git-history'); offset += size + 1;
}

const bundledFiles = (path: string): string[] => !existsSync(path) ? [] : readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? bundledFiles(join(path, entry.name)) : [join(path, entry.name)]);
const bundles = bundledFiles('dist');
for (const path of bundles) scan(readFileSync(path, 'utf8'), 'frontend-bundle');
const index = existsSync('dist/index.html') ? readFileSync('dist/index.html', 'utf8') : '';
const assets = [...index.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
const missingAssets = assets.filter(path => !/^https?:\/\//.test(path) && !existsSync(resolve('dist', path.replace(/^\//, ''))));
if (!bundles.length || !index) flag('frontend-bundle:missing');
if (missingAssets.length) flag('frontend-bundle:missing-linked-asset');
const ignoredProbes = ['.env', '.env.local', 'private/cqa.sqlite', 'private/reports/audit.json', 'tmp/audit.txt', 'dist/index.html', 'node_modules/audit'];
const ignored = git(['check-ignore', '--no-index', ...ignoredProbes]).trim().split('\n');
if (ignoredProbes.some(path => !ignored.includes(path))) flag('gitignore:private-probe-not-ignored');
const remoteNames = git(['remote']).trim().split('\n').filter(Boolean);
const guidePath = 'private/source-audit/CQA_Hackathon_Student_Guide_v3 1.txt';
const guide = existsSync(guidePath) ? readFileSync(guidePath, 'utf8') : '';
const deadlineRelativeEvidence = /Через 23 часа после старта/.test(guide) && /Через 24 часа после старта/.test(guide) && /Точное расписание.*сообщат отдельно/.test(guide);
const report = {
  status: Object.keys(findings).length ? 'FAIL' : 'PASS', generatedAt: new Date().toISOString(), gitHead: git(['rev-parse', 'HEAD']).trim(),
  scopes: { publicWorkingFiles: publicFiles.length, historicalBlobs: blobs.length, gitObjects: objectIds.length, frontendFiles: bundles.length, linkedLocalAssets: assets.filter(path => !/^https?:\/\//.test(path)).length },
  privateFingerprintCoverage: { databaseReadOnly: databaseRead, realCallRecords: realCalls, audioUrlRecords: audioUrls, realUtterancesAtLeast24Characters: realUtterances, valuesPrinted: false },
  findings, gitignore: { probes: ignoredProbes.length, allIgnored: ignoredProbes.every(path => ignored.includes(path)) },
  remoteCount: remoteNames.length, publicationPerformed: false, billingChanged: false, buildRebuiltByAudit: false,
  deadline: { relativeEvidenceVerified: deadlineRelativeEvidence, controlHoursAfterStart: deadlineRelativeEvidence ? 23 : null, stopCodeHoursAfterStart: deadlineRelativeEvidence ? 24 : null, absoluteDateTime: null, reason: 'Official start and absolute deadline have not been provided; guide says organizers announce exact schedule separately.' },
  limitations: ['Pattern and exact-value scanning cannot prove absence of every secret or transformed private datum.', 'No public repository is created or published by this audit. Required submission and publication remain pending user approval.', 'Existing dist files are inspected; production build and clean-install checks belong to the release verification run.', 'Private real-call phrases shorter than 24 characters are not fingerprinted to avoid meaningless common-word matches.'],
};
mkdirSync('private/reports', { recursive: true });
writeFileSync('private/reports/release-audit.json', `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(JSON.stringify(report));
if (report.status !== 'PASS') process.exitCode = 1;
