import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app.js';
import { config } from '../server/config.js';
import { Store } from '../server/store.js';
import { ReviewStore } from '../server/reviews.js';
import { isApprovedSyntheticConversation, parseOrganizerResponse } from '../server/importer.js';
import { GeminiProvider, getProviderConfigurationIdentity, type ProviderTelemetry, type ProviderTransport } from '../server/provider.js';
import { publicAttempt, recoveryPolicy } from '../server/recovery.js';
import { interruptRecordedAttempts, probeExecutorPid } from '../server/interrupted-attempts.js';
import { initialChecklist } from '../src/checklist.js';
import { calculateScore } from '../src/scoring.js';
import type { Checklist, Conversation, CriterionResult, Evaluation, EvaluationAttempt } from '../src/domain.js';
import { approvedSyntheticRecord } from './synthetic-fixture.js';
import { removeLocalTemp } from './local-temp.js';

const headers = { host: 'localhost:3001', origin: 'http://localhost:3001', 'content-type': 'application/json' };
const checklist: Checklist = { ...initialChecklist, version: 'recovery-software-checklist-v1', criteria: [initialChecklist.criteria[0]] };
const testKey = 'non-live-recovery-test-key';
const secretSource = 'private-provider-body https://private.example/?sig=never-disclose';
function dataset(groupId = 'DEV') {
  return parseOrganizerResponse({ error: '', isSuccess: true, data: { dataset_group_id: groupId, total_records: 1, records: [approvedSyntheticRecord] } });
}
function tempStore() {
  const root = resolve('tmp'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'recovery-test-'));
  const dbPath = join(dir, 'cqa.sqlite'); const store = new Store(dbPath);
  store.importDataset(dataset()); store.saveChecklist(checklist);
  const conversation = store.listConversations()[0];
  assert(isApprovedSyntheticConversation(conversation));
  return { dir, dbPath, store, conversation };
}
async function setup() {
  const local = tempStore();
  const context = {
    ...local, app: await createApp(local.store, new ReviewStore(local.dbPath)),
    async restart() { await this.app.close(); this.store = new Store(this.dbPath); this.app = await createApp(this.store, new ReviewStore(this.dbPath)); },
    async close() { await this.app.close(); removeLocalTemp(this.dir); },
  };
  return context;
}
function results(conversation: Conversation): CriterionResult[] {
  const operator = conversation.messages.find(m => m.speaker === 'operator')!;
  return [{ criterionId: checklist.criteria[0].id, answer: 'YES', applicabilityRationale: 'Software fixture only.', explanation: 'Deterministic test response, not a human reference.', evidence: [{ messageId: operator.id, quote: 'Здравствуйте! Меня зовут Алина.' }], checkedRange: null, reviewRequired: false, uncertainty: '' }];
}
function response(conversation: Conversation) { return { text: JSON.stringify({ results: results(conversation) }), usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, totalTokenCount: 130 } }; }
// Exercise the real provider validation and observer through an injected transport.
// There is no network transport, key lookup, runtime fallback or external model call.
function interceptProvider(t: TestContext, transport: ProviderTransport) {
  const original = GeminiProvider.prototype.evaluate;
  t.mock.method(GeminiProvider.prototype, 'evaluate', function (this: GeminiProvider, conversation: Conversation, rubric: Checklist) {
    const observer = (this as unknown as { onTelemetry?: (telemetry: ProviderTelemetry) => void }).onTelemetry;
    return original.call(new GeminiProvider({ ...config, apiKey: testKey, freeTierConfirmed: true, retryLimit: 0 }, transport, observer), conversation, rubric);
  });
}
function body(conversation: Conversation, requestId: string, retryOf?: string, checklistVersion = checklist.version) {
  return { conversationVersion: conversation.version, checklistVersion, requestId, ...(retryOf ? { retryOf } : {}) };
}
function pendingAttempt(conversation: Conversation, id: string, overrides: Partial<EvaluationAttempt> = {}): EvaluationAttempt {
  return { id, requestId: id, recoveryDepth: 0, conversationVersion: conversation.version, checklistVersion: checklist.version, model: config.model, startedAt: '2026-11-07T10:00:00.000Z', finishedAt: null, status: 'running', evaluationId: null, errorCode: null, latencyMs: null, usage: null, ...overrides };
}
function failedAttempt(store: Store, conversation: Conversation, id: string, overrides: Partial<EvaluationAttempt> = {}) {
  const attempt = pendingAttempt(conversation, id, overrides); store.startEvaluationAttempt(attempt);
  const failed = { ...attempt, status: 'failed' as const, finishedAt: '2026-11-07T10:00:01.000Z', errorCode: 'PROVIDER_FAILED' };
  store.finishEvaluationAttempt(failed); return failed;
}
function savedEvaluation(conversation: Conversation, attempt: EvaluationAttempt): Evaluation {
  const decisions = results(conversation);
  return { id: 'atomic-evaluation', attemptId: attempt.id, createdAt: '2026-11-07T10:00:01.000Z', conversationVersion: conversation.version, checklistVersion: checklist.version, provider: config.provider, model: config.model, mode: config.mode, status: 'live_validated', origin: 'ai', results: decisions, score: calculateScore(checklist, decisions), usage: { totalTokens: 130 }, latencyMs: 1000, providerCallCount: 1, configuration: { testDouble: true } };
}

