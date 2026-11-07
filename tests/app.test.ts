import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { removeLocalTemp } from './local-temp.js';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app.js';
import { config } from '../server/config.js';
import { Store } from '../server/store.js';
import { parseOrganizerResponse } from '../server/importer.js';
import { initialChecklist } from '../src/checklist.js';
import { calculateScore } from '../src/scoring.js';
import { ReviewStore } from '../server/reviews.js';
import type { Checklist, CriterionResult, Evaluation } from '../src/domain.js';

// One explicitly permitted SYNTHETIC organizer chat, used only for software checks.
// No real call records, signed URLs, or private audio are included in the test source.
const syntheticRecord = {
  "conversation_id": "p1-ru-001",
  "channel": "agent chat",
  "language": "RU",
  "transcript": [
    {
      "timestamp": "00:00",
      "speaker": "client",
      "text": "Где посмотреть мой тариф? В приложении не нахожу."
    },
    {
      "timestamp": "00:02",
      "speaker": "bot",
      "text": "Здравствуйте! Я AIM, AI-ассистент Freedom Broker. Я могу ответить на вопросы о продуктах и услугах, предоставить информацию по вашим счетам, активам и комиссиям, сравнить данные в таблице, отправить контакты вашего менеджера и передать вопрос специалистам поддержки."
    },
    {
      "timestamp": "00:03",
      "speaker": "bot",
      "text": "Продолжая разговор, Вы соглашаетесь на сбор и обработку персональных данных и подтверждаете, что ознакомились с Политикой конфиденциальности Компании."
    },
    {
      "timestamp": "00:08",
      "speaker": "bot",
      "text": "Тариф указан на первой странице отчёта брокера."
    },
    {
      "timestamp": "00:28",
      "speaker": "client",
      "text": "Я сейчас с ноутбука, отчёт качать не хочу. Можно оператора?"
    },
    {
      "timestamp": "00:30",
      "speaker": "bot",
      "text": "Желаете, чтобы я соединил Вас с оператором?"
    },
    {
      "timestamp": "00:35",
      "speaker": "client",
      "text": "да"
    },
    {
      "timestamp": "00:36",
      "speaker": "bot",
      "text": "Пожалуйста, ожидайте. Оператор скоро подключится к чату."
    },
    {
      "timestamp": "00:38",
      "speaker": "system",
      "text": "Эскалация на оператора."
    },
    {
      "timestamp": "01:15",
      "speaker": "operator",
      "text": "Здравствуйте! Меня зовут Алина. В веб-версии откройте вкладку «Кабинет». Название тарифа будет под вашим ФИО."
    },
    {
      "timestamp": "01:28",
      "speaker": "client",
      "text": "Нашла, спасибо."
    },
    {
      "timestamp": "02:04",
      "speaker": "operator",
      "text": "Пожалуйста. Хорошего вечера!"
    }
  ],
  "audio_url": null
};
const approvedEndpoint = 'https://ec88f21f1accecf38e20095a9fe175.a5.environment.api.powerplatform.com/powerautomate/automations/direct/cu/11/workflows/b3d2a68006a24662be2b721454cb4e00/triggers/manual/paths/invoke?sig=test-only';
const headers = { host: 'localhost:3001', origin: 'http://localhost:3001', 'content-type': 'application/json' };
function envelope(records: unknown[] = [syntheticRecord], groupId = 'DEV') {
  return { error: '', isSuccess: true, data: { dataset_group_id: groupId, total_records: records.length, records } };
}
async function setup() {
  const tempRoot = resolve('tmp'); mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(join(tempRoot, 'api-test-'));
  const dbPath = join(dir, 'cqa.sqlite');
  const store = new Store(dbPath);
  const app = await createApp(store, new ReviewStore(dbPath));
  return { app, store, dbPath, close: async () => { await app.close(); removeLocalTemp(dir); } };
}

test('API status reports configuration booleans without disclosing key or signed endpoint', async () => {
  const context = await setup();
  try {
    const response = await context.app.inject({ url: '/api/status', headers: { host: headers.host } });
    assert.equal(response.statusCode, 200);
    const status = response.json();
    assert.equal(status.apiKeyPresent, Boolean(config.apiKey));
    assert.equal(status.organizerConfigured, Boolean(config.organizerUrl));
    assert.equal(status.liveEvaluationCount, 0);
    assert.equal('apiKey' in status, false);
    assert.equal('organizerUrl' in status, false);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(String(response.headers['content-security-policy']), /frame-ancestors 'none'/);
    if (config.apiKey) assert.equal(response.body.includes(config.apiKey), false);
    if (config.organizerUrl) assert.equal(response.body.includes(config.organizerUrl), false);
  } finally { await context.close(); }
});

