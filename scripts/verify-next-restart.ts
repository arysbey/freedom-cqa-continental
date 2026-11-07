import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { config } from '../server/config.js';
import { canonicalJson } from '../server/importer.js';
import { QualityStore } from '../server/quality.js';

const before = JSON.parse(readFileSync('private/reports/next-before-restart.json', 'utf8')) as { evaluations: Array<{ id: string; status: string; hash: string; historyHash: string }>; checklists: Array<{ version: string; hash: string }>; qualityManifestId: string | null; references: Array<{ id: string; hash: string }> };
const base = `http://127.0.0.1:${config.port}`;
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
async function get(path: string) { const response = await fetch(`${base}${path}`); assert(response.ok); return response.json(); }
for (const source of before.evaluations) {
  const evaluation = await get(`/api/evaluations/${source.id}`);
  assert.equal(digest(evaluation), source.hash);
  assert.equal(digest(await get(`/api/evaluations/${source.id}/history`)), source.historyHash);
  if (evaluation.status !== 'live_validated') assert.equal(evaluation.providerCallCount, 0);
}
const checklists = await get('/api/checklists');
for (const source of before.checklists) assert.equal(digest(checklists.find((c: { version: string }) => c.version === source.version)), source.hash);
const quality = new QualityStore(config.dbPath);
try {
  const references = before.qualityManifestId ? quality.listReferences(before.qualityManifestId) : [];
  for (const source of before.references) assert.equal(digest(references.find(r => r.id === source.id)), source.hash);
} finally { quality.close(); }
const status = await get('/api/status');
const report = { status: 'PASS', realBackend: true, networkMocks: false, evaluationsUnchanged: before.evaluations.length, completeReviewHistoriesUnchanged: before.evaluations.length, checklistVersionsUnchanged: before.checklists.length, preexistingHumanReferencesPreserved: before.references.length, liveEvaluationCount: status.liveEvaluationCount, manualEvaluationCount: status.manualEvaluationCount };
writeFileSync('private/reports/next-restart-verification.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
