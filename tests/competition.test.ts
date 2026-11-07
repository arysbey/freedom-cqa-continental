import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initialChecklist } from '../src/checklist.js';
import { calculateScore } from '../src/scoring.js';
import type { Conversation, CriterionResult, Evaluation } from '../src/domain.js';
import { buildCompetitionExport, competitionDocumentSchema, selectOfficialEvaluation, validateCompetitionResults, verifyOriginalTranscript, writeCompetitionExport, type CompetitionDataset, type CompetitionDocument, type CompetitionOptions } from '../server/competition.js';
import { removeLocalTemp } from './local-temp.js';
import { Store } from '../server/store.js';
import { PermissionStore } from '../server/data-permissions.js';
import { evaluateAndSave } from '../server/evaluation-service.js';
import { parseOrganizerResponse } from '../server/importer.js';

// Isolated software fixtures only. None of these answers are independent human labels.
const options: CompetitionOptions = { target: 'prod', teamName: 'Continental', configuredModel: 'gemini-3.1-flash-lite' };
const explanations = ['Оператор в первой реплике установил контакт и обозначил свою роль.', 'Запрос клиента содержит достаточный контекст для ответа без дополнительных уточнений.', 'Обращение носит общий характер и не затрагивает сведения защищённого счёта.', 'Основной вопрос получил ответ, но сохранённый разбор отмечает неполную детализацию.', 'Оператор корректно отреагировал на настроение клиента без агрессивных формулировок.', 'Сохранённый разбор отмечает отдельные повторы при понятном ходе разговора.', 'В заключительном участке не подтверждены все необходимые элементы завершения.', 'В сохранённом разборе отмечено недопустимое поведение оператора.'];
function fixture(count = 10, groupId = 'REHEARSAL-SOFTWARE-ONLY'): CompetitionDataset {
  const conversations: Conversation[] = Array.from({ length: count }, (_, index) => ({ groupId, conversationId: `software-${String(index).padStart(3, '0')}`, version: `software-cv-${index}`, channel: 'agent chat', language: index % 3 === 0 ? 'RU' : index % 3 === 1 ? 'KZ' : 'EN', classification: 'synthetic_allowed', audioAvailable: false,
    messages: [{ id: `m${index}-0`, position: 0, speaker: 'client', timestamp: '00:00', text: 'Где найти нужный раздел?' }, { id: `m${index}-1`, position: 1, speaker: 'bot', timestamp: '00:00', text: 'Здравствуйте. Ожидайте подключения.' }, { id: `m${index}-2`, position: 2, speaker: 'system', timestamp: '00:01', text: 'Оператор подключён.' }, { id: `m${index}-3`, position: 3, speaker: 'operator', timestamp: '00:02', text: 'Здравствуйте! Нужный раздел доступен.' }] }));
  const evaluations = conversations.map((conversation, index): Evaluation => {
    const answers = ['YES', 'N/A', 'N/A', '15', 'YES', '7', 'NO', 'YES'];
    const results: CriterionResult[] = initialChecklist.criteria.map((criterion, ci) => ({ criterionId: criterion.id, answer: answers[ci], explanation: explanations[ci], applicabilityRationale: answers[ci] === 'N/A' ? 'Из исходного обращения понятна общая потребность.' : '', evidence: [{ messageId: conversation.messages[3].id, quote: conversation.messages[3].text }], checkedRange: { startMessageId: conversation.messages[0].id, endMessageId: conversation.messages[3].id }, reviewRequired: false, uncertainty: '' }));
    return { id: `software-eval-${index}`, conversationVersion: conversation.version, checklistVersion: 'official-v1', createdAt: '2026-11-07T00:00:00.000Z', provider: 'gemini', model: options.configuredModel, mode: 'free', status: 'live_validated', origin: 'ai', results, score: calculateScore(initialChecklist, results), latencyMs: 10, providerCallCount: 1, usage: { totalTokens: 1 }, configuration: { purpose: 'isolated-software-fixture-not-gold' } };
  });
  const originals = new Map(conversations.map(conversation => [conversation.version, { conversation_id: conversation.conversationId, channel: conversation.channel, language: conversation.language, audio_url: null, transcript: conversation.messages.map(({ timestamp, speaker, text }) => ({ timestamp, speaker, text })) }]));
  return { groupId, conversations, evaluations, originals, checklists: [structuredClone(initialChecklist)], attempts: [] };
}
function firstOk(document: CompetitionDocument) { const result = document.results[0]; assert.equal(result.status, 'ok'); if (result.status !== 'ok') throw new Error('FIXTURE_EXPECTED_OK'); return result; }

