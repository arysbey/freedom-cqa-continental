import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { removeLocalTemp } from './local-temp.js';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { QualityStore, computeValidationMetrics, type HumanReference, type HumanJudgment, type ValidationManifest, type ValidationAttempt } from '../server/quality.js';
import { Store } from '../server/store.js';
import { parseOrganizerResponse } from '../server/importer.js';
import { initialChecklist } from '../src/checklist.js';
import { calculateScore } from '../src/scoring.js';
import type { Checklist, Conversation, CriterionResult, Evaluation } from '../src/domain.js';

// These are software-test fixtures, NOT actual human labels and NOT a production gold set.
const source: Conversation = { version: 'fixture-cv', conversationId: 'fixture', groupId: 'TEST', channel: 'agent chat', classification: 'synthetic_allowed', language: 'RU', audioAvailable: false, messages: [{ id: 'm0', position: 0, timestamp: '00:00', speaker: 'client', text: 'Question' }, { id: 'm1', position: 1, timestamp: '00:01', speaker: 'operator', text: 'Hello. Answer.' }] };
const checklist: Checklist = { id: 'fixture', version: 'fixture-v1', title: 'Fixture', criteria: [
  { id: 'C1', title: 'First', instructions: 'Fixture', weight: 20, answerType: 'boolean', allowedValues: ['YES', 'NO'], scaleMax: 1, naAllowed: true, naCondition: 'Fixture condition', section: 'Main', evidenceRequirement: 'Exact source', flag: false },
  { id: 'C2', title: 'Second', instructions: 'Fixture', weight: 30, answerType: 'boolean', allowedValues: ['YES', 'NO'], scaleMax: 1, naAllowed: true, naCondition: 'Fixture condition', section: 'Main', evidenceRequirement: 'Exact source', flag: false },
  { id: 'C3', title: 'Numeric', instructions: 'Fixture', weight: 50, answerType: 'numeric', allowedValues: ['0', '10'], scaleMax: 10, naAllowed: false, naCondition: '', section: 'Main', evidenceRequirement: 'Exact source', flag: false },
  { id: 'C8', title: 'Flag', instructions: 'Fixture', weight: 0, answerType: 'boolean', allowedValues: ['YES', 'NO'], scaleMax: 1, naAllowed: false, naCondition: '', section: 'Flag', evidenceRequirement: 'Exact source', flag: true },
] };
function results(answers = ['YES', 'NO', '10', 'NO'], conversation = source, rubric = checklist): CriterionResult[] {
  return rubric.criteria.map((criterion, index) => ({ criterionId: criterion.id, answer: answers[index], applicabilityRationale: 'Fixture condition.', explanation: 'Software fixture, not a human judgment.', evidence: [{ messageId: conversation.messages.at(-1)!.id, quote: conversation.messages.at(-1)!.text }], checkedRange: { startMessageId: conversation.messages[0].id, endMessageId: conversation.messages.at(-1)!.id }, reviewRequired: false, uncertainty: '' }));
}
function manifest(conversation = source, rubric = checklist): ValidationManifest {
  return { id: 'test-manifest', title: 'Software fixture only', createdAt: '2026-11-07T00:00:00.000Z', sourceRevision: 'fixture', model: 'gemini-3.1-flash-lite', selectionFrozen: true, priorTuningExcluded: [], cases: [{ id: 'case', conversationId: conversation.conversationId, conversationVersion: conversation.version, checklistVersion: rubric.version, language: conversation.language, split: 'development', kind: 'core', tags: ['fixture'], selectionReason: 'Software fixture only.' }] };
}
function model(answers = ['YES', 'NO', '10', 'NO'], id = 'eval', conversation = source, rubric = checklist): Evaluation {
  const r = results(answers, conversation, rubric);
  return { id, conversationVersion: conversation.version, checklistVersion: rubric.version, createdAt: '2026-11-07T01:00:00.000Z', status: 'live_validated', origin: 'ai', provider: 'gemini', model: 'gemini-3.1-flash-lite', mode: 'free', results: r, score: calculateScore(rubric, r), usage: { totalTokens: 100 }, latencyMs: 1000, providerCallCount: 1, configuration: { softwareFixture: true } };
}
function reference(answers = ['YES', 'NO', '10', 'NO']): HumanReference {
  const judgments = results(answers).map(r => ({ criterionId: r.criterionId, resolved: true, answer: r.answer, explanation: r.explanation, applicabilityRationale: r.applicabilityRationale, evidence: r.evidence, checkedRange: r.checkedRange }));
  return { id: 'ref', manifestId: 'test-manifest', caseId: 'case', conversationVersion: source.version, checklistVersion: checklist.version, origin: 'human_declared', humanAttestation: true, blindReviewAttested: true, reviewerId: 'software-fixture', createdAt: '2026-11-07T00:30:00.000Z', requestId: 'fixture-request', judgments, score: calculateScore(checklist, results(answers)) };
}
const attempt = (changes: Partial<ValidationAttempt> = {}): ValidationAttempt => ({ id: 'attempt', caseId: 'case', createdAt: '2026-11-07T01:00:00.000Z', model: 'gemini-3.1-flash-lite', status: 'success', evaluationId: 'eval', latencyMs: 1000, providerCallCount: 1, usage: { totalTokens: 100 }, ...changes });
const metrics = (refs: HumanReference[] = [], runs: ValidationAttempt[] = [attempt()], evals = [model()], m = manifest()) => computeValidationMetrics(m, refs, runs, evals, [source], [checklist]);

