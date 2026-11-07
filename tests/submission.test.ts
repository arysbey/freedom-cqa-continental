import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { ReviewStore } from '../server/reviews.js';
import { QualityStore } from '../server/quality.js';
import { PermissionStore } from '../server/data-permissions.js';
import { parseOrganizerResponse } from '../server/importer.js';
import { GeminiProvider, type ProviderTelemetry, type ProviderTransport } from '../server/provider.js';
import { config } from '../server/config.js';
import { competitionDocumentSchema } from '../server/competition.js';
import { initialChecklist } from '../src/checklist.js';
import { BatchStore, batchRequestId } from '../server/batches.js';
import type { Checklist, Conversation } from '../src/domain.js';
import { approvedSyntheticRecord } from './synthetic-fixture.js';
import { removeLocalTemp } from './local-temp.js';

const headers = { host: 'localhost:3001', origin: 'http://localhost:3001', 'content-type': 'application/json' };
const teamName = 'Continental';
function envelope(group: string, count: number, calls = 0) { return { error: '', isSuccess: true, data: { dataset_group_id: group, total_records: count,
  records: Array.from({ length: count }, (_, index) => ({ ...approvedSyntheticRecord, conversation_id: `SOFTWARE_ONLY_${String(index + 1).padStart(3, '0')}`, channel: index >= count - calls ? 'voice call' : 'agent chat' })) } }; }
async function setup(isolatedExports = true) {
  mkdirSync(resolve('tmp'), { recursive: true }); const directory = mkdtempSync(resolve('tmp', 'submission-test-')); const path = join(directory, 'test.sqlite');
  const store = new Store(path); const permissions = new PermissionStore(path);
  const app = await createApp(store, new ReviewStore(path), new QualityStore(path), permissions, isolatedExports ? { submissionWorkspaceRoot: directory } : {});
  return { directory, path, store, permissions, app, close: async () => { await app.close(); removeLocalTemp(directory); } };
}
function importGroup(c: Awaited<ReturnType<typeof setup>>, group: string, count: number, calls = 0) { const parsed = parseOrganizerResponse(envelope(group, count, calls)); c.store.importDataset(parsed); return parsed.conversations; }
function permissionCount(path: string) { const db = new DatabaseSync(path, { readOnly: true }); try { return Number((db.prepare('SELECT COUNT(*) AS n FROM permission_approvals').get() as { n: number }).n); } finally { db.close(); } }
function query(groupId: string, target = 'prod') { return `groupId=${encodeURIComponent(groupId)}&target=${target}&teamName=${teamName}`; }
async function post(c: Awaited<ReturnType<typeof setup>>, url: string, payload: unknown) { return c.app.inject({ method: 'POST', url, headers, payload: JSON.stringify(payload) }); }
async function batchState(c: Awaited<ReturnType<typeof setup>>, id: string, predicate: (state: { status: string; records: Array<{ status: string }> }) => boolean) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) { const response = await c.app.inject({ url: `/api/competition/batches/${id}`, headers }); const state = response.json(); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('ASYNC_BATCH_DID_NOT_REACH_EXPECTED_STATE');
}
function interceptProvider(t: TestContext, generate: ProviderTransport['generate']) {
  const original = GeminiProvider.prototype.evaluate;
  t.mock.method(GeminiProvider.prototype, 'evaluate', function (this: GeminiProvider, conversation: Conversation, checklist: Checklist) {
    const observer = (this as unknown as { onTelemetry?: (telemetry: ProviderTelemetry) => void }).onTelemetry;
    return original.call(new GeminiProvider({ ...config, apiKey: 'non-live-submission-test-key', freeTierConfirmed: true, retryLimit: 0 }, { listModels: async () => [], generate }, observer), conversation, checklist);
  });
}
function softwareResponse(request: Parameters<ProviderTransport['generate']>[0]) {
  const input = JSON.parse(request.contents) as { conversation: { messages: Conversation['messages'] } };
  const messages = input.conversation.messages; const operator = messages.find(m => m.speaker === 'operator')!;
  return { text: JSON.stringify({ results: initialChecklist.criteria.map(c => ({ criterionId: c.id, answer: c.answerType === 'numeric' ? '0' : 'NO', explanation: 'Программная проверка технического сохранения, не человеческий эталон.', applicabilityRationale: '', evidence: [{ messageId: operator.id, quote: operator.text }], checkedRange: { startMessageId: messages[0].id, endMessageId: messages.at(-1)!.id }, reviewRequired: false, uncertainty: '' })) }), usageMetadata: { totalTokenCount: 130 } };
}

