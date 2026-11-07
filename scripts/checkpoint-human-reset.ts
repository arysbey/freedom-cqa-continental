import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.js';

type Row = Record<string, unknown>;
interface TableCheckpoint { count: number; hash: string; schemaHash: string; rowHashes: string[] }
interface Checkpoint { schemaVersion: 1; capturedAt: string; database: string; readOnly: true; tables: Record<string, TableCheckpoint>; summary: Row }
const canonical = (value: unknown): string => {
  if (value instanceof Uint8Array) return JSON.stringify({ sqliteBlobHex: Buffer.from(value).toString('hex') });
  if (typeof value === 'bigint') return JSON.stringify({ sqliteInteger: value.toString() });
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Row)[key])).join(',') + '}';
  return JSON.stringify(value);
};
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function withinWorkspace(path: string): string {
  const target = resolve(path); const child = relative(resolve('.'), target);
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('WORKSPACE_PATH_REQUIRED');
  return target;
}
function privateOutput(path: string): string {
  const target = withinWorkspace(path); const child = relative(resolve('private'), target);
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('PRIVATE_OUTPUT_REQUIRED');
  return target;
}
const identifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const parsedJson = (value: unknown): Row => typeof value === 'string' ? JSON.parse(value) as Row : {};
function snapshot(dbPath: string): Checkpoint {
  const db = new DatabaseSync(withinWorkspace(dbPath), { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const schemas = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; sql: string }>;
    const tables: Checkpoint['tables'] = {};
    const rowsByTable = new Map<string, Row[]>();
    for (const schema of schemas) {
      const rows = db.prepare(`SELECT * FROM ${identifier(schema.name)}`).all() as Row[];
      rowsByTable.set(schema.name, rows);
      const rowHashes = rows.map(hash).sort();
      tables[schema.name] = { count: rows.length, hash: hash(rowHashes), schemaHash: hash(schema.sql), rowHashes };
    }
    const get = (table: string) => rowsByTable.get(table) || [];
    const groups = new Map<string, { groupId: string; storedVersions: number; conversationIds: Set<string> }>();
    for (const row of get('conversations')) {
      const groupId = String(row.group_id); const group = groups.get(groupId) || { groupId, storedVersions: 0, conversationIds: new Set<string>() };
      group.storedVersions++; group.conversationIds.add(String(row.conversation_id)); groups.set(groupId, group);
    }
    const manifestSnapshots = get('quality_manifests').map(row => {
      const manifest = parsedJson(row.json); const cases = manifest.cases as Row[];
      return { id: manifest.id, manifestHash: hash(manifest), casesHash: hash(cases), cases: cases.length,
        core: cases.filter(c => c.kind === 'core').length, semanticProbes: cases.filter(c => c.kind === 'semantic_probe').length,
        development: cases.filter(c => c.kind === 'core' && c.split === 'development').length,
        holdout: cases.filter(c => c.kind === 'core' && c.split === 'holdout').length };
    });
    const reviewerScopes = new Map<string, { table: string; manifestId: unknown; reviewerHash: string; records: number; caseHashes: Set<string>; totalJudgments: number; resolvedJudgments: number }>();
    for (const table of ['quality_references', 'quality_evidence_reviews']) for (const row of get(table)) {
      const record = parsedJson(row.json); const reviewerHash = hash(record.reviewerId);
      const scopeKey = canonical([table, record.manifestId, reviewerHash]);
      const scope = reviewerScopes.get(scopeKey) || { table, manifestId: record.manifestId, reviewerHash, records: 0, caseHashes: new Set<string>(), totalJudgments: 0, resolvedJudgments: 0 };
      const judgments = Array.isArray(record.judgments) ? record.judgments as Row[] : [];
      scope.records++; scope.caseHashes.add(hash(record.caseId)); scope.totalJudgments += judgments.length; scope.resolvedJudgments += judgments.filter(j => j.resolved === true).length;
      reviewerScopes.set(scopeKey, scope);
    }
    const operationCounts: Record<string, number> = {};
    for (const row of get('quality_requests')) operationCounts[String(row.operation)] = (operationCounts[String(row.operation)] || 0) + 1;
    db.exec('COMMIT');
    return { schemaVersion: 1, capturedAt: new Date().toISOString(), database: relative(resolve('.'), resolve(dbPath)).replaceAll('\\', '/'), readOnly: true, tables,
      summary: { tableCounts: Object.fromEntries(Object.entries(tables).map(([name, table]) => [name, table.count])),
        conversationGroups: [...groups.values()].map(group => ({ groupId: group.groupId, storedVersions: group.storedVersions, conversations: group.conversationIds.size })),
        manifests: manifestSnapshots, reviewerScopes: [...reviewerScopes.values()].map(scope => ({ ...scope, caseHashes: undefined, distinctCases: scope.caseHashes.size })), qualityRequestOperations: operationCounts } };
  } finally { db.close(); }
}
function verify(before: Checkpoint, after: Checkpoint) {
  const checks: Array<{ table: string; pass: boolean; policy: string; before: number; after: number | null }> = [];
  for (const [name, old] of Object.entries(before.tables)) {
    const current = after.tables[name];
    // A reset may append an idempotency audit row; it may not alter an older request.
    if (name === 'quality_requests' && current) {
      const available = new Map<string, number>(); for (const h of current.rowHashes) available.set(h, (available.get(h) || 0) + 1);
      const retained = old.rowHashes.every(h => { const n = available.get(h) || 0; if (!n) return false; available.set(h, n - 1); return true; });
      checks.push({ table: name, pass: retained && old.schemaHash === current.schemaHash, policy: 'existing-rows-preserved-append-only', before: old.count, after: current.count });
    } else checks.push({ table: name, pass: !!current && old.hash === current.hash && old.schemaHash === current.schemaHash, policy: 'exactly-unchanged', before: old.count, after: current?.count ?? null });
  }
  return { pass: before.database === after.database && checks.every(c => c.pass), databaseMatches: before.database === after.database, checks,
    addedTables: Object.keys(after.tables).filter(name => !(name in before.tables)).map(name => ({ table: name, count: after.tables[name].count })),
    warning: 'Added round/audit tables are reported separately. This verifies stored history, not the correctness of active-round filtering or browser state.' };
}
function run() {
  const [mode, ...args] = process.argv.slice(2); const options = new Map<string, string>();
  if (!['capture', 'verify'].includes(mode) || args.length % 2 !== 0) throw new Error('USAGE_CAPTURE_OR_VERIFY');
  for (let i = 0; i < args.length; i += 2) { if (!['--db', '--out', '--before'].includes(args[i])) throw new Error('UNKNOWN_ARGUMENT'); options.set(args[i], args[i + 1]); }
  const out = privateOutput(options.get('--out') || `private/reports/human-reset-${mode}.json`);
  const current = snapshot(options.get('--db') || config.dbPath);
  if (mode === 'capture') {
    mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(current, null, 2));
    console.log(JSON.stringify({ status: 'CAPTURED_READ_ONLY', output: relative(resolve('.'), out), ...current.summary }));
  } else {
    if (!options.get('--before')) throw new Error('BEFORE_CHECKPOINT_REQUIRED');
    const before = JSON.parse(readFileSync(privateOutput(options.get('--before')!), 'utf8')) as Checkpoint;
    if (before.schemaVersion !== 1 || before.readOnly !== true) throw new Error('INVALID_CHECKPOINT');
    const comparison = verify(before, current);
    mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify({ beforeCapturedAt: before.capturedAt, after: current, comparison }, null, 2));
    console.log(JSON.stringify({ status: comparison.pass ? 'UNCHANGED_HISTORY_PASS' : 'HISTORY_CHECK_FAILED', output: relative(resolve('.'), out), ...comparison }));
    if (!comparison.pass) process.exitCode = 1;
  }
}
try { run(); } catch (error) { console.error(error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message) ? error.message : 'CHECKPOINT_FAILED'); process.exitCode = 1; }
