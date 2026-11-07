import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRecoveryServerConfiguration, officialRecoveryConfigurationAudit, planOfficialRecovery, executeOfficialRecoveries, officialRecoveryRequestId, type OfficialRecoveryState, type RecoveryClient } from '../server/recover-official.js';
import { officialChecklistFingerprint, type GroupBatch } from '../server/batches.js';
import { getProviderConfigurationIdentity } from '../server/provider.js';
import { parseOrganizerResponse } from '../server/importer.js';
import { initialChecklist } from '../src/checklist.js';
import { calculateScore } from '../src/scoring.js';
import { config } from '../server/config.js';
import type { Conversation, Evaluation, EvaluationAttempt } from '../src/domain.js';
import { approvedSyntheticRecord } from './synthetic-fixture.js';

// Pure isolated software fixtures. No database writes, human gold or model/network calls.
function fixture(count = 1): OfficialRecoveryState {
  const parsed = parseOrganizerResponse({ error: '', isSuccess: true, data: { dataset_group_id: 'DEV', total_records: count, records: Array.from({ length: count }, (_, i) => ({ ...approvedSyntheticRecord, ...(i ? { conversation_id: `SOFTWARE_ONLY_RECOVERY_${i}` } : {}) })) } });
  const attempts: EvaluationAttempt[] = parsed.conversations.map((c, i) => ({ id: `failed-parent-${i}`, requestId: `failed-parent-${i}`, conversationVersion: c.version, checklistVersion: initialChecklist.version, model: config.model, recoveryDepth: 0, startedAt: '2026-11-07T10:00:00.000Z', finishedAt: '2026-11-07T10:00:01.000Z', status: 'failed', errorCode: 'INVALID_EVIDENCE', evaluationId: null, usage: { totalTokens: 130 }, latencyMs: 1000 }));
  const batch: GroupBatch = { id: 'software-official-recovery-001', groupId: 'DEV', model: config.model, configurationFingerprint: getProviderConfigurationIdentity(config).configurationFingerprint, checklistVersion: initialChecklist.version, checklistFingerprint: officialChecklistFingerprint, createdAt: '2026-11-07T10:00:00.000Z', minSpacingMs: 12000, runBudgetMs: 2700000, revision: 1, updatedAt: '2026-11-07T10:00:01.000Z', status: 'completed', control: 'run', reason: 'COMPLETED_WITH_UNAVAILABLE_RECORDS', allowInterruptedRecovery: false, retryQuota: false,
    records: parsed.conversations.map((c, i) => ({ conversationId: c.conversationId, conversationVersion: c.version, status: 'error', errorCode: 'INVALID_EVIDENCE', evaluationId: null, retryAt: null, runs: [{ requestId: attempts[i].id, status: 'failed', startedAt: attempts[i].startedAt, finishedAt: attempts[i].finishedAt, errorCode: 'INVALID_EVIDENCE', providerCallCount: 1, usage: attempts[i].usage, latencyMs: 1000 }] })) };
  return { batch, batches: [batch], dataset: { groupId: 'DEV', conversations: parsed.conversations, originals: new Map(parsed.conversations.map((c, i) => [c.version, parsed.originals[i]])), evaluations: [], attempts, checklists: [structuredClone(initialChecklist)] }, approvedSyntheticVersions: parsed.conversations.filter(c => c.classification === 'unknown').map(c => c.version) };
}
function success(source: Conversation, attemptId: string): Evaluation {
  const operator = source.messages.find(m => m.speaker === 'operator')!;
  const results = initialChecklist.criteria.map(c => ({ criterionId: c.id, answer: c.answerType === 'numeric' ? '0' : 'NO', explanation: 'Только программная проверка отдельного восстановления; не человеческий эталон.', applicabilityRationale: '', evidence: [{ messageId: operator.id, quote: operator.text }], checkedRange: { startMessageId: source.messages[0].id, endMessageId: source.messages.at(-1)!.id }, reviewRequired: false, uncertainty: '' }));
  return { id: `eval-${attemptId}`, attemptId, conversationVersion: source.version, checklistVersion: initialChecklist.version, provider: 'gemini', model: config.model, mode: 'free', status: 'live_validated', origin: 'ai', createdAt: '2026-11-07T10:00:03.000Z', results, score: calculateScore(initialChecklist, results), usage: { totalTokens: 200 }, latencyMs: 1000, providerCallCount: 1, configuration: { softwareFixtureNotGold: true } };
}
function client(state: OfficialRecoveryState, failure?: string) {
  const posts: Parameters<RecoveryClient['post']>[0][] = [];
  return { posts, load: async () => state, post: async (payload: Parameters<RecoveryClient['post']>[0]) => {
    posts.push(payload); const parent = state.dataset.attempts.find(a => a.id === payload.retryOf)!;
    const child: EvaluationAttempt = { ...parent, id: payload.requestId, requestId: payload.requestId, recoveryOf: parent.id, recoveryDepth: 1, status: failure ? 'failed' : 'succeeded', errorCode: failure || null, usage: failure ? null : { totalTokens: 200 }, latencyMs: 1000, evaluationId: failure ? null : `eval-${payload.requestId}` };
    state.dataset.attempts.push(child); if (!failure) state.dataset.evaluations.push(success(state.dataset.conversations.find(c => c.version === payload.conversationVersion)!, payload.requestId));
    return { ok: !failure, ...(failure ? { errorCode: failure } : {}) };
  } };
}
function clock() { let time = 1000000; const sleeps: number[] = []; return { now: () => time, sleep: async (ms: number) => { sleeps.push(ms); time += ms; }, sleeps }; }