test('zero actual human references produces unavailable agreement and score errors, never fake zero accuracy', () => {
  const value = metrics();
  assert.equal(value.humanReviewedCases, 0); assert.equal(value.status, 'awaiting_human_review');
  assert.equal(value.byCriterion.C1.agreement, null); assert.equal(value.byLanguage.KZ.agreement, null);
  assert.equal(value.totalScoreError.meanAbsoluteError, null); assert.equal(value.grossViolations.available, false);
  assert.equal(value.evidence.evaluationValidity, 1); assert.equal(value.reliability.successes, 1);
});
test('criterion/language/split agreement, N/A confusion, score error and gross flags compare declared references only', () => {
  const value = metrics([reference(['N/A', 'YES', '10', 'YES'])], [attempt()], [model(['YES', 'N/A', '0', 'NO'])]);
  assert.equal(value.byCriterion.C1.matches, 0); assert.equal(value.byLanguage.RU.total, 4); assert.equal(value.bySplit.development.total, 4);
  assert.equal(value.na.falseNA, 1); assert.equal(value.na.missedNA, 1); assert.equal(value.grossViolations.falseNegative, 1);
  assert.equal(value.materialDisagreements.length, 4); assert(value.totalScoreError.meanAbsoluteError! > 0);
});
test('gross false positives and true negatives remain separate from numerical score', () => {
  const value = metrics([reference()], [attempt()], [model(['YES', 'NO', '10', 'YES'])]);
  assert.equal(value.grossViolations.falsePositive, 1); assert.equal(value.totalScoreError.maxAbsoluteError, 0);
});
test('unresolved judgments are excluded and partial references have no total-score comparison', () => {
  const ref = reference(); ref.judgments[1] = { ...ref.judgments[1], resolved: false, answer: null }; ref.score = null;
  const value = metrics([ref]); assert.equal(value.resolvedHumanJudgments, 3); assert.equal(value.unresolvedHumanJudgments, 1); assert.equal(value.byCriterion.C2.total, 0); assert.equal(value.totalScoreError.dialogs, 0);
});
test('agent/test origins, manual evaluations, wrong models and mismatched checklist versions never enter model agreement', () => {
  const badRef = { ...reference(), origin: 'agent_proposed' } as unknown as HumanReference;
  assert.equal(metrics([badRef]).humanReviewedCases, 0); assert.equal(metrics([badRef]).byCriterion.C1.agreement, null);
  for (const badModel of [{ ...model(), status: 'manual_demo' as const }, { ...model(), model: 'gemini-3.8-flash' }, { ...model(), checklistVersion: 'other' }]) assert.equal(metrics([reference()], [attempt()], [badModel]).comparedCases, 0);
});
test('invalid exact evidence is reported even when a supplied evaluation claims validated status', () => {
  const bad = model(); bad.results[0].evidence[0].quote = 'Invented quote';
  const value = metrics([], [attempt()], [bad]); assert.equal(value.evidence.evaluationsValid, 0); assert.equal(value.evidence.quotesValid, 3); assert.equal(value.evidence.quotesChecked, 4);
});
test('provider failures and unknown usage/call counts stay explicit, latency covers failures', () => {
  const value = metrics([], [attempt(), attempt({ id: 'failure', status: 'failed', evaluationId: undefined, errorCode: 'PROVIDER_TIMEOUT', latencyMs: 120000, usage: { totalTokens: null }, providerCallCount: null })]);
  assert.equal(value.reliability.failures, 1); assert.equal(value.reliability.errors.PROVIDER_TIMEOUT, 1); assert.equal(value.reliability.unknownTokenUsageAttempts, 1); assert.equal(value.reliability.unknownProviderCallAttempts, 1); assert.equal(value.reliability.reportedTokens, 100); assert.equal(value.reliability.latencyMs.p95, 120000);
});
test('latency median uses the conventional mean of the middle pair for even samples', () => {
  for (const [latencies, expected] of [[[], null], [[10], 10], [[30, 10], 20], [[40, 10, 30, 20], 25]] as Array<[number[], number | null]>) {
    const runs = latencies.map((latencyMs, index) => attempt({ id: `median-${index}`, latencyMs }));
    assert.equal(metrics([], runs).reliability.latencyMs.median, expected);
  }
});
test('semantic probes are reported separately rather than changing balanced core agreement', () => {
  const m = manifest(); m.cases[0].kind = 'semantic_probe';
  const value = metrics([reference()], [attempt()], [model()], m); assert.equal(value.byCriterion.C1.total, 0); assert.equal(value.semanticProbes[0].matches, 4);
});