test('API rejects hostile Host, cross-origin mutation, form POST and oversized request', async () => {
  const context = await setup();
  try {
    const hostile = await context.app.inject({ url: '/api/status', headers: { host: 'localhost.evil.example' } });
    assert.equal(hostile.statusCode, 403);
    assert.equal(hostile.json().error, 'LOCAL_HOST_REQUIRED');
    for (const requestHeaders of [
      { ...headers, origin: 'https://evil.example' },
      { ...headers, 'sec-fetch-site': 'cross-site' },
      { ...headers, origin: 'null' },
    ]) {
      const response = await context.app.inject({ method: 'POST', url: '/api/import', headers: requestHeaders, payload: { groupId: 'DEV' } });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error, 'CROSS_ORIGIN_BLOCKED');
    }
    const form = await context.app.inject({ method: 'POST', url: '/api/import', headers: { host: headers.host, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'groupId=DEV' });
    assert.equal(form.statusCode, 415);
    const oversized = await context.app.inject({ method: 'POST', url: '/api/checklists', headers, payload: JSON.stringify({ title: 'x'.repeat(1024 * 1024 + 1) }) });
    assert.ok(oversized.statusCode >= 400);
    assert.ok(oversized.body.length < 1000);
    assert.equal(context.store.listConversations().length, 0);
  } finally { await context.close(); }
});

test('API imports via server, is idempotent, exposes positional sources without signed URLs', async t => {
  const context = await setup();
  const previousEndpoint = config.organizerUrl;
  config.organizerUrl = approvedEndpoint;
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL | RequestInfo) => {
    calls.push(new URL(String(url)).searchParams.get('group_id') || '');
    return new Response(JSON.stringify(envelope()), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const first = await context.app.inject({ method: 'POST', url: '/api/import', headers, payload: { groupId: 'DEV' } });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), { inserted: 1, unchanged: 0, total: 1 });
    const repeated = await context.app.inject({ method: 'POST', url: '/api/import', headers, payload: { groupId: 'DEV' } });
    assert.deepEqual(repeated.json(), { inserted: 0, unchanged: 1, total: 1 });
    assert.deepEqual(calls, ['DEV', 'DEV']);
    const list = await context.app.inject({ url: '/api/conversations', headers: { host: headers.host } });
    assert.equal(list.statusCode, 200);
    const summary = list.json()[0];
    assert.equal(summary.classification, 'synthetic_allowed');
    assert.equal(summary.messageCount, syntheticRecord.transcript.length);
    assert.equal('messages' in summary, false);
    assert.equal('audio_url' in summary, false);
    const detail = await context.app.inject({ url: `/api/conversations/${summary.version}`, headers: { host: headers.host } });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().messages[0].text, syntheticRecord.transcript[0].text);
    assert.equal(detail.json().messages[0].position, 0);
    assert.equal(detail.body.includes('sig='), false);
    const missing = await context.app.inject({ url: '/api/conversations/missing', headers: { host: headers.host } });
    assert.equal(missing.statusCode, 404);
  } finally { config.organizerUrl = previousEndpoint; await context.close(); }
});

test('API import rejects invalid group, malformed upstream response and key-shaped client parameters', async t => {
  const context = await setup();
  const previousEndpoint = config.organizerUrl;
  config.organizerUrl = approvedEndpoint;
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  try {
    for (const payload of [{ groupId: '../DEV' }, { groupId: 'DEV', url: 'https://evil.example' }, { groupId: 'DEV', apiKey: 'test-only' }]) {
      const invalid = await context.app.inject({ method: 'POST', url: '/api/import', headers, payload });
      assert.equal(invalid.statusCode, 400);
    }
    assert.equal(mock.mock.callCount(), 0);
    const malformed = await context.app.inject({ method: 'POST', url: '/api/import', headers, payload: { groupId: 'DEV' } });
    assert.equal(malformed.statusCode, 400);
    assert.equal(context.store.listConversations().length, 0);
  } finally { config.organizerUrl = previousEndpoint; await context.close(); }
});