test('submission groups and coverage use real group IDs/counts and retain all65 DEV entries including five unavailable calls', async () => {
  const c = await setup();
  try {
    const dev = importGroup(c, 'DEV', 65, 5); importGroup(c, 'LOCAL_REHEARSAL_10', 10); importGroup(c, 'SOFTWARE_ACCEPTANCE_GROUP', 1);
    const groups = (await c.app.inject({ url: '/api/competition/groups', headers })).json();
    assert.equal(groups.teamName, teamName); assert.equal(groups.model, config.model);
    assert.deepEqual(groups.groups.find((g: { groupId: string }) => g.groupId === 'DEV'), { groupId: 'DEV', records: 65, fixture: false });
    assert.equal(groups.groups.find((g: { groupId: string }) => g.groupId === 'LOCAL_REHEARSAL_10').fixture, true);
    assert.equal(groups.groups.find((g: { groupId: string }) => g.groupId === 'SOFTWARE_ACCEPTANCE_GROUP').fixture, true);
    const coverage = await c.app.inject({ url: `/api/competition/coverage?${query('DEV', 'dev')}`, headers });
    assert.equal(coverage.statusCode, 200, coverage.body); assert.equal(coverage.json().records, 65); assert.equal(coverage.json().success, 0); assert.equal(coverage.json().error, 65);
    assert.deepEqual(coverage.json().recordsSummary.map((r: { conversationId: string }) => r.conversationId).sort(), dev.map(d => d.conversationId).sort());
    assert.equal(c.store.listEvaluationAttempts().length, 0); assert.equal(c.store.listEvaluations().length, 0);
  } finally { await c.close(); }
});

test('coverage enforces target counts; download returns strict JSON with original IDs and truthful errors', async () => {
  const c = await setup();
  try {
    const sources = importGroup(c, 'CONTROL_SOFTWARE_FIXTURE', 10); importGroup(c, 'WRONG_COUNT_FIXTURE', 9);
    for (const url of [`/api/competition/coverage?${query('WRONG_COUNT_FIXTURE')}`, `/api/competition/coverage?${query('CONTROL_SOFTWARE_FIXTURE', 'dev')}`]) {
      const bad = await c.app.inject({ url, headers }); assert.equal(bad.statusCode, 400); assert.equal(bad.json().error, 'COMPETITION_SOURCE_COVERAGE_MISMATCH');
    }
    const download = await c.app.inject({ url: `/api/competition/download?${query('CONTROL_SOFTWARE_FIXTURE')}`, headers });
    assert.equal(download.statusCode, 200); assert.match(String(download.headers['content-type']), /application\/json/); assert.match(String(download.headers['content-disposition']), /prod-results\.json/);
    const document = download.json(); assert(competitionDocumentSchema.safeParse(document).success); assert.equal(document.results.length, 10);
    assert.deepEqual(document.results.map((r: { conversation_id: string }) => r.conversation_id).sort(), sources.map(s => s.conversationId).sort());
    assert(document.results.every((r: { status: string; criteria: unknown[]; score: unknown; error?: string }) => r.status === 'error' && r.criteria.length === 0 && r.score === null && !!r.error));
    assert.equal(document.team_name, teamName); assert.equal(document.model.name, config.model);
  } finally { await c.close(); }
});

