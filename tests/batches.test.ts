import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { BatchStore, batchExecutorState, batchRequestId, createGroupBatch, findValidOfficialEvaluation, isValidOfficialEvaluation, runGroupBatch, validateBatchDeadlineAt, type GroupBatch } from '../server/batches.js';
import { Store } from '../server/store.js';
import { PermissionStore } from '../server/data-permissions.js';
import { parseOrganizerResponse } from '../server/importer.js';
import { initialChecklist } from '../src/checklist.js';
import { calculateScore } from '../src/scoring.js';
import { config } from '../server/config.js';
import { ProviderError, getProviderConfigurationIdentity, type ProviderTelemetry } from '../server/provider.js';
import { interruptRecordedAttempts } from '../server/interrupted-attempts.js';
import type { Conversation, Evaluation, EvaluationAttempt } from '../src/domain.js';
import type { evaluateAndSave } from '../server/evaluation-service.js';
import { approvedSyntheticRecord } from './synthetic-fixture.js';
import { removeLocalTemp } from './local-temp.js';

// These deterministic software responses never enter the production database or human gold.
function setup(count = 1, group = 'DEV') {
  mkdirSync(resolve('tmp'), { recursive: true }); const directory = mkdtempSync(resolve('tmp', 'batch-test-')); const path = join(directory, 'test.sqlite');
  const store = new Store(path); store.saveChecklist(initialChecklist);
  const records = Array.from({ length: count }, (_, index) => ({ ...approvedSyntheticRecord, ...(group === 'DEV' && count === 1 ? {} : { conversation_id: `SOFTWARE_ONLY_${index + 1}` }) }));
  const parsed = parseOrganizerResponse({ error: '', isSuccess: true, data: { dataset_group_id: group, total_records: records.length, records } }); store.importDataset(parsed);
  const batches = new BatchStore(path); const permissions = new PermissionStore(path);
  const context = { directory, path, store, batches, permissions, conversations: parsed.conversations,
    close() { this.permissions.close(); this.batches.close(); this.store.close(); removeLocalTemp(this.directory); } };
  return context;
}
function approve(context: ReturnType<typeof setup>, conversation: Conversation) {
  context.permissions.approve(conversation, { reviewer: 'SOFTWARE_PERMISSION_FIXTURE', reason: 'Test-only explicit permission boundary; no external calls.', syntheticAttestation: true, freeTierUseApproved: true, origin: 'human_declared', requestId: `permission_${conversation.version}` });
}
function evaluation(conversation: Conversation, id: string, attemptId?: string): Evaluation {
  const operator = conversation.messages.find(m => m.speaker === 'operator')!;
  const results = initialChecklist.criteria.map(c => ({ criterionId: c.id, answer: c.answerType === 'numeric' ? '0' : 'NO', applicabilityRationale: '', explanation: 'Software-only arbitrary response. Not a human reference.', evidence: [{ messageId: operator.id, quote: operator.text }], checkedRange: { startMessageId: conversation.messages[0].id, endMessageId: conversation.messages.at(-1)!.id }, reviewRequired: false, uncertainty: '' }));
  return { id, ...(attemptId ? { attemptId } : {}), createdAt: '2026-11-07T10:00:00.000Z', conversationVersion: conversation.version, checklistVersion: initialChecklist.version, provider: 'gemini', model: config.model, mode: 'free', status: 'live_validated', origin: 'ai', results, score: calculateScore(initialChecklist, results), usage: { totalTokens: 130 }, latencyMs: 1000, providerCallCount: 2, configuration: { softwareFixtureNotGold: true } };
}
function telemetry(failed: boolean): ProviderTelemetry {
  return { ...getProviderConfigurationIdentity(config), providerCallCount: 2, retryCount: 1, retryLimit: 1, totalBudgetMs: config.timeoutMs, elapsedMs: 1000,
    attempts: [{ call: 1, status: 'request-failed', elapsedMs: 500, failure: { httpStatus: 503, errorName: 'ApiError', errorCode: null, causeName: null, causeCode: null } }, { call: 2, status: failed ? 'request-failed' : 'response-received', elapsedMs: 1000, ...(failed ? { failure: { httpStatus: 503, errorName: 'ApiError', errorCode: null, causeName: null, causeCode: null } } : {}) }],
    reportedUsage: { inputTokens: null, outputTokens: null, thoughtTokens: null, cachedTokens: null, totalTokens: failed ? null : 130 }, unknownUsageCalls: failed ? 2 : 1, diagnosticId: 'software-fixture', outcome: failed ? 'failed' : 'succeeded' };
}
function attempt(conversation: Conversation, id: string): EvaluationAttempt { return { id, requestId: id, conversationVersion: conversation.version, checklistVersion: initialChecklist.version, model: config.model, startedAt: '2026-11-07T10:00:00.000Z', finishedAt: null, status: 'running', errorCode: null, evaluationId: null, usage: null, latencyMs: null, recoveryDepth: 0 }; }
function executor(context: ReturnType<typeof setup>, failures: Array<string | null> = [], configurationFingerprint?: string) {
  const calls: Array<{ id: string; retryOf?: string; cv: string; kv: string }> = [];
  const execute: typeof evaluateAndSave = async (store, cv, kv, options = {}) => {
    const id = options.attemptId!; const conversation = store.getConversation(cv)!;
    calls.push({ id, retryOf: options.retryOf, cv, kv });
    const pending = { ...attempt(conversation, id), ...(options.retryOf ? { recoveryOf: options.retryOf, recoveryDepth: 1 } : {}) }; store.startEvaluationAttempt(pending);
    const errorCode = failures.shift();
    if (errorCode) { store.finishEvaluationAttempt({ ...pending, status: 'failed', finishedAt: '2026-11-07T10:00:01.000Z', errorCode, telemetry: telemetry(true), latencyMs: 1000 }); throw new ProviderError(errorCode, 'Software fixture failure.'); }
    const saved = evaluation(conversation, `eval_${calls.length}_${id}`, id);
    if (configurationFingerprint) saved.configuration.configurationFingerprint = configurationFingerprint;
    store.saveEvaluationWithAttempt(saved, { ...pending, status: 'succeeded', finishedAt: saved.createdAt, evaluationId: saved.id, telemetry: telemetry(false), latencyMs: 1000, usage: saved.usage }); return saved;
  };
  void context;
  return { execute, calls };
}
function clock() { let value = 1794050000000; const sleeps: number[] = []; return { now: () => value, sleep: async (ms: number) => { sleeps.push(ms); value += ms; }, random: () => 0.5, advance: (ms: number) => { value += ms; }, sleeps }; }
function create(context: ReturnType<typeof setup>, options: Partial<Pick<GroupBatch, 'groupId' | 'minSpacingMs' | 'runBudgetMs' | 'deadlineAt'>> = {}) { return createGroupBatch(context.store, context.batches, { groupId: 'DEV', minSpacingMs: 0, ...options }); }