test('schema1.0 exports exact original IDs, official order, types and 1-based complete-array evidence', () => {
  const data = fixture(); const bundle = buildCompetitionExport(data, options); const first = firstOk(bundle.document);
  assert.equal(bundle.audit.success, 10); assert.equal(bundle.audit.error, 0);
  assert.deepEqual(first.criteria.map(c => c.criterion_id), ['contact', 'discovery', 'identification', 'consultation', 'empathy', 'dialogue', 'closure', 'critical']);
  assert.equal(first.criteria[0].value, true); assert.equal(first.criteria[1].value, null); assert.equal(first.criteria[3].value, 15);
  assert.deepEqual(first.criteria[0].evidence_turns, [4]); assert.deepEqual(first.criteria[1].evidence_turns, [1, 2, 3, 4]);
  assert.equal(first.score.critical_flag, true); assert(first.score.final_score > 0, 'gross flag never zeros total');
  assert.equal(first.score.final_score, calculateScore(initialChecklist, data.evaluations[0].results).total);
  assert.equal(validateCompetitionResults(bundle.document, data, options).results.length, 10);
});

test('official appendix numeric contract is 85.38 and an independent critical flag does not zero it', () => {
  // The published appendix supplies this expected number; these remain software fixtures,
  // never human annotations or an assessment of an actual DEV conversation.
  const data = fixture(); const results = data.evaluations[0].results;
  results.find(result => result.criterionId === 'C7')!.answer = 'YES';
  results.find(result => result.criterionId === 'C8')!.answer = 'NO';
  const sample = firstOk(buildCompetitionExport(data, options).document);
  assert.deepEqual(sample.criteria.map(criterion => criterion.value), [true, null, null, 15, true, 7, true, false]);
  assert.equal(sample.score.final_score, 85.38); assert.equal(sample.score.critical_flag, false);
  results.find(result => result.criterionId === 'C8')!.answer = 'YES';
  const flagged = firstOk(buildCompetitionExport(data, options).document);
  assert.equal(flagged.score.final_score, 85.38); assert.equal(flagged.score.critical_flag, true);
});

test('strict shapes reject extra fields at every level, wrong schema/team/model, C9 and criterion order', () => {
  const data = fixture(); const original = buildCompetitionExport(data, options).document;
  const corruptions: Array<(doc: CompetitionDocument) => void> = [
    doc => Reflect.set(doc, 'extra', true), doc => Reflect.set(doc.model, 'provider', 'gemini'), doc => Reflect.set(doc.results[0], 'evaluationId', 'private'),
    doc => Reflect.set(firstOk(doc).criteria[0], 'quote', 'raw source'), doc => Reflect.set(firstOk(doc).score, 'rawPoints', 50),
    doc => Reflect.set(doc, 'schema_version', '2.0'), doc => { doc.team_name = 'Placeholder'; }, doc => { doc.model.name = 'gemini-3.8-flash'; },
    doc => { const row = firstOk(doc); Reflect.set(row.criteria[0], 'criterion_id', 'C9'); },
    doc => { const row = firstOk(doc); const first = row.criteria[0]; Reflect.set(row.criteria, 0, row.criteria[1]); Reflect.set(row.criteria, 1, first); },
  ];
  for (const corrupt of corruptions) { const document = structuredClone(original); corrupt(document); assert.throws(() => validateCompetitionResults(document, data, options)); }
});