test('requestId returns the same saved result without another provider call, including after database restart', async t => {
  const context = await setup(); let calls = 0;
  interceptProvider(t, { listModels: async () => [], generate: async () => { calls++; return response(context.conversation); } });
  const payload = body(context.conversation, 'idempotent-success-001');
  try {
    const first = await context.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload });
    assert.equal(first.statusCode, 200, first.body); const evaluation = first.json();
    assert.equal(evaluation.status, 'live_validated'); assert.equal(evaluation.score.total, 100);
    const repeated = await context.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload });
    assert.equal(repeated.statusCode, 200); assert.deepEqual(repeated.json(), evaluation); assert.equal(calls, 1);
    await context.restart();
    const afterRestart = await context.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload });
    assert.equal(afterRestart.statusCode, 200); assert.deepEqual(afterRestart.json(), evaluation); assert.equal(calls, 1);
    assert.equal(context.store.listEvaluations().length, 1); assert.equal(context.store.listEvaluationAttempts().length, 1);
    const attempt = await context.app.inject({ url: `/api/evaluation-attempts/${payload.requestId}`, headers });
    assert.equal(attempt.statusCode, 200); assert.equal(attempt.json().evaluationId, evaluation.id);
    assert.equal(attempt.json().providerCallCount, 1); assert.equal(attempt.json().recovery.canRetry, false);
  } finally { await context.close(); }
});

test('the same failed request cannot silently call Gemini again or invent an evaluation', async t => {
  const context = await setup(); let calls = 0;
  interceptProvider(t, { listModels: async () => [], generate: async () => { calls++; throw { status: 400, name: 'ApiError', message: secretSource }; } });
  const payload = body(context.conversation, 'idempotent-failure-001');
  try {
    const first = await context.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload });
    assert.equal(first.statusCode, 400); assert.equal(first.json().error, 'PROVIDER_FAILED');
    const original = context.store.getEvaluationAttempt(payload.requestId);
    const second = await context.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload });
    assert.equal(second.statusCode, 400); assert.equal(second.json().attempt.id, payload.requestId); assert.equal(calls, 1);
    assert.deepEqual(context.store.getEvaluationAttempt(payload.requestId), original);
    assert.equal(context.store.listEvaluations().length, 0); assert.equal(context.store.listEvaluationAttempts().length, 1);
    assert.equal(second.json().attempt.telemetry.unknownUsageCalls, 1); assert.equal(second.json().recovery.canRetry, true);
    assert.equal(second.body.includes(secretSource), false); assert.equal(second.body.includes(testKey), false);
  } finally { await context.close(); }
});