test('API supports new checklist semantics, immutable versions, validation and restart persistence', async () => {
  const context = await setup();
  try {
    const original = structuredClone(initialChecklist);
    const changed: Checklist = {
      ...original, version: 'api-test-v2', title: 'API test custom checklist', criteria: [...original.criteria, {
        id: 'C9', title: 'Mentions a support channel', instructions: 'YES only if the human operator explicitly gives an official support channel.',
        weight: 12.5, answerType: 'boolean', allowedValues: ['YES', 'NO'], scaleMax: 1, naAllowed: false, naCondition: '',
        section: 'Additional', evidenceRequirement: 'Exact operator source message.', flag: false,
      }],
    };
    const created = await context.app.inject({ method: 'POST', url: '/api/checklists', headers, payload: changed });
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().criteria.length, 9);
    assert.equal(created.json().criteria[8].instructions, changed.criteria[8].instructions);
    const invalid = structuredClone(changed); invalid.version = 'bad-na'; invalid.criteria[8].naAllowed = true;
    const rejected = await context.app.inject({ method: 'POST', url: '/api/checklists', headers, payload: invalid });
    assert.equal(rejected.statusCode, 400);
    const overwrite = await context.app.inject({ method: 'POST', url: '/api/checklists', headers, payload: { ...changed, title: 'Overwrite attempt' } });
    assert.equal(overwrite.statusCode, 400);
    assert.deepEqual(context.store.getChecklist(original.version), original);
    const list = await context.app.inject({ url: '/api/checklists', headers: { host: headers.host } });
    assert.equal(list.json().length, 2);
    const reopened = new Store(context.dbPath);
    try {
      assert.deepEqual(reopened.getChecklist(changed.version), changed);
      assert.deepEqual(reopened.getChecklist(original.version), original);
    } finally { reopened.close(); }
  } finally { await context.close(); }
});

test('API missing-key evaluation fails explicitly, makes no inference call, and saves no fake evaluation', async t => {
  const context = await setup();
  const previousKey = config.apiKey;
  const previousConfirmation = config.freeTierConfirmed;
  config.apiKey = undefined;
  config.freeTierConfirmed = true;
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external request during missing-key test'); });
  try {
    const parsed = parseOrganizerResponse(envelope(), 'DEV'); context.store.importDataset(parsed);
    const response = await context.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload: {
      conversationVersion: parsed.conversations[0].version, checklistVersion: initialChecklist.version,
    } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'MISSING_API_KEY');
    assert.equal(network.mock.callCount(), 0);
    assert.equal(context.store.listEvaluations().length, 0);
    const list = await context.app.inject({ url: '/api/evaluations', headers: { host: headers.host } });
    assert.deepEqual(list.json(), []);
    const missing = await context.app.inject({ url: '/api/evaluations/missing', headers: { host: headers.host } });
    assert.equal(missing.statusCode, 404);
  } finally { config.apiKey = previousKey; config.freeTierConfirmed = previousConfirmation; await context.close(); }
});

test('API refuses restricted call, unknown classification and missing source before provider access', async t => {
  const context = await setup();
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external request during restriction test'); });
  try {
    const records = [
      { conversation_id: 'voice-test', channel: 'voice call', language: 'RU', transcript: [{ timestamp: '2026-01-01T00:00:00+05:00', speaker: 'operator', text: 'Invented voice fixture' }], audio_url: 'https://audio.example.invalid/fixture?signature=test-only' },
      { conversation_id: 'unknown-test', channel: 'agent chat', language: 'EN', transcript: [{ timestamp: '00:00', speaker: 'operator', text: 'Invented unknown fixture' }], audio_url: null },
    ];
    const parsed = parseOrganizerResponse(envelope(records), 'DEV'); context.store.importDataset(parsed);
    for (const conversation of parsed.conversations) {
      const response = await context.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload: { conversationVersion: conversation.version, checklistVersion: initialChecklist.version } });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, 'DATA_POLICY_RESTRICTED');
    }
    const missing = await context.app.inject({ method: 'POST', url: '/api/evaluations', headers, payload: { conversationVersion: 'missing', checklistVersion: initialChecklist.version } });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().error, 'SOURCE_NOT_FOUND');
    const sources = await context.app.inject({ url: '/api/conversations', headers: { host: headers.host } });
    assert.equal(sources.body.includes('signature='), false);
    assert.equal(network.mock.callCount(), 0);
    assert.equal(context.store.listEvaluations().length, 0);
  } finally { await context.close(); }
});

