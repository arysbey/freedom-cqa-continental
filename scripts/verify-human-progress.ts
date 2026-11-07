/** Read-only proof that human history and the active frozen validation round survive application work. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.js';

type Row = Record<string, unknown>;
interface Progress { manifestId: string; manifestHash: string; roundId: string; cases: number; development: number; holdout: number; referenceCases: number; resolved: number; unresolved: number; resolvedC1: number; caseProgress: Array<{ caseHash: string; resolvedCriteria: string[] }> }
interface Checkpoint { version: 1; readOnly: true; createdAt: string; database: string; tables: Record<string, { count: number; hash: string; rowHashes: string[] }>; progress: Progress[]; runningEvaluationAttempts: number }
const canonical = (value: unknown): string => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value !== null && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Row)[key])).join(',') + '}' : JSON.stringify(value);
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function privatePath(path: string) { const target = resolve(path); const child = relative(resolve('private'), target); if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('PRIVATE_OUTPUT_REQUIRED'); return target; }
function capture(): Checkpoint {
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const names = ['quality_manifests', 'quality_review_rounds', 'quality_references', 'quality_evidence_reviews', 'quality_requests'];
    const tables: Checkpoint['tables'] = {}; const records = new Map<string, Row[]>();
    for (const name of names) {
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
      const rows = exists ? db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() as Row[] : [];
      records.set(name, rows); const rowHashes = rows.map(hash).sort(); tables[name] = { count: rows.length, hash: hash(rowHashes), rowHashes };
    }
    const parsed = (table: string) => (records.get(table) || []).map(row => JSON.parse(String(row.json)) as Row);
    const references = parsed('quality_references'); const rounds = parsed('quality_review_rounds');
    const progress = parsed('quality_manifests').map(manifest => {
      const cases = manifest.cases as Row[]; const round = rounds.filter(r => r.manifestId === manifest.id).at(-1); const roundId = String(round?.id || 'legacy');
      let resolved = 0; let unresolved = 0; let resolvedC1 = 0; let referenceCases = 0;
      const caseProgress = cases.map(item => {
        const reference = references.filter(r => r.manifestId === manifest.id && r.caseId === item.id && (r.reviewRoundId || 'legacy') === roundId).at(-1);
        const checklist = db.prepare('SELECT json FROM checklists WHERE version=?').get(String(item.checklistVersion)) as { json: string };
        const total = (JSON.parse(checklist.json).criteria as unknown[]).length;
        const judgments = reference ? reference.judgments as Row[] : []; const resolvedCriteria = judgments.filter(j => j.resolved === true).map(j => String(j.criterionId)).sort();
        if (reference) referenceCases++; resolved += resolvedCriteria.length; unresolved += total - resolvedCriteria.length; if (resolvedCriteria.includes('C1')) resolvedC1++;
        return { caseHash: hash(item.id), resolvedCriteria };
      });
      return { manifestId: String(manifest.id), manifestHash: hash(manifest), roundId, cases: cases.length, development: cases.filter(c => c.split === 'development').length, holdout: cases.filter(c => c.split === 'holdout').length, referenceCases, resolved, unresolved, resolvedC1, caseProgress };
    });
    const runningEvaluationAttempts = Number((db.prepare("SELECT COUNT(*) AS count FROM evaluation_attempts WHERE json_extract(json,'$.status')='running'").get() as { count: number }).count);
    db.exec('COMMIT'); return { version: 1, readOnly: true, createdAt: new Date().toISOString(), database: relative(resolve('.'), config.dbPath).replaceAll('\\', '/'), tables, progress, runningEvaluationAttempts };
  } finally { db.close(); }
}
try {
  const mode = process.argv[2]; if (!['capture', 'verify'].includes(mode)) throw new Error('CAPTURE_OR_VERIFY_REQUIRED');
  const value = (key: string) => { const index = process.argv.indexOf(key); return index >= 0 ? process.argv[index + 1] : undefined; };
  const out = privatePath(value('--out') || `private/reports/human-progress-${mode}.json`); const after = capture();
  let comparison: unknown;
  if (mode === 'verify') {
    const beforePath = value('--before'); if (!beforePath) throw new Error('BEFORE_CHECKPOINT_REQUIRED');
    const before = JSON.parse(readFileSync(privatePath(beforePath), 'utf8')) as Checkpoint; if (before.version !== 1 || !before.readOnly) throw new Error('INVALID_CHECKPOINT');
    const tableChecks = Object.entries(before.tables).map(([name, old]) => {
      const current = after.tables[name]; const available = new Map<string, number>(); current.rowHashes.forEach(h => available.set(h, (available.get(h) || 0) + 1));
      const retained = old.rowHashes.every(h => { const count = available.get(h) || 0; available.set(h, count - 1); return count > 0; });
      return { table: name, pass: ['quality_manifests', 'quality_review_rounds'].includes(name) ? old.hash === current.hash : retained, before: old.count, after: current.count, policy: ['quality_manifests', 'quality_review_rounds'].includes(name) ? 'exactly-unchanged' : 'existing-history-preserved-human-appends-allowed' };
    });
    const progressChecks = before.progress.map(old => { const current = after.progress.find(p => p.manifestId === old.manifestId); return { manifestId: old.manifestId, pass: !!current && old.manifestHash === current.manifestHash && old.roundId === current.roundId && old.caseProgress.every(item => item.resolvedCriteria.every(id => current.caseProgress.find(p => p.caseHash === item.caseHash)?.resolvedCriteria.includes(id))) }; });
    const pass = before.database === after.database && tableChecks.every(c => c.pass) && progressChecks.every(c => c.pass); comparison = { pass, tableChecks, progressChecks }; if (!pass) process.exitCode = 1;
  }
  mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(mode === 'capture' ? after : { after, comparison }, null, 2));
  console.log(JSON.stringify({ status: mode === 'capture' ? 'CAPTURED_READ_ONLY' : process.exitCode ? 'HUMAN_PROGRESS_CHECK_FAILED' : 'HUMAN_PROGRESS_PRESERVED', output: relative(resolve('.'), out), progress: after.progress.map(({ caseProgress: _privateHashes, ...summary }) => { void _privateHashes; return summary; }), runningEvaluationAttempts: after.runningEvaluationAttempts, ...(mode === 'verify' ? { comparison } : {}) }));
} catch (error) { console.error(error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message) ? error.message : 'HUMAN_PROGRESS_CHECK_FAILED'); process.exitCode = 1; }
