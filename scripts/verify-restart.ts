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
assert(all.length >= before.evaluations.length);
for (const item of before.evaluations) {
  const evaluationResponse = await fetch(`${base}/api/evaluations/${item.id}`);
  assert(evaluationResponse.ok);
  const evaluation = await evaluationResponse.json() as Evaluation;
  if (evaluation.status !== 'live_validated') assert(evaluation.mode === 'local' && evaluation.providerCallCount === 0);
  assert.equal(evaluation.id, item.id);
  const historyResponse = await fetch(`${base}/api/evaluations/${item.id}/history`);
  assert(historyResponse.ok);
  const history = await historyResponse.json() as ReviewHistory;
  for (const appeal of item.history.appeals) assert.deepEqual(history.appeals.find(a => a.id === appeal.id), appeal);
  for (const decision of item.history.decisions) assert.deepEqual(history.decisions.find(d => d.id === decision.id), decision);
}
const report = { status: 'PASS', savedLiveEvaluations: all.filter(e => e.status === 'live_validated').length, preservedBaselineEvaluations: before.evaluations.length, preexistingReviewEntriesPreserved: true, newerEvaluationsAndReviewEntriesAllowed: true, realBackend: true, networkMocks: false };
writeFileSync('private/reports/restart-verification.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