test('explicit recovery uses the same conversation/checklist/model once and refuses a second child or depth two', async t => {
  const context = await setup(); let calls = 0;
  interceptProvider(t, { listModels: async () => [], generate: async () => { if (++calls === 1) throw { status: 400 }; return response(context.conversation); } });
  const parent = body(context.conversation, 'recovery-parent-001');
  const child = body(context.conversation, 'recovery-child-001', parent.requestId);
  try {
    const failed = await context.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload: parent }); assert.equal(failed.statusCode, 400);
    const parentSnapshot = context.store.getEvaluationAttempt(parent.requestId);
    const recovered = await context.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload: child });
    assert.equal(recovered.statusCode, 200, recovered.body); assert.equal(calls, 2);
    const saved = context.store.getEvaluationAttempt(child.requestId)!;
    assert.equal(saved.recoveryOf, parent.requestId); assert.equal(saved.recoveryDepth, 1); assert.equal(saved.model, config.model);
    assert.equal(saved.conversationVersion, parent.conversationVersion); assert.equal(saved.checklistVersion, parent.checklistVersion);
    assert.deepEqual(context.store.getEvaluationAttempt(parent.requestId), parentSnapshot);
    const repeatChild = await context.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload: child });
    assert.equal(repeatChild.statusCode, 200); assert.equal(repeatChild.json().id, recovered.json().id);
    for (const [payload, code] of [[body(context.conversation, 'second-child-001', parent.requestId), 'RECOVERY_ALREADY_STARTED'], [body(context.conversation, 'depth-two-child-001', child.requestId), 'RECOVERY_LIMIT_REACHED']] as const) {
      const refused = await context.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload });
      assert.equal(refused.statusCode, 409); assert.equal(refused.json().error, code);
    }
    assert.equal(calls, 2); assert.equal(context.store.listEvaluations().length, 1); assert.equal(context.store.listEvaluationAttempts().length, 2);
    const parentStatus = await context.app.inject({ url: `/api/evaluation-attempts/${parent.requestId}`, headers });
    assert.equal(parentStatus.json().recovery.canRetry, false);
  } finally { await context.close(); }
});

test('recovery cannot substitute a source version, checklist version or model and requestId conflicts never invoke provider', async t => {
  const context = await setup(); let calls = 0;
  interceptProvider(t, { listModels: async () => [], generate: async () => { calls++; return response(context.conversation); } });
  try {
    const changedChecklist = { ...checklist, version: 'recovery-changed-checklist-v2' }; context.store.saveChecklist(changedChecklist);
    failedAttempt(context.store, context.conversation, 'mismatch-checklist-001');
    failedAttempt(context.store, context.conversation, 'mismatch-conversation-001', { conversationVersion: 'different-version' });
    failedAttempt(context.store, context.conversation, 'mismatch-model-001', { model: 'different-model' });
    for (const payload of [body(context.conversation, 'mismatch-child-001', 'mismatch-checklist-001', changedChecklist.version), body(context.conversation, 'mismatch-child-002', 'mismatch-conversation-001'), body(context.conversation, 'mismatch-child-003', 'mismatch-model-001')]) {
      const rejected = await context.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload });
      assert.equal(rejected.statusCode, 400); assert.equal(rejected.json().error, 'RECOVERY_SOURCE_MISMATCH');
    }
    const conflict = await context.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload: body(context.conversation, 'mismatch-checklist-001', undefined, changedChecklist.version) });
    assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().error, 'IDEMPOTENCY_CONFLICT');
    assert.equal(calls, 0); assert.equal(context.store.listEvaluationAttempts().length, 3);
  } finally { await context.close(); }
});