test('wrong65/10 IDs, duplicates, omissions, scales and evidence indices fail despite plausible lengths', () => {
  const data = fixture(); const original = buildCompetitionExport(data, options).document;
  const corruptions: Array<(doc: CompetitionDocument) => void> = [
    doc => { doc.results[0].conversation_id = 'wrong-id'; }, doc => { doc.results[1].conversation_id = doc.results[0].conversation_id; }, doc => { doc.results.pop(); },
    doc => Reflect.set(firstOk(doc).criteria[0], 'value', 'YES'), doc => Reflect.set(firstOk(doc).criteria[3], 'value', 7), doc => Reflect.set(firstOk(doc).criteria[5], 'value', 5), doc => Reflect.set(firstOk(doc).criteria[0], 'value', null),
    doc => { firstOk(doc).criteria[0].evidence_turns = [0]; }, doc => { firstOk(doc).criteria[0].evidence_turns = [5]; }, doc => { firstOk(doc).criteria[0].evidence_turns = [1]; }, doc => { firstOk(doc).criteria[0].evidence_turns = [4, 4]; }, doc => { firstOk(doc).criteria[0].evidence_turns = [2, 1]; },
    doc => { firstOk(doc).score.final_score += 0.01; }, doc => { firstOk(doc).score.final_score = 33.333; }, doc => { firstOk(doc).score.critical_flag = false; },
  ];
  for (const corrupt of corruptions) { const document = structuredClone(original); corrupt(document); assert.throws(() => validateCompetitionResults(document, data, options)); }
  assert.throws(() => buildCompetitionExport(fixture(9), options), /COVERAGE/);
  assert.throws(() => buildCompetitionExport(data, { ...options, expectedIds: data.conversations.map((c, index) => index ? c.conversationId : 'wrong') }), /EXPECTED_ID/);
});

test('modified official semantics, experimental results, old model and manual demos are never selected', () => {
  const data = fixture(); const conversation = data.conversations[0]; const evaluation = data.evaluations[0];
  const changed = structuredClone(data.checklists); changed[0].criteria[1].instructions += ' Changed semantics.';
  assert.throws(() => selectOfficialEvaluation(conversation, changed, data.evaluations, options.configuredModel), /SNAPSHOT_MISMATCH/);
  for (const candidate of [{ ...evaluation, checklistVersion: 'custom-c9' }, { ...evaluation, model: 'gemini-3.8-flash' }, { ...evaluation, status: 'manual_demo' as const, origin: 'agent_demo' as const }, { ...evaluation, checklistVersion: 'official-v1', results: [...evaluation.results, { ...evaluation.results[0], criterionId: 'C9' }] }]) assert.equal(selectOfficialEvaluation(conversation, data.checklists, [candidate], options.configuredModel).evaluation, undefined);
  const forgedScore = structuredClone(evaluation); forgedScore.score.total = 0; data.evaluations[0] = forgedScore;
  assert.equal(firstOk(buildCompetitionExport(data, options).document).score.final_score, evaluation.score.total);
});

test('complete original transcript and stable positions are checked independently of duplicate timestamps', () => {
  const data = fixture(); const c = data.conversations[0]; const raw = data.originals.get(c.version);
  assert.equal(verifyOriginalTranscript(c, raw).get(c.messages[3].id), 4);
  const bad = structuredClone(c); bad.messages[3].position = 2; assert.throws(() => verifyOriginalTranscript(bad, raw), /ORIGINAL/);
  const missing = structuredClone(c); missing.messages.splice(1, 1); assert.throws(() => verifyOriginalTranscript(missing, raw), /ORIGINAL/);
  const changed = structuredClone(c); changed.messages[0].text += ' changed'; assert.throws(() => verifyOriginalTranscript(changed, raw), /ORIGINAL/);
});