test('first technically valid recorded result is fixed; reruns cannot cherry-pick agreement', () => {
  const first = model(); const later = model(['NO', 'YES', '0', 'YES'], 'later');
  const value = metrics([reference()], [attempt(), attempt({ id: 'later-attempt', evaluationId: later.id })], [later, first]);
  assert.equal(value.selectionPolicy, 'first-valid-in-recorded-run-order');
  assert.equal(value.byCriterion.C1.matches, 1); assert.equal(value.materialDisagreements.length, 0);
  const invalid = model(); invalid.results[0].evidence[0].quote = 'Invented';
  const accepted = metrics([reference()], [attempt(), attempt({ id: 'later-attempt', evaluationId: later.id })], [invalid, later]);
  assert.equal(accepted.coverage.excludedInvalidModelResults, 1); assert.equal(accepted.evidence.evaluationsChecked, 2);
  assert.equal(accepted.evidence.evaluationsValid, 1); assert.equal(accepted.byCriterion.C1.matches, 0);
  const rejectedOnly = metrics([reference()], [attempt()], [invalid]);
  assert.equal(rejectedOnly.comparedCases, 0); assert.equal(rejectedOnly.byCriterion.C1.agreement, null);
});

test('unresolved references and absent positives do not become reviewed cases or zero sensitivity', () => {
  const unresolved = reference(); unresolved.judgments = unresolved.judgments.map(j => ({ ...j, resolved: false, answer: null })); unresolved.score = null;
  const empty = metrics([unresolved]);
  assert.equal(empty.humanReviewedCases, 0); assert.equal(empty.comparedCases, 0); assert.equal(empty.status, 'awaiting_human_review');
  assert.equal(empty.coverage.casesWithReference, 1); assert.equal(empty.coverage.unannotatedJudgments, 4);
  const absent = metrics(); assert.equal(absent.coverage.casesWithoutReference, 1); assert.equal(absent.coverage.unannotatedJudgments, 4);
  const negative = metrics([reference()]);
  assert.equal(negative.grossViolations.referencePositives, 0); assert.equal(negative.grossViolations.recall, null);
  assert.equal(negative.grossViolations.precision, null); assert.equal(negative.grossViolations.specificity, 1);
  assert.equal(negative.na.missedNARate, null);
});

test('weighted-complete references permit score MAE while an independent flag remains unresolved', () => {
  const ref = reference(); ref.judgments[3] = { ...ref.judgments[3], resolved: false, answer: null }; ref.score = null;
  const value = metrics([ref]);
  assert.equal(value.totalScoreError.dialogs, 1); assert.equal(value.totalScoreError.meanAbsoluteError, 0);
  assert.equal(value.coverage.weightedCompleteCases, 1); assert.equal(value.coverage.fullyResolvedCases, 0);
  assert.equal(value.grossViolations.total, 0); assert.equal(value.byCriterion.C8.total, 0);
  const staleScore = reference(); staleScore.score!.total = 0;
  assert.equal(metrics([staleScore]).totalScoreError.meanAbsoluteError, 0, 'cached scores cannot change deterministic reference scoring');
});