test('arbitrary ten-record groups preserve original IDs, block unknown data, then use only explicit version-bound permissions', async () => {
  const c = setup(10, 'CONTROL_SOFTWARE_FIXTURE'); const fake = executor(c); const time = clock();
  try {
    let batch = create(c, { groupId: 'CONTROL_SOFTWARE_FIXTURE' }); batch = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...time, permissions: c.permissions });
    assert.equal(fake.calls.length, 0); assert.equal(batch.records.length, 10); assert(batch.records.every(r => r.status === 'blocked' && r.errorCode === 'DATA_PERMISSION_REQUIRED'));
    c.conversations.forEach(item => approve(c, item)); c.batches.resume(batch.id);
    batch = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...time, permissions: c.permissions });
    assert.equal(fake.calls.length, 10); assert(batch.records.every(r => r.status === 'succeeded'));
    assert.deepEqual(batch.records.map(r => r.conversationId).sort(), c.conversations.map(r => r.conversationId).sort());
    c.batches.resume(batch.id); await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...time, permissions: c.permissions }); assert.equal(fake.calls.length, 10);
    assert(fake.calls.every(call => call.kv === initialChecklist.version));
  } finally { c.close(); }
});

test('reuse accepts only strictly validated original official checklist, current model and genuine provenance', async () => {
  const c = setup(); const conversation = c.conversations[0];
  try {
    const valid = evaluation(conversation, 'valid-official');
    const old = { ...valid, id: 'old-model', model: 'gemini-old-model' };
    const demo = { ...valid, id: 'demo', status: 'manual_demo' as const, origin: 'agent_demo' as const };
    const wrongScore = { ...valid, id: 'wrong-score', score: { ...valid.score, total: 99 } };
    const badQuote = { ...valid, id: 'bad-quote', results: valid.results.map((r, i) => i ? r : { ...r, evidence: [{ messageId: r.evidence[0].messageId, quote: 'invented-quote' }] }) };
    const custom = { ...initialChecklist, version: 'experimental-eight', criteria: initialChecklist.criteria.map((r, i) => i ? r : { ...r, instructions: 'Different semantics.' }) }; c.store.saveChecklist(custom);
    for (const e of [old, demo, wrongScore, badQuote, { ...valid, id: 'custom-version', checklistVersion: custom.version }]) { c.store.saveEvaluation(e); assert.equal(isValidOfficialEvaluation(c.store, conversation, e), false); }
    assert.equal(findValidOfficialEvaluation(c.store, conversation), undefined);
    valid.configuration = { ...valid.configuration, generationConstraintVersion: 'all-criteria-source-span-v1', configurationFingerprint: getProviderConfigurationIdentity(config).compatibleSourceSpanFingerprint };
    c.store.saveEvaluation(valid);
    const fake = executor(c); const batch = create(c); const completed = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...clock() });
    assert.equal(fake.calls.length, 0); assert.equal(completed.records[0].status, 'reused'); assert.equal(completed.records[0].evaluationId, valid.id);
    c.batches.resume(batch.id); const repeated = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...clock() }); assert.equal(repeated.records[0].status, 'reused'); assert.equal(fake.calls.length, 0);
  } finally { c.close(); }
});