test('running status is observable and duplicate/concurrent submissions do not create another call', async t => {
  const context = await setup(); let calls = 0;
  let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  interceptProvider(t, { listModels: async () => [], generate: async () => { calls++; started(); await blocked; return response(context.conversation); } });
  const payload = body(context.conversation, 'observable-running-001');
  const request = context.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload });
  try {
    await entered;
    const running = await context.app.inject({ url: `/api/evaluation-attempts/${payload.requestId}`, headers });
    assert.equal(running.statusCode, 200); assert.equal(running.json().status, 'running'); assert.equal(running.json().providerCallCount, 1);
    assert.equal(running.json().executorPid, process.pid); assert.match(running.json().executorSessionId, /^[0-9a-f-]{36}$/);
    assert.equal(interruptRecordedAttempts(context.store, [payload.requestId]), 0);
    assert.equal(context.store.getEvaluationAttempt(payload.requestId)?.status, 'running');
    assert.equal(running.json().events[0].status, 'running'); assert.equal(running.json().telemetry.outcome, 'running'); assert.equal(running.json().recovery.canRetry, false);
    for (const pendingBody of [payload, body(context.conversation, 'observable-other-001')]) {
      const busy = await context.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload: pendingBody });
      assert.equal(busy.statusCode, 409); assert.equal(busy.json().error, 'EVALUATION_BUSY');
    }
    assert.equal(calls, 1); assert.equal(context.store.listEvaluationAttempts().length, 1);
    assert.equal(running.body.includes(testKey), false); assert.equal(running.body.includes(context.conversation.messages[0].text), false);
    release(); const saved = await request; assert.equal(saved.statusCode, 200); assert.equal(calls, 1);
    const missing = await context.app.inject({ url: '/api/evaluation-attempts/no-such-attempt', headers });
    assert.equal(missing.statusCode, 404); assert.equal(missing.json().error, 'ATTEMPT_NOT_FOUND');
  } finally { release(); await request; await context.close(); }
});

test('rejected model output keeps known usage and safe attempt diagnostics without exposing the response body', async t => {
  const context = await setup(); let calls = 0;
  interceptProvider(t, { listModels: async () => [], generate: async () => { calls++; return { text: secretSource, usageMetadata: { totalTokenCount: 7312 } }; } });
  const payload = body(context.conversation, 'invalid-json-request-001');
  try {
    const rejected = await context.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload });
    assert.equal(rejected.statusCode, 400); assert.equal(rejected.json().error, 'INVALID_MODEL_JSON');
    const attempt = rejected.json().attempt;
    assert.equal(attempt.providerCallCount, 1); assert.equal(attempt.usage.totalTokens, 7312); assert.equal(attempt.telemetry.unknownUsageCalls, 0);
    assert.equal(attempt.telemetry.outcome, 'failed'); assert.equal(attempt.events[0].status, 'response-received'); assert.equal(attempt.recovery.canRetry, true);
    const list = await context.app.inject({ url: '/api/evaluation-attempts', headers });
    assert.equal(list.json().length, 1); assert.equal(list.body.includes(secretSource), false); assert.equal(list.body.includes(testKey), false);
    assert.equal(rejected.body.includes(secretSource), false); assert.equal(calls, 1); assert.equal(context.store.listEvaluations().length, 0);
  } finally { await context.close(); }
});