test('planner selects only strict official/current-model failed depth-zero approved synthetic sources', () => {
  const state = fixture(); assert.equal(planOfficialRecovery(state)[0].action, 'eligible');
  for (const code of ['INVALID_EVIDENCE', 'INVALID_MODEL_JSON', 'PROVIDER_EMPTY_RESULT', 'PROVIDER_TIMEOUT']) { const s = fixture(); s.dataset.attempts[0].errorCode = code; s.batch.records[0].runs[0].errorCode = code; assert.equal(planOfficialRecovery(s)[0].action, 'eligible'); }
  for (const mutate of [(s: OfficialRecoveryState) => { s.dataset.attempts[0].model = 'old-model'; }, (s: OfficialRecoveryState) => { s.dataset.attempts[0].checklistVersion = 'custom-nine'; }, (s: OfficialRecoveryState) => { s.dataset.conversations[0].channel = 'voice call'; }, (s: OfficialRecoveryState) => { s.dataset.attempts[0].errorCode = 'PROVIDER_RATE_LIMIT'; }, (s: OfficialRecoveryState) => { s.dataset.attempts[0].recoveryDepth = 1; }]) { const s = fixture(); mutate(s); assert.notEqual(planOfficialRecovery(s)[0].action, 'eligible'); }
  const changed = fixture(); changed.dataset.checklists[0].criteria[0].instructions += ' Changed.'; assert.throws(() => planOfficialRecovery(changed), /CONFIGURATION_MISMATCH/);
  const unknown = fixture(2); unknown.approvedSyntheticVersions = []; assert.equal(planOfficialRecovery(unknown)[1].reason, 'DATA_PERMISSION_REQUIRED');
});

test('existing valid success is reused; any existing child failure blocks another child', () => {
  const state = fixture(); const id = officialRecoveryRequestId(state.dataset.attempts[0].id);
  state.dataset.evaluations.push(success(state.dataset.conversations[0], id)); assert.equal(planOfficialRecovery(state)[0].action, 'reused');
  state.dataset.evaluations = []; state.dataset.attempts.push({ ...state.dataset.attempts[0], id, recoveryOf: state.dataset.attempts[0].id, recoveryDepth: 1 });
  assert.equal(planOfficialRecovery(state)[0].action, 'exhausted'); assert.equal(planOfficialRecovery(state)[0].reason, 'CHILD_ALREADY_ATTEMPTED');
  assert.equal(officialRecoveryRequestId('one-parent'), officialRecoveryRequestId('one-parent')); assert.notEqual(officialRecoveryRequestId('one-parent'), officialRecoveryRequestId('other-parent'));
});

test('all batch/ledger running states refuse dispatch, including running existing child', async () => {
  for (const kind of ['batch', 'ledger', 'child']) {
    const state = fixture(); if (kind === 'batch') state.batch.status = 'running'; else if (kind === 'ledger') state.dataset.attempts[0].status = 'running'; else state.dataset.attempts.push({ ...state.dataset.attempts[0], id: 'existing-child', recoveryOf: state.dataset.attempts[0].id, recoveryDepth: 1, status: 'running' });
    const api = client(state); await assert.rejects(executeOfficialRecoveries(api), /OFFICIAL_RECOVERY_BUSY/); assert.equal(api.posts.length, 0);
  }
});