test('persistent transient failure uses at most one linked child and four total provider calls across resume', async () => {
  const c = setup(); const fake = executor(c, ['PROVIDER_FAILED', 'PROVIDER_FAILED']); const time = clock();
  try {
    const batch = create(c); const completed = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...time });
    assert.equal(fake.calls.length, 2); assert.equal(fake.calls[1].retryOf, fake.calls[0].id);
    assert.equal(completed.records[0].runs.length, 2); assert.equal(completed.records[0].runs.reduce((n, r) => n + (r.providerCallCount || 0), 0), 4);
    assert(time.sleeps.includes(2250)); assert.equal(completed.records[0].status, 'error');
    c.batches.resume(batch.id); await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...time }); assert.equal(fake.calls.length, 2);
    assert.equal(c.store.listEvaluations().length, 0); assert.equal(c.store.listEvaluationAttempts().length, 2);
  } finally { c.close(); }
});

test('successful transient recovery checkpoints usage and respects minimum start spacing', async () => {
  const c = setup(); const fake = executor(c, ['PROVIDER_FAILED', null]); const time = clock();
  try {
    const batch = create(c, { minSpacingMs: 6000 }); const completed = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...time });
    assert.equal(completed.records[0].status, 'succeeded'); assert(time.sleeps[0] >= 6000);
    assert.equal(completed.records[0].runs[0].usage, null); assert.equal(completed.records[0].runs[1].usage?.totalTokens, 130);
    assert.equal(fake.calls[0].id, batchRequestId(batch, c.conversations[0].version, 0)); assert.equal(fake.calls[1].id, batchRequestId(batch, c.conversations[0].version, 1));
  } finally { c.close(); }
});

test('quota pauses immediately and only an explicit bounded quota resume makes a new request', async () => {
  const c = setup(); const fake = executor(c, ['PROVIDER_RATE_LIMIT', null]); const time = clock();
  try {
    const batch = create(c); let result = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...time });
    assert.equal(result.status, 'paused'); assert.equal(result.reason, 'PROVIDER_RATE_LIMIT'); assert.equal(fake.calls.length, 1);
    c.batches.resume(batch.id); result = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...time }); assert.equal(result.status, 'paused'); assert.equal(fake.calls.length, 1);
    c.batches.resume(batch.id, { retryQuota: true }); result = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...time });
    assert.equal(result.records[0].status, 'succeeded'); assert.equal(fake.calls.length, 2); assert.equal(fake.calls[1].retryOf, undefined);
  } finally { c.close(); }
});

test('timeouts and malformed evidence stop or fail honestly without automatic semantic repair', async () => {
  for (const code of ['PROVIDER_TIMEOUT', 'INVALID_EVIDENCE', 'INVALID_MODEL_JSON']) {
    const c = setup(); const fake = executor(c, [code]);
    try { const batch = create(c); const result = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...clock() }); assert.equal(fake.calls.length, 1); assert.equal(result.records[0].errorCode, code); assert.equal(result.status, code === 'PROVIDER_TIMEOUT' ? 'paused' : 'completed'); assert.equal(c.store.listEvaluations().length, 0); }
    finally { c.close(); }
  }
});

