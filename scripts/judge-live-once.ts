/** One explicitly requested REAL judge B+D call. Default is DRY RUN. Never invoke from automated tests. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium, expect } from '@playwright/test';
import type { Checklist, Evaluation } from '../src/domain.js';

const budgetPath = resolve('private/targeted-accuracy/call-budget.json');
const baselineFingerprint = '1131f160e7e3953232d4d6af2b076492f82254028fb0ceedec651d23a8889c26';
const fixtureId = 'LOCAL_JUDGE_LIVE_EN_SAFETY';
if (!process.argv.includes('--execute-live-once')) {
  console.log(JSON.stringify({ status: 'DRY_RUN', realModelCalls: 0, executionFlag: '--execute-live-once', model: 'gemini-3.1-flash-lite', retryLimit: 0, maximumThisRun: 1, budgetPath: 'private/targeted-accuracy/call-budget.json', source: fixtureId, mainDatabaseAccess: false }));
  process.exit(0);
}
interface BudgetEntry { scope: string; status: string; requestId?: string; startedAt?: string; finishedAt?: string; reservedCalls: number; observedCalls: number | null; [key: string]: unknown }
interface Budget { maximumNewGenerationCalls: number; reservedCalls: number; observedCalls: number; stopped: boolean; judgeLiveAllowed: boolean; judgeProfile: string; entries: BudgetEntry[]; [key: string]: unknown }
const readBudget = (): Budget => JSON.parse(readFileSync(budgetPath, 'utf8').replace(/^\uFEFF/, ''));
let budget = readBudget(); assert.equal(budget.judgeLiveAllowed, true); assert.equal(budget.judgeProfile, 'proven_baseline_only'); assert(budget.reservedCalls < budget.maximumNewGenerationCalls); assert(!budget.entries.some(e => e.scope === 'judge-ui-live-once'));
const runId = new Date().toISOString().replaceAll(/[:.]/g, '_'), root = resolve('.');
const workspace = resolve('tmp/judge-live-once', runId), output = resolve('private/reports/judge-live-once', runId), dbPath = join(workspace, 'private/cqa.sqlite');
mkdirSync(join(workspace, 'private'), { recursive: true }); mkdirSync(output, { recursive: true });
assert.notEqual(dbPath, resolve('private/cqa.sqlite'));
const devHash = createHash('sha256').update(readFileSync('results/dev/results.json')).digest('hex');
process.env.CQA_DB_PATH = dbPath; process.env.CQA_RETRY_LIMIT = '0'; process.env.CQA_TIMEOUT_MS = '120000'; process.env.PORT = '3009';
const [{ config }, { createApp }, { Store }, { ReviewStore }, { QualityStore }, { PermissionStore }, { parseOrganizerResponse }, { getProviderConfigurationIdentity }, { validateEvidence }, { calculateScore }] = await Promise.all([
  import('../server/config.js'), import('../server/app.js'), import('../server/store.js'), import('../server/reviews.js'), import('../server/quality.js'), import('../server/data-permissions.js'), import('../server/importer.js'), import('../server/provider.js'), import('../server/evidence.js'), import('../src/scoring.js'),
]);
assert.equal(config.model, 'gemini-3.1-flash-lite'); assert.equal(config.retryLimit, 0); assert.equal(config.freeTierConfirmed, true); assert(config.apiKey?.trim(), 'SERVER_KEY_REQUIRED'); assert.equal(getProviderConfigurationIdentity(config).configurationFingerprint, baselineFingerprint);
const fixture = { error: '', isSuccess: true, data: { dataset_group_id: 'LOCAL_JUDGE_LIVE', total_records: 1, records: [{ conversation_id: fixtureId, channel: 'agent chat', language: 'EN', audio_url: null, transcript: [
  { timestamp: '00:00', speaker: 'system', text: 'INVENTED SYNTHETIC JUDGE DEMO ONLY. No real customer, account, private information or human reference labels.' },
  { timestamp: '00:01', speaker: 'client', text: 'Where can I find the training documents?' },
  { timestamp: '00:02', speaker: 'operator', text: 'Hello, I am Dana. Open Training account, then Documents.' },
  { timestamp: '00:03', speaker: 'client', text: 'I still cannot find that page. Could you explain it again?' },
  { timestamp: '00:04', speaker: 'operator', text: 'Are you incapable of reading? Stop wasting my time.' },
  { timestamp: '00:05', speaker: 'client', text: 'That was insulting. Please just help me find the training documents.' },
  { timestamp: '00:06', speaker: 'operator', text: 'The path is Training account, then Documents. Is there anything else I can help with? Goodbye.' },
] }] } };
writeFileSync(join(output, 'safe-synthetic-source.json'), JSON.stringify(fixture, null, 2));
const store = new Store(dbPath), permissions = new PermissionStore(dbPath); store.importDataset(parseOrganizerResponse(fixture)); const conversation = store.listConversations('LOCAL_JUDGE_LIVE')[0];
permissions.approve(conversation, { reviewer: 'User-authorized synthetic judge demonstration', reason: 'Explicit user mission and root authorization for one real B+D UI call on newly invented safe synthetic data; this is processing consent in an isolated database, never a human judgment or benchmark label.', syntheticAttestation: true, freeTierUseApproved: true, origin: 'human_declared', requestId: randomUUID() });
const app = await createApp(store, new ReviewStore(dbPath), new QualityStore(dbPath), permissions, { submissionWorkspaceRoot: workspace });
await app.listen({ port: 0, host: '127.0.0.1' }); const address = app.server.address(); assert(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'; const browser = await chromium.launch({ executablePath: process.env.CQA_BROWSER_EXECUTABLE || (existsSync(chrome) ? chrome : undefined), headless: true });
const context = await browser.newContext({ viewport: { width: 1540, height: 1000 }, reducedMotion: 'reduce' }); const page = await context.newPage(); page.setDefaultTimeout(15000);
let posted = 0, reservedRequestId = ''; const browserErrors: string[] = []; page.on('pageerror', e => browserErrors.push(e.message));
function writeBudget(value: Budget) { const path = `${budgetPath}.judge-${runId}.tmp`; writeFileSync(path, JSON.stringify(value, null, 2)); renameSync(path, budgetPath); }
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== base) { await route.abort(); return; }
  if (url.pathname === '/api/evaluations' && request.method() === 'POST') {
    if (posted++) { await route.abort(); return; }
    const payload = request.postDataJSON() as { requestId: string }; reservedRequestId = payload.requestId;
    const lock = openSync(resolve('private/targeted-accuracy/judge-live-once.lock'), 'wx'); try { writeFileSync(lock, `${runId}\n`); } finally { closeSync(lock); }
    budget = readBudget(); assert.equal(budget.judgeLiveAllowed, true); assert(budget.reservedCalls + 1 <= budget.maximumNewGenerationCalls); assert(!budget.entries.some(e => e.scope === 'judge-ui-live-once'));
    budget.reservedCalls++; budget.judgeLiveAllowed = false; budget.entries.push({ scope: 'judge-ui-live-once', status: 'reserved-before-post', requestId: reservedRequestId, conversationId: fixtureId, startedAt: new Date().toISOString(), reservedCalls: 1, observedCalls: null, configurationFingerprint: baselineFingerprint }); writeBudget(budget);
  }
  await route.continue();
});
const started = performance.now(); let saved: Evaluation | undefined;
try {
  await page.goto(base, { waitUntil: 'networkidle' }); await page.getByRole('combobox', { name: 'Фильтр по группе', exact: true }).selectOption('LOCAL_JUDGE_LIVE'); await page.locator('.conversation').click(); await page.getByRole('heading', { name: fixtureId, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Чек-листы', exact: true }).click(); await page.getByRole('combobox', { name: 'Основа чек-листа', exact: true }).selectOption('official-v1'); await page.getByRole('button', { name: 'Добавить критерий', exact: true }).click(); await page.getByRole('textbox', { name: 'ID критерия', exact: true }).fill('C9'); await page.getByRole('textbox', { name: 'Название критерия', exact: true }).fill('Training documents navigation'); await page.getByRole('textbox', { name: 'Правила оценки', exact: true }).fill('YES only if a human operator explicitly provides the menu path Training account, then Documents. Otherwise NO. Cite the exact human operator message. This is a local added criterion and does not replace C1–C8.');
  const rubricResponse = page.waitForResponse(r => r.url().endsWith('/api/checklists') && r.request().method() === 'POST'); await page.getByRole('button', { name: 'Сохранить новую версию', exact: true }).click(); const rubric = await (await rubricResponse).json() as Checklist; assert.equal(rubric.criteria.length, 9);
  await page.getByRole('button', { name: 'Оценка диалогов', exact: true }).click(); await page.getByRole('combobox', { name: 'Чек-лист', exact: true }).selectOption(rubric.version);
  const generated = page.waitForResponse(r => r.url().endsWith('/api/evaluations') && r.request().method() === 'POST', { timeout: 125000 }); await page.getByRole('button', { name: 'Оценить через бесплатную модель', exact: true }).click(); const response = await generated; const body = await response.json(); assert(response.ok(), `LIVE_PROVIDER_FAILURE_${String(body.error || 'UNKNOWN')}`); saved = body as Evaluation;
  assert.equal(posted, 1); assert.equal(saved.providerCallCount, 1); assert.equal(saved.model, 'gemini-3.1-flash-lite'); assert.equal(saved.results.length, 9); validateEvidence(conversation, rubric, { results: saved.results }); assert.deepEqual(JSON.parse(JSON.stringify(calculateScore(rubric, saved.results))), saved.score);
  await expect(page.locator('.assessment > .panel-heading .badge')).toHaveText('Сохранённый результат API'); await page.locator('.criterion').filter({ hasText: 'C9 ·' }).click(); await page.locator('.criterion-details .evidence-link').first().click(); assert(await page.locator('.message:focus').count()); await page.screenshot({ path: join(output, 'actual-ui-c9-evidence.png'), fullPage: true });
  await page.reload({ waitUntil: 'networkidle' }); await page.getByRole('combobox', { name: 'Фильтр по группе', exact: true }).selectOption('LOCAL_JUDGE_LIVE'); await page.locator('.conversation').click(); await expect(page.getByRole('combobox', { name: 'Сохранённая оценка', exact: true })).toHaveValue(saved.id); assert.equal(posted, 1);
  assert.equal(createHash('sha256').update(readFileSync('results/dev/results.json')).digest('hex'), devHash);
  writeFileSync(join(output, 'report.json'), JSON.stringify({ status: 'PASS', runId, source: 'ACTUAL_CONFIGURED_PROVIDER_REAL_UI_CALL', realProviderCalls: 1, model: saved.model, configurationFingerprint: baselineFingerprint, checklistVersion: rubric.version, criteria: 9, c9Answer: saved.results.find(r => r.criterionId === 'C9')?.answer, grossFlagObserved: Object.values(saved.score.flags).some(Boolean), evidenceValidity: 'PASS', savedResultSurvivedRefresh: true, noSecondCallOnRefresh: true, latencyMs: saved.latencyMs, reportedUsage: saved.usage, providerCallCount: saved.providerCallCount, elapsedSeconds: (performance.now() - started) / 1000, conversationId: fixtureId, isolatedDb: relative(root, dbPath), newSyntheticDataOnly: true, humanGoldAuthored: 0, independentSemanticAccuracy: 'UNKNOWN', mainDatabaseWritten: false, officialDevBytesUnchanged: true, published: false, browserErrors }, null, 2)); console.log(JSON.stringify({ status: 'PASS', report: relative(root, join(output, 'report.json')), realProviderCalls: 1, latencyMs: saved.latencyMs }));
} catch (error) { await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => undefined); writeFileSync(join(output, 'report.json'), JSON.stringify({ status: 'FAIL_STOP_NO_RETRY', runId, error: error instanceof Error ? error.message.split('\n')[0].slice(0, 160) : 'FAILED', requestId: reservedRequestId || null, posted, mainDatabaseWritten: false, browserErrors }, null, 2)); throw new Error('JUDGE_LIVE_FAILED_STOP_NO_RETRY'); }
finally {
  if (reservedRequestId) { const attempt = store.getEvaluationAttempt(reservedRequestId); const observed = attempt?.telemetry?.providerCallCount ?? saved?.providerCallCount ?? null; budget = readBudget(); const entry = budget.entries.find(e => e.scope === 'judge-ui-live-once' && e.requestId === reservedRequestId); if (entry) { entry.status = saved ? 'accepted' : 'failed-stop-no-retry'; entry.finishedAt = new Date().toISOString(); entry.observedCalls = observed; entry.errorCode = attempt?.errorCode ?? null; if (observed !== null) budget.observedCalls += observed; else budget.judgeObservedCallsUnknown = true; writeBudget(budget); } }
  await browser.close(); await app.close();
}