test('recovery policy excludes quota, configuration failures, active requests and exhausted recovery', () => {
  const local = tempStore();
  try {
    const base = failedAttempt(local.store, local.conversation, 'policy-parent-001');
    assert.equal(recoveryPolicy(local.store, base).canRetry, true);
    for (const errorCode of ['INVALID_EVIDENCE', 'INVALID_MODEL_JSON', 'PROVIDER_EMPTY_RESULT', 'PROVIDER_TIMEOUT']) assert.equal(recoveryPolicy(local.store, { ...base, errorCode }).canRetry, true);
    for (const errorCode of ['PROVIDER_RATE_LIMIT', 'MISSING_API_KEY', 'DATA_POLICY_RESTRICTED', 'FREE_TIER_UNCONFIRMED']) assert.equal(recoveryPolicy(local.store, { ...base, errorCode }).canRetry, false);
    assert.equal(recoveryPolicy(local.store, { ...base, status: 'running' }).canRetry, false);
    assert.equal(recoveryPolicy(local.store, { ...base, status: 'succeeded' }).canRetry, false);
    assert.equal(recoveryPolicy(local.store, { ...base, recoveryDepth: 1 }).canRetry, false);
    local.store.startEvaluationAttempt(pendingAttempt(local.conversation, 'policy-child-001', { recoveryOf: base.id, recoveryDepth: 1 }));
    assert.equal(recoveryPolicy(local.store, base).canRetry, false); assert.equal(publicAttempt(local.store, base).requestId, base.id);
    assert.throws(() => local.store.startEvaluationAttempt(pendingAttempt(local.conversation, 'policy-child-002', { recoveryOf: base.id, recoveryDepth: 1 })), /RECOVERY_ALREADY_STARTED/);
  } finally { local.store.close(); removeLocalTemp(local.dir); }
});

test('atomic evaluation+attempt write rolls back an inserted evaluation if immutable attempt source validation fails', () => {
  const local = tempStore();
  try {
    const attempt = pendingAttempt(local.conversation, 'atomic-rollback-001'); local.store.startEvaluationAttempt(attempt);
    local.store.importDataset(dataset('LOCAL_ATOMIC_FIXTURE'));
    const otherSource = local.store.listConversations('LOCAL_ATOMIC_FIXTURE')[0];
    const evaluation = savedEvaluation(otherSource, attempt);
    const mismatched = { ...attempt, conversationVersion: otherSource.version, status: 'succeeded' as const, finishedAt: evaluation.createdAt, evaluationId: evaluation.id };
    assert.throws(() => local.store.saveEvaluationWithAttempt(evaluation, mismatched), /IMMUTABLE_ATTEMPT_SOURCE/);
    assert.equal(local.store.getEvaluation(evaluation.id), undefined); assert.deepEqual(local.store.getEvaluationAttempt(attempt.id), attempt);
    const valid = savedEvaluation(local.conversation, attempt);
    local.store.saveEvaluationWithAttempt(valid, { ...attempt, status: 'succeeded', finishedAt: valid.createdAt, evaluationId: valid.id });
    assert.deepEqual(local.store.getEvaluation(valid.id), JSON.parse(JSON.stringify(valid))); assert.equal(local.store.getEvaluationAttempt(attempt.id)?.status, 'succeeded');
  } finally { local.store.close(); removeLocalTemp(local.dir); }
});

test('atomic save rejects a result linked to another attempt/source/checklist/model before writing either record', () => {
  const local = tempStore();
  try {
    const attempt = pendingAttempt(local.conversation, 'atomic-link-001'); local.store.startEvaluationAttempt(attempt);
    const valid = savedEvaluation(local.conversation, attempt);
    for (const change of [{ attemptId: 'other-attempt' }, { conversationVersion: 'other-conversation' }, { checklistVersion: 'other-checklist' }, { model: 'other-model' }]) {
      assert.throws(() => local.store.saveEvaluationWithAttempt({ ...valid, ...change }, { ...attempt, status: 'succeeded', finishedAt: valid.createdAt, evaluationId: valid.id }), /ATTEMPT_RESULT_SOURCE_MISMATCH/);
      assert.equal(local.store.listEvaluations().length, 0); assert.deepEqual(local.store.getEvaluationAttempt(attempt.id), attempt);
    }
  } finally { local.store.close(); removeLocalTemp(local.dir); }
});