test('semantic evidence judgments only count for selected evaluation, exact reference versions and resolved criterion', () => {
  const ref = reference(); ref.judgments[1] = { ...ref.judgments[1], resolved: false, answer: null }; ref.score = null;
  const review = { id: 'semantic-fixture', manifestId: 'test-manifest', caseId: 'case', evaluationId: 'eval', criterionId: 'C1', reviewerId: 'software-fixture', humanAttestation: true as const, verdict: 'supports' as const, category: 'evidence' as const, comment: 'Software fixture only.', createdAt: '2026-11-07T02:00:00.000Z', requestId: 'semantic-fixture' };
  const value = computeValidationMetrics(manifest(), [ref], [attempt()], [model()], [source], [checklist], [review, { ...review, id: 'wrong-evaluation', evaluationId: 'other' }, { ...review, id: 'unresolved', criterionId: 'C2' }]);
  assert.equal(value.evidence.humanSemantic.reviewed, 1); assert.equal(value.evidence.humanSemantic.supportRate, 1);
  const otherVersion = computeValidationMetrics(manifest(), [{ ...ref, checklistVersion: 'other' }], [attempt()], [model()], [source], [checklist], [review]);
  assert.equal(otherVersion.evidence.humanSemantic.reviewed, 0); assert.equal(otherVersion.humanReviewedCases, 0);
});

// The exact permitted synthetic source below is used only to test privacy gates and persistence.
const approvedRecord = { conversation_id: 'p1-ru-001', channel: 'agent chat', language: 'RU', audio_url: null, transcript: [
  { timestamp: '00:00', speaker: 'client', text: 'Где посмотреть мой тариф? В приложении не нахожу.' },
  { timestamp: '00:02', speaker: 'bot', text: 'Здравствуйте! Я AIM, AI-ассистент Freedom Broker. Я могу ответить на вопросы о продуктах и услугах, предоставить информацию по вашим счетам, активам и комиссиям, сравнить данные в таблице, отправить контакты вашего менеджера и передать вопрос специалистам поддержки.' },
  { timestamp: '00:03', speaker: 'bot', text: 'Продолжая разговор, Вы соглашаетесь на сбор и обработку персональных данных и подтверждаете, что ознакомились с Политикой конфиденциальности Компании.' },
  { timestamp: '00:08', speaker: 'bot', text: 'Тариф указан на первой странице отчёта брокера.' },
  { timestamp: '00:28', speaker: 'client', text: 'Я сейчас с ноутбука, отчёт качать не хочу. Можно оператора?' },
  { timestamp: '00:30', speaker: 'bot', text: 'Желаете, чтобы я соединил Вас с оператором?' },
  { timestamp: '00:35', speaker: 'client', text: 'да' },
  { timestamp: '00:36', speaker: 'bot', text: 'Пожалуйста, ожидайте. Оператор скоро подключится к чату.' },
  { timestamp: '00:38', speaker: 'system', text: 'Эскалация на оператора.' },
  { timestamp: '01:15', speaker: 'operator', text: 'Здравствуйте! Меня зовут Алина. В веб-версии откройте вкладку «Кабинет». Название тарифа будет под вашим ФИО.' },
  { timestamp: '01:28', speaker: 'client', text: 'Нашла, спасибо.' },
  { timestamp: '02:04', speaker: 'operator', text: 'Пожалуйста. Хорошего вечера!' },
] };
function persistentFixture() {
  mkdirSync(resolve('tmp'), { recursive: true }); const path = mkdtempSync(join(resolve('tmp'), 'quality-')); const dbPath = join(path, 'quality.sqlite');
  const store = new Store(dbPath); const quality = new QualityStore(dbPath);
  const parsed = parseOrganizerResponse({ error: '', isSuccess: true, data: { dataset_group_id: 'DEV', total_records: 1, records: [approvedRecord] } });
  store.importDataset(parsed); store.saveChecklist(initialChecklist);
  const conversation = parsed.conversations[0]; const m = manifest(conversation, initialChecklist); quality.saveManifest(m, [conversation], initialChecklist);
  const full = results(['YES', 'N/A', 'N/A', '20', 'YES', '10', 'NO', 'NO'], conversation, initialChecklist);
  const judgments: HumanJudgment[] = full.map(r => ({ criterionId: r.criterionId, resolved: true, answer: r.answer, explanation: r.explanation, applicabilityRationale: r.applicabilityRationale, evidence: r.evidence, checkedRange: r.checkedRange }));
  const input = { manifestId: m.id, caseId: 'case', reviewerId: 'software-fixture-only', origin: 'human_declared' as const, humanAttestation: true as const, blindReviewAttested: true as const, requestId: 'fixture-human-request', judgments };
  const e = model(['YES', 'N/A', 'N/A', '20', 'YES', '10', 'NO', 'NO'], 'fixture-live-evaluation', conversation, initialChecklist); store.saveEvaluation(e);
  return { path, dbPath, store, quality, conversation, m, input, evaluation: e, close() { quality.close(); store.close(); removeLocalTemp(path); } };
}

