import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { config } from '../server/config.js';
import type { Evaluation } from '../src/domain.js';
import type { ReviewHistory } from '../server/reviews.js';

const before = JSON.parse(readFileSync('private/reports/persistence-before.json', 'utf8')) as { evaluations: Array<{ id: string; history: ReviewHistory }> };
const base = `http://127.0.0.1:${config.port}`;
const allResponse = await fetch(`${base}/api/evaluations`);
assert(allResponse.ok);
const all = await allResponse.json() as Evaluation[];
assert.equal(all.length, before.evaluations.length);
for (const item of before.evaluations) {
  const evaluationResponse = await fetch(`${base}/api/evaluations/${item.id}`);
  assert(evaluationResponse.ok);
  const evaluation = await evaluationResponse.json() as Evaluation;
  assert.equal(evaluation.status, 'live_validated');
  assert.equal(evaluation.id, item.id);
  const historyResponse = await fetch(`${base}/api/evaluations/${item.id}/history`);
  assert(historyResponse.ok);
  assert.deepEqual(await historyResponse.json(), item.history);
}
const report = { status: 'PASS', savedLiveEvaluations: all.length, completeReviewHistoriesUnchanged: true, realBackend: true, networkMocks: false };
writeFileSync('private/reports/restart-verification.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
