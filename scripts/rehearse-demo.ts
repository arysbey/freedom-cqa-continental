/** A measured five-minute rehearsal of saved real results. Never invokes AI or writes judgments. */
import { chromium, expect } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import type { Checklist, Conversation, Evaluation, EvaluationAttempt } from '../src/domain.js';
import type { ReviewHistory } from '../server/reviews.js';
import type { ValidationManifest } from '../server/quality.js';
import { config } from '../server/config.js';

interface QualityView { manifest: ValidationManifest | null; referenceCount: number; metrics: { comparedCases: number; resolvedHumanJudgments: number; totalScoreError: { dialogs: number; meanAbsoluteError: number | null }; reliability: { attempts: number; successes: number; failures: number; errors: Record<string, number> } } | null }
interface Checkpoint { targetSeconds: number; actualSeconds: number; finishedSeconds: number; name: string; status: 'PASS' | 'FAIL' | 'BLOCKED'; findings?: unknown; failure?: string }
const base = `http://127.0.0.1:${config.port}`;
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const currentModel = process.argv.includes('--current-model');
const directory = currentModel ? 'private/reports/demo-rehearsal-current-model' : 'private/reports/demo-rehearsal';
mkdirSync(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CQA_BROWSER_EXECUTABLE || (existsSync(chrome) ? chrome : undefined), headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1540, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage();
page.setDefaultTimeout(8000);
const browserErrors: string[] = [];
const blockedMutations: Array<{ method: string; path: string }> = [];
let externalBrowserRequests = 0;
page.on('pageerror', error => browserErrors.push(error.message));
await context.route('**/*', async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (['http:', 'https:'].includes(url.protocol) && url.origin !== base) externalBrowserRequests++;
  if (url.origin === base && !['GET', 'HEAD'].includes(request.method())) {
    blockedMutations.push({ method: request.method(), path: url.pathname });
    await route.abort('blockedbyclient');
  } else await route.continue();
});
async function json<T>(path: string): Promise<T> {
  const response = await context.request.get(`${base}${path}`);
  assert(response.ok(), `LOCAL_GET_FAILED_HTTP_${response.status()}`);
  return await response.json() as T;
}
const checkpoints: Checkpoint[] = [];
const screenshots: string[] = [];
let started = 0;
const elapsed = () => (performance.now() - started) / 1000;
async function until(seconds: number) {
  while (elapsed() < seconds) await new Promise(resolve => setTimeout(resolve, Math.min(1000, (seconds - elapsed()) * 1000)));
}
async function shot(name: string) {
  const path = `${directory}/${name}.png`; await page.screenshot({ path, fullPage: true }); screenshots.push(path);
}
async function at(targetSeconds: number, name: string, action: () => Promise<unknown>) {
  await until(targetSeconds);
  const actualSeconds = elapsed();
  console.log(JSON.stringify({ progress: name, elapsedSeconds: Number(actualSeconds.toFixed(3)), targetSeconds }));
  try {
    const findings = await action();
    checkpoints.push({ targetSeconds, actualSeconds, finishedSeconds: elapsed(), name, status: 'PASS', findings });
  } catch (error) {
    const failure = error instanceof Error ? error.message.split('\n')[0].slice(0, 200) : 'CHECK_FAILED';
    checkpoints.push({ targetSeconds, actualSeconds, finishedSeconds: elapsed(), name, status: failure.startsWith('MISSING_') ? 'BLOCKED' : 'FAIL', failure });
    await shot(`failure-${targetSeconds}`).catch(() => undefined);
    console.log(JSON.stringify({ progress: name, status: 'FAIL', failure }));
  }
}
async function openConversation(conversation: Pick<Conversation, 'version' | 'conversationId' | 'groupId'>) {
  await page.getByRole('button', { name: 'Оценка диалогов', exact: true }).click();
  await page.getByRole('combobox', { name: 'Фильтр по группе', exact: true }).selectOption(conversation.groupId);
  await page.getByRole('combobox', { name: 'Фильтр по каналу', exact: true }).selectOption('');
  await page.getByRole('searchbox', { name: 'Поиск диалога', exact: true }).fill(conversation.conversationId);
  await page.locator(`.conversation[data-version="${conversation.version}"]`).click();
  await page.getByRole('heading', { name: conversation.conversationId, exact: true }).waitFor();
}
async function selectSaved(evaluation: Evaluation) {
  await page.getByRole('combobox', { name: 'Сохранённая оценка', exact: true }).selectOption(evaluation.id);
  await expect(page.locator('.result-version')).toContainText(evaluation.checklistVersion);
  await expect(page.locator('.evaluation-provenance')).toContainText('сохранённый ответ предыдущего реального запроса');
}