test('numeric score visibility cannot leak an unresolved independent flag through rows or flags', () => {
  const f = persistentFixture();
  try {
    f.quality.recordRun(f.m.id, attempt({ evaluationId: f.evaluation.id }), f.store);
    const input = structuredClone(f.input); input.judgments = input.judgments.map(j => j.criterionId === 'C8' ? { ...j, resolved: false, answer: null, evidence: [], checkedRange: null } : j);
    const ref = f.quality.saveReference(f.conversation, initialChecklist, input);
    assert.equal(ref.score, null, 'stored immutable reference retains existing full-score semantics');
    const view = f.quality.getCase(f.m.id, 'case', f.store);
    assert.notEqual(view.referenceNumericScore, null); assert.notEqual(view.modelEvaluation?.score, null);
    assert.equal(JSON.stringify(view.modelEvaluation).includes('C8'), false);
    assert.equal(f.quality.getDashboard(f.store).metrics?.totalScoreError.dialogs, 1);
    const exported = f.quality.exportComparison(f.store, f.m.id, '2030-01-01T00:00:00.000Z');
    assert.equal(exported.comparisons.length, 7); assert.equal(exported.comparisons.some(c => c.criterionId === 'C8'), false);
    assert.equal(exported.comparisons[0].human.resolved, true); assert.equal(exported.comparisons[0].matches, true);
  } finally { f.close(); }
});

