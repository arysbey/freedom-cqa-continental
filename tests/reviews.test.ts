import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { initialChecklist } from '../src/checklist.js';
import type { Checklist, CriterionResult, Evaluation } from '../src/domain.js';
import { calculateScore } from '../src/scoring.js';
import { ReviewStore } from '../server/reviews.js';

// A software-test fixture only; it is never exposed as a live model result.
function fixture(id = 'test-only-evaluation'): Evaluation {
  const values = ['YES', 'YES', 'YES', '20', 'YES', '10', 'NO', 'NO'];
  const results: CriterionResult[] = values.map((answer, index) => ({
    criterionId: `C${index + 1}`, answer, applicabilityRationale: 'Applicable test condition.',
    explanation: 'Software-test-only rationale.', evidence: [{ messageId: 'test-message', quote: 'Test' }],
    checkedRange: null, reviewRequired: false, uncertainty: '',
  }));
  return {
    id, createdAt: '2026-11-07T00:00:00.000Z', conversationVersion: 'test-conversation',
    checklistVersion: initialChecklist.version, provider: 'test-double', model: 'test-only', mode: 'free',
    status: 'live_validated', results, score: calculateScore(initialChecklist, results),
    usage: {}, latencyMs: 0, providerCallCount: 0, configuration: { fixture: true },
  };
}

test('appeal preserves original result and an upheld answer requires a reason', () => {
  const store = new ReviewStore(':memory:');
  try {
    const evaluation = fixture();
    const original = JSON.stringify(evaluation);
    const appeal = store.createAppeal(evaluation, initialChecklist, { criterionId: 'C7', comment: 'Please review closing.', requestId: 'a1' });
    assert.equal(appeal.originalAnswer, 'NO');
    assert.equal(appeal.contestedAnswer, 'NO');
    assert.deepEqual(appeal.originalResult, evaluation.results[6]);
    assert.throws(() => store.decide(evaluation, initialChecklist, { appealId: appeal.id, action: 'uphold', reason: ' ', requestId: 'd-empty' }));
    const decision = store.decide(evaluation, initialChecklist, { appealId: appeal.id, action: 'uphold', reason: 'Closing was omitted.', requestId: 'd1' });
    assert.equal(decision.answer, 'NO');
    assert.equal(decision.finalScore.total, 95);
    assert.equal(store.getHistory(evaluation, initialChecklist).finalScore.total, 95);
    assert.equal(JSON.stringify(evaluation), original);
  } finally { store.close(); }
});

test('changed answer recalculates total and original model assessment remains unchanged', () => {
  const store = new ReviewStore(':memory:');
  try {
    const evaluation = fixture();
    const appeal = store.createAppeal(evaluation, initialChecklist, { criterionId: 'C7', comment: 'The final reply contains closing.', requestId: 'a1' });
    const decision = store.decide(evaluation, initialChecklist, { appealId: appeal.id, action: 'change', answer: 'YES', reason: 'Confirmed final reply.', requestId: 'd1' });
    assert.equal(decision.previousAnswer, 'NO');
    assert.equal(decision.answer, 'YES');
    assert.equal(decision.finalScore.total, 100);
    const history = store.getHistory(evaluation, initialChecklist);
    assert.equal(history.appeals.length, 1);
    assert.equal(history.decisions.length, 1);
    assert.equal(history.finalAnswers.C7, 'YES');
    assert.equal(history.finalScore.total, 100);
    assert.equal(evaluation.results[6].answer, 'NO');
    assert.equal(evaluation.score.total, 95);
  } finally { store.close(); }
});

test('N/A revision uses original applicability configuration and changes denominator', () => {
  const store = new ReviewStore(':memory:');
  try {
    const evaluation = fixture();
    const appeal = store.createAppeal(evaluation, initialChecklist, { criterionId: 'C3', comment: 'Public request.', requestId: 'a1' });
    const decision = store.decide(evaluation, initialChecklist, { appealId: appeal.id, action: 'change', answer: 'N/A', reason: 'Identification was not required.', requestId: 'd1' });
    assert.equal(decision.finalScore.applicableWeight, 80);
    assert.equal(decision.finalScore.total, 93.75);
  } finally { store.close(); }
});

test('flag revision stays independent of numeric total', () => {
  const store = new ReviewStore(':memory:');
  try {
    const evaluation = fixture();
    const appeal = store.createAppeal(evaluation, initialChecklist, { criterionId: 'C8', comment: 'Violation evidence.', requestId: 'a1' });
    const decision = store.decide(evaluation, initialChecklist, { appealId: appeal.id, action: 'change', answer: 'YES', reason: 'Direct disclosure confirmed.', requestId: 'd1' });
    assert.equal(decision.finalScore.total, 95);
    assert.equal(decision.finalScore.flags.C8, true);
  } finally { store.close(); }
});

