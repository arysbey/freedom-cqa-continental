/** Isolated software rehearsal. All Gemini responses are test doubles, never real PROD or human gold. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium, expect } from '@playwright/test';
import type { Checklist, Conversation, CriterionResult, Evaluation } from '../src/domain.js';
import type { GroupBatch } from '../server/batches.js';
import type { ProviderTelemetry, ProviderTransport } from '../server/provider.js';

const projectRoot = resolve('.');
const runId = new Date().toISOString().replaceAll(/[:.]/g, '_');
const directory = resolve('private/reports/prod-rehearsal', runId);
const workspace = resolve('tmp/prod-rehearsal', runId);
const isolatedDb = join(workspace, 'private/software-only.sqlite');
const mainDb = resolve('private/cqa.sqlite');
const groupId = 'LOCAL_REHEARSAL_10';
const fixture = JSON.parse(readFileSync('tests/fixtures/prod-rehearsal.json', 'utf8')) as { data: { dataset_group_id: string; records: Array<{ conversation_id: string; transcript: unknown[] }> } };
const fixtureIds = fixture.data.records.map(item => item.conversation_id).sort();
mkdirSync(join(workspace, 'private'), { recursive: true });
assert.equal(fixtureIds.length, 10); assert(fixtureIds.every(id => id.startsWith('LOCAL_REHEARSAL_')));
assert.notEqual(isolatedDb, mainDb);
// Test-only process configuration: no real key or organizer signature reaches the provider.
process.env.GEMINI_API_KEY = 'software-rehearsal-no-network-key';
process.env.GEMINI_FREE_TIER_CONFIRMED = 'true';
process.env.CQA_DB_PATH = isolatedDb;
process.env.CQA_PROVIDER = 'gemini'; process.env.CQA_MODE = 'free';
process.env.CQA_RETRY_LIMIT = '0'; process.env.CQA_TIMEOUT_MS = '1000';
process.env.CQA_ORGANIZER_URL = 'https://ec88f21f1accecf38e20095a9fe175.a5.environment.api.powerplatform.com/powerautomate/automations/direct/cu/11/workflows/b3d2a68006a24662be2b721454cb4e00/triggers/manual/paths/invoke';
const [{ createApp }, { Store }, { ReviewStore }, { QualityStore }, { PermissionStore }, providerModule, competition, { initialChecklist }, { config }] = await Promise.all([
  import('../server/app.js'), import('../server/store.js'), import('../server/reviews.js'), import('../server/quality.js'), import('../server/data-permissions.js'), import('../server/provider.js'), import('../server/competition.js'), import('../src/checklist.js'), import('../server/config.js'),
]);
assert.equal(config.dbPath, isolatedDb); assert.equal(config.model, 'gemini-3.1-flash-lite');
function mainHumanSnapshot() {
  const db = new DatabaseSync(mainDb, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const records = ['quality_references', 'quality_evidence_reviews', 'quality_review_rounds', 'quality_manifests'].flatMap(table =>
      (db.prepare(`SELECT id,json FROM ${table}`).all() as Array<{ id: string; json: string }>).map(row => ({ key: `${table}:${row.id}`, hash: createHash('sha256').update(row.json).digest('hex') })));
    const activeRound = db.prepare('SELECT id FROM quality_review_rounds ORDER BY sequence DESC LIMIT 1').get()?.id;
    return { records, activeRound };
  } finally { db.close(); }
}
const beforeHuman = mainHumanSnapshot();
const publicProd = resolve('results/prod/results.json');
const publicProdBefore = existsSync(publicProd) ? createHash('sha256').update(readFileSync(publicProd)).digest('hex') : null;
const originalFetch = globalThis.fetch;
let base = '';
let organizerStubRequests = 0;
const forbiddenNetwork: string[] = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
  if (url.hostname === 'ec88f21f1accecf38e20095a9fe175.a5.environment.api.powerplatform.com') {
    assert.equal(url.searchParams.get('group_id'), groupId); organizerStubRequests++;
    return new Response(JSON.stringify(fixture), { headers: { 'content-type': 'application/json' } });
  }
  if (base && url.origin === base) return originalFetch(input, init);
  forbiddenNetwork.push(`${url.protocol}//${url.hostname}${url.pathname}`);
  throw new Error('SOFTWARE_REHEARSAL_EXTERNAL_NETWORK_FORBIDDEN');
};
const calls: Array<{ conversationId: string; checklistVersion: string; outcome: string }> = [];
let customInstructionsForwarded = false;
const changedInstruction = 'LOCAL_REHEARSAL_CONTRACT_ONLY: проверяйте только наличие учебного раздела Documents; это проверка передачи настроек, не измерение смысловой точности модели.';
const originalEvaluate = providerModule.GeminiProvider.prototype.evaluate;
providerModule.GeminiProvider.prototype.evaluate = async function (this: InstanceType<typeof providerModule.GeminiProvider>, conversation: Conversation, checklist: Checklist) {
  assert(conversation.conversationId.startsWith('LOCAL_REHEARSAL_'));
  const observer = (this as unknown as { onTelemetry?: (telemetry: ProviderTelemetry) => void }).onTelemetry;
  const transport: ProviderTransport = {
    listModels: async () => [],
    generate: async request => {
      assert.equal(request.model, 'gemini-3.1-flash-lite');
      if (conversation.conversationId === 'LOCAL_REHEARSAL_KZ_03') { calls.push({ conversationId: conversation.conversationId, checklistVersion: checklist.version, outcome: 'software-http-400' }); throw { status: 400, name: 'ApiError', message: 'SOFTWARE_REHEARSAL_ONLY' }; }
      if (conversation.conversationId === 'LOCAL_REHEARSAL_RU_03') { calls.push({ conversationId: conversation.conversationId, checklistVersion: checklist.version, outcome: 'software-invalid-json' }); return { text: 'SOFTWARE_REHEARSAL_INVALID_JSON', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } }; }
      const payload = JSON.parse(request.contents) as { checklist: Checklist; conversation: { messages: Conversation['messages'] } };
      assert.equal(payload.checklist.version, checklist.version);
      if (checklist.criteria.some(criterion => criterion.id === 'C9')) { assert.equal(payload.checklist.criteria.find(criterion => criterion.id === 'C9')?.instructions, changedInstruction); customInstructionsForwarded = true; }
      const messages = payload.conversation.messages;
      const operator = messages.find(message => message.speaker === 'operator');
      const context = messages.find(message => message.speaker === 'client') || messages[0];
      const range = { startMessageId: messages[0].id, endMessageId: messages.at(-1)!.id };
      const results: CriterionResult[] = checklist.criteria.map(criterion => {
        const na = criterion.id === 'C3' && conversation.conversationId === 'LOCAL_REHEARSAL_EN_01';
        const positive = criterion.id === 'C1' && Boolean(operator);
        return { criterionId: criterion.id, answer: na ? 'N/A' : criterion.answerType === 'numeric' ? '0' : positive ? 'YES' : 'NO',
          explanation: 'Техническая программная проверка сохранения ответа и точных ссылок на учебные реплики; это не модельная оценка и не человеческий эталон.',
          applicabilityRationale: na ? 'Учебный общий вопрос об открытом расписании тарифов не требует идентификации.' : '',
          evidence: [{ messageId: (positive ? operator! : context).id, quote: (positive ? operator! : context).text }], checkedRange: positive ? null : range, reviewRequired: true, uncertainty: 'Software test double; no semantic accuracy claim.' };
      });
      calls.push({ conversationId: conversation.conversationId, checklistVersion: checklist.version, outcome: 'software-json-contract' });
      return { text: JSON.stringify({ results }), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } };
    },
  };
  const result = await originalEvaluate.call(new providerModule.GeminiProvider({ ...config, apiKey: 'software-rehearsal-no-network-key', freeTierConfirmed: true, retryLimit: 0 }, transport, observer), conversation, checklist);
  return { ...result, configuration: { ...result.configuration, softwareTestOnly: true, realModelCall: false, independentHumanGold: false } };
};
let store = new Store(isolatedDb);
let app = await createApp(store, new ReviewStore(isolatedDb), new QualityStore(isolatedDb), new PermissionStore(isolatedDb), { submissionWorkspaceRoot: workspace });
async function listen() { await app.listen({ port: 0, host: '127.0.0.1' }); const address = app.server.address(); assert(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}`; }
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) });
  const data = await response.json(); assert(response.ok, `ISOLATED_API_${response.status}_${String(data.error || '')}`); return data as T;
}
async function waitFor<T>(read: () => Promise<T>, condition: (value: T) => boolean, timeoutMs = 20000) {
  const until = performance.now() + timeoutMs;
  while (performance.now() < until) { const value = await read(); if (condition(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('REHEARSAL_WAIT_TIMEOUT');
}
const browser = await chromium.launch({ executablePath: process.env.CQA_BROWSER_EXECUTABLE || (existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined), headless: true });
const context = await browser.newContext({ viewport: { width: 1540, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const browserErrors: string[] = [];
const externalBrowserRequests: string[] = [];
page.on('pageerror', error => browserErrors.push(error.message));
await context.route('**/*', async route => { const url = new URL(route.request().url()); if (['http:', 'https:'].includes(url.protocol) && url.origin !== base) { externalBrowserRequests.push(`${url.protocol}//${url.hostname}${url.pathname}`); await route.abort(); } else await route.continue(); });
const started = performance.now();
let phase = 'isolated-start';
const checkpoints: Array<{ phase: string; elapsedSeconds: number }> = [];
function progress(name: string) { phase = name; const checkpoint = { phase, elapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(3)) }; checkpoints.push(checkpoint); console.log(JSON.stringify(checkpoint)); }
try {
  await listen();
  progress('ui-import-arbitrary-group');
  await page.goto(`${base}/?view=submission`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Сдача результатов', exact: true }).waitFor();
  await page.getByRole('combobox', { name: 'Набор результатов', exact: true }).selectOption('prod');
  await page.getByLabel('Группа для сдачи', { exact: true }).fill(groupId);
  const imported = page.waitForResponse(response => response.url().endsWith('/api/import') && response.request().method() === 'POST');
  await page.locator('.submission-workspace').getByRole('button', { name: 'Импорт GET', exact: true }).click(); assert((await imported).ok());
  const sources = await api<Conversation[]>('/api/conversations');
  assert.deepEqual(sources.map(source => source.conversationId).sort(), fixtureIds); assert(sources.every(source => source.classification === 'unknown'));
  assert.equal(organizerStubRequests, 1); assert.equal(calls.length, 0);
  progress('unknown-denied-before-approval');
  await page.getByRole('button', { name: 'Оценить недостающие записи', exact: true }).click();
  const denied = await waitFor(() => api<GroupBatch[]>('/api/competition/batches'), batches => batches.some(batch => batch.groupId === groupId && batch.status === 'completed'));
  assert(denied[0].records.every(record => record.status === 'blocked' && record.errorCode === 'DATA_PERMISSION_REQUIRED')); assert.equal(calls.length, 0);
  const permissionButton = page.getByRole('button', { name: 'Разрешить только проверенные версии', exact: true });
  await expect(permissionButton).toBeDisabled(); assert.equal(await page.locator('.submission-workspace input[type="checkbox"]:checked').count(), 0);
  await page.screenshot({ path: join(directory, '01-unknown-denied-software-only.png'), fullPage: true });
  progress('explicit-software-fixture-permission-isolated-only');
  await page.getByLabel('Проверяющий группового разрешения', { exact: true }).fill('SOFTWARE_TEST_ONLY_ISOLATED_ACTOR');
  await page.getByLabel('Основание группового разрешения', { exact: true }).fill('Programmatic approval of invented LOCAL_REHEARSAL fixture in isolated database; not an actual human declaration or permission for real PROD data. No real API transport exists.');
  const declarations = page.locator('.submission-card').filter({ has: page.getByRole('heading', { name: 'Разрешение для новых синтетических чатов', exact: true }) }).getByRole('checkbox');
  assert.equal(await declarations.count(), 2); await declarations.nth(0).check(); await declarations.nth(1).check(); await permissionButton.click();
  await waitFor(() => api<Conversation[]>('/api/conversations'), list => list.every(source => source.classification === 'synthetic_allowed'));
  progress('ui-run-pause-after-three');
  const batch = await api<GroupBatch>('/api/competition/batches', { groupId, id: `LOCAL_REHEARSAL_API_${randomUUID()}`, minSpacingMs: 1000, runBudgetMs: 60000 });
  await page.getByRole('button', { name: 'Обновить покрытие', exact: true }).click();
  await page.getByRole('combobox', { name: 'Прогон группы', exact: true }).selectOption(batch.id);
  await page.getByRole('button', { name: 'Продолжить прогон', exact: true }).click();
  await waitFor(async () => calls.length, count => count >= 3);
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  const paused = await waitFor(() => api<GroupBatch>(`/api/competition/batches/${batch.id}`), value => value.status === 'paused');
  const beforeRestartIds = store.listEvaluations().map(evaluation => evaluation.id).sort(); assert.equal(beforeRestartIds.length, 3); assert.equal(calls.length, 3);
  await page.screenshot({ path: join(directory, '02-paused-software-only.png'), fullPage: true });
  progress('restart-and-resume-same-batch');
  await app.close(); store = new Store(isolatedDb);
  app = await createApp(store, new ReviewStore(isolatedDb), new QualityStore(isolatedDb), new PermissionStore(isolatedDb), { submissionWorkspaceRoot: workspace }); await listen();
  await page.goto(`${base}/?view=submission`, { waitUntil: 'networkidle' });
  await page.getByRole('combobox', { name: 'Набор результатов', exact: true }).selectOption('prod'); await page.getByLabel('Группа для сдачи', { exact: true }).fill(groupId);
  await page.getByRole('button', { name: 'Обновить покрытие', exact: true }).click(); await page.getByRole('combobox', { name: 'Прогон группы', exact: true }).selectOption(batch.id);
  await page.getByRole('button', { name: 'Продолжить прогон', exact: true }).click();
  const completed = await waitFor(() => api<GroupBatch>(`/api/competition/batches/${batch.id}`), value => value.status === 'completed');
  assert.equal(completed.records.filter(record => ['succeeded', 'reused'].includes(record.status)).length, 8); assert.equal(completed.records.filter(record => record.status === 'error').length, 2);
  assert.equal(calls.length, 10); assert(beforeRestartIds.every(id => store.listEvaluations().some(evaluation => evaluation.id === id))); assert.equal(store.listEvaluations().length, 8);
  await api(`/api/competition/batches/${batch.id}/run`, { resume: true });
  await waitFor(() => api<GroupBatch>(`/api/competition/batches/${batch.id}`), value => value.status === 'completed'); assert.equal(calls.length, 10); assert.equal(store.listEvaluations().length, 8);
  progress('ui-strict-export-exact-private-path');
  await page.getByRole('button', { name: 'Обновить покрытие', exact: true }).click();
  await expect(page.locator('.submission-counts')).toContainText('Всего 10 · готово 8 · error 2');
  const exported = page.waitForResponse(response => response.url().endsWith('/api/competition/export') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Подготовить results/prod/results.json', exact: true }).click(); const exportResponse = await exported; assert(exportResponse.ok()); const exportMetadata = await exportResponse.json(); assert.equal(exportMetadata.outputPath, 'results/prod/results.json'); assert.equal(exportMetadata.published, false);
  const resultPath = join(workspace, 'results/prod/results.json'); const submissionDocument = JSON.parse(readFileSync(resultPath, 'utf8')) as ReturnType<typeof competition.buildCompetitionExport>['document'];
  const dataset = competition.readCompetitionDataset(isolatedDb, groupId); competition.validateCompetitionResults(submissionDocument, dataset, { target: 'prod', teamName: 'Continental', configuredModel: config.model });
  assert.deepEqual(submissionDocument.results.map(record => record.conversation_id).sort(), fixtureIds); assert.equal(submissionDocument.results.filter(record => record.status === 'ok').length, 8); assert.equal(submissionDocument.results.filter(record => record.status === 'error').length, 2);
  const duplicateTimes = submissionDocument.results.find(record => record.conversation_id === 'LOCAL_REHEARSAL_EN_01'); assert(duplicateTimes?.status === 'ok'); assert.deepEqual(duplicateTimes.criteria[0].evidence_turns, [4]); assert.equal(duplicateTimes.criteria[2].value, null);
  const wrongId = structuredClone(submissionDocument); wrongId.results[0].conversation_id = 'NOT_AN_ORGANIZER_OR_FIXTURE_ID'; assert.throws(() => competition.validateCompetitionResults(wrongId, dataset, { target: 'prod', teamName: 'Continental', configuredModel: config.model }));
  await page.screenshot({ path: join(directory, '03-export-eight-ok-two-errors-software-only.png'), fullPage: true });
  progress('ui-save-changed-criterion-and-forward-contract');
  await page.getByRole('button', { name: 'Чек-листы', exact: true }).click(); await page.getByRole('combobox', { name: 'Основа чек-листа', exact: true }).selectOption('official-v1');
  await page.getByRole('button', { name: 'Добавить критерий', exact: true }).click(); await page.getByLabel('ID критерия', { exact: true }).fill('C9'); await page.getByLabel('Название критерия', { exact: true }).fill('LOCAL_REHEARSAL contract-only criterion'); await page.getByLabel('Правила оценки', { exact: true }).fill(changedInstruction);
  const checklistSaved = page.waitForResponse(response => response.url().endsWith('/api/checklists') && response.request().method() === 'POST'); await page.getByRole('button', { name: 'Сохранить новую версию', exact: true }).click(); const savedChecklist = await (await checklistSaved).json() as Checklist; assert.equal(savedChecklist.criteria.length, 9);
  const source = sources.find(source => source.conversationId === 'LOCAL_REHEARSAL_EN_01')!;
  const contractEvaluation = await api<Evaluation>('/api/evaluations', { conversationVersion: source.version, checklistVersion: savedChecklist.version, requestId: `LOCAL_REHEARSAL_CONTRACT_${randomUUID()}` });
  assert.equal(contractEvaluation.results.length, 9); assert(customInstructionsForwarded); assert.deepEqual(store.getChecklist('official-v1'), initialChecklist);
  progress('actual-cli-entrypoint-reuses-eight-valid-results');
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'Сдача результатов', exact: true }).click(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await page.screenshot({ path: join(directory, '04-submission-mobile-software-only.png'), fullPage: true });
  await app.close();
  const priorArgv = process.argv, priorLog = console.log; const cliLog: string[] = []; const beforeCliCalls = calls.length;
  const cliBatchId = `LOCAL_REHEARSAL_CLI_${randomUUID()}`;
  process.argv = [process.execPath, 'scripts/run-group.ts', '--group', groupId, '--id', cliBatchId, '--execute', '--min-spacing-ms', '0', '--budget-ms', '60000'];
  process.chdir(workspace); console.log = (...args: unknown[]) => { cliLog.push(args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')); };
  try { await import(`./run-group.ts?software-rehearsal=${runId}`); }
  finally { process.chdir(projectRoot); process.argv = priorArgv; console.log = priorLog; }
  assert(!process.exitCode, 'ACTUAL_CLI_ENTRYPOINT_FAILED'); writeFileSync(join(directory, 'software-only-cli-output.txt'), cliLog.join('\n'));
  const cliReport = JSON.parse(readFileSync(join(workspace, 'private/batches', `${cliBatchId}.json`), 'utf8')) as GroupBatch;
  assert.equal(cliReport.records.filter(record => record.status === 'reused').length, 8); assert.equal(cliReport.records.filter(record => record.status === 'error').length, 2); assert.equal(calls.length - beforeCliCalls, 2);
  const finalDataset = competition.readCompetitionDataset(isolatedDb, groupId); assert.equal(finalDataset.evaluations.filter(evaluation => evaluation.checklistVersion === 'official-v1').length, 8);
  const afterHuman = mainHumanSnapshot(), afterMap = new Map(afterHuman.records.map(record => [record.key, record.hash])); assert(beforeHuman.records.every(record => afterMap.get(record.key) === record.hash)); assert.equal(afterHuman.activeRound, beforeHuman.activeRound);
  const publicProdAfter = existsSync(publicProd) ? createHash('sha256').update(readFileSync(publicProd)).digest('hex') : null; assert.equal(publicProdAfter, publicProdBefore);
  assert.deepEqual(forbiddenNetwork, []); assert.deepEqual(externalBrowserRequests, []); assert.deepEqual(browserErrors, []);
  const report = { status: 'PASS', runId, elapsedSeconds: (performance.now() - started) / 1000, softwareRehearsalOnly: true, actualProd: false, independentHumanGold: false, realProviderCalls: 0, allGenerationResponsesAreSoftwareStubs: true, fixtureGroup: groupId, importedIds: fixtureIds, organizerFetchStubRequests: organizerStubRequests, defaultDenied: 10, approvedOnlyInIsolatedDb: 10, pausedAfterSuccesses: beforeRestartIds.length, resumedBatchId: paused.id, firstRun: { ok: 8, errors: 2, errorsByCode: completed.records.filter(record => record.status === 'error').map(record => ({ id: record.conversationId, code: record.errorCode })) }, sameBatchRerunAdditionalCalls: 0, actualCli: { reused: 8, errors: 2, successfulDuplicates: 0, softwareStubCalls: calls.length - beforeCliCalls }, totalSoftwareTransportCalls: calls.length, customCriterionContract: { savedVersion: savedChecklist.version, forwarded: customInstructionsForwarded, semanticAccuracyClaim: false }, duplicateTimestampEvidenceTurn: 4, publicProdFileUnchanged: true, mainHumanHistoryRowsPreserved: beforeHuman.records.length, concurrentNewHumanRows: afterHuman.records.length - beforeHuman.records.length, activeHumanRoundUnchanged: true, mainDatabaseWritten: false, resultPath: relative(projectRoot, resultPath).replaceAll('\\', '/'), published: false, forbiddenNetwork, externalBrowserRequests, browserErrors, checkpoints };
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = { status: 'FAIL', phase, failure: error instanceof Error ? error.message.split('\n')[0].slice(0, 250) : 'SOFTWARE_REHEARSAL_FAILED', realProviderCalls: 0, softwareRehearsalOnly: true, forbiddenNetwork, browserErrors, checkpoints };
  await page.screenshot({ path: join(directory, 'failure-software-only.png'), fullPage: true }).catch(() => undefined); writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.error(JSON.stringify(report)); process.exitCode = 1;
} finally {
  await app.close().catch(() => undefined); await browser.close(); globalThis.fetch = originalFetch; providerModule.GeminiProvider.prototype.evaluate = originalEvaluate;
}