test('dry run preserves existing output and fixture official writes are restricted to explicit isolated workspaces', async () => {
  const c = await setup(); const guarded = await setup(false);
  try {
    importGroup(c, 'LOCAL_REHEARSAL_10', 10); importGroup(guarded, 'SOFTWARE_ACCEPTANCE_GROUP', 10);
    const official = join(c.directory, 'results/prod/results.json'); mkdirSync(join(c.directory, 'results/prod'), { recursive: true }); writeFileSync(official, 'existing-output-sentinel');
    const input = { groupId: 'LOCAL_REHEARSAL_10', target: 'prod', teamName };
    const dry = await post(c, '/api/competition/export', { ...input, dryRun: true });
    assert.equal(dry.statusCode, 200, dry.body); assert.equal(dry.json().published, false); assert(dry.json().outputPath.startsWith('private/')); assert.equal(readFileSync(official, 'utf8'), 'existing-output-sentinel');
    const actualLocal = await post(c, '/api/competition/export', { ...input, dryRun: false });
    assert.equal(actualLocal.statusCode, 200, actualLocal.body); assert.equal(actualLocal.json().outputPath, 'results/prod/results.json'); assert.equal(actualLocal.json().records, 10); assert(existsSync(official));
    assert(competitionDocumentSchema.safeParse(JSON.parse(readFileSync(official, 'utf8'))).success);
    const blocked = await post(guarded, '/api/competition/export', { groupId: 'SOFTWARE_ACCEPTANCE_GROUP', target: 'prod', teamName, dryRun: false });
    assert.equal(blocked.statusCode, 400); assert.equal(blocked.json().error, 'FIXTURE_OFFICIAL_EXPORT_FORBIDDEN');
    const extra = await post(c, '/api/competition/export', { ...input, dryRun: true, publish: true }); assert.equal(extra.statusCode, 400);
  } finally { await c.close(); await guarded.close(); }
});

test('unknown-group batch permissions require explicit attestations and the whole fingerprint; mixed real calls fail atomically', async () => {
  const c = await setup();
  try {
    importGroup(c, 'PERMISSION_SOFTWARE_GROUP', 3, 1);
    const previewResponse = await c.app.inject({ url: '/api/competition/permissions?groupId=PERMISSION_SOFTWARE_GROUP', headers });
    assert.equal(previewResponse.statusCode, 200); const preview = previewResponse.json(); assert.equal(preview.sources.length, 2); assert.equal(preview.preview.eligibleCount, 2);
    const payload = { ...preview.preview, reviewer: 'SOFTWARE_PERMISSION_FIXTURE', reason: 'Explicit isolated software permission test, no external processing.', syntheticAttestation: true, freeTierUseApproved: true, origin: 'human_declared', requestId: 'submission-permission-001' };
    // eligibleCount is display metadata, not an undocumented mutation parameter.
    delete payload.eligibleCount;
    const invalid = await post(c, '/api/competition/permissions', { ...payload, sourceFingerprint: '0'.repeat(64) }); assert.equal(invalid.statusCode, 400); assert.equal(permissionCount(c.path), 0);
    const all = c.store.listConversations('PERMISSION_SOFTWARE_GROUP').map(item => item.version);
    const mixed = await post(c, '/api/competition/permissions', { ...payload, conversationVersions: all }); assert.equal(mixed.statusCode, 400); assert.equal(permissionCount(c.path), 0);
    const missingAttestation = await post(c, '/api/competition/permissions', { ...payload, syntheticAttestation: false }); assert.equal(missingAttestation.statusCode, 400); assert.equal(permissionCount(c.path), 0);
    const first = await post(c, '/api/competition/permissions', payload); assert.equal(first.statusCode, 200, first.body); assert.equal(first.json().eligibleCount, 2); assert.equal(permissionCount(c.path), 2);
    const repeated = await post(c, '/api/competition/permissions', payload); assert.equal(repeated.statusCode, 200); assert.deepEqual(repeated.json(), first.json()); assert.equal(permissionCount(c.path), 2);
    const conflict = await post(c, '/api/competition/permissions', { ...payload, reviewer: 'CHANGED_SOFTWARE_REVIEWER' }); assert.equal(conflict.statusCode, 400); assert.equal(conflict.json().error, 'IDEMPOTENCY_CONFLICT'); assert.equal(permissionCount(c.path), 2);
    const remaining = (await c.app.inject({ url: '/api/competition/permissions?groupId=PERMISSION_SOFTWARE_GROUP', headers })).json(); assert.equal(remaining.preview, null); assert.equal(remaining.sources.length, 0);
    assert.equal(c.store.listEvaluationAttempts().length, 0); assert.equal(c.store.listEvaluations().length, 0);
  } finally { await c.close(); }
});

