import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { initialChecklist } from '../src/checklist.js';
import { parseOrganizerResponse } from '../server/importer.js';
import { config } from '../server/config.js';

const fixture = { error: '', isSuccess: true, data: { dataset_group_id: 'LOCAL_NEW_GROUP', total_records: 1, records: [{ conversation_id: 'invented-call', channel: 'voice call', language: 'RU', audio_url: null, transcript: [{ timestamp: '2026-11-07T10:00:00+05:00', speaker: 'operator', text: 'Здравствуйте. Это вымышленный пример для программного теста.' }] }] } };
const headers = { host: '127.0.0.1:3001', 'content-type': 'application/json' };

test('local file imports a new group, keeps unknown permission closed and never calls the provider', async () => {
  const store = new Store(':memory:');
  const app = await createApp(store);
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => { networkCalls++; throw new Error('TEST_NETWORK_FORBIDDEN'); }) as typeof fetch;
  try {
    const imported = await app.inject({ method: 'POST', url: '/api/import-file', headers, payload: { payload: fixture } });
    assert.equal(imported.statusCode, 200);
    assert.equal(imported.json().groupId, 'LOCAL_NEW_GROUP');
    const version = store.listConversations()[0].version;
    const denied = await app.inject({ method: 'POST', url: '/api/evaluations', headers, payload: { conversationVersion: version, checklistVersion: initialChecklist.version } });
    assert.equal(denied.json().error, 'DATA_POLICY_RESTRICTED');
    assert.equal(store.listEvaluationAttempts().length, 0);
    assert.equal(networkCalls, 0);
    const repeated = await app.inject({ method: 'POST', url: '/api/import-file', headers, payload: { payload: fixture } });
    assert.equal(repeated.json().unchanged, 1);
  } finally { globalThis.fetch = originalFetch; await app.close(); }
});

test('local manual voice entry is separately labelled, evidence-linked and appealable with zero model calls', async () => {
  const store = new Store(':memory:');
  store.importDataset(parseOrganizerResponse(fixture));
  const app = await createApp(store);
  try {
    const conversation = store.listConversations()[0];
    const message = conversation.messages[0];
    const results = initialChecklist.criteria.map(c => ({ criterionId: c.id, answer: c.answerType === 'numeric' ? '0' : 'NO', applicabilityRationale: 'Программный технический пример.', explanation: 'Техническая проверка, не человеческая оценка качества.', evidence: [{ messageId: message.id, quote: 'Здравствуйте.' }], checkedRange: { startMessageId: message.id, endMessageId: message.id }, reviewRequired: true, uncertainty: 'Не является экспертным выводом.' }));
    const response = await app.inject({ method: 'POST', url: '/api/manual-evaluations', headers, payload: { conversationVersion: conversation.version, checklistVersion: initialChecklist.version, reviewer: 'Acceptance test agent', origin: 'agent_demo', humanAttestation: false, requestId: 'manual-acceptance-request', results } });
    assert.equal(response.statusCode, 200);
    const evaluation = response.json();
    assert.equal(evaluation.status, 'manual_demo'); assert.equal(evaluation.mode, 'local'); assert.equal(evaluation.providerCallCount, 0); assert.equal(evaluation.score.total, 0);
    const status = (await app.inject({ method: 'GET', url: '/api/status', headers: { host: headers.host } })).json();
    assert.equal(status.liveEvaluationCount, 0); assert.equal(status.manualEvaluationCount, 1);
    const appeal = await app.inject({ method: 'POST', url: `/api/evaluations/${evaluation.id}/appeals`, headers, payload: { criterionId: 'C1', comment: 'Программная проверка апелляции.', requestId: 'manual-api-appeal' } });
    assert.equal(appeal.statusCode, 200);
    const decision = await app.inject({ method: 'POST', url: `/api/evaluations/${evaluation.id}/decisions`, headers, payload: { appealId: appeal.json().id, action: 'change', answer: 'YES', reason: 'Только тест пересчёта.', requestId: 'manual-api-decision' } });
    assert.equal(decision.statusCode, 200); assert.equal(decision.json().finalScore.total, 10);
    const audio = await app.inject({ method: 'GET', url: `/api/conversations/${conversation.version}/audio/status`, headers: { host: headers.host } });
    assert.equal(audio.json().state, 'unavailable');
    assert.equal(store.listEvaluationAttempts().length, 0);
  } finally { await app.close(); }
});

test('cross-site reads cannot embed a private audio resource', async () => {
  const app = await createApp(new Store(':memory:'));
  try {
    const result = await app.inject({ method: 'GET', url: '/api/conversations/nonexistent/audio', headers: { host: headers.host, 'sec-fetch-site': 'cross-site' } });
    assert.equal(result.statusCode, 403); assert.equal(result.json().error, 'CROSS_ORIGIN_BLOCKED');
  } finally { await app.close(); }
});

test('isolated software-fixture permission enables only its immutable unknown chat without touching source or sending data', async () => {
  const store = new Store(':memory:');
  const chat = structuredClone(fixture); chat.data.records[0].channel = 'agent chat';
  store.importDataset(parseOrganizerResponse(chat));
  const source = store.listConversations()[0];
  const app = await createApp(store);
  const previousKey = config.apiKey; config.apiKey = undefined;
  try {
    const approved = await app.inject({ method: 'POST', url: `/api/conversations/${source.version}/permission`, headers, payload: { reviewer: 'software-fixture-only', reason: 'Isolated permission contract test; no actual human approval or AI call.', origin: 'human_declared', syntheticAttestation: true, freeTierUseApproved: true, requestId: 'isolated-permission-test' } });
    assert.equal(approved.statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: `/api/conversations/${source.version}`, headers: { host: headers.host } })).json().classification, 'synthetic_allowed');
    assert.equal(store.getConversation(source.version)?.classification, 'unknown');
    const evaluated = await app.inject({ method: 'POST', url: '/api/evaluations', headers, payload: { conversationVersion: source.version, checklistVersion: initialChecklist.version } });
    assert.equal(evaluated.json().error, 'MISSING_API_KEY');
    assert.equal(store.listEvaluations().length, 0);
    assert.equal(store.listEvaluationAttempts()[0].status, 'failed');
  } finally { config.apiKey = previousKey; await app.close(); }
});