function savedReviewFixture(store: Store): Evaluation {
  const parsed = parseOrganizerResponse(envelope(), 'DEV');
  store.importDataset(parsed);
  const conversation = parsed.conversations[0];
  // Test-only stored evaluation exercises HTTP/storage/recalculation, not model quality.
  // The test's provider is clearly named and its genuine provider call count is zero.
  const answers = ['YES', 'YES', 'YES', '20', 'YES', '10', 'NO', 'NO'];
  const results: CriterionResult[] = answers.map((answer, index) => ({
    criterionId: `C${index + 1}`, answer, applicabilityRationale: 'Applicable software-test fixture.',
    explanation: 'Software-test-only decision, not a real AI evaluation.',
    evidence: [{ messageId: conversation.messages[9].id, quote: 'Здравствуйте!' }],
    checkedRange: { startMessageId: conversation.messages[0].id, endMessageId: conversation.messages.at(-1)!.id },
    reviewRequired: false, uncertainty: '',
  }));
  const evaluation: Evaluation = {
    id: 'api-review-test-only', createdAt: '2026-11-07T00:00:00.000Z', conversationVersion: conversation.version,
    checklistVersion: initialChecklist.version, provider: 'automated-test-double', model: 'test-only-not-live',
    mode: 'free', status: 'live_validated', results, score: calculateScore(initialChecklist, results),
    usage: {}, latencyMs: 0, providerCallCount: 0, configuration: { testOnly: true, actualModelInvocation: false },
  };
  store.saveEvaluation(evaluation);
  return evaluation;
}

test('API appeal/review preserves original assessment, recomputes final score and replays safely', async t => {
  const context = await setup();
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('A review must not invoke any external service'); });
  try {
    const evaluation = savedReviewFixture(context.store);
    const originalSnapshot = JSON.parse(JSON.stringify(evaluation)) as Evaluation;
    assert.equal(evaluation.score.total, 95);
    const base = `/api/evaluations/${evaluation.id}`;
    const appealInput = { criterionId: 'C7', comment: 'Please inspect the final operator reply.', requestId: 'api-appeal-1' };
    const appealResponse = await context.app.inject({ method: 'POST', url: `${base}/appeals`, headers, payload: appealInput });
    assert.equal(appealResponse.statusCode, 200);
    const appeal = appealResponse.json();
    assert.equal(appeal.originalAnswer, 'NO');
    assert.equal(appeal.contestedAnswer, 'NO');
    assert.deepEqual(appeal.originalResult, evaluation.results[6]);
    const replayAppeal = await context.app.inject({ method: 'POST', url: `${base}/appeals`, headers, payload: appealInput });
    assert.deepEqual(replayAppeal.json(), appeal);
    const decisionInput = { appealId: appeal.id, action: 'change', answer: 'YES', reason: 'The final reply contains an appropriate closing.', requestId: 'api-decision-1' };
    const decisionResponse = await context.app.inject({ method: 'POST', url: `${base}/decisions`, headers, payload: decisionInput });
    assert.equal(decisionResponse.statusCode, 200);
    const decision = decisionResponse.json();
    assert.equal(decision.previousAnswer, 'NO');
    assert.equal(decision.answer, 'YES');
    assert.equal(decision.finalScore.total, 100);
    const replayDecision = await context.app.inject({ method: 'POST', url: `${base}/decisions`, headers, payload: decisionInput });
    assert.deepEqual(replayDecision.json(), decision);
    const historyResponse = await context.app.inject({ url: `${base}/history`, headers: { host: headers.host } });
    assert.equal(historyResponse.statusCode, 200);
    const history = historyResponse.json();
    assert.equal(history.appeals.length, 1);
    assert.equal(history.decisions.length, 1);
    assert.equal(history.finalAnswers.C7, 'YES');
    assert.equal(history.finalScore.total, 100);
    const originalResponse = await context.app.inject({ url: base, headers: { host: headers.host } });
    assert.deepEqual(originalResponse.json(), originalSnapshot);
    assert.equal(context.store.getEvaluation(evaluation.id)?.score.total, 95);
    assert.equal(context.store.getEvaluation(evaluation.id)?.results[6].answer, 'NO');
    assert.equal(network.mock.callCount(), 0);

    // Close the complete service, then restart it against the same private SQLite file.
    await context.app.close();
    const reopened = await createApp(new Store(context.dbPath), new ReviewStore(context.dbPath));
    try {
      const persisted = await reopened.inject({ url: `${base}/history`, headers: { host: headers.host } });
      assert.deepEqual(persisted.json(), history);
      const replayAfterRestart = await reopened.inject({ method: 'POST', url: `${base}/decisions`, headers, payload: decisionInput });
      assert.deepEqual(replayAfterRestart.json(), decision);
      const unchanged = await reopened.inject({ url: base, headers: { host: headers.host } });
      assert.deepEqual(unchanged.json(), originalSnapshot);
    } finally { await reopened.close(); }
  } finally { await context.close(); }
});

