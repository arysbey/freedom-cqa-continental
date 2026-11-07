import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { ReviewStore } from '../server/reviews.js';
import { parseOrganizerResponse } from '../server/importer.js';
import { saveManualEvaluation } from '../server/manual.js';
import { initialChecklist } from '../src/checklist.js';
import type { CriterionResult } from '../src/domain.js';

function setup(path = ':memory:') {
  const store = new Store(path);
  const dataset = parseOrganizerResponse({ error: '', isSuccess: true, data: { dataset_group_id: 'TEST', total_records: 1, records: [{ conversation_id: 'invented-call', channel: 'voice call', language: 'RU', audio_url: null, transcript: [
    { timestamp: '2026-11-01T00:00:00Z', speaker: 'client', text: 'Где найти справку?' },
    { timestamp: '2026-11-01T00:00:01Z', speaker: 'operator', text: 'Здравствуйте! Я Дана. Откройте раздел Справка. Могу помочь ещё? До свидания.' },
  ] }] } });
  store.importDataset(dataset); store.saveChecklist(initialChecklist);
  const conversation = dataset.conversations[0];
  const range = { startMessageId: conversation.messages[0].id, endMessageId: conversation.messages[1].id };
  const results: CriterionResult[] = initialChecklist.criteria.map(c => ({ criterionId: c.id, answer: c.flag ? 'NO' : c.answerType === 'numeric' ? String(c.scaleMax) : 'YES', applicabilityRationale: '', explanation: 'Техническая тестовая запись; не экспертная разметка.', evidence: [{ messageId: conversation.messages[1].id, quote: 'Здравствуйте! Я Дана.' }], checkedRange: range, reviewRequired: false, uncertainty: '' }));
  const input = { conversationVersion: conversation.version, checklistVersion: initialChecklist.version, reviewer: 'Тестовый ввод', origin: 'agent_demo' as const, humanAttestation: false, requestId: 'manual-test-request', results };
  return { store, conversation, input };
}

test('manual call assessment never invokes fetch or a model and is explicitly a demo', () => {
  const { store, input } = setup();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('NETWORK_MUST_NOT_BE_USED'); };
  try {
    const evaluation = saveManualEvaluation(store, input);
    assert.equal(evaluation.status, 'manual_demo'); assert.equal(evaluation.origin, 'agent_demo');
    assert.equal(evaluation.providerCallCount, 0); assert.equal(evaluation.provider, 'local');
    assert.equal(evaluation.score.total, 100); assert.equal(evaluation.mode, 'local');
    assert.deepEqual(store.getEvaluation(evaluation.id), JSON.parse(JSON.stringify(evaluation)));
  } finally { globalThis.fetch = originalFetch; store.close(); }
});
test('human entry requires explicit attestation and cannot be confused with AI or agent demo', () => {
  const { store, input } = setup();
  assert.throws(() => saveManualEvaluation(store, { ...input, origin: 'human' }), /HUMAN_ATTESTATION_REQUIRED/);
  assert.throws(() => saveManualEvaluation(store, { ...input, humanAttestation: true }), /DEMO_CANNOT_ATTEST_HUMAN/);
  const result = saveManualEvaluation(store, { ...input, origin: 'human', humanAttestation: true });
  assert.equal(result.status, 'human_entered'); assert.equal(result.origin, 'human'); assert.equal(result.model, 'none');
  assert.equal(result.configuration.humanAttestation, true); store.close();
});
test('manual evidence and selected answers must satisfy the original rubric', () => {
  const { store, input } = setup();
  assert.throws(() => saveManualEvaluation(store, { ...input, results: input.results.slice(1) }), /criterion count/);
  assert.throws(() => saveManualEvaluation(store, { ...input, results: input.results.map((r, i) => i ? r : { ...r, answer: 'N/A' }) }), /rationale|scale/);
  assert.throws(() => saveManualEvaluation(store, { ...input, results: input.results.map((r, i) => i ? r : { ...r, evidence: [{ messageId: 'foreign', quote: 'Hello' }] }) }), /quotation/);
  assert.equal(store.listEvaluations().length, 0); store.close();
});
test('manual request retries are idempotent and changed payloads cannot overwrite history', () => {
  const { store, input } = setup();
  const result = saveManualEvaluation(store, input);
  assert.equal(saveManualEvaluation(store, input).id, result.id);
  assert.throws(() => saveManualEvaluation(store, { ...input, reviewer: 'Другой автор' }), /IDEMPOTENCY_CONFLICT/);
  assert.equal(store.listEvaluations().length, 1); store.close();
});
test('manual evaluation and appeal/review persist after database restart with no provider calls', () => {
  mkdirSync('tmp/tests', { recursive: true });
  const path = join(mkdtempSync(resolve('tmp/tests/cqa-manual-')), 'data.sqlite');
  const { store, input } = setup(path);
  const evaluation = saveManualEvaluation(store, input);
  const reviews = new ReviewStore(path);
  const appeal = reviews.createAppeal(evaluation, initialChecklist, { criterionId: 'C7', comment: 'Техническая апелляция.', requestId: 'manual-appeal-test' });
  const decision = reviews.decide(evaluation, initialChecklist, { appealId: appeal.id, action: 'change', answer: 'NO', reason: 'Техническая проверка пересчёта, не экспертный вывод.', requestId: 'manual-decision-test' });
  assert.equal(decision.finalScore.total, 95); reviews.close(); store.close();
  const reopened = new Store(path); const reopenedReviews = new ReviewStore(path);
  assert.equal(reopened.getEvaluation(evaluation.id)?.status, 'manual_demo');
  assert.equal(reopenedReviews.getHistory(reopened.getEvaluation(evaluation.id)!, initialChecklist).finalScore.total, 95);
  assert.equal(saveManualEvaluation(reopened, input).id, evaluation.id);
  reopened.close(); reopenedReviews.close();
});