test('request replay returns the same appeal and decision, including after resolution', () => {
  const store = new ReviewStore(':memory:');
  try {
    const evaluation = fixture();
    const input = { criterionId: 'C7', comment: 'Review.', requestId: 'a1' };
    const appeal = store.createAppeal(evaluation, initialChecklist, input);
    assert.deepEqual(store.createAppeal(evaluation, initialChecklist, input), appeal);
    const choice = { appealId: appeal.id, action: 'change' as const, answer: 'YES', reason: 'Confirmed.', requestId: 'd1' };
    const decision = store.decide(evaluation, initialChecklist, choice);
    assert.equal(store.decide(evaluation, initialChecklist, choice).id, decision.id);
    assert.deepEqual(store.createAppeal(evaluation, initialChecklist, input), appeal);
    assert.equal(store.getHistory(evaluation, initialChecklist).decisions.length, 1);
    assert.throws(() => store.createAppeal(evaluation, initialChecklist, { ...input, comment: 'Different.' }), /IDEMPOTENCY_CONFLICT/);
    assert.throws(() => store.decide(evaluation, initialChecklist, { ...choice, reason: 'Different.' }), /IDEMPOTENCY_CONFLICT/);
    assert.throws(() => store.decide(evaluation, initialChecklist, { ...choice, requestId: 'd2' }), /APPEAL_ALREADY_REVIEWED/);
  } finally { store.close(); }
});

test('reject invalid review answers, missing comments and unknown criteria without persisting failures', () => {
  const store = new ReviewStore(':memory:');
  try {
    const evaluation = fixture();
    assert.throws(() => store.createAppeal(evaluation, initialChecklist, { criterionId: 'unknown', comment: 'Review.', requestId: 'unknown' }), /UNKNOWN_CRITERION/);
    assert.throws(() => store.createAppeal(evaluation, initialChecklist, { criterionId: 'C1', comment: '', requestId: 'empty' }));
    const appeal = store.createAppeal(evaluation, initialChecklist, { criterionId: 'C1', comment: 'Review.', requestId: 'a1' });
    const choice = { appealId: appeal.id, action: 'change' as const, answer: 'N/A', reason: 'Review.', requestId: 'd1' };
    assert.throws(() => store.decide(evaluation, initialChecklist, choice), /N\/A is not allowed/);
    assert.throws(() => store.decide(evaluation, initialChecklist, { ...choice, answer: 'MAYBE' }), /outside allowed values/);
    assert.throws(() => store.decide(evaluation, initialChecklist, { ...choice, answer: 'YES' }), /CHANGED_ANSWER_MUST_DIFFER/);
    assert.throws(() => store.decide(evaluation, initialChecklist, { ...choice, action: 'uphold' }));
    assert.throws(() => store.decide(evaluation, initialChecklist, { appealId: 'unknown', action: 'uphold', reason: 'Review.', requestId: 'unknown-decision' }), /APPEAL_NOT_FOUND/);
    assert.equal(store.getHistory(evaluation, initialChecklist).decisions.length, 0);
    assert.equal(store.getHistory(evaluation, initialChecklist).appeals.length, 1);
    // Failed attempts do not consume the request ID.
    assert.equal(store.decide(evaluation, initialChecklist, { ...choice, answer: 'NO' }).answer, 'NO');
  } finally { store.close(); }
});

test('source snapshots reject changed checklist semantics, versions and original evaluations', () => {
  const store = new ReviewStore(':memory:');
  try {
    const evaluation = fixture();
    store.getHistory(evaluation, initialChecklist);
    const changed = structuredClone(initialChecklist);
    changed.criteria[0].instructions = 'A new materially different condition.';
    assert.throws(() => store.getHistory(evaluation, changed), /IMMUTABLE_REVIEW_SOURCE_CHANGED/);
    changed.version = 'v2';
    assert.throws(() => store.getHistory(evaluation, changed), /CHECKLIST_VERSION_MISMATCH/);
    const altered = structuredClone(evaluation);
    altered.results[0].explanation = 'Changed original explanation.';
    assert.throws(() => store.getHistory(altered, initialChecklist), /IMMUTABLE_REVIEW_SOURCE_CHANGED/);
    const wrongScore = { ...evaluation, score: { ...evaluation.score, total: 50 } };
    assert.throws(() => store.getHistory(wrongScore, initialChecklist), /ORIGINAL_SCORE_MISMATCH/);
  } finally { store.close(); }
});