test('attempt identity and terminal history cannot be mutated by progress updates or another finish', () => {
  const local = tempStore();
  try {
    const attempt = pendingAttempt(local.conversation, 'immutable-attempt-001'); local.store.startEvaluationAttempt(attempt);
    for (const change of [{ conversationVersion: 'changed' }, { checklistVersion: 'changed' }, { model: 'changed' }, { requestId: 'changed' }, { startedAt: 'changed' }, { recoveryOf: 'changed' }, { recoveryDepth: 1 }, { executorPid: process.pid }, { executorSessionId: 'changed' }]) {
      assert.throws(() => local.store.updateRunningEvaluationAttempt({ ...attempt, ...change }), /IMMUTABLE_ATTEMPT_SOURCE/);
      assert.throws(() => local.store.finishEvaluationAttempt({ ...attempt, ...change, status: 'failed' }), /IMMUTABLE_ATTEMPT_SOURCE/);
    }
    assert.deepEqual(local.store.getEvaluationAttempt(attempt.id), attempt);
    local.store.updateRunningEvaluationAttempt({ ...attempt, latencyMs: 123 });
    const finished = { ...attempt, status: 'failed' as const, finishedAt: '2026-11-07T10:00:01.000Z', errorCode: 'PROVIDER_TIMEOUT', latencyMs: 1000 };
    local.store.finishEvaluationAttempt(finished);
    assert.throws(() => local.store.finishEvaluationAttempt({ ...finished, status: 'succeeded' }), /INVALID_ATTEMPT_STATE/);
    assert.throws(() => local.store.updateRunningEvaluationAttempt(attempt), /INVALID_ATTEMPT_STATE/);
    assert.deepEqual(local.store.getEvaluationAttempt(attempt.id), finished);
  } finally { local.store.close(); removeLocalTemp(local.dir); }
});

test('restart interruption changes only captured attempts still running and never calls a provider or saves an evaluation', t => {
  const local = tempStore(); let calls = 0;
  t.mock.method(GeminiProvider.prototype, 'evaluate', async () => { calls++; throw new Error('No provider call permitted during restart cleanup.'); });
  try {
    const captured = pendingAttempt(local.conversation, 'captured-running-001'); local.store.startEvaluationAttempt(captured);
    const settledMeanwhile = pendingAttempt(local.conversation, 'captured-terminal-001'); local.store.startEvaluationAttempt(settledMeanwhile);
    const capturedIds = local.store.listEvaluationAttempts().filter(a => a.status === 'running').map(a => a.id);
    const terminal = { ...settledMeanwhile, status: 'failed' as const, finishedAt: '2026-11-07T10:00:01.000Z', errorCode: 'INVALID_EVIDENCE' };
    local.store.finishEvaluationAttempt(terminal);
    const uncaptured = pendingAttempt(local.conversation, 'uncaptured-running-001'); local.store.startEvaluationAttempt(uncaptured);
    const finishedAt = '2026-11-07T11:00:00.000Z';
    assert.equal(interruptRecordedAttempts(local.store, [...capturedIds, 'missing-attempt'], finishedAt), 1);
    const interrupted = local.store.getEvaluationAttempt(captured.id)!;
    assert.deepEqual(interrupted, { ...captured, status: 'failed', finishedAt, errorCode: 'REQUEST_INTERRUPTED' });
    assert.deepEqual(local.store.getEvaluationAttempt(terminal.id), terminal);
    assert.deepEqual(local.store.getEvaluationAttempt(uncaptured.id), uncaptured);
    assert.equal(interruptRecordedAttempts(local.store, capturedIds, '2026-11-07T12:00:00.000Z'), 0);
    assert.deepEqual(local.store.getEvaluationAttempt(captured.id), interrupted);
    assert.equal(calls, 0); assert.equal(local.store.listEvaluations().length, 0);
  } finally { local.store.close(); removeLocalTemp(local.dir); }
});