test('one deterministic linked child is saved and subsequent executions reuse it without another POST', async () => {
  const state = fixture(); const api = client(state); const result = await executeOfficialRecoveries(api, { ...clock(), onProgress: outcome => { outcome.status = 'failed'; throw new Error('Observer unavailable'); } });
  assert.equal(api.posts.length, 1); assert.equal(api.posts[0].retryOf, 'failed-parent-0'); assert.equal(api.posts[0].requestId, officialRecoveryRequestId('failed-parent-0')); assert.equal(result.outcomes[0].status, 'succeeded'); assert.equal(result.outcomes[0].usage?.totalTokens, 200);
  const rerun = await executeOfficialRecoveries(api, clock()); assert.equal(api.posts.length, 1); assert.equal(rerun.selectedParents, 0);
});

test('failed child evidence is never repaired or retried, quota and timeouts stop the finite pass', async () => {
  for (const error of ['INVALID_EVIDENCE', 'PROVIDER_RATE_LIMIT', 'PROVIDER_TIMEOUT']) {
    const state = fixture(2); const api = client(state, error); const result = await executeOfficialRecoveries(api, { ...clock(), limit: 1 });
    assert.equal(api.posts.length, 1); assert.equal(result.outcomes[0].status, 'failed'); assert.equal(result.outcomes[0].errorCode, error);
    if (error !== 'INVALID_EVIDENCE') assert.equal(result.stopReason, error);
    await executeOfficialRecoveries(api, { ...clock(), limit: 1 }); assert.equal(api.posts.filter(p => p.retryOf === 'failed-parent-0').length, 1);
  }
});

test('bounds reserve a complete request deadline and spacing; lost request outcome stops without an automatic second call', async () => {
  const state = fixture(2); const api = client(state); const time = clock();
  const blocked = await executeOfficialRecoveries(api, { ...time, budgetMs: config.timeoutMs + 4999 }); assert.equal(blocked.stopReason, 'OFFICIAL_RECOVERY_BUDGET_EXHAUSTED'); assert.equal(api.posts.length, 0);
  const result = await executeOfficialRecoveries(api, { ...time, limit: 2, spacingMs: 6000 }); assert.equal(result.outcomes.length, 2); assert.deepEqual(time.sleeps, [6000]);
  const unknown = fixture(2); let posts = 0; const uncertain = await executeOfficialRecoveries({ load: async () => unknown, post: async () => { posts++; throw new Error('untrusted transport body'); } }, clock());
  assert.equal(posts, 1); assert.equal(uncertain.stopReason, 'RECOVERY_OUTCOME_NOT_CONFIRMED'); assert.equal(uncertain.outcomes[0].status, 'unknown'); assert(!JSON.stringify(uncertain).includes('untrusted transport body'));
});

test('concurrency is rechecked immediately before each POST, not only when the original plan is created', async () => {
  const state = fixture(); let reads = 0; let posts = 0;
  await assert.rejects(executeOfficialRecoveries({ load: async () => { if (++reads > 1) state.batch.status = 'running'; return state; }, post: async () => { posts++; return { ok: true }; } }, clock()), /OFFICIAL_RECOVERY_BUSY/); assert.equal(posts, 0);
});