test('API uphold retains the answer and invalid appeals/reviews leave no successful decision', async t => {
  const context = await setup();
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('A review must remain local'); });
  try {
    const evaluation = savedReviewFixture(context.store);
    const base = `/api/evaluations/${evaluation.id}`;
    const missingComment = await context.app.inject({ method: 'POST', url: `${base}/appeals`, headers, payload: { criterionId: 'C7', comment: ' ', requestId: 'empty-comment' } });
    assert.equal(missingComment.statusCode, 400);
    const unknownCriterion = await context.app.inject({ method: 'POST', url: `${base}/appeals`, headers, payload: { criterionId: 'unknown', comment: 'Review.', requestId: 'unknown-criterion' } });
    assert.equal(unknownCriterion.statusCode, 400);
    assert.equal(unknownCriterion.json().error, 'UNKNOWN_CRITERION');
    const appealInput = { criterionId: 'C7', comment: 'Please review.', requestId: 'api-uphold-appeal' };
    const appeal = (await context.app.inject({ method: 'POST', url: `${base}/appeals`, headers, payload: appealInput })).json();
    for (const choice of [
      { appealId: appeal.id, action: 'change', answer: 'MAYBE', reason: 'Invalid answer.', requestId: 'invalid-answer' },
      { appealId: appeal.id, action: 'change', answer: 'YES', reason: ' ', requestId: 'empty-reason' },
      { appealId: appeal.id, action: 'uphold', answer: 'YES', reason: 'Must not replace an upheld answer.', requestId: 'invalid-uphold' },
    ]) {
      const invalid = await context.app.inject({ method: 'POST', url: `${base}/decisions`, headers, payload: choice });
      assert.equal(invalid.statusCode, 400);
    }
    const before = (await context.app.inject({ url: `${base}/history`, headers: { host: headers.host } })).json();
    assert.equal(before.appeals.length, 1);
    assert.equal(before.decisions.length, 0);
    const upheldResponse = await context.app.inject({ method: 'POST', url: `${base}/decisions`, headers, payload: { appealId: appeal.id, action: 'uphold', reason: 'The required closing was absent in the test fixture.', requestId: 'api-uphold-decision' } });
    assert.equal(upheldResponse.statusCode, 200);
    assert.equal(upheldResponse.json().answer, 'NO');
    assert.equal(upheldResponse.json().finalScore.total, 95);
    const duplicateOtherId = await context.app.inject({ method: 'POST', url: `${base}/decisions`, headers, payload: { appealId: appeal.id, action: 'uphold', reason: 'Repeated click with another request ID.', requestId: 'duplicate-decision' } });
    assert.equal(duplicateOtherId.statusCode, 400);
    assert.equal(duplicateOtherId.json().error, 'APPEAL_ALREADY_REVIEWED');
    const conflictingReplay = await context.app.inject({ method: 'POST', url: `${base}/appeals`, headers, payload: { ...appealInput, comment: 'Changed payload with same request ID.' } });
    assert.equal(conflictingReplay.statusCode, 400);
    assert.equal(conflictingReplay.json().error, 'IDEMPOTENCY_CONFLICT');
    const final = (await context.app.inject({ url: `${base}/history`, headers: { host: headers.host } })).json();
    assert.equal(final.decisions.length, 1);
    assert.equal(final.finalScore.total, 95);
    assert.equal(network.mock.callCount(), 0);
  } finally { await context.close(); }
});