test('interrupted status exposes the last observed calls as incomplete and never invents final usage or provider outcome', async () => {
  const context = await setup();
  try {
    const telemetry: ProviderTelemetry = {
      ...getProviderConfigurationIdentity(config), providerCallCount: 1, retryCount: 0, retryLimit: 1, totalBudgetMs: config.timeoutMs,
      elapsedMs: 1234, attempts: [{ call: 1, status: 'response-received', elapsedMs: 1234, reportedUsage: { inputTokens: 100, outputTokens: 30, thoughtTokens: null, cachedTokens: null, totalTokens: 130 } }],
      reportedUsage: { inputTokens: 100, outputTokens: 30, thoughtTokens: null, cachedTokens: null, totalTokens: 130 }, unknownUsageCalls: 0, diagnosticId: 'incomplete-observation-only', outcome: 'running',
    };
    const attempt = pendingAttempt(context.conversation, 'interrupted-observed-001', { telemetry, latencyMs: 1234, usage: { totalTokens: 130 } });
    context.store.startEvaluationAttempt(attempt);
    assert.equal(interruptRecordedAttempts(context.store, [attempt.id], '2026-11-07T11:00:00.000Z'), 1);
    const result = await context.app.inject({ url: `/api/evaluation-attempts/${attempt.id}`, headers });
    assert.equal(result.statusCode, 200);
    const exposed = result.json();
    assert.equal(exposed.status, 'failed'); assert.equal(exposed.errorCode, 'REQUEST_INTERRUPTED');
    assert.equal(exposed.usage, null); assert.equal(exposed.evaluationId, null); assert.equal(exposed.providerCallCountObservedOnly, true);
    assert.equal(exposed.providerCallCount, 1); assert.deepEqual(exposed.telemetry, telemetry); assert.equal(exposed.telemetry.outcome, 'running');
    assert.equal(exposed.recovery.canRetry, true); assert.equal(context.store.listEvaluations().length, 0);
    assert.equal(exposed.conversationVersion, attempt.conversationVersion); assert.equal(exposed.checklistVersion, attempt.checklistVersion); assert.equal(exposed.model, attempt.model);
  } finally { await context.close(); }
});

test('interrupted requests remain idempotent and allow exactly one explicit recovery using the same saved versions', async t => {
  const context = await setup(); let calls = 0;
  interceptProvider(t, { listModels: async () => [], generate: async () => { calls++; return response(context.conversation); } });
  try {
    const parent = pendingAttempt(context.conversation, 'interrupted-parent-001'); context.store.startEvaluationAttempt(parent);
    const capturedIds = [parent.id];
    await context.restart();
    assert.equal(interruptRecordedAttempts(context.store, capturedIds, '2026-11-07T11:00:00.000Z'), 1);
    assert.equal(calls, 0);
    const failedSnapshot = context.store.getEvaluationAttempt(parent.id);
    const replay = await context.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload: body(context.conversation, parent.id) });
    assert.equal(replay.statusCode, 400); assert.equal(replay.json().error, 'REQUEST_INTERRUPTED'); assert.equal(replay.json().recovery.canRetry, true); assert.equal(calls, 0);
    const recovered = await context.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload: body(context.conversation, 'interrupted-child-001', parent.id) });
    assert.equal(recovered.statusCode, 200, recovered.body); assert.equal(calls, 1);
    assert.equal(recovered.json().conversationVersion, parent.conversationVersion); assert.equal(recovered.json().checklistVersion, parent.checklistVersion); assert.equal(recovered.json().model, parent.model);
    assert.deepEqual(context.store.getEvaluationAttempt(parent.id), failedSnapshot);
    const second = await context.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload: body(context.conversation, 'interrupted-second-001', parent.id) });
    assert.equal(second.statusCode, 409); assert.equal(second.json().error, 'RECOVERY_ALREADY_STARTED'); assert.equal(calls, 1);
    assert.equal(context.store.listEvaluationAttempts().length, 2); assert.equal(context.store.listEvaluations().length, 1);
  } finally { await context.close(); }
});

