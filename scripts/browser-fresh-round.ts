/** Verify an explicitly reset human round without saving judgments or requesting AI. */
import { chromium, expect } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { config } from '../server/config.js';
import type { Checklist, Evaluation, EvaluationAttempt, Score } from '../src/domain.js';
import type { HumanReference, HumanReviewRound, ValidationCase, ValidationManifest } from '../server/quality.js';

interface FreshDashboard {
  manifest: ValidationManifest;
  reviewRound: HumanReviewRound;
  referenceCount: number;
  cases: Array<ValidationCase & { humanReferenceSaved: boolean }>;
  metrics: {
    resolvedHumanJudgments: number; comparedCases: number;
    coverage: { expectedHumanJudgments: number; unannotatedJudgments: number };
    byCriterion: Record<string, { total: number; agreement: number | null }>;
    totalScoreError: { dialogs: number; meanAbsoluteError: number | null };
    na: { available: boolean }; grossViolations: { available: boolean };
    evidence: { humanSemantic: { available: boolean } };
  };
}
interface FreshCase {
  case: ValidationCase;
  checklist: Checklist;
  reviewRound: HumanReviewRound;
  reference: HumanReference | null;
  referenceNumericScore: Score | null;
  modelEvaluation: unknown;
}
const base = `http://127.0.0.1:${config.port}`;
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const directory = 'private/reports/fresh-human-round';
mkdirSync(directory, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CQA_BROWSER_EXECUTABLE || (existsSync(chrome) ? chrome : undefined), headless: true });
const context = await browser.newContext({ viewport: { width: 1540, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const browserErrors: string[] = [];
const attemptedMutations: string[] = [];
page.on('pageerror', error => browserErrors.push(error.message));
await context.route('**/*', async route => {
  const request = route.request();
  if (new URL(request.url()).origin === base && !['GET', 'HEAD'].includes(request.method())) {
    attemptedMutations.push(new URL(request.url()).pathname); await route.abort('blockedbyclient');
  } else await route.continue();
});
async function json<T>(path: string): Promise<T> {
  const response = await context.request.get(`${base}${path}`); assert(response.ok(), `LOCAL_GET_HTTP_${response.status()}`);
  return await response.json() as T;
}
let phase = 'preflight';
try {
  const [before, evaluationsBefore, attemptsBefore] = await Promise.all([json<FreshDashboard>('/api/quality'), json<Evaluation[]>('/api/evaluations'), json<EvaluationAttempt[]>('/api/evaluation-attempts')]);
  assert.notEqual(before.reviewRound.id, 'legacy', 'FRESH_ROUND_REQUIRED');
  assert.equal(before.referenceCount, 0, 'HUMAN_REVIEW_ALREADY_RESUMED');
  assert.equal(before.metrics.resolvedHumanJudgments, 0);
  assert.equal(before.metrics.comparedCases, 0);
  assert.equal(before.metrics.totalScoreError.dialogs, 0);
  assert.equal(before.metrics.totalScoreError.meanAbsoluteError, null);
  assert.equal(before.metrics.coverage.unannotatedJudgments, before.metrics.coverage.expectedHumanJudgments);
  assert.equal(before.metrics.na.available, false); assert.equal(before.metrics.grossViolations.available, false); assert.equal(before.metrics.evidence.humanSemantic.available, false);
  assert(Object.values(before.metrics.byCriterion).every(item => item.total === 0 && item.agreement === null));
  const cases = await Promise.all(before.cases.map(item => json<FreshCase>(`/api/quality/cases/${encodeURIComponent(item.id)}?manifestId=${encodeURIComponent(before.manifest.id)}`)));
  for (const item of cases) {
    assert.equal(item.reviewRound.id, before.reviewRound.id); assert.equal(item.reference, null); assert.equal(item.referenceNumericScore, null); assert.equal(item.modelEvaluation, null);
  }
  phase = 'export';
  const exported = await json<{ reviewRound: HumanReviewRound; comparisons: unknown[]; provenance: { referenceHistory: Array<{ includedInCurrentRound: boolean }>; cases: Array<{ humanReference: unknown }> } }>(`/api/quality/export?manifestId=${encodeURIComponent(before.manifest.id)}`);
  assert.equal(exported.reviewRound.id, before.reviewRound.id); assert.equal(exported.comparisons.length, 0); assert(exported.provenance.referenceHistory.every(item => !item.includedInCurrentRound)); assert(exported.provenance.cases.every(item => item.humanReference === null));
  phase = 'ui';
  await page.goto(`${base}/?view=quality`, { waitUntil: 'networkidle' });
  await expect(page.locator('[data-review-round]')).toHaveAttribute('data-review-round', before.reviewRound.id);
  assert.equal(await page.locator('.quality-case-list button').count(), before.cases.length);
  const storage = await page.evaluate(manifestId => {
    const removedDraftKeys = Object.keys(localStorage).filter(key => key.includes(manifestId) && /draft/i.test(key) && /cqa|quality/i.test(key));
    for (const key of removedDraftKeys) localStorage.removeItem(key);
    return { scope: 'isolated-QA-browser-current-manifest-only', removedDraftKeys, userBrowserProfileAccessed: false };
  }, before.manifest.id);
  let editableCriteria = 0;
  const records: Array<{ caseId: string; language: string; split: string; criteria: number }> = [];
  for (const item of cases) {
    await page.locator('.quality-case-list button').filter({ hasText: item.case.conversationId }).click();
    await expect(page.locator('.quality-transcript h2')).toHaveText(item.case.conversationId);
    await expect(page.getByRole('combobox', { name: 'Критерий эталона', exact: true })).toBeVisible();
    assert.equal(await page.getByLabel('Проверяющий эталона', { exact: true }).inputValue(), '');
    assert.equal(await page.locator('input[type="checkbox"]:checked').count(), 0);
    for (const criterion of item.checklist.criteria) {
      await page.getByRole('combobox', { name: 'Критерий эталона', exact: true }).selectOption(criterion.id);
      const answer = page.getByRole('combobox', { name: 'Ответ эталона', exact: true });
      await expect(answer).toBeEnabled(); assert.equal(await answer.inputValue(), '');
      assert.equal(await page.getByLabel('Обоснование эталона', { exact: true }).inputValue(), '');
      assert.equal(await page.getByLabel('Цитата эталона', { exact: true }).inputValue(), '');
      assert.equal(await page.getByLabel('Начало диапазона эталона', { exact: true }).inputValue(), '');
      assert.equal(await page.getByLabel('Конец диапазона эталона', { exact: true }).inputValue(), '');
      editableCriteria++;
    }
    await expect(page.getByRole('button', { name: 'Сохранить человеческую разметку', exact: true })).toBeDisabled();
    await expect(page.locator('.quality-reference-form')).toContainText(`Решено: 0 / ${item.checklist.criteria.length}`);
    records.push({ caseId: item.case.id, language: item.case.language, split: item.case.split, criteria: item.checklist.criteria.length });
  }
  assert.equal(editableCriteria, before.metrics.coverage.expectedHumanJudgments);
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('[data-review-round]')).toHaveAttribute('data-review-round', before.reviewRound.id);
  assert.equal(await page.locator('.quality-case-list button').filter({ hasText: 'Разметка отсутствует' }).count(), before.cases.length);
  const first = before.cases.find(item => item.conversationId === 'p1-ru-003'); assert(first);
  await page.locator('.quality-case-list button').filter({ hasText: first.conversationId }).click();
  await expect(page.locator('.quality-transcript h2')).toHaveText(first.conversationId);
  await page.getByRole('combobox', { name: 'Критерий эталона', exact: true }).selectOption('C1');
  assert.equal(await page.getByLabel('Обоснование эталона', { exact: true }).inputValue(), '');
  assert.equal(await page.getByRole('combobox', { name: 'Ответ эталона', exact: true }).inputValue(), '');
  await page.locator('.quality-workspace').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: `${directory}/desktop.png`, fullPage: true });
  await page.getByRole('combobox', { name: 'Ответ эталона', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${directory}/desktop-empty-form.png`, fullPage: true });
  await page.locator('.quality-workspace').evaluate(element => { element.scrollTop = 0; });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: `${directory}/mobile.png`, fullPage: true });
  const [after, evaluationsAfter, attemptsAfter] = await Promise.all([json<FreshDashboard>('/api/quality'), json<Evaluation[]>('/api/evaluations'), json<EvaluationAttempt[]>('/api/evaluation-attempts')]);
  assert.equal(after.reviewRound.id, before.reviewRound.id); assert.equal(after.referenceCount, 0);
  assert.deepEqual(evaluationsAfter, evaluationsBefore); assert.deepEqual(attemptsAfter, attemptsBefore); assert.deepEqual(browserErrors, []); assert.deepEqual(attemptedMutations, []);
  const report = { status: 'PASS', source: 'actual-running-app-no-network-mocks', reviewRoundId: before.reviewRound.id, manifestId: before.manifest.id, cases: records, editableUnreviewedCriteria: editableCriteria, development: records.filter(item => item.split === 'development').length, holdout: records.filter(item => item.split === 'holdout').length, references: after.referenceCount, modelOutputsHiddenCases: cases.length, exportComparisonRows: 0, archivedReferenceMetadataPreserved: exported.provenance.referenceHistory.length, scoreMAE: null, browserErrors, attemptedMutations, storage, savedEvaluationsPreserved: evaluationsBefore.length, savedAttemptsPreserved: attemptsBefore.length, humanJudgmentsAuthored: 0, modelCallsTriggered: 0, screenshots: [`${directory}/desktop.png`, `${directory}/desktop-empty-form.png`, `${directory}/mobile.png`] };
  writeFileSync(`${directory}/report.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const failure = error instanceof Error ? error.message.split('\n')[0].slice(0, 220) : 'FRESH_ROUND_CHECK_FAILED';
  const status = failure.includes('HUMAN_REVIEW_ALREADY_RESUMED') ? 'BLOCKED' : 'FAIL';
  await page.screenshot({ path: `${directory}/failure.png`, fullPage: true }).catch(() => undefined);
  const report = { status, phase, failure, browserErrors, attemptedMutations, humanJudgmentsAuthored: 0, modelCallsTriggered: 0 };
  writeFileSync(`${directory}/report.json`, JSON.stringify(report, null, 2)); console.error(JSON.stringify(report)); process.exitCode = 1;
} finally { await browser.close(); }