test('known required-range configuration upgrade requires an explicit flag and never accepts arbitrary semantic changes', async () => {
  const state = fixture(); const identity = getProviderConfigurationIdentity(config); state.batch.configurationFingerprint = identity.compatiblePreviousFingerprint;
  assert.throws(() => planOfficialRecovery(state), /CONFIGURATION_MISMATCH/);
  assert.equal(planOfficialRecovery(state, { acceptRequiredRangeUpgrade: true })[0].action, 'eligible');
  const api = client(state); await assert.rejects(executeOfficialRecoveries(api, clock()), /CONFIGURATION_MISMATCH/); assert.equal(api.posts.length, 0);
  const result = await executeOfficialRecoveries(api, { ...clock(), acceptRequiredRangeUpgrade: true });
  assert.equal(api.posts.length, 1); assert.equal(result.configurationAudit.acceptRequiredRangeUpgrade, true); assert.equal(result.configurationAudit.requiredRangeUpgradeApplied, true);
  assert.equal(result.configurationAudit.batchConfigurationFingerprint, identity.compatiblePreviousFingerprint); assert.equal(result.configurationAudit.currentConfigurationFingerprint, identity.configurationFingerprint);
  state.batch.configurationFingerprint = 'f'.repeat(64); assert.throws(() => planOfficialRecovery(state, { acceptRequiredRangeUpgrade: true }), /CONFIGURATION_MISMATCH/);
  state.batch.configurationFingerprint = identity.compatibleSourceSpanFingerprint;
  assert.throws(() => planOfficialRecovery(state), /CONFIGURATION_MISMATCH/);
  assert.equal(planOfficialRecovery(state, { acceptRequiredRangeUpgrade: true })[0].action, 'reused');
  state.batch.configurationFingerprint = identity.compatibleExactQuotesFingerprint;
  assert.throws(() => planOfficialRecovery(state), /CONFIGURATION_MISMATCH/);
  assert.equal(planOfficialRecovery(state, { acceptRequiredRangeUpgrade: true })[0].action, 'reused');
  state.batch.configurationFingerprint = identity.compatibleFlatQuotesFingerprint;
  assert.throws(() => planOfficialRecovery(state), /CONFIGURATION_MISMATCH/);
  assert.equal(planOfficialRecovery(state, { acceptRequiredRangeUpgrade: true })[0].action, 'reused');
  assert.equal(officialRecoveryConfigurationAudit(state, { acceptRequiredRangeUpgrade: true }).generationCompatibilityScope, 'configuration-transition-only-not-vendor-acceptance');
  const wrongModel = fixture(); wrongModel.batch.configurationFingerprint = identity.compatiblePreviousFingerprint; wrongModel.batch.model = 'different-model'; assert.throws(() => planOfficialRecovery(wrongModel, { acceptRequiredRangeUpgrade: true }), /CONFIGURATION_MISMATCH/);
  assert.equal(officialRecoveryConfigurationAudit(fixture()).requiredRangeUpgradeApplied, false);
});

test('server generation identity is verified before each POST so an old server cannot consume a child', async () => {
  const identity = getProviderConfigurationIdentity(config);
  const current = { model: config.model, provider: 'gemini', mode: 'free', configurationFingerprint: identity.configurationFingerprint, generationConstraintVersion: identity.generationConstraintVersion };
  assert.doesNotThrow(() => assertRecoveryServerConfiguration(current));
  for (const changed of [{ ...current, configurationFingerprint: identity.compatiblePreviousFingerprint }, { ...current, generationConstraintVersion: undefined }, { ...current, generationConstraintVersion: 'arbitrary-source-policy-v999' }, { ...current, model: 'different-model' }]) assert.throws(() => assertRecoveryServerConfiguration(changed), /LOCAL_SERVER_GENERATION_CONFIGURATION_MISMATCH/);
  const api = client(fixture()); await assert.rejects(executeOfficialRecoveries({ ...api, beforePost: async () => assertRecoveryServerConfiguration({ ...current, configurationFingerprint: identity.compatiblePreviousFingerprint }) }, clock()), /LOCAL_SERVER_GENERATION_CONFIGURATION_MISMATCH/);
  assert.equal(api.posts.length, 0);
});

test('intentional current-configuration recovery ignores a valid old-profile AI result without changing legacy default reuse', async () => {
  const state = fixture(); const old = success(state.dataset.conversations[0], 'old-profile-request'); old.configuration.configurationFingerprint = 'old-valid-configuration'; state.dataset.evaluations.push(old);
  assert.equal(planOfficialRecovery(state)[0].action, 'reused');
  state.batch.requireCurrentConfiguration = true; assert.equal(planOfficialRecovery(state)[0].action, 'eligible');
  const api = client(state); await executeOfficialRecoveries(api, clock()); assert.equal(api.posts.length, 1);
  const latest = state.dataset.evaluations.at(-1)!; latest.configuration.configurationFingerprint = state.batch.configurationFingerprint;
  assert.equal(planOfficialRecovery(state)[0].action, 'reused'); await executeOfficialRecoveries(api, clock()); assert.equal(api.posts.length, 1);
});
