/** UI persistence software acceptance ONLY. Never authors a reference in the production database. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { chromium, expect, type Browser } from '@playwright/test';
import { config } from '../server/config.js';
import type { Checklist, Conversation } from '../src/domain.js';
import type { HumanReference, HumanReviewRound, ValidationCase, ValidationManifest } from '../server/quality.js';
import { removeLocalTemp } from '../tests/local-temp.js';

interface Dashboard {
  manifest: ValidationManifest; reviewRound: HumanReviewRound; referenceCount: number;
  cases: Array<ValidationCase & { humanReferenceSaved: boolean }>;
  metrics: { resolvedHumanJudgments: number; coverage: { expectedHumanJudgments: number; unannotatedJudgments: number } };
}
interface CaseView { case: ValidationCase; conversation: Conversation; checklist: Checklist; reviewRound: HumanReviewRound; reference: HumanReference | null; modelEvaluation: unknown }
type Fingerprints = Record<string, { count: number; hash: string }>;
const base = 'http://127.0.0.1:3023';
const softwareReviewer = 'SOFTWARE_ACCEPTANCE_ONLY';
const softwareExplanation = 'Только программная проверка сохранения в изолированной копии. Произвольный тестовый ответ; не человеческий эталон и не оценка качества.';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quotedIdentifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';
function fingerprints(path: string): Fingerprints {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
    const result: Fingerprints = {};
    for (const table of tables) {
      const rows = db.prepare(`SELECT * FROM ${quotedIdentifier(table.name)}`).all();
      result[table.name] = { count: rows.length, hash: hash(rows.map(hash).sort()) };
    }
    db.exec('COMMIT'); return result;
  } finally { db.close(); }
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(done => { const timer = setTimeout(done, 5000); child.once('exit', () => { clearTimeout(timer); done(); }); child.kill(); });
}
async function run() {
  assert(process.argv.includes('--after-production-reset'), 'RUN_ONLY_AFTER_PRODUCTION_RESET_SIGNAL');
  assert.equal(config.model, 'gemini-3.1-flash-lite', 'CURRENT_APPROVED_MODEL_REQUIRED');
  assert(existsSync(resolve('dist/index.html')), 'PRODUCTION_BUILD_REQUIRED');
  mkdirSync(resolve('tmp'), { recursive: true });
  const isolatedDirectory = mkdtempSync(resolve('tmp', 'human-round-software-proof-'));
  const isolatedPath = join(isolatedDirectory, 'isolated.sqlite');
  const reports = resolve('private/reports', `human-round-software-save-${Date.now()}`); mkdirSync(reports, { recursive: true });
  const mainBefore = fingerprints(config.dbPath);
  const source = new DatabaseSync(config.dbPath, { readOnly: true });
  try { await backup(source, isolatedPath); } finally { source.close(); }
  assert.notEqual(resolve(isolatedPath), resolve(config.dbPath));
  const childEnv = { ...process.env };
  for (const name of Object.keys(childEnv)) if (/^(GEMINI_|GOOGLE_API_KEY$|CQA_ORGANIZER_URL$)/i.test(name)) delete childEnv[name];
  // Empty values also prevent dotenv from reloading either secret into this child.
  Object.assign(childEnv, { GEMINI_API_KEY: '', GOOGLE_API_KEY: '', CQA_ORGANIZER_URL: '', GEMINI_FREE_TIER_CONFIRMED: String(config.freeTierConfirmed),
    CQA_DB_PATH: isolatedPath, CQA_MODEL: config.model, CQA_PROVIDER: config.provider, CQA_MODE: config.mode,
    CQA_TIMEOUT_MS: String(config.timeoutMs), CQA_RETRY_LIMIT: String(config.retryLimit), PORT: '3023' });
  let server: ChildProcess | undefined; let browser: Browser | undefined;
  let phase = 'isolated-server'; const browserErrors: string[] = []; const blockedRequests: string[] = []; let readiness: Record<string, unknown> = {};
  let referencePosts = 0; let modelRequests = 0;
  try {
    server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/index.ts'], { cwd: resolve('.'), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    server.stdout?.on('data', value => { const found = String(value).match(/CQA local workspace: http:\/\/127\.0\.0\.1:(\d+)/); if (found) readiness.childListeningPort = Number(found[1]); });
    server.stderr?.on('data', value => { if (String(value).includes('SERVER_START_FAILED')) readiness.childStartFailed = true; });
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      assert(server.exitCode === null, 'ISOLATED_SERVER_EXITED');
      try {
        const statusResponse = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(500) });
        if (statusResponse.ok) {
          const status = await statusResponse.json();
          readiness = { httpStatus: statusResponse.status, apiKeyPresent: status.apiKeyPresent, organizerConfigured: status.organizerConfigured, model: status.model, provider: status.provider, mode: status.mode };
          if (status.apiKeyPresent !== false) throw new Error('ISOLATED_API_KEY_NOT_EMPTY');
          if (status.organizerConfigured !== false) throw new Error('ISOLATED_ORGANIZER_NOT_EMPTY');
          if (status.model !== config.model || status.provider !== config.provider || status.mode !== config.mode) throw new Error('ISOLATED_PROVIDER_CONFIGURATION_MISMATCH');
          ready = true; break;
        }
        readiness = { httpStatus: statusResponse.status };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('ISOLATED_')) throw error;
        // Only waiting for this local process; no model or organizer endpoint is contacted.
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert(ready, 'ISOLATED_SERVER_NOT_READY');
    const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    browser = await chromium.launch({ executablePath: process.env.CQA_BROWSER_EXECUTABLE || (existsSync(chrome) ? chrome : undefined), headless: true });
    const context = await browser.newContext({ viewport: { width: 1540, height: 1000 }, reducedMotion: 'reduce' });
    await context.route('**/*', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.pathname === '/api/evaluations' && request.method() === 'POST') modelRequests++;
      if (url.origin !== base || (!['GET', 'HEAD'].includes(request.method()) && url.pathname !== '/api/quality/references')) {
        blockedRequests.push(`${request.method()} ${url.pathname}`); await route.abort('blockedbyclient'); return;
      }
      if (url.pathname === '/api/quality/references' && request.method() === 'POST') referencePosts++;
      await route.continue();
    });
    const page = await context.newPage(); page.on('pageerror', error => browserErrors.push(error.name));
    async function get<T>(path: string): Promise<T> { const result = await context.request.get(`${base}${path}`); assert(result.ok(), `LOCAL_HTTP_${result.status()}`); return await result.json() as T; }
    const before = await get<Dashboard>('/api/quality');
    assert.notEqual(before.reviewRound.id, 'legacy', 'FRESH_ROUND_REQUIRED'); assert.equal(before.referenceCount, 0, 'ACTIVE_ROUND_MUST_BE_EMPTY');
    assert.equal(before.cases.length, 12); assert.equal(before.metrics.resolvedHumanJudgments, 0);
    const item = before.cases.find(c => c.language === 'RU') || before.cases[0];
    const casePath = `/api/quality/cases/${encodeURIComponent(item.id)}?manifestId=${encodeURIComponent(before.manifest.id)}`;
    const initial = await get<CaseView>(casePath);
    assert.equal(initial.reference, null); assert.equal(initial.modelEvaluation, null); assert.equal(initial.checklist.criteria.length, 9);
    assert(initial.checklist.criteria.some(c => c.id === 'C1' && c.allowedValues.includes('NO')));
    const operator = initial.conversation.messages.find(m => m.speaker === 'operator' && m.text.trim()); assert(operator);
    const isolatedBefore = fingerprints(isolatedPath);
    phase = 'ui-fill';
    await page.goto(`${base}/?view=quality`, { waitUntil: 'networkidle' });
    await expect(page.locator('[data-review-round]')).toHaveAttribute('data-review-round', before.reviewRound.id);
    await page.locator('.quality-case-list button').filter({ hasText: item.conversationId }).click();
    await expect(page.locator('.quality-transcript h2')).toHaveText(item.conversationId);
    await page.getByLabel('Проверяющий эталона', { exact: true }).fill(softwareReviewer);
    await page.getByRole('combobox', { name: 'Критерий эталона', exact: true }).selectOption('C1');
    await page.getByRole('combobox', { name: 'Ответ эталона', exact: true }).selectOption('NO');
    await page.getByLabel('Обоснование эталона', { exact: true }).fill(softwareExplanation);
    await page.getByRole('combobox', { name: 'Источник доказательства эталона', exact: true }).selectOption(operator.id);
    await expect(page.getByLabel('Цитата эталона', { exact: true })).toHaveValue(operator.text);
    await page.getByRole('button', { name: 'Добавить цитату', exact: true }).click();
    await page.getByRole('button', { name: 'Я проверил весь диалог', exact: true }).click();
    // These self-attestations are exercised only in the throwaway software fixture copy.
    await page.getByRole('checkbox', { name: 'Я человек и самостоятельно проверил отмеченные пункты. Это не агентная демонстрация.', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Для новых решений я не смотрел ответы оценивающей модели.', exact: true }).check();
    const save = page.getByRole('button', { name: 'Сохранить человеческую разметку', exact: true });
    await expect(save).toBeEnabled();
    phase = 'ui-save';
    const savedResponsePromise = page.waitForResponse(r => new URL(r.url()).pathname === '/api/quality/references' && r.request().method() === 'POST');
    await save.click(); const savedResponse = await savedResponsePromise;
    assert.equal(savedResponse.status(), 200, 'SOFTWARE_FIXTURE_SAVE_FAILED');
    const saved = await savedResponse.json() as HumanReference;
    assert.equal(saved.reviewerId, softwareReviewer); assert.equal(saved.reviewRoundId, before.reviewRound.id);
    assert.equal(saved.judgments.filter(j => j.resolved).length, 1); assert.equal(saved.judgments.filter(j => !j.resolved).length, 8);
    const c1 = saved.judgments.find(j => j.criterionId === 'C1')!;
    assert.equal(c1.answer, 'NO'); assert.equal(c1.explanation, softwareExplanation);
    assert.deepEqual(c1.evidence, [{ messageId: operator.id, quote: operator.text }]);
    assert.deepEqual(c1.checkedRange, { startMessageId: initial.conversation.messages[0].id, endMessageId: initial.conversation.messages.at(-1)!.id });
    assert(saved.judgments.filter(j => !j.resolved).every(j => j.answer === null && j.explanation === '' && j.applicabilityRationale === '' && j.evidence.length === 0 && j.checkedRange === null));
    await expect(page.locator('.quality-reference-form')).toContainText('Решено: 1 / 9');
    await page.screenshot({ path: join(reports, 'saved-test-fixture-desktop.png'), fullPage: true });
    phase = 'ui-refresh';
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.quality-case-list button').filter({ hasText: item.conversationId }).click();
    await expect(page.locator('.quality-transcript h2')).toHaveText(item.conversationId);
    await expect(page.locator('[data-review-round]')).toHaveAttribute('data-review-round', before.reviewRound.id);
    await page.getByRole('combobox', { name: 'Критерий эталона', exact: true }).selectOption('C1');
    await expect(page.getByRole('combobox', { name: 'Ответ эталона', exact: true })).toBeDisabled();
    await expect(page.getByRole('combobox', { name: 'Ответ эталона', exact: true })).toHaveValue('NO');
    await expect(page.getByLabel('Обоснование эталона', { exact: true })).toHaveValue(softwareExplanation);
    let unresolvedEditable = 0;
    for (const criterion of initial.checklist.criteria.filter(c => c.id !== 'C1')) {
      await page.getByRole('combobox', { name: 'Критерий эталона', exact: true }).selectOption(criterion.id);
      await expect(page.getByRole('combobox', { name: 'Ответ эталона', exact: true })).toBeEnabled();
      await expect(page.getByRole('combobox', { name: 'Ответ эталона', exact: true })).toHaveValue('');
      await expect(page.getByLabel('Обоснование эталона', { exact: true })).toHaveValue('');
      await expect(page.getByRole('combobox', { name: 'Начало диапазона эталона', exact: true })).toHaveValue('');
      await expect(page.getByRole('combobox', { name: 'Конец диапазона эталона', exact: true })).toHaveValue('');
      unresolvedEditable++;
    }
    const persisted = await get<CaseView>(casePath); assert.deepEqual(persisted.reference, saved);
    const after = await get<Dashboard>('/api/quality');
    assert.equal(after.reviewRound.id, before.reviewRound.id); assert.equal(after.referenceCount, 1); assert.equal(after.metrics.resolvedHumanJudgments, 1);
    assert.equal(after.metrics.coverage.unannotatedJudgments, before.metrics.coverage.expectedHumanJudgments - 1);
    const isolatedAfter = fingerprints(isolatedPath);
    for (const [table, value] of Object.entries(isolatedBefore)) if (!['quality_references', 'quality_requests'].includes(table)) assert.deepEqual(isolatedAfter[table], value, `ISOLATED_UNRELATED_TABLE_CHANGED_${table}`);
    assert.equal(isolatedAfter.quality_references.count, isolatedBefore.quality_references.count + 1);
    assert.equal(isolatedAfter.quality_requests.count, isolatedBefore.quality_requests.count + 1);
    assert.equal(referencePosts, 1); assert.equal(modelRequests, 0); assert.deepEqual(blockedRequests, []); assert.deepEqual(browserErrors, []);
    const mainAfter = fingerprints(config.dbPath); assert.deepEqual(mainAfter, mainBefore, 'PRODUCTION_DATABASE_CHANGED_DURING_SOFTWARE_PROOF');
    await page.screenshot({ path: join(reports, 'refreshed-eight-blank-test-fixture.png'), fullPage: true });
    const report = { status: 'PASS', softwareFixtureNotGold: true, humanGoldLabelsAuthored: 0, isolatedSoftwareAnnotations: 1,
      actualRunningApplication: true, headlessIsolatedBrowserProfile: true, userBrowserProfileAccessed: false, port: 3023,
      activeRoundId: before.reviewRound.id, caseId: item.id, savedCriteria: 1, unresolvedBlankEditableCriteria: unresolvedEditable,
      exactSourceQuoteAndFullRangeValidated: true, saveThenRefreshPreservedReference: true, preservedModel: config.model,
      modelCallsTriggered: 0, modelEvaluationRequests: modelRequests, newEvaluations: 0, newEvaluationAttempts: 0,
      productionDatabaseUnchanged: true, productionReferencesBefore: mainBefore.quality_references.count, productionReferencesAfter: mainAfter.quality_references.count,
      productionTableFingerprintsBefore: mainBefore, productionTableFingerprintsAfter: mainAfter,
      fixturesExcludedFromProductionAndQualityClaims: true, reports: relative(resolve('.'), reports), isolatedDatabaseRemovedAfterProof: true,
      screenshots: [join(reports, 'saved-test-fixture-desktop.png'), join(reports, 'refreshed-eight-blank-test-fixture.png')], browserErrors, blockedRequests };
    writeFileSync(join(reports, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, softwareFixtureNotGold: true, savedCriteria: 1, unresolvedBlankEditableCriteria: unresolvedEditable, productionDatabaseUnchanged: true, modelCallsTriggered: 0, report: join(reports, 'report.json') }));
  } catch (error) {
    const failure = error instanceof Error && /^[A-Z0-9_]{1,160}$/.test(error.message) ? error.message : 'SOFTWARE_UI_ACCEPTANCE_FAILED';
    writeFileSync(join(reports, 'report.json'), JSON.stringify({ status: 'FAIL', phase, failure, softwareFixtureNotGold: true, humanGoldLabelsAuthored: 0, modelCallsTriggered: 0, referencePosts, modelRequests, productionDatabaseUnchanged: hash(fingerprints(config.dbPath)) === hash(mainBefore), readiness, browserErrors, blockedRequests }, null, 2));
    console.error(JSON.stringify({ status: 'FAIL', phase, failure, report: join(reports, 'report.json') })); process.exitCode = 1;
  } finally { await browser?.close(); await stop(server); removeLocalTemp(isolatedDirectory); }
}
await run();