test('remaining wall-clock budget must fit a complete provider deadline before dispatch', async () => {
  const c = setup(); const fake = executor(c);
  try { const batch = create(c, { runBudgetMs: config.timeoutMs }); const result = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...clock() }); assert.equal(result.reason, 'RUN_TIME_BUDGET_EXHAUSTED'); assert.equal(fake.calls.length, 0); assert.equal(result.records[0].runs.length, 0); }
  finally { c.close(); }
});

test('crash after a saved evaluation but before batch checkpoint reuses it after reopening SQLite', async () => {
  const c = setup(); const fake = executor(c);
  try {
    const batch = create(c); const requestId = batchRequestId(batch, c.conversations[0].version, 0);
    const run = { requestId, status: 'running' as const, startedAt: '2026-11-07T10:00:00.000Z', finishedAt: null, errorCode: null, providerCallCount: null, usage: null, latencyMs: null };
    c.batches.save({ ...batch, status: 'paused', records: [{ ...batch.records[0], status: 'running', runs: [run] }] });
    await fake.execute(c.store, c.conversations[0].version, initialChecklist.version, { attemptId: requestId });
    c.batches.close(); c.batches = new BatchStore(c.path); c.batches.resume(batch.id);
    const completed = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...clock() });
    assert.equal(fake.calls.length, 1); assert.equal(completed.records[0].evaluationId, c.store.listEvaluations()[0].id); assert.equal(c.store.listEvaluations().length, 1);
    assert.equal(completed.records[0].runs[0].status, 'succeeded'); assert.equal(completed.records[0].runs[0].usage?.totalTokens, 130);
  } finally { c.close(); }
});

test('persisted running outcome is never recalled automatically, while explicit interrupted recovery is linked once', async () => {
  const c = setup(); const fake = executor(c); const time = clock();
  try {
    const batch = create(c); const requestId = batchRequestId(batch, c.conversations[0].version, 0);
    const run = { requestId, status: 'running' as const, startedAt: '2026-11-07T10:00:00.000Z', finishedAt: null, errorCode: null, providerCallCount: null, usage: null, latencyMs: null };
    c.batches.save({ ...batch, status: 'paused', records: [{ ...batch.records[0], status: 'running', runs: [run] }] }); c.store.startEvaluationAttempt(attempt(c.conversations[0], requestId));
    c.batches.resume(batch.id); let result = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...time }); assert.equal(result.reason, 'REQUEST_OUTCOME_UNKNOWN_RESTART_OR_REVIEW_REQUIRED'); assert.equal(fake.calls.length, 0);
    interruptRecordedAttempts(c.store, [requestId]); c.batches.resume(batch.id);
    result = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...time }); assert.equal(result.reason, 'INTERRUPTED_RECOVERY_REQUIRES_EXPLICIT_APPROVAL'); assert.equal(fake.calls.length, 0);
    c.batches.resume(batch.id, { allowInterruptedRecovery: true }); result = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...time });
    assert.equal(result.records[0].status, 'succeeded'); assert.equal(fake.calls.length, 1); assert.equal(fake.calls[0].retryOf, requestId);
    assert.equal(result.records[0].runs[0].status, 'failed'); assert.equal(result.records[0].runs[0].usage, null);
  } finally { c.close(); }
});

test('pause during a request checkpoints that result and issues no next request until explicit resume', async () => {
  const c = setup(2, 'PAUSE_SOFTWARE_FIXTURE'); const fake = executor(c); c.conversations.forEach(item => approve(c, item));
  try {
    const batch = create(c, { groupId: 'PAUSE_SOFTWARE_FIXTURE' }); let active = 0; let maximum = 0;
    const execute: typeof evaluateAndSave = async (...args) => { active++; maximum = Math.max(maximum, active); const result = await fake.execute(...args); if (fake.calls.length === 1) c.batches.pause(batch.id); active--; return result; };
    let result = await runGroupBatch(c.store, c.batches, batch.id, { execute, ...clock(), permissions: c.permissions });
    assert.equal(result.status, 'paused'); assert.equal(fake.calls.length, 1); assert.equal(result.records[0].status, 'succeeded'); assert.equal(result.records[1].runs.length, 0);
    c.batches.resume(batch.id); result = await runGroupBatch(c.store, c.batches, batch.id, { execute, ...clock(), permissions: c.permissions });
    assert.equal(result.status, 'completed'); assert.equal(fake.calls.length, 2); assert.equal(maximum, 1);
    c.batches.cancel(batch.id); assert.throws(() => c.batches.resume(batch.id), /BATCH_CANCELLED/);
  } finally { c.close(); }
});