test('multiple successive reviews retain each outcome and reject stale competing appeals', () => {
  const store = new ReviewStore(':memory:');
  try {
    const evaluation = fixture();
    const first = store.createAppeal(evaluation, initialChecklist, { criterionId: 'C7', comment: 'First.', requestId: 'a1' });
    const stale = store.createAppeal(evaluation, initialChecklist, { criterionId: 'C7', comment: 'Competing.', requestId: 'a2' });
    store.decide(evaluation, initialChecklist, { appealId: first.id, action: 'change', answer: 'YES', reason: 'Confirmed.', requestId: 'd1' });
    assert.throws(() => store.decide(evaluation, initialChecklist, { appealId: stale.id, action: 'uphold', reason: 'Outdated.', requestId: 'stale' }), /STALE_APPEAL/);
    const second = store.createAppeal(evaluation, initialChecklist, { criterionId: 'C7', comment: 'Second.', requestId: 'a3' });
    assert.equal(second.originalAnswer, 'NO');
    assert.equal(second.contestedAnswer, 'YES');
    store.decide(evaluation, initialChecklist, { appealId: second.id, action: 'change', answer: 'NO', reason: 'Reconsidered.', requestId: 'd2' });
    const history = store.getHistory(evaluation, initialChecklist);
    assert.deepEqual(history.decisions.map(d => d.finalScore.total), [100, 95]);
    assert.equal(history.finalScore.total, 95);
  } finally { store.close(); }
});

test('appeals cannot be reviewed using a different evaluation', () => {
  const store = new ReviewStore(':memory:');
  try {
    const first = fixture('first');
    const second = fixture('second');
    const appeal = store.createAppeal(first, initialChecklist, { criterionId: 'C7', comment: 'Review.', requestId: 'a1' });
    assert.throws(() => store.decide(second, initialChecklist, { appealId: appeal.id, action: 'uphold', reason: 'Wrong evaluation.', requestId: 'd1' }), /APPEAL_NOT_FOUND/);
    assert.equal(store.getHistory(second, initialChecklist).appeals.length, 0);
  } finally { store.close(); }
});

test('persistent audit survives database close/reopen and SQL UPDATE/DELETE is blocked', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cqa-reviews-'));
  const path = join(directory, 'reviews.sqlite');
  let store: ReviewStore | undefined = new ReviewStore(path);
  try {
    const evaluation = fixture();
    const appeal = store.createAppeal(evaluation, initialChecklist, { criterionId: 'C7', comment: 'Review.', requestId: 'a1' });
    const choice = { appealId: appeal.id, action: 'change' as const, answer: 'YES', reason: 'Verified.', requestId: 'd1' };
    const decision = store.decide(evaluation, initialChecklist, choice);
    store.close();
    store = new ReviewStore(path);
    assert.equal(store.getHistory(evaluation, initialChecklist).finalScore.total, 100);
    assert.equal(store.getHistory(evaluation, initialChecklist).appeals[0].id, appeal.id);
    assert.equal(store.decide(evaluation, initialChecklist, choice).id, decision.id);
    const db = new DatabaseSync(path);
    try {
      assert.throws(() => db.prepare('DELETE FROM review_appeals WHERE id = ?').run(appeal.id), /append-only/);
      assert.throws(() => db.prepare('UPDATE review_decisions SET json = ? WHERE id = ?').run('{}', decision.id), /append-only/);
    } finally { db.close(); }
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('numeric appeals use the original configured scale, including new custom criteria', () => {
  const checklist: Checklist = structuredClone(initialChecklist);
  checklist.version = 'custom-v1';
  checklist.criteria.push({ ...checklist.criteria[5], id: 'custom', title: 'Custom criterion', weight: 10, allowedValues: ['0', '0.5', '2'], scaleMax: 2 });
  const evaluation = fixture();
  evaluation.checklistVersion = checklist.version;
  evaluation.results.push({ ...evaluation.results[5], criterionId: 'custom', answer: '0' });
  evaluation.score = calculateScore(checklist, evaluation.results);
  const store = new ReviewStore(':memory:');
  try {
    const appeal = store.createAppeal(evaluation, checklist, { criterionId: 'custom', comment: 'Custom review.', requestId: 'a1' });
    assert.throws(() => store.decide(evaluation, checklist, { appealId: appeal.id, action: 'change', answer: '1', reason: 'Invalid value.', requestId: 'd1' }));
    const decision = store.decide(evaluation, checklist, { appealId: appeal.id, action: 'change', answer: '0.5', reason: 'Configured scale step.', requestId: 'd1' });
    assert.equal(decision.finalScore.total, 88.64);
    assert.equal(evaluation.results.at(-1)?.answer, '0');
  } finally { store.close(); }
});