test('real calls require attested genuine human entry, missing results remain truthful errors', () => {
  const data = fixture(); const call = data.conversations[0]; call.channel = 'voice call'; call.classification = 'real_restricted';
  assert.equal(buildCompetitionExport(data, options).document.results[0].status, 'error');
  const manual = { ...data.evaluations[0], id: 'software-local-human-route', status: 'human_entered' as const, origin: 'human' as const, model: 'none', provider: 'local', mode: 'local' as const, reviewer: 'software-fixture-only', configuration: { humanAttestation: true, method: 'manual-entry', policy: 'local-only-no-provider', purpose: 'user-entered-local-review' } };
  data.evaluations[0] = manual;
  const bundle = buildCompetitionExport(data, options); assert.equal(bundle.document.results[0].status, 'ok'); assert.equal(bundle.document.model.mode, 'hybrid'); assert.equal(bundle.document.model.name, options.configuredModel);
  manual.configuration.humanAttestation = false; assert.equal(buildCompetitionExport(data, options).document.results[0].status, 'error');
  data.evaluations = []; const allErrors = buildCompetitionExport(data, options); assert.equal(allErrors.audit.error, 10); assert.equal(allErrors.audit.modelMetadata.noSuccessfulModelObserved, true);
  const failed = allErrors.document.results[0]; assert.equal(failed.status, 'error'); assert.deepEqual(failed.criteria, []); assert.equal(failed.score, null);
});

test('public rationales redact source identities, quotes and URLs while retaining uncertainty privately', () => {
  const data = fixture(); const c = data.conversations[0]; c.messages[3].text = 'Здравствуйте! Меня зовут Иван Иванов. Нужный раздел доступен.';
  data.originals.set(c.version, { conversation_id: c.conversationId, transcript: c.messages.map(({ timestamp, speaker, text }) => ({ timestamp, speaker, text })) });
  const result = data.evaluations[0].results[0]; result.evidence[0].quote = c.messages[3].text;
  for (const item of data.evaluations[0].results) item.evidence[0].quote = c.messages[3].text;
  result.explanation = 'Оператор Иван Иванов установил контакт и объяснил порядок обращения. Ссылка https://example.test/?sig=private-token и счёт123456789 скрываются.';
  result.reviewRequired = true; result.uncertainty = 'Нужна предметная проверка достаточности этого вывода.';
  const bundle = buildCompetitionExport(data, options); const rationale = firstOk(bundle.document).criteria[0].rationale;
  assert(!rationale.includes('Иван')); assert(!rationale.includes('https://')); assert(!rationale.includes('123456789')); assert(rationale.includes('Требуется предметная проверка'));
  assert(JSON.stringify(bundle.audit).includes('Иван Иванов')); assert(!JSON.stringify(bundle.document).includes('Здравствуйте! Меня зовут'));
  result.explanation = 'https://example.test/?sig=private-token'; assert.equal(buildCompetitionExport(data, options).document.results[0].status, 'error');
});

test('dry run never overwrites official results; official local write validates before atomic replacement', () => {
  mkdirSync(resolve('tmp'), { recursive: true }); const root = mkdtempSync(join(resolve('tmp'), 'competition-'));
  try {
    mkdirSync(join(root, 'results/prod'), { recursive: true }); const path = join(root, 'results/prod/results.json'); writeFileSync(path, 'sentinel');
    const data = fixture(); const bundle = buildCompetitionExport(data, options);
    const dry = writeCompetitionExport(bundle, data, { ...options, dryRun: true, workspaceRoot: root }); assert(dry.outputPath.includes('private')); assert.equal(readFileSync(path, 'utf8'), 'sentinel');
    const official = writeCompetitionExport(bundle, data, { ...options, dryRun: false, workspaceRoot: root }); assert.equal(official.outputPath, path); assert(competitionDocumentSchema.safeParse(JSON.parse(readFileSync(path, 'utf8'))).success);
    const before = readFileSync(path, 'utf8'); const corrupted = structuredClone(bundle); firstOk(corrupted.document).score.final_score = 99;
    assert.throws(() => writeCompetitionExport(corrupted, data, { ...options, dryRun: false, workspaceRoot: root })); assert.equal(readFileSync(path, 'utf8'), before); assert(existsSync(official.auditPath));
  } finally { removeLocalTemp(root); }
});