test('batch definitions and events are immutable, revisions are checked and real calls stay local', async () => {
  const c = setup();
  try {
    const batch = createGroupBatch(c.store, c.batches, { groupId: 'DEV', id: 'immutable-batch-001' });
    assert.deepEqual(createGroupBatch(c.store, c.batches, { groupId: 'DEV', id: batch.id }), batch);
    assert.throws(() => c.batches.save({ ...batch, model: 'changed' }), /IMMUTABLE_BATCH_SOURCE/);
    c.batches.pause(batch.id); assert.throws(() => c.batches.save(batch), /BATCH_REVISION_CONFLICT/);
    const db = new DatabaseSync(c.path); try { assert.throws(() => db.exec("DELETE FROM official_batch_events"), /append-only/); assert.throws(() => db.exec("UPDATE official_batches SET json='{}'"), /append-only/); } finally { db.close(); }
    const parsed = parseOrganizerResponse({ error: '', isSuccess: true, data: { dataset_group_id: 'LOCAL_REAL_CALL_FIXTURE', total_records: 1, records: [{ ...approvedSyntheticRecord, conversation_id: 'SOFTWARE_ONLY_VOICE', channel: 'voice call' }] } }); c.store.importDataset(parsed);
    const callBatch = create(c, { groupId: parsed.groupId }); const fake = executor(c); const result = await runGroupBatch(c.store, c.batches, callBatch.id, { ...fake, ...clock() });
    assert.equal(fake.calls.length, 0); assert.equal(result.records[0].errorCode, 'LOCAL_HUMAN_REVIEW_REQUIRED');
  } finally { c.close(); }
});

test('real-call reuse requires authentic local human entry and never accepts an AI or demonstration claim', async () => {
  const c = setup();
  try {
    const parsed = parseOrganizerResponse({ error: '', isSuccess: true, data: { dataset_group_id: 'LOCAL_VOICE_FIXTURE', total_records: 1, records: [{ ...approvedSyntheticRecord, conversation_id: 'SOFTWARE_ONLY_CALL', channel: 'voice call' }] } }); c.store.importDataset(parsed);
    const conversation = parsed.conversations[0]; const ai = evaluation(conversation, 'disallowed-call-ai'); c.store.saveEvaluation(ai);
    assert.equal(isValidOfficialEvaluation(c.store, conversation, ai), false);
    const human = { ...ai, id: 'local-attested-human-fixture', provider: 'local', model: 'none', mode: 'local' as const, status: 'human_entered' as const, origin: 'human' as const, reviewer: 'SOFTWARE_ONLY_LOCAL_HUMAN_FIXTURE', configuration: { humanAttestation: true, softwareFixtureNotGold: true } };
    assert.equal(isValidOfficialEvaluation(c.store, conversation, { ...human, configuration: { humanAttestation: false } }), false); c.store.saveEvaluation(human);
    const fake = executor(c); const batch = create(c, { groupId: parsed.groupId }); const result = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...clock() });
    assert.equal(fake.calls.length, 0); assert.equal(result.records[0].evaluationId, human.id); assert.equal(result.records[0].status, 'reused');
  } finally { c.close(); }
});

test('a cancelled signal dispatches nothing, and an already running batch cannot acquire a second runner', async () => {
  const c = setup(); const fake = executor(c);
  try {
    const batch = create(c); const abort = new AbortController(); abort.abort();
    const result = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...clock(), signal: abort.signal }); assert.equal(result.status, 'paused'); assert.equal(fake.calls.length, 0);
    c.batches.resume(batch.id); const ready = c.batches.required(batch.id); c.batches.save({ ...ready, status: 'running' });
    await assert.rejects(runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...clock() }), /BATCH_ALREADY_RUNNING/); assert.equal(fake.calls.length, 0);
  } finally { c.close(); }
});

test('an official-v1 name with changed criterion text cannot be used for batch evaluation', async () => {
  const c = setup(); const fake = executor(c);
  try {
    const batch = create(c); const db = new DatabaseSync(c.path);
    try { db.prepare('UPDATE checklists SET json=? WHERE version=?').run(JSON.stringify({ ...initialChecklist, criteria: initialChecklist.criteria.map((criterion, index) => index ? criterion : { ...criterion, instructions: 'Corrupted official wording.' }) }), initialChecklist.version); }
    finally { db.close(); }
    await assert.rejects(runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...clock() }), /BATCH_CONFIGURATION_CHANGED/);
    assert.throws(() => create(c), /OFFICIAL_CHECKLIST_SNAPSHOT_REQUIRED/); assert.equal(fake.calls.length, 0);
  } finally { c.close(); }
});