test('comparison export is reproducible, cutoff-bound, private and does not reveal unresolved model answers', () => {
  const f = persistentFixture();
  try {
    f.quality.recordRun(f.m.id, attempt({ evaluationId: f.evaluation.id }), f.store);
    const cutoff = '2030-01-01T00:00:00.000Z';
    const first = f.quality.exportComparison(f.store, f.m.id, cutoff);
    const second = f.quality.exportComparison(f.store, f.m.id, cutoff);
    assert.equal(first.reportHash, second.reportHash); assert.equal(first.manifestHash.length, 64);
    assert.equal(first.metrics.humanReviewedCases, 0); assert.equal(first.metrics.totalScoreError.meanAbsoluteError, null);
    assert.equal(first.provenance.cases[0].selectedEvaluation?.id, f.evaluation.id);
    assert.equal(JSON.stringify(first).includes('Software fixture, not a human judgment.'), false);
    assert.equal(first.provenance.cases[0].sourceHash?.length, 64);
    const before = f.quality.exportComparison(f.store, f.m.id, '2026-11-07T00:30:00.000Z');
    assert.equal(before.provenance.cases[0].selectedEvaluation, null); assert.equal(before.metrics.reliability.attempts, 0);
    assert.throws(() => f.quality.exportComparison(f.store, f.m.id, 'invalid'));
    assert.throws(() => f.quality.exportComparison(f.store, f.m.id, '2026-11-06T00:00:00.000Z'), /CUTOFF/);
    const readonly = new QualityStore(f.dbPath, { readOnly: true });
    try { assert.equal(readonly.exportComparison(f.store, f.m.id, cutoff).reportHash, first.reportHash); }
    finally { readonly.close(); }
  } finally { f.close(); }
});
test('manifest source permission, frozen content and exclusion of prior tuning cases are enforced', () => {
  const q = new QualityStore(':memory:');
  try {
    assert.throws(() => q.saveManifest(manifest(), [source], checklist), /RESTRICTED/);
  } finally { q.close(); }
  const f = persistentFixture();
  try {
    assert.throws(() => f.quality.saveManifest({ ...f.m, title: 'Changed' }, [f.conversation], initialChecklist), /IMMUTABLE/);
    assert.throws(() => f.quality.saveManifest({ ...f.m, id: 'other', priorTuningExcluded: [f.conversation.conversationId] }, [f.conversation], initialChecklist), /TUNING_CASE/);
  } finally { f.close(); }
});
test('human attestation, source evidence and criterion identities are mandatory; agent origins rejected', () => {
  const f = persistentFixture();
  try {
    for (const patch of [{ origin: 'agent_proposed' }, { humanAttestation: false }, { blindReviewAttested: false }]) assert.throws(() => f.quality.saveReference(f.conversation, initialChecklist, { ...f.input, ...patch }));
    const forged = structuredClone(f.input); forged.judgments[0].evidence[0].quote = 'Fabricated'; assert.throws(() => f.quality.saveReference(f.conversation, initialChecklist, forged), /quotation/);
    assert.throws(() => f.quality.saveReference(f.conversation, initialChecklist, { ...f.input, judgments: f.input.judgments.slice(1) }), /CRITERIA/);
    assert.equal(f.quality.getReference(f.m.id, 'case'), undefined);
  } finally { f.close(); }
});
test('partial blind references reveal only fixed judgments, preserve snapshots and support exact retries', () => {
  const f = persistentFixture();
  try {
    f.quality.recordRun(f.m.id, attempt({ evaluationId: f.evaluation.id }), f.store);
    assert.equal(f.quality.getCase(f.m.id, 'case', f.store).modelEvaluation, null);
    const input = structuredClone(f.input); input.judgments = input.judgments.map((j, i) => i === 0 ? j : { ...j, resolved: false, answer: null, evidence: [], checkedRange: null });
    const saved = f.quality.saveReference(f.conversation, initialChecklist, input);
    assert.equal(saved.score, null); assert.equal(f.quality.saveReference(f.conversation, initialChecklist, input).id, saved.id);
    const view = f.quality.getCase(f.m.id, 'case', f.store); assert.equal(view.modelEvaluation?.results.length, 1); assert.equal(view.modelEvaluation?.score, null);
    const changed = structuredClone(input); changed.requestId = 'changed'; changed.judgments[0].answer = 'NO'; assert.throws(() => f.quality.saveReference(f.conversation, initialChecklist, changed), /FROZEN/);
    const completed = { ...f.input, requestId: 'completion' }; assert(f.quality.saveReference(f.conversation, initialChecklist, completed).score);
    assert.equal(f.quality.getCase(f.m.id, 'case', f.store).modelEvaluation?.results.length, 8);
    assert.throws(() => f.quality.saveReference(f.conversation, initialChecklist, { ...completed, reviewerId: 'different' }), /IDEMPOTENCY/);
  } finally { f.close(); }
});
test('model-result linking rejects manual/other-model sources and preserves runs immutably', () => {
  const f = persistentFixture();
  try {
    assert.throws(() => f.quality.recordRun(f.m.id, attempt({ model: 'gemini-3.8-flash', evaluationId: f.evaluation.id }), f.store), /MISMATCH/);
    f.store.saveEvaluation({ ...f.evaluation, id: 'manual', status: 'manual_demo', origin: 'agent_demo', provider: 'local', mode: 'local' });
    assert.throws(() => f.quality.recordRun(f.m.id, attempt({ evaluationId: 'manual' }), f.store), /MISMATCH/);
    const a = attempt({ evaluationId: f.evaluation.id }); f.quality.recordRun(f.m.id, a, f.store); f.quality.recordRun(f.m.id, a, f.store);
    assert.equal(f.quality.listRuns(f.m.id).length, 1); assert.throws(() => f.quality.recordRun(f.m.id, { ...a, latencyMs: 5 }, f.store), /IMMUTABLE/);
  } finally { f.close(); }
});
test('updated imports preserve frozen manifest source and technical evidence metrics for historical versions', () => {
  const f = persistentFixture();
  try {
    f.quality.recordRun(f.m.id, attempt({ evaluationId: f.evaluation.id }), f.store);
    const before = f.quality.getDashboard(f.store, f.m.id);
    assert.equal(before.metrics?.evidence.evaluationsChecked, 1);
    const changed = structuredClone(approvedRecord);
    changed.transcript.at(-1)!.text += ' Software test source revision.';
    const imported = parseOrganizerResponse({ error: '', isSuccess: true, data: { dataset_group_id: 'DEV', total_records: 1, records: [changed] } });
    f.store.importDataset(imported);
    assert.notEqual(f.store.listConversations('DEV')[0].version, f.conversation.version);
    assert.equal(f.quality.getCase(f.m.id, 'case', f.store).conversation.version, f.conversation.version);
    const after = f.quality.getDashboard(f.store, f.m.id);
    assert.deepEqual(after.metrics?.evidence, before.metrics?.evidence);
    assert.equal(after.metrics?.evidence.evaluationsValid, 1);
    assert.equal(after.metrics?.humanReviewedCases, 0);
  } finally { f.close(); }
});
test('human semantic evidence judgments require a prior blind reference and survive restart with append-only history', () => {
  const f = persistentFixture();
  let closed = false;
  try {
    const input = { manifestId: f.m.id, caseId: 'case', evaluationId: f.evaluation.id, criterionId: 'C1', reviewerId: 'software-fixture-only', humanAttestation: true, verdict: 'supports', category: 'evidence', comment: 'Software fixture, not actual semantic review.', requestId: 'evidence-fixture' };
    assert.throws(() => f.quality.saveEvidenceReview(input, f.store), /BLIND_REFERENCE/);
    const ref = f.quality.saveReference(f.conversation, initialChecklist, f.input); const review = f.quality.saveEvidenceReview(input, f.store);
    assert.equal(f.quality.saveEvidenceReview(input, f.store).id, review.id);
    f.quality.close(); f.store.close(); closed = true;
    const reopened = new QualityStore(f.dbPath); const reopenedStore = new Store(f.dbPath);
    assert.equal(reopened.getReference(f.m.id, 'case')?.id, ref.id); assert.equal(reopened.listEvidenceReviews(f.m.id)[0].id, review.id);
    const direct = new DatabaseSync(f.dbPath); assert.throws(() => direct.exec('DELETE FROM quality_references'), /append-only/); direct.close(); reopened.close(); reopenedStore.close();
  } finally { if (!closed) { f.quality.close(); f.store.close(); } removeLocalTemp(f.path); }
});