test('owner existence probe treats only ESRCH as dead and never sends an actual signal', t => {
  const probed: number[] = [];
  t.mock.method(process, 'kill', (pid: number, signal?: number | string) => {
    assert.equal(signal, 0); probed.push(pid);
    if (pid === 101) throw Object.assign(new Error('Process absent'), { code: 'ESRCH' });
    if (pid === 102) throw Object.assign(new Error('Permissions unavailable'), { code: 'EPERM' });
    if (pid === 103) throw Object.assign(new Error('Access unavailable'), { code: 'EACCES' });
    if (pid === 104) throw new Error('Unexpected probe failure');
    return true as const;
  });
  assert.equal(probeExecutorPid(101), 'dead'); assert.equal(probeExecutorPid(102), 'unknown'); assert.equal(probeExecutorPid(103), 'unknown'); assert.equal(probeExecutorPid(104), 'unknown'); assert.equal(probeExecutorPid(105), 'alive');
  for (const invalid of [0, -1, NaN, Infinity, 1.5, 2147483648]) assert.equal(probeExecutorPid(invalid), 'unknown');
  assert.deepEqual(probed, [101, 102, 103, 104, 105]);
});

test('restart preserves live/uncertain executor ownership and interrupts only a confirmed dead owner', () => {
  const local = tempStore();
  try {
    const dead = pendingAttempt(local.conversation, 'dead-owner-request-001', { executorPid: 101, executorSessionId: 'dead-session', usage: { totalTokens: 130 } });
    const alive = pendingAttempt(local.conversation, 'alive-owner-request-001', { executorPid: 105, executorSessionId: 'alive-session' });
    const uncertain = pendingAttempt(local.conversation, 'uncertain-owner-request-001', { executorPid: 102, executorSessionId: 'uncertain-session' });
    for (const request of [dead, alive, uncertain]) local.store.startEvaluationAttempt(request);
    const finishedAt = '2026-11-07T12:00:00.000Z';
    const probe = (pid: number) => pid === dead.executorPid ? 'dead' as const : pid === alive.executorPid ? 'alive' as const : 'unknown' as const;
    assert.equal(interruptRecordedAttempts(local.store, [dead.id, alive.id, uncertain.id], finishedAt, probe), 1);
    assert.deepEqual(local.store.getEvaluationAttempt(alive.id), alive); assert.deepEqual(local.store.getEvaluationAttempt(uncertain.id), uncertain);
    assert.deepEqual(local.store.getEvaluationAttempt(dead.id), { ...dead, status: 'failed', finishedAt, evaluationId: null, errorCode: 'REQUEST_INTERRUPTED', usage: null });
    assert.equal(local.store.listEvaluations().length, 0);
  } finally { local.store.close(); removeLocalTemp(local.dir); }
});

test('executor PID/session cannot be changed, removed or added through progress and finish updates', () => {
  const local = tempStore();
  try {
    const owned = pendingAttempt(local.conversation, 'immutable-owned-request-001', { executorPid: process.pid, executorSessionId: 'immutable-session' }); local.store.startEvaluationAttempt(owned);
    for (const change of [{ executorPid: process.pid + 1 }, { executorSessionId: 'different-session' }, { executorPid: undefined }, { executorSessionId: undefined }]) {
      assert.throws(() => local.store.updateRunningEvaluationAttempt({ ...owned, ...change }), /IMMUTABLE_ATTEMPT_SOURCE/);
      assert.throws(() => local.store.finishEvaluationAttempt({ ...owned, ...change, status: 'failed' }), /IMMUTABLE_ATTEMPT_SOURCE/);
    }
    assert.deepEqual(local.store.getEvaluationAttempt(owned.id), owned);
  } finally { local.store.close(); removeLocalTemp(local.dir); }
});