test('semantic configuration drift is blocked and progress observers cannot mutate or fail a valid batch', async () => {
  const c = setup(); const fake = executor(c);
  try {
    const batch = create(c);
    const changed = c.batches.create({ ...batch, id: 'different-semantic-configuration', configurationFingerprint: '0'.repeat(64) });
    await assert.rejects(runGroupBatch(c.store, c.batches, changed.id, { ...fake, ...clock() }), /BATCH_CONFIGURATION_CHANGED/); assert.equal(fake.calls.length, 0);
    const observed: string[] = [];
    const completed = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...clock(), onProgress: snapshot => { observed.push(snapshot.status); snapshot.model = 'observer-mutation'; snapshot.records.length = 0; throw new Error('Observer unavailable.'); } });
    assert.equal(completed.model, config.model); assert.equal(completed.records.length, 1); assert.equal(completed.records[0].status, 'succeeded');
    assert(observed.includes('running')); assert.equal(observed.at(-1), 'completed'); assert.equal(fake.calls.length, 1);
  } finally { c.close(); }
});

test('each batch run records its current process/session without changing frozen inputs and owner uncertainty stays unknown', async () => {
  const c = setup(); const fake = executor(c);
  try {
    const batch = create(c);
    assert.equal(batchExecutorState(batch), 'unknown');
    for (const state of ['alive', 'dead', 'unknown'] as const) assert.equal(batchExecutorState({ executorPid: 123 }, () => state), state);
    assert.notEqual(batchExecutorState({ executorPid: process.pid }), 'dead');
    const prior = c.batches.save({ ...batch, executorPid: 123, executorSessionId: 'earlier-executor' });
    const completed = await runGroupBatch(c.store, c.batches, prior.id, { ...fake, ...clock() });
    assert.equal(completed.executorPid, process.pid); assert.match(completed.executorSessionId!, /^[0-9a-f-]{36}$/);
    assert.equal(completed.configurationFingerprint, batch.configurationFingerprint); assert.equal(completed.checklistFingerprint, batch.checklistFingerprint);
    assert.equal(completed.id, batch.id); assert.equal(fake.calls.length, 1);
  } finally { c.close(); }
});

test('explicit configuration-bound rescoring replaces reuse of old prompts without deleting results or repeating new successes', async () => {
  const c = setup();
  try {
    const source = c.conversations[0]; const old = evaluation(source, 'prior-semantic-profile'); old.configuration.configurationFingerprint = 'prior-profile'; c.store.saveEvaluation(old);
    const fingerprint = getProviderConfigurationIdentity(config).configurationFingerprint;
    assert.equal(findValidOfficialEvaluation(c.store, source)?.id, old.id);
    assert.equal(findValidOfficialEvaluation(c.store, source, config.model, fingerprint), undefined);
    const ordinary = create(c); const unused = executor(c);
    assert.equal((await runGroupBatch(c.store, c.batches, ordinary.id, { ...unused, ...clock() })).records[0].status, 'reused'); assert.equal(unused.calls.length, 0);
    const strict = createGroupBatch(c.store, c.batches, { groupId: 'DEV', minSpacingMs: 0, requireCurrentConfiguration: true }); const fresh = executor(c, [], fingerprint);
    const completed = await runGroupBatch(c.store, c.batches, strict.id, { ...fresh, ...clock() });
    assert.equal(completed.records[0].status, 'succeeded'); assert.equal(fresh.calls.length, 1); assert.equal(c.store.getEvaluation(old.id)?.id, old.id);
    c.batches.resume(strict.id); await runGroupBatch(c.store, c.batches, strict.id, { ...fresh, ...clock() }); assert.equal(fresh.calls.length, 1);
    const repeat = createGroupBatch(c.store, c.batches, { groupId: 'DEV', minSpacingMs: 0, requireCurrentConfiguration: true });
    assert.equal((await runGroupBatch(c.store, c.batches, repeat.id, { ...fresh, ...clock() })).records[0].status, 'reused'); assert.equal(fresh.calls.length, 1);
    assert.throws(() => c.batches.save({ ...c.batches.required(strict.id), requireCurrentConfiguration: false }), /IMMUTABLE_BATCH_SOURCE/);
    assert.throws(() => createGroupBatch(c.store, c.batches, { id: strict.id, groupId: 'DEV', minSpacingMs: 0 }), /BATCH_IDEMPOTENCY_CONFLICT/);
  } finally { c.close(); }
});

