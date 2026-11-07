/** Actual browser/backend/provider acceptance. No request mocks and no fabricated results. */
import { chromium, expect } from '@playwright/test';
import { existsSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { config } from '../server/config.js';
import type { Checklist, Evaluation } from '../src/domain.js';

const windowsChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: process.env.CQA_BROWSER_EXECUTABLE || (existsSync(windowsChrome) ? windowsChrome : undefined), headless: true });
const page = await browser.newPage({ viewport: { width: 1540, height: 1000 }, reducedMotion: 'reduce' });
const base = `http://127.0.0.1:${config.port}`;
const browserErrors: string[] = [];
page.on('pageerror', e => browserErrors.push(e.message));
try {
  await page.goto(base);
  await page.getByText('Реальный API', { exact: true }).waitFor();
  const before = await (await page.request.get(`${base}/api/evaluations`)).json() as Evaluation[];
  const original = before.find(e => e.checklistVersion === 'official-v1');
  assert(original, 'A saved actual official evaluation is required before the dynamic acceptance.');
  let checklist: Checklist;
  let evaluation: Evaluation;
  if (process.argv.includes('--resume')) {
    const saved = before.find(e => e.conversationVersion === original.conversationVersion && e.results.some(r => r.criterionId === 'C9'));
    assert(saved, 'No actual saved dynamic evaluation to resume.');
    evaluation = saved;
    const allChecklists = await (await page.request.get(`${base}/api/checklists`)).json() as Checklist[];
    checklist = allChecklists.find(c => c.version === saved.checklistVersion)!;
    assert(checklist);
  } else {
  await page.getByRole('button', { name: 'Чек-листы', exact: true }).click();
  await page.getByRole('combobox', { name: 'Основа чек-листа', exact: true }).selectOption('official-v1');
  if (process.argv.includes('--refine-rubric')) {
    await page.getByRole('combobox', { name: 'Редактируемый критерий', exact: true }).selectOption({ label: '2. Выявление потребности · C2' });
    await page.getByLabel('Правила оценки', { exact: true }).fill('ДА — оператор учёл известные детали И задал вопросы о действительно недостающей информации до ответа. N/A — до первого ответа человека-оператора данных для ответа уже хватало; в этом случае уточнения не нужны. НЕТ — существенная информация отсутствовала, но оператор не уточнил её до ответа. Сам по себе учёт деталей и правильный ответ без уточняющих вопросов не является основанием для ДА: если уточнение не требовалось, выбирайте N/A.');
    await page.getByRole('combobox', { name: 'Редактируемый критерий', exact: true }).selectOption({ label: '7. Завершение · C7' });
    await page.getByLabel('Правила оценки', { exact: true }).fill('ДА требует ОДНОВРЕМЕННО двух компонентов: (1) оператор подвёл итог решения ИЛИ предложил дальнейшую помощь; (2) оператор попрощался. Одного прощания, пожелания хорошего дня или ответа «Пожалуйста» недостаточно для ДА. Если возможность завершить была, но первый компонент отсутствует, ставьте НЕТ. N/A — чат оборвался до возможности оператора его завершить.');
    await page.getByLabel('Требования к доказательствам', { exact: true }).fill('Для ДА приведите точные цитаты, отдельно подтверждающие итог или предложение дальнейшей помощи и прощание. Одно пожелание хорошего дня подтверждает только прощание. Для НЕТ укажите проверенный заключительный диапазон и недостающий компонент.');
  }
  await page.getByRole('button', { name: 'Добавить критерий', exact: true }).click();
  await page.getByLabel('ID критерия', { exact: true }).fill('C9');
  await page.getByLabel('Название критерия', { exact: true }).fill('Ссылка на справочную страницу');
  await page.getByLabel('Правила оценки', { exact: true }).fill('Да — человек-оператор прислал клиенту явный URL справочной страницы. Нет — в репликах человека-оператора нет URL справочной страницы. Упоминания раздела приложения без URL недостаточно. Ссылки бота не засчитываются. Для Нет укажите проверенный диапазон реплик оператора.');
  await page.getByLabel('Вес критерия', { exact: true }).fill('10');
  const saved = page.waitForResponse(r => r.url().endsWith('/api/checklists') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Сохранить новую версию', exact: true }).click();
  const response = await saved;
  assert(response.ok());
  checklist = await response.json() as Checklist;
  assert.equal(checklist.criteria.length, 9);
  await page.getByRole('button', { name: 'Оценка диалогов', exact: true }).click();
  await page.locator('.assessment > label').first().locator('select').selectOption(checklist.version);
  const evaluated = page.waitForResponse(r => r.url().endsWith('/api/evaluations') && r.request().method() === 'POST', { timeout: 140000 });
  await page.getByRole('button', { name: 'Оценить через бесплатную модель', exact: true }).click();
  const evaluatedResponse = await evaluated;
  const body = await evaluatedResponse.json();
  assert(evaluatedResponse.ok(), `Live dynamic evaluation failed with safe code ${body.error}`);
  evaluation = body as Evaluation;
  }
  assert.equal(evaluation.status, 'live_validated');
  assert.equal(evaluation.checklistVersion, checklist.version);
  assert.equal(evaluation.results.length, 9);
  const added = evaluation.results.find(r => r.criterionId === 'C9');
  assert(added);
  assert.equal(added.answer, 'NO');
  assert(added.checkedRange);
  if (process.argv.includes('--refine-rubric')) {
    assert.equal(evaluation.results.find(r => r.criterionId === 'C7')?.answer, 'NO', 'Closing conjunction must be respected.');
    assert.equal(evaluation.results.find(r => r.criterionId === 'C2')?.answer, 'N/A', 'Sufficient pre-operator context should not earn clarification credit.');
  }
  // A local demo reviewer can change and restore a criterion; it is not a human gold label.
  await page.getByRole('combobox', { name: 'Сохранённая оценка', exact: true }).selectOption(evaluation.id);
  await page.getByRole('button', { name: 'Заявитель', exact: true }).click();
  await page.getByRole('combobox', { name: /^Критерий апелляции/ }).selectOption('C9');
  await page.getByLabel('Комментарий к апелляции', { exact: true }).fill('Техническая демонстрация пересчёта: временно изменим C9 и затем восстановим исходный ответ. Это не экспертная разметка.');
  await page.getByRole('button', { name: 'Подать апелляцию', exact: true }).click();
  await page.getByText('Апелляция сохранена.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Проверяющий', exact: true }).click();
  const form = page.getByRole('form', { name: 'Решение по C9' });
  await form.getByRole('combobox', { name: /^Действие/ }).selectOption('change');
  await form.getByRole('combobox', { name: /^Новый ответ/ }).selectOption('YES');
  await form.getByLabel('Причина решения', { exact: true }).fill('Демонстрационное изменение для проверки детерминированного пересчёта; не является утверждением о наличии URL.');
  await form.getByRole('button', { name: 'Сохранить решение', exact: true }).click();
  await expect(page.getByText('Решение сохранено. Финальный балл пересчитан.', { exact: true })).toBeVisible();
  let history = await (await page.request.get(`${base}/api/evaluations/${evaluation.id}/history`)).json();
  assert.equal(history.finalAnswers.C9, 'YES');
  const changedTotal = history.finalScore.total;
  await page.getByRole('button', { name: 'Заявитель', exact: true }).click();
  await page.getByLabel('Комментарий к апелляции', { exact: true }).fill('Завершение технической демонстрации: восстановить C9 = Нет, так как URL в репликах оператора отсутствует.');
  await page.getByRole('button', { name: 'Подать апелляцию', exact: true }).click();
  await page.getByText('Апелляция сохранена.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Проверяющий', exact: true }).click();
  const restoreForm = page.getByRole('form', { name: 'Решение по C9' });
  await restoreForm.getByRole('combobox', { name: /^Действие/ }).selectOption('change');
  await restoreForm.getByRole('combobox', { name: /^Новый ответ/ }).selectOption('NO');
  await restoreForm.getByLabel('Причина решения', { exact: true }).fill('Восстановлен исходный ответ C9 = Нет после технической проверки. В операторских репликах URL нет.');
  await restoreForm.getByRole('button', { name: 'Сохранить решение', exact: true }).click();
  await expect(page.getByText('Решение сохранено. Финальный балл пересчитан.', { exact: true })).toBeVisible();
  history = await (await page.request.get(`${base}/api/evaluations/${evaluation.id}/history`)).json();
  assert.equal(history.finalAnswers.C9, 'NO');
  assert.equal(history.finalScore.total, evaluation.score.total);
  await page.reload();
  await page.getByText('Реальный API', { exact: true }).waitFor();
  const originalAfter = await (await page.request.get(`${base}/api/evaluations/${original.id}`)).json();
  assert.deepEqual(originalAfter, original);
  assert.deepEqual(browserErrors, []);
  const report = { status: 'PASS', networkMocks: false, originalEvaluationId: original.id, newEvaluationId: evaluation.id, checklistVersion: checklist.version, model: evaluation.model, newCriterionAnswer: added.answer, originalTotal: original.score.total, newTotal: evaluation.score.total, demoChangedTotal: changedTotal, restoredTotal: history.finalScore.total, appeals: history.appeals.length, decisions: history.decisions.length, originalUnchanged: true, usage: evaluation.usage, latencyMs: evaluation.latencyMs, providerCallCount: evaluation.providerCallCount, browserErrors };
  writeFileSync('private/reports/browser-live-dynamic.json', JSON.stringify(report, null, 2));
  await page.screenshot({ path: 'private/reports/dynamic-review-desktop.png', fullPage: true });
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
