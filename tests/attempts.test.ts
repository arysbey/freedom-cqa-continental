import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import type { EvaluationAttempt } from '../src/domain.js';

const attempt: EvaluationAttempt = { id: 'test-attempt', conversationVersion: 'conversation', checklistVersion: 'checklist', model: 'gemini-3.1-flash-lite', startedAt: '2026-11-07T10:00:00Z', finishedAt: null, status: 'running', evaluationId: null, errorCode: null, latencyMs: null, usage: null };
test('attempt ledger preserves failure state and unknown usage without an invented evaluation', () => {
  const store = new Store(':memory:');
  try {
    store.startEvaluationAttempt(attempt);
    store.finishEvaluationAttempt({ ...attempt, status: 'failed', finishedAt: '2026-11-07T10:00:01Z', errorCode: 'PROVIDER_TIMEOUT', latencyMs: 1000 });
    const saved = store.listEvaluationAttempts()[0];
    assert.equal(saved.status, 'failed'); assert.equal(saved.usage, null); assert.equal(saved.evaluationId, null); assert.equal(store.listEvaluations().length, 0);
    assert.throws(() => store.finishEvaluationAttempt({ ...saved, status: 'succeeded' }), /STATE/);
  } finally { store.close(); }
});
test('attempt cannot replace its source or overwrite an existing attempt', () => {
  const store = new Store(':memory:');
  try {
    store.startEvaluationAttempt(attempt);
    assert.throws(() => store.startEvaluationAttempt(attempt));
    assert.throws(() => store.finishEvaluationAttempt({ ...attempt, conversationVersion: 'changed', status: 'failed' }), /SOURCE/);
    assert.equal(store.listEvaluationAttempts()[0].status, 'running');
  } finally { store.close(); }
});