test('configuration-bound reruns preserve authentic local human reuse without an AI prompt fingerprint', async () => {
  const c = setup();
  try {
    const source = c.conversations[0]; const human = { ...evaluation(source, 'authentic-local-fixture'), provider: 'local', model: 'none', mode: 'local' as const, status: 'human_entered' as const, origin: 'human' as const, reviewer: 'SOFTWARE_ONLY_HUMAN_FIXTURE', configuration: { humanAttestation: true, softwareFixtureNotGold: true } };
    c.store.saveEvaluation(human); const fake = executor(c);
    const batch = createGroupBatch(c.store, c.batches, { groupId: 'DEV', minSpacingMs: 0, requireCurrentConfiguration: true });
    const result = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...clock() });
    assert.equal(result.records[0].status, 'reused'); assert.equal(result.records[0].evaluationId, human.id); assert.equal(fake.calls.length, 0);
  } finally { c.close(); }
});

test('absolute deadlines require canonical UTC and form immutable idempotent batch input', () => {
  const c = setup(); const time = clock(); const deadlineAt = new Date(time.now() + 600000).toISOString();
  try {
    assert.equal(validateBatchDeadlineAt(undefined), undefined);
    for (const invalid of ['not-a-date', '2026-11-07', '2026-11-07T12:00:00', '2026-11-07T12:00:00Z', '2026-11-07T12:00:00.000+00:00', '2026-02-30T12:00:00.000Z']) assert.throws(() => create(c, { deadlineAt: invalid }), /INVALID_BATCH_DEADLINE/);
    const batch = create(c, { deadlineAt });
    assert.equal(batch.deadlineAt, deadlineAt);
    assert.deepEqual(createGroupBatch(c.store, c.batches, { groupId: 'DEV', id: batch.id, minSpacingMs: 0, deadlineAt }), batch);
    assert.throws(() => c.batches.save({ ...batch, deadlineAt: new Date(time.now() + 1200000).toISOString() }), /IMMUTABLE_BATCH_SOURCE/);
    assert.throws(() => c.batches.save({ ...batch, deadlineAt: undefined }), /IMMUTABLE_BATCH_SOURCE/);
    assert.throws(() => createGroupBatch(c.store, c.batches, { groupId: 'DEV', id: batch.id, minSpacingMs: 0 }), /BATCH_IDEMPOTENCY_CONFLICT/);
    const legacy = create(c); assert.equal(Object.hasOwn(legacy, 'deadlineAt'), false);
  } finally { c.close(); }
});

test('an absolute deadline that cannot fit the full provider budget dispatches no request', async () => {
  const c = setup(); const time = clock(); const fake = executor(c);
  try {
    const deadlineAt = new Date(time.now() + config.timeoutMs + 999).toISOString(); const batch = create(c, { deadlineAt });
    const paused = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...time });
    assert.equal(paused.reason, 'ABSOLUTE_DEADLINE_EXHAUSTED'); assert.equal(fake.calls.length, 0); assert.equal(c.store.listEvaluationAttempts().length, 0);
    assert.equal(paused.deadlineAt, deadlineAt); assert.equal(paused.records[0].runs.length, 0);
  } finally { c.close(); }
});

test('pause and resume cannot extend the absolute cutoff, while saved results remain reusable', async () => {
  const c = setup(2, 'DEADLINE_RESUME_FIXTURE'); const time = clock(); const fake = executor(c); c.conversations.forEach(item => approve(c, item));
  try {
    const deadlineAt = new Date(time.now() + config.timeoutMs + 6000).toISOString(); const batch = create(c, { groupId: 'DEADLINE_RESUME_FIXTURE', deadlineAt });
    const execute: typeof evaluateAndSave = async (...args) => { const saved = await fake.execute(...args); time.advance(6000); return saved; };
    let paused = await runGroupBatch(c.store, c.batches, batch.id, { ...time, execute, permissions: c.permissions });
    assert.equal(fake.calls.length, 1); assert.equal(paused.reason, 'ABSOLUTE_DEADLINE_EXHAUSTED'); assert.equal(paused.records[0].status, 'succeeded');
    c.batches.close(); c.batches = new BatchStore(c.path); c.batches.resume(batch.id); time.advance(config.timeoutMs + 10000);
    paused = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...time, permissions: c.permissions });
    assert.equal(paused.deadlineAt, deadlineAt); assert.equal(paused.reason, 'ABSOLUTE_DEADLINE_EXHAUSTED'); assert.equal(fake.calls.length, 1); assert.equal(paused.records[1].runs.length, 0);
    assert(['succeeded', 'reused'].includes(paused.records[0].status)); assert.equal(c.store.listEvaluations().length, 1);
  } finally { c.close(); }
});