test('fresh manifest review round clears current progress without deleting history, model results or another manifest', () => {
  const f = persistentFixture();
  try {
    f.quality.recordRun(f.m.id, attempt({ evaluationId: f.evaluation.id }), f.store);
    const original = f.quality.saveReference(f.conversation, initialChecklist, f.input);
    const semantic = f.quality.saveEvidenceReview({ manifestId: f.m.id, caseId: 'case', evaluationId: f.evaluation.id, criterionId: 'C1', reviewerId: 'software-fixture-only', humanAttestation: true, verdict: 'supports', category: 'evidence', comment: 'Isolated software fixture, not real human review.', requestId: 'old-semantic' }, f.store);
    const otherManifest = { ...f.m, id: 'other-manifest' }; f.quality.saveManifest(otherManifest, [f.conversation], initialChecklist);
    const other = f.quality.saveReference(f.conversation, initialChecklist, { ...f.input, manifestId: otherManifest.id, requestId: 'other-reference' });
    const before = f.quality.exportComparison(f.store, f.m.id, semantic.createdAt);
    assert.equal(before.metrics.humanReviewedCases, 1); assert.equal(before.metrics.evidence.humanSemantic.reviewed, 1);
    const round = f.quality.startFreshReviewRound({ manifestId: f.m.id, reviewerId: 'software-fixture-reset-actor', requestId: 'reset-fixture', expectedRoundId: 'legacy' });
    assert.equal(round.previousRoundId, 'legacy'); assert.deepEqual(round.supersededReviewerIds, ['software-fixture-only']);
    assert.match(round.note, /does not restore blindness/);
    const dashboard = f.quality.getDashboard(f.store, f.m.id);
    assert.equal(dashboard.reviewRound?.id, round.id); assert.equal(dashboard.referenceCount, 0);
    assert.equal(dashboard.metrics?.humanReviewedCases, 0); assert.equal(dashboard.metrics?.byCriterion.C1.agreement, null);
    assert.equal(dashboard.metrics?.totalScoreError.meanAbsoluteError, null); assert.equal(dashboard.metrics?.evidence.humanSemantic.reviewed, 0);
    assert.equal(f.quality.getCase(f.m.id, 'case', f.store).modelEvaluation, null);
    assert.equal(f.quality.getReference(f.m.id, 'case'), undefined);
    assert.equal(f.quality.listReferenceHistory(f.m.id)[0].id, original.id); assert.equal(f.quality.listReferences(f.m.id, { includeSuperseded: true }).length, 1);
    assert.equal(f.quality.listEvidenceReviewHistory(f.m.id)[0].id, semantic.id); assert.equal(f.quality.listEvidenceReviews(f.m.id).length, 0);
    assert.equal(f.quality.getReference(otherManifest.id, 'case')?.id, other.id); assert.equal(f.quality.getReviewRound(otherManifest.id).id, 'legacy');
    assert.equal(f.store.getEvaluation(f.evaluation.id)?.id, f.evaluation.id); assert.deepEqual(f.quality.getManifest(f.m.id), f.m);
    assert.equal(f.quality.exportComparison(f.store, f.m.id, semantic.createdAt).reportHash, before.reportHash, 'a pre-reset cutoff stays exactly reproducible');
    const current = f.quality.exportComparison(f.store, f.m.id, round.createdAt!);
    assert.equal(current.reviewRound.id, round.id); assert.equal(current.metrics.humanReviewedCases, 0); assert.equal(current.provenance.referenceHistory.length, 1);
    assert.equal(current.provenance.referenceHistory[0].includedInCurrentRound, false);
  } finally { f.close(); }
});