test('a stale group permission preview cannot approve a newly imported source version', async () => {
  const c = await setup();
  try {
    importGroup(c, 'STALE_PERMISSION_GROUP', 2);
    const preview = (await c.app.inject({ url: '/api/competition/permissions?groupId=STALE_PERMISSION_GROUP', headers })).json().preview;
    const updated = envelope('STALE_PERMISSION_GROUP', 2); updated.data.records[0].transcript = updated.data.records[0].transcript.map((m, i) => i ? m : { ...m, text: m.text + ' Software changed source.' });
    const imported = await post(c, '/api/import-file', { payload: updated }); assert.equal(imported.statusCode, 200);
    const { eligibleCount: _count, ...source } = preview; void _count;
    const blocked = await post(c, '/api/competition/permissions', { ...source, reviewer: 'SOFTWARE_PERMISSION_FIXTURE', reason: 'Isolated stale preview test.', syntheticAttestation: true, freeTierUseApproved: true, origin: 'human_declared', requestId: 'stale-permission-001' });
    assert.equal(blocked.statusCode, 400); assert.equal(blocked.json().error, 'DATA_PERMISSION_BATCH_SOURCE_MISMATCH'); assert.equal(permissionCount(c.path), 0);
  } finally { await c.close(); }
});

test('batch API starts a genuine asynchronous service job, exposes progress and saves exactly once through pause/resume', async t => {
  const c = await setup(); let calls = 0; let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  c.store.importDataset(parseOrganizerResponse({ error: '', isSuccess: true, data: { dataset_group_id: 'DEV', total_records: 1, records: [approvedSyntheticRecord] } }));
  interceptProvider(t, async request => { calls++; await blocked; return softwareResponse(request); });
  try {
    const payload = { groupId: 'DEV', id: 'async-submission-batch-001', minSpacingMs: 1000, runBudgetMs: 300000 };
    const created = await post(c, '/api/competition/batches', payload); assert.equal(created.statusCode, 200, created.body);
    const repeated = await post(c, '/api/competition/batches', payload); assert.deepEqual(repeated.json(), created.json());
    const conflicting = await post(c, '/api/competition/batches', { ...payload, minSpacingMs: 2000 }); assert.equal(conflicting.statusCode, 400); assert.equal(conflicting.json().error, 'BATCH_IDEMPOTENCY_CONFLICT');
    const run = await post(c, `/api/competition/batches/${payload.id}/run`, {}); assert.equal(run.statusCode, 200); assert.equal(run.json().status, 'running'); assert.equal(calls, 1);
    const running = await batchState(c, payload.id, state => state.records[0].status === 'running'); assert.equal(running.records[0].runs.length, 1); assert.equal(c.store.listEvaluations().length, 0);
    const duplicate = await post(c, `/api/competition/batches/${payload.id}/run`, {}); assert.equal(duplicate.json().error, 'BATCH_ALREADY_RUNNING'); assert.equal(calls, 1);
    const paused = await post(c, `/api/competition/batches/${payload.id}/pause`, {}); assert.equal(paused.statusCode, 200); assert.equal(paused.json().status, 'paused');
    release(); const saved = await batchState(c, payload.id, state => state.records[0].status === 'succeeded'); assert.equal(saved.status, 'paused'); assert.equal(c.store.listEvaluations().length, 1);
    const resume = await post(c, `/api/competition/batches/${payload.id}/run`, { resume: true }); assert.equal(resume.statusCode, 200, resume.body);
    const completed = await batchState(c, payload.id, state => state.status === 'completed'); assert.equal(completed.records[0].status, 'succeeded'); assert.equal(calls, 1); assert.equal(c.store.listEvaluationAttempts().length, 1);
    const evaluations = c.store.listEvaluations(); assert.equal(evaluations[0].checklistVersion, initialChecklist.version); assert.equal(evaluations[0].model, config.model); assert.equal(evaluations[0].status, 'live_validated');
  } finally { release(); await c.close(); }
});