try {
  const [conversations, evaluationsBefore, attemptsBefore, checklists, qualityBefore] = await Promise.all([
    json<Conversation[]>('/api/conversations'), json<Evaluation[]>('/api/evaluations'), json<EvaluationAttempt[]>('/api/evaluation-attempts'), json<Checklist[]>('/api/checklists'), json<QualityView>('/api/quality'),
  ]);
  const synthetic = conversations.find(c => c.groupId === 'DEV' && c.conversationId === 'p1-ru-001');
  const official = evaluationsBefore.find(e => e.conversationVersion === synthetic?.version && e.checklistVersion === 'official-v1' && e.status === 'live_validated');
  const urlResult = evaluationsBefore.find(e => e.id === 'fcf30c1f-cf45-4314-ac24-00831c66fc0f');
  const navigationResult = evaluationsBefore.find(e => e.id === '4c7739b2-b724-40fa-8bb7-09c8499d957c');
  const call = conversations.find(c => c.groupId === 'DEV' && c.conversationId === 'p4-ru-001');
  assert(synthetic && official && urlResult && navigationResult && call, 'MISSING_SAVED_DEMO_SOURCE');
  if (currentModel) assert.equal(official.model, config.model, 'CURRENT_MODEL_SAVED_RESULT_REQUIRED');
  const historyBefore = await json<ReviewHistory>(`/api/evaluations/${urlResult.id}/history`);
  const sourceUrl = checklists.find(c => c.version === urlResult.checklistVersion);
  const sourceNavigation = checklists.find(c => c.version === navigationResult.checklistVersion);
  assert(sourceUrl && sourceNavigation, 'MISSING_SEMANTIC_CHECKLIST');
  const voice = await json<Conversation>(`/api/conversations/${call.version}`);
  started = performance.now();
  const wallStartedAt = new Date().toISOString();
  const heartbeat = setInterval(() => console.log(JSON.stringify({ progress: 'rehearsal-running', elapsedSeconds: Number(elapsed().toFixed(1)) })), 30000);
  await at(0, '0–30 · официальный DEV и происхождение результата', async () => {
    await page.goto(base, { waitUntil: 'networkidle' });
    assert.equal(await page.getByRole('combobox', { name: 'Фильтр по группе', exact: true }).inputValue(), 'DEV');
    assert.equal(await page.getByRole('combobox', { name: 'Чек-лист', exact: true }).inputValue(), 'official-v1');
    assert.equal(await page.locator('.conversation').count(), 65);
    await expect(page.locator('.result-version')).toContainText('Официальный чек-лист · official-v1');
    await expect(page.locator('.assessment > .panel-heading .badge')).toHaveText('Сохранённый результат API');
    await shot('01-official-dev-desktop');
    return { devRecords: 65, otherGroupsRecords: conversations.length - 65, savedEvaluationId: official.id, savedModel: official.model, savedAt: official.createdAt, liveCallOptional: true, noNewCall: true };
  });
  await at(30, '30–90 · доказательства и N/A', async () => {
    await page.locator('.criterion').first().click();
    await page.locator('.criterion-details .evidence-link').first().click();
    assert.equal(await page.locator('.message:focus').count(), 1);
    const na = official.results.find(r => r.answer === 'N/A'); assert(na, 'MISSING_SAVED_NA');
    const title = sourceUrl.criteria.find(c => c.id === na.criterionId)?.title; assert(title);
    await page.locator('.criterion').filter({ hasText: title }).click();
    await expect(page.locator('.criterion-details')).toContainText('Применимость:');
    await page.locator('.criterion-details').scrollIntoViewIfNeeded();
    await shot('02-na-and-evidence');
    return { criterion: na.criterionId, answer: na.answer, evidenceJump: true, hasApplicability: Boolean(na.applicabilityRationale), hasEvidenceOrRange: Boolean(na.evidence.length || na.checkedRange) };
  });
  await at(90, '90–150 · сохранённая апелляция и пересмотр', async () => {
    await selectSaved(urlResult);
    await page.getByRole('button', { name: 'Проверяющий', exact: true }).click();
    const panel = page.locator('.review-panel'); await panel.scrollIntoViewIfNeeded();
    assert(historyBefore.appeals.length > 0 && historyBefore.decisions.length > 0, 'MISSING_EXISTING_REVIEW_HISTORY');
    await page.getByText(`Полная история решений · ${historyBefore.decisions.length}`, { exact: true }).click();
    assert.equal(await page.locator('.appeal-card').count(), historyBefore.appeals.length);
    await shot('03-existing-appeal-history');
    const historyAfter = await json<ReviewHistory>(`/api/evaluations/${urlResult.id}/history`); assert.deepEqual(historyAfter, historyBefore);
    return { evaluationId: urlResult.id, appeals: historyAfter.appeals.length, decisions: historyAfter.decisions.length, originalTotal: urlResult.score.total, finalTotal: historyAfter.finalScore.total, unchanged: true, humanJudgmentsAuthored: 0, provenance: 'Existing technical role demonstration; not human gold' };
  });
  await at(150, '150–180 · реальный звонок и локальная форма', async () => {
    await openConversation(call);
    const audio = page.locator('audio'); await audio.waitFor({ timeout: 15000 });
    await expect.poll(() => audio.evaluate(e => { const a = e as HTMLAudioElement; return a.readyState >= 2 && Number.isFinite(a.duration) && a.duration > 0; }), { timeout: 15000 }).toBe(true);
    await audio.evaluate(async e => { const a = e as HTMLAudioElement; a.muted = true; a.currentTime = 0; await a.play(); });
    await expect.poll(() => audio.evaluate(e => (e as HTMLAudioElement).currentTime), { timeout: 5000 }).toBeGreaterThan(0.2);
    const playback = await audio.evaluate(e => { const a = e as HTMLAudioElement; const result = { durationSeconds: a.duration, advancedSeconds: a.currentTime, pausedDuringProof: a.paused, mediaError: a.error?.code ?? null, muted: a.muted }; a.pause(); return result; });
    assert.equal(playback.pausedDuringProof, false); assert.equal(playback.mediaError, null);
    assert.equal(await page.getByRole('button', { name: 'Оценить через бесплатную модель', exact: true }).isEnabled(), false);
    await expect(page.getByRole('region', { name: 'Ручная локальная оценка', exact: true })).toBeVisible();
    await shot('04-real-call-local-only');
    return { conversationId: call.conversationId, transcriptMessages: voice.messages.length, playback, manualFormAvailable: true, savedProvenance: 'manual_demo', newManualAssessments: 0, externalAiForbidden: true };
  });
  await at(180, '180–205 · редактируемый критерий без нового оценивания', async () => {
    await page.getByRole('button', { name: 'Чек-листы', exact: true }).click();
    await page.getByRole('combobox', { name: 'Основа чек-листа', exact: true }).selectOption(sourceNavigation.version);
    const editor = page.getByRole('combobox', { name: 'Редактируемый критерий', exact: true });
    const option = await editor.locator('option').filter({ hasText: ' · C9' }).getAttribute('value'); assert(option); await editor.selectOption(option);
    const rules = page.getByLabel('Правила оценки', { exact: true });
    await rules.fill(`${await rules.inputValue()}\nЧерновик репетиции: не сохранялся и не оценивался.`);
    await shot('05-unsaved-criterion-draft');
    return { baseVersion: sourceNavigation.version, criterion: 'C9', draftEditedInUi: true, saved: false, evaluated: false };
  });
  await at(205, '205–222 · ранее сохранённый критерий URL', async () => {
    await openConversation(synthetic); await selectSaved(urlResult);
    await page.locator('.criterion').filter({ hasText: sourceUrl.criteria.find(c => c.id === 'C9')!.title }).click();
    await page.locator('.criterion-details').scrollIntoViewIfNeeded();
    assert.equal(urlResult.results.find(r => r.criterionId === 'C9')?.answer, 'NO'); assert.equal(urlResult.score.total, 80);
    await shot('06-saved-url-no');
    return { evaluationId: urlResult.id, checklistVersion: sourceUrl.version, answer: 'NO', total: 80, originalSavedAt: urlResult.createdAt, newCall: false };
  });
  await at(222, '222–240 · ранее сохранённая новая семантика', async () => {
    await selectSaved(navigationResult);
    await page.locator('.criterion').filter({ hasText: sourceNavigation.criteria.find(c => c.id === 'C9')!.title }).click();
    await page.locator('.criterion-details .evidence-link').first().click();
    assert.equal(navigationResult.results.find(r => r.criterionId === 'C9')?.answer, 'YES'); assert.equal(navigationResult.score.total, 93.33);
    assert.deepEqual(sourceNavigation.criteria.filter(c => c.id !== 'C9'), sourceUrl.criteria.filter(c => c.id !== 'C9'));
    await shot('07-saved-web-navigation-yes');
    return { evaluationId: navigationResult.id, checklistVersion: sourceNavigation.version, answer: 'YES', total: 93.33, onlyC9MeaningChanged: true, originalSavedAt: navigationResult.createdAt, model: navigationResult.model, newCall: false };
  });
  await at(240, '240–265 · независимая выборка и фактическое покрытие', async () => {
    await page.getByRole('button', { name: 'Проверка качества', exact: true }).click();
    await page.getByRole('heading', { name: 'Человек → эталон → сравнение', exact: true }).waitFor();
    const dashboard = await json<QualityView>('/api/quality'); const manifest = dashboard.manifest; assert(manifest);
    assert.equal(manifest.cases.filter(c => c.split === 'development').length, 6); assert.equal(manifest.cases.filter(c => c.split === 'holdout').length, 6);
    assert.equal(await page.locator('input[type="checkbox"]:checked').count(), 0);
    await shot('08-independent-quality');
    return { manifestId: manifest.id, development: 6, holdout: 6, byLanguage: Object.fromEntries(['ru', 'kz', 'en'].map(language => [language, manifest.cases.filter(c => c.language.toLowerCase() === language).length])), referenceCount: dashboard.referenceCount, comparedCases: dashboard.metrics?.comparedCases, resolvedJudgments: dashboard.metrics?.resolvedHumanJudgments, mae: dashboard.metrics?.totalScoreError.meanAbsoluteError, reliability: dashboard.metrics?.reliability, humanAttestationsByRehearsal: 0 };
  });
  await at(265, '265–285 · сохранённая ошибка и граница повторов', async () => {
    const failed = attemptsBefore.find(a => a.status === 'failed'); assert(failed, 'MISSING_SAVED_FAILED_ATTEMPT');
    const source = conversations.find(c => c.version === failed.conversationVersion); assert(source);
    await openConversation(source);
    await page.getByRole('combobox', { name: 'Чек-лист', exact: true }).selectOption(failed.checklistVersion);
    const selector = page.getByRole('combobox', { name: 'История запросов', exact: true });
    if (await selector.count()) await selector.selectOption(failed.id);
    await expect(page.getByRole('region', { name: 'История запроса модели', exact: true })).toContainText('Запрос завершён без новой оценки');
    await page.getByText('Идентификатор и диагностика', { exact: true }).click();
    await shot('09-failed-attempt-no-retry-triggered');
    return { attemptId: failed.id, errorCode: failed.errorCode, retryClicked: false, automaticCallOnHistoryOpen: false };
  });
  await at(285, '285–300 · официальный экран, мобильная ширина, завершение', async () => {
    await openConversation(synthetic);
    await page.getByRole('searchbox', { name: 'Поиск диалога', exact: true }).fill('');
    await page.getByRole('combobox', { name: 'Чек-лист', exact: true }).selectOption('official-v1');
    await selectSaved(official);
    await page.locator('.assessment').evaluate(e => { e.scrollTop = 0; }); await page.locator('.transcript').evaluate(e => { e.scrollTop = 0; });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await shot('10-official-dev-mobile');
    await page.setViewportSize({ width: 1540, height: 1000 });
    await shot('11-final-desktop');
    return { mobileWidth: 390, horizontalOverflow: false, liveStepSkippedExplicitly: true, savedResultShown: official.id };
  });
  await until(300);
  const actualDurationSeconds = elapsed(); clearInterval(heartbeat);
  const [evaluationsAfter, attemptsAfter, qualityAfter] = await Promise.all([json<Evaluation[]>('/api/evaluations'), json<EvaluationAttempt[]>('/api/evaluation-attempts'), json<QualityView>('/api/quality')]);
  const dataUnchanged = evaluationsBefore.map(e => e.id).sort().join() === evaluationsAfter.map(e => e.id).sort().join() && attemptsBefore.map(a => a.id).sort().join() === attemptsAfter.map(a => a.id).sort().join();
  const report = { status: checkpoints.every(c => c.status === 'PASS') && dataUnchanged && !browserErrors.length && !blockedMutations.length && !externalBrowserRequests ? 'PASS' : 'FAIL', source: 'actual-running-production-app-no-network-mocks', wallStartedAt, wallFinishedAt: new Date().toISOString(), plannedSeconds: 300, actualDurationSeconds, checkpoints, screenshots, browserErrors, blockedMutations, externalBrowserRequests, dataUnchanged, beforeSavedEvaluations: evaluationsBefore.length, afterSavedEvaluations: evaluationsAfter.length, beforeAttempts: attemptsBefore.length, afterAttempts: attemptsAfter.length, beforeReferences: qualityBefore.referenceCount, afterReferences: qualityAfter.referenceCount, newModelCalls: 0, newHumanJudgments: 0, savedChecklistVersionsCreated: 0, liveStep: 'Skipped deliberately; all displayed AI results were previously saved actual API responses.' };
  writeFileSync(`${directory}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'PASS') process.exitCode = 1;
} catch (error) {
  const failure = error instanceof Error ? error.message.split('\n')[0].slice(0, 200) : 'REHEARSAL_FAILED';
  writeFileSync(`${directory}/report.json`, JSON.stringify({ status: 'BLOCKED', phase: started ? 'rehearsal' : 'preflight', failure, checkpoints, screenshots, browserErrors, blockedMutations }, null, 2));
  console.error(JSON.stringify({ status: 'BLOCKED', failure })); process.exitCode = 1;
} finally { await browser.close(); }