test('new review round rejects stale retries and permits new partial human inputs with untouched blanks', () => {
  const f = persistentFixture();
  try {
    f.quality.recordRun(f.m.id, attempt({ evaluationId: f.evaluation.id }), f.store);
    const original = f.quality.saveReference(f.conversation, initialChecklist, f.input);
    const resetInput = { manifestId: f.m.id, reviewerId: 'software-fixture-only', requestId: 'fresh-reset', expectedRoundId: 'legacy' };
    const round = f.quality.startFreshReviewRound(resetInput);
    assert.equal(f.quality.startFreshReviewRound(resetInput).id, round.id, 'exact reset retry is idempotent while still active');
    assert.throws(() => f.quality.saveReference(f.conversation, initialChecklist, f.input), /REVIEW_ROUND_CHANGED/);
    assert.throws(() => f.quality.saveReference(f.conversation, initialChecklist, { ...f.input, requestId: 'explicit-old-round', reviewRoundId: 'legacy' }), /REVIEW_ROUND_CHANGED/);
    const freshInput = { ...structuredClone(f.input), requestId: 'fresh-partial', reviewRoundId: round.id };
    freshInput.judgments = freshInput.judgments.map((judgment, index) => index === 0 ? judgment : { ...judgment, resolved: false, answer: null, explanation: '', applicabilityRationale: '', evidence: [], checkedRange: null });
    const invalid = structuredClone(freshInput); invalid.judgments[0].explanation = '';
    assert.throws(() => f.quality.saveReference(f.conversation, initialChecklist, invalid), /explanation/);
    const fresh = f.quality.saveReference(f.conversation, initialChecklist, freshInput);
    assert.equal(fresh.reviewRoundId, round.id); assert.notEqual(fresh.id, original.id); assert.equal(fresh.judgments[1].explanation, '');
    assert.equal(f.quality.saveReference(f.conversation, initialChecklist, freshInput).id, fresh.id);
    assert.equal(f.quality.listReferenceHistory(f.m.id).length, 2); assert.equal(f.quality.listReferences(f.m.id).length, 1);
    const modelView = f.quality.getCase(f.m.id, 'case', f.store).modelEvaluation;
    assert.equal(modelView?.results.length, 1); assert.equal(modelView?.score, null);
    assert.throws(() => f.quality.saveEvidenceReview({ manifestId: f.m.id, caseId: 'case', evaluationId: f.evaluation.id, criterionId: 'C1', reviewerId: 'software-fixture-only', humanAttestation: true, verdict: 'supports', category: 'evidence', comment: 'Software fixture.', requestId: 'missing-round-review' }, f.store), /REVIEW_ROUND_CHANGED/);
    const second = f.quality.startFreshReviewRound({ ...resetInput, requestId: 'second-reset', expectedRoundId: round.id });
    assert.equal(second.previousRoundId, round.id);
    assert.throws(() => f.quality.startFreshReviewRound(resetInput), /REVIEW_ROUND_CHANGED/, 'a superseded reset retry cannot claim to be current');
    assert.throws(() => f.quality.saveReference(f.conversation, initialChecklist, freshInput), /REVIEW_ROUND_CHANGED/, 'old idempotent reference retry stays stale after another round');
    assert.equal(f.quality.listReviewRounds(f.m.id).length, 2);
  } finally { f.close(); }
});

test('active review round and immutable old references survive restart', () => {
  const f = persistentFixture(); let closed = false;
  try {
    const reference = f.quality.saveReference(f.conversation, initialChecklist, f.input);
    const round = f.quality.startFreshReviewRound({ manifestId: f.m.id, reviewerId: 'software-fixture-only', requestId: 'persistent-reset', expectedRoundId: 'legacy' });
    f.quality.close(); f.store.close(); closed = true;
    const reopened = new QualityStore(f.dbPath); const store = new Store(f.dbPath);
    try {
      assert.equal(reopened.getReviewRound(f.m.id).id, round.id); assert.equal(reopened.listReferences(f.m.id).length, 0);
      assert.equal(reopened.listReferenceHistory(f.m.id)[0].id, reference.id); assert.equal(reopened.getDashboard(store).metrics?.humanReviewedCases, 0);
      const direct = new DatabaseSync(f.dbPath);
      try { for (const table of ['quality_references', 'quality_review_rounds']) for (const operation of ['DELETE FROM', 'UPDATE']) assert.throws(() => direct.exec(operation === 'UPDATE' ? `UPDATE ${table} SET json='{}'` : `DELETE FROM ${table}`), /append-only/); }
      finally { direct.close(); }
    } finally { reopened.close(); store.close(); }
  } finally { if (!closed) { f.quality.close(); f.store.close(); } removeLocalTemp(f.path); }
});