test('unknown data stay blocked in a real asynchronous job until an explicit source-bound approval is saved', async t => {
  const c = await setup(); let calls = 0; interceptProvider(t, async request => { calls++; return softwareResponse(request); });
  try {
    importGroup(c, 'UNKNOWN_SOFTWARE_BATCH', 1);
    const created = await post(c, '/api/competition/batches', { groupId: 'UNKNOWN_SOFTWARE_BATCH', id: 'unknown-submission-batch-001', runBudgetMs: 300000 }); const id = created.json().id;
    await post(c, `/api/competition/batches/${id}/run`, {});
    const blocked = await batchState(c, id, state => state.status === 'completed'); assert.equal(blocked.records[0].status, 'blocked'); assert.equal(calls, 0); assert.equal(c.store.listEvaluationAttempts().length, 0);
    const preview = (await c.app.inject({ url: '/api/competition/permissions?groupId=UNKNOWN_SOFTWARE_BATCH', headers })).json().preview;
    const { eligibleCount: _count, ...sources } = preview; void _count;
    const approved = await post(c, '/api/competition/permissions', { ...sources, reviewer: 'SOFTWARE_PERMISSION_FIXTURE', reason: 'Isolated explicit permission software test.', syntheticAttestation: true, freeTierUseApproved: true, origin: 'human_declared', requestId: 'unknown-submit-permission-001' }); assert.equal(approved.statusCode, 200, approved.body);
    const resumed = await post(c, `/api/competition/batches/${id}/run`, { resume: true }); assert.equal(resumed.statusCode, 200, resumed.body);
    const completed = await batchState(c, id, state => state.status === 'completed'); assert.equal(completed.records[0].status, 'succeeded'); assert.equal(calls, 1); assert.equal(c.store.listEvaluations().length, 1);
  } finally { await c.close(); }
});