test('an overlong sleep is rechecked against the absolute deadline before creating the next request', async () => {
  const c = setup(2, 'DEADLINE_SLEEP_FIXTURE'); const time = clock(); const fake = executor(c); c.conversations.forEach(item => approve(c, item));
  try {
    const batch = create(c, { groupId: 'DEADLINE_SLEEP_FIXTURE', minSpacingMs: 1000, deadlineAt: new Date(time.now() + config.timeoutMs + 2000).toISOString() });
    const result = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...time, sleep: async ms => { await time.sleep(ms); time.advance(2); }, permissions: c.permissions });
    assert.equal(time.sleeps[0], 1000); assert.equal(result.reason, 'ABSOLUTE_DEADLINE_EXHAUSTED'); assert.equal(fake.calls.length, 1); assert.equal(result.records[1].runs.length, 0);
    assert.equal(c.store.listEvaluationAttempts().length, 1);
  } finally { c.close(); }
});

test('retry backoff must fit the immutable absolute deadline and cannot start a late linked child', async () => {
  const c = setup(); const time = clock(); const fake = executor(c, ['PROVIDER_FAILED', null]);
  try {
    const batch = create(c, { deadlineAt: new Date(time.now() + config.timeoutMs + 1500).toISOString() });
    const paused = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...time });
    assert.equal(paused.reason, 'ABSOLUTE_DEADLINE_EXHAUSTED'); assert.equal(fake.calls.length, 1); assert.equal(paused.records[0].runs.length, 1);
    assert.equal(paused.records[0].errorCode, 'PROVIDER_FAILED'); assert.equal(c.store.listEvaluations().length, 0);
  } finally { c.close(); }
});

test('an expired deadline does not prevent zero-call reuse of already valid results', async () => {
  const c = setup(); const time = clock(); const saved = evaluation(c.conversations[0], 'saved-before-deadline'); c.store.saveEvaluation(saved); const fake = executor(c);
  try {
    const batch = create(c, { deadlineAt: new Date(time.now() - 1000).toISOString() });
    const completed = await runGroupBatch(c.store, c.batches, batch.id, { ...fake, ...time });
    assert.equal(completed.status, 'completed'); assert.equal(completed.records[0].status, 'reused'); assert.equal(completed.records[0].evaluationId, saved.id); assert.equal(fake.calls.length, 0);
  } finally { c.close(); }
});

test('actual CLI accepts stop-at with the current-configuration flag and an expired cutoff makes no attempt', () => {
  const c = setup(); const deadlineAt = '2020-01-01T00:00:00.000Z';
  const env = { ...process.env, CQA_DB_PATH: c.path, CQA_MODEL: config.model, GEMINI_API_KEY: '', GEMINI_FREE_TIER_CONFIRMED: 'true' };
  const cli = ['--import', 'tsx', resolve('scripts/run-group.ts')];
  try {
    const preview = spawnSync(process.execPath, [...cli, '--group', 'DEV', '--dry-run', '--require-current-configuration', '--stop-at', deadlineAt], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(preview.status, 0, preview.stderr); const plan = JSON.parse(preview.stdout); assert.equal(plan.deadlineAt, deadlineAt); assert.equal(plan.requireCurrentConfiguration, true); assert.equal(plan.noCallsMade, true); assert.equal(c.batches.list().length, 0);
    const run = spawnSync(process.execPath, [...cli, '--group', 'DEV', '--id', 'CLI_ABSOLUTE_DEADLINE_FIXTURE', '--execute', '--require-current-configuration', '--stop-at', deadlineAt], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(run.status, 2, run.stderr); assert(run.stdout.includes('ABSOLUTE_DEADLINE_EXHAUSTED'));
    const batch = c.batches.required('CLI_ABSOLUTE_DEADLINE_FIXTURE'); assert.equal(batch.deadlineAt, deadlineAt); assert.equal(batch.requireCurrentConfiguration, true); assert.equal(c.store.listEvaluationAttempts().length, 0);
    const changed = spawnSync(process.execPath, [...cli, '--batch', batch.id, '--resume', '--execute', '--stop-at', '2020-01-02T00:00:00.000Z'], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(changed.status, 1); assert(changed.stderr.includes('BATCH_DEADLINE_IS_IMMUTABLE')); assert.equal(c.batches.required(batch.id).deadlineAt, deadlineAt);
  } finally { c.close(); }
});