test('DEV requires65 actual IDs and60 chats/5 calls; errors are retained rather than dropping calls', () => {
  const data = fixture(65, 'DEV');
  for (let index = 60; index < 65; index++) { data.conversations[index].channel = 'voice call'; data.conversations[index].classification = 'real_restricted'; }
  const devOptions = { ...options, target: 'dev' as const };
  const bundle = buildCompetitionExport(data, devOptions); assert.equal(bundle.document.results.length, 65); assert.equal(bundle.audit.success, 60); assert.equal(bundle.audit.error, 5);
  assert.equal(validateCompetitionResults(bundle.document, data, devOptions).results.length, 65);
  const wrong = structuredClone(bundle.document); wrong.results[0].conversation_id = 'wrong-but-still65'; assert.throws(() => validateCompetitionResults(wrong, data, devOptions), /COVERAGE/);
});

test('error representation is exact and cannot carry fabricated scores or hidden criteria', () => {
  const data = fixture(); data.evaluations = []; const document = buildCompetitionExport(data, options).document;
  assert.equal(validateCompetitionResults(document, data, options).results.length, 10);
  const score = structuredClone(document); Reflect.set(score.results[0], 'score', { final_score: 0, critical_flag: false }); assert(!competitionDocumentSchema.safeParse(score).success);
  const criteria = structuredClone(document); Reflect.set(criteria.results[0].criteria, 0, { criterion_id: 'contact', value: false, rationale: 'Unrelated software fixture.', evidence_turns: [1] }); assert(!competitionDocumentSchema.safeParse(criteria).success);
  const extra = structuredClone(document); Reflect.set(extra.results[0], 'privateDiagnostic', 'private'); assert(!competitionDocumentSchema.safeParse(extra).success);
  const reason = structuredClone(document); Reflect.deleteProperty(reason.results[0], 'error'); assert(!competitionDocumentSchema.safeParse(reason).success);
});

test('unknown chats may use genuine local human review while free Gemini remains denied without permission', async () => {
  const data = fixture(); data.conversations.forEach(conversation => { conversation.classification = 'unknown'; });
  data.evaluations = data.evaluations.map(evaluation => ({ ...evaluation, status: 'human_entered', origin: 'human', provider: 'local', model: 'none', mode: 'local', reviewer: 'software-fixture-local-human-route', configuration: { humanAttestation: true, method: 'manual-entry', policy: 'local-only-no-provider', purpose: 'user-entered-local-review' } }));
  const bundle = buildCompetitionExport(data, options);
  assert.equal(bundle.audit.success, 10); assert.deepEqual(bundle.document.model, { mode: 'local', name: 'human review (no AI model)' });
  assert.equal(bundle.audit.modelMetadata.noSuccessfulModelObserved, true); assert.equal(bundle.audit.modelMetadata.selectedAiEvaluationCount, 0);
  assert.equal(validateCompetitionResults(bundle.document, data, options).results.length, 10);
  const misleading = structuredClone(bundle.document); misleading.model = { mode: 'external_api', name: options.configuredModel };
  assert.throws(() => validateCompetitionResults(misleading, data, options), /PROVENANCE/);
  const store = new Store(':memory:'); const permissions = new PermissionStore(':memory:');
  try {
    const parsed = parseOrganizerResponse({ error: '', isSuccess: true, data: { dataset_group_id: data.groupId, total_records: 10, records: [...data.originals.values()] } });
    store.importDataset(parsed); store.saveChecklist(initialChecklist);
    const source = parsed.conversations[0]; assert.equal(permissions.resolve(source).classification, 'unknown');
    await assert.rejects(evaluateAndSave(store, source.version, 'official-v1', { permissions }), /DATA_POLICY_RESTRICTED/);
    assert.equal(store.listEvaluationAttempts().length, 0); assert.equal(permissions.getPermission(source.version), undefined);
  } finally { permissions.close(); store.close(); }
});

test('obvious fixture groups cannot overwrite official root files through CLI/module defaults', () => {
  const data = fixture(); const bundle = buildCompetitionExport(data, options);
  assert.throws(() => writeCompetitionExport(bundle, data, { ...options, dryRun: false }), /FIXTURE_OFFICIAL_EXPORT_FORBIDDEN/);
  assert.throws(() => writeCompetitionExport(bundle, data, { ...options, dryRun: false, workspaceRoot: resolve('.') }), /FIXTURE_OFFICIAL_EXPORT_FORBIDDEN/);
});