test('resume API permits only a confirmed dead persisted batch owner; live, uncertain and legacy owners never dispatch', async t => {
  let calls = 0; interceptProvider(t, async request => { calls++; return softwareResponse(request); });
  t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
    assert.equal(signal, 0);
    if (pid === 51002) throw Object.assign(new Error('Absent process'), { code: 'ESRCH' });
    if (pid === 51003) throw Object.assign(new Error('Unknown process permissions'), { code: 'EPERM' });
    return true as const;
  });
  for (const [label, executorPid] of [['alive', 51001], ['dead', 51002], ['dead-interrupted', 51002], ['uncertain', 51003], ['legacy', undefined]] as const) {
    const c = await setup(); const ledger = new BatchStore(c.path);
    try {
      c.store.importDataset(parseOrganizerResponse({ error: '', isSuccess: true, data: { dataset_group_id: 'DEV', total_records: 1, records: [approvedSyntheticRecord] } }));
      const id = `owner-${label}-submission-001`; const created = await post(c, '/api/competition/batches', { id, groupId: 'DEV', runBudgetMs: 300000 }); assert.equal(created.statusCode, 200);
      let snapshot = ledger.required(id);
      if (label === 'dead-interrupted') {
        const record = snapshot.records[0]; const requestId = batchRequestId(snapshot, record.conversationVersion, 0); const startedAt = '2026-11-07T10:00:00.000Z';
        const pending = { id: requestId, requestId, executorPid, executorSessionId: 'dead-session', conversationVersion: record.conversationVersion, checklistVersion: initialChecklist.version, model: config.model, startedAt, finishedAt: null, status: 'running' as const, evaluationId: null, errorCode: null, latencyMs: null, usage: null, recoveryDepth: 0 };
        c.store.startEvaluationAttempt(pending); c.store.finishEvaluationAttempt({ ...pending, status: 'failed', finishedAt: '2026-11-07T10:00:01.000Z', errorCode: 'REQUEST_INTERRUPTED' });
        snapshot = { ...snapshot, records: [{ ...record, status: 'running', runs: [{ requestId, status: 'running', startedAt, finishedAt: null, errorCode: null, providerCallCount: null, usage: null, latencyMs: null }] }] };
      }
      ledger.save({ ...snapshot, status: 'running', ...(executorPid ? { executorPid, executorSessionId: `session-${label}` } : {}) });
      const before = calls;
      const implicit = await post(c, `/api/competition/batches/${id}/run`, {}); assert.equal(implicit.json().error, 'BATCH_ALREADY_RUNNING'); assert.equal(calls, before);
      const resumed = await post(c, `/api/competition/batches/${id}/run`, { resume: true, recoverInterrupted: true });
      if (label === 'dead' || label === 'dead-interrupted') {
        assert.equal(resumed.statusCode, 200, resumed.body); const completed = await batchState(c, id, state => state.status === 'completed');
        assert.equal(completed.records[0].status, 'succeeded'); assert.equal(calls, before + 1); assert.equal(completed.executorPid, process.pid);
        if (label === 'dead-interrupted') { assert.equal(completed.records[0].runs.length, 2); assert.equal(completed.records[0].runs[1].retryOf, completed.records[0].runs[0].requestId); assert.equal(c.store.listEvaluationAttempts().length, 2); }
      } else { assert.equal(resumed.json().error, 'BATCH_ALREADY_RUNNING'); assert.equal(calls, before); assert.equal(c.store.listEvaluationAttempts().length, 0); }
    } finally { ledger.close(); await c.close(); }
  }
});

test('a separately running evaluation ledger blocks asynchronous batch dispatch even when the batch is ready', async t => {
  const c = await setup(); let calls = 0; interceptProvider(t, async request => { calls++; return softwareResponse(request); });
  try {
    c.store.importDataset(parseOrganizerResponse({ error: '', isSuccess: true, data: { dataset_group_id: 'DEV', total_records: 1, records: [approvedSyntheticRecord] } }));
    const source = c.store.listConversations()[0];
    c.store.startEvaluationAttempt({ id: 'separate-running-attempt', requestId: 'separate-running-attempt', executorPid: process.pid, executorSessionId: 'software-separate-session', conversationVersion: source.version, checklistVersion: initialChecklist.version, model: config.model, startedAt: new Date().toISOString(), finishedAt: null, status: 'running', evaluationId: null, errorCode: null, latencyMs: null, usage: null });
    const created = await post(c, '/api/competition/batches', { id: 'separate-evaluation-guard-001', groupId: 'DEV' });
    const batches = new BatchStore(c.path); try { batches.pause(created.json().id); } finally { batches.close(); }
    const blocked = await post(c, `/api/competition/batches/${created.json().id}/run`, { resume: true });
    assert.equal(blocked.json().error, 'BATCH_ALREADY_RUNNING'); assert.equal(calls, 0); assert.equal(c.store.listEvaluationAttempts().length, 1); assert.equal(c.store.listEvaluations().length, 0);
  } finally { await c.close(); }
});
