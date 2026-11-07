/** Actual local-app voice acceptance. All authored ratings are explicit agent demos, never human gold. */
import { chromium, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { config } from '../server/config.js';
import { canonicalJson } from '../server/importer.js';
import type { Checklist, Conversation, Evaluation } from '../src/domain.js';

const base = `http://127.0.0.1:${config.port}`;
const windowsChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: process.env.CQA_BROWSER_EXECUTABLE || (existsSync(windowsChrome) ? windowsChrome : undefined), headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, reducedMotion: 'reduce' });
const browserErrors: string[] = [];
let browserInferencePosts = 0; let externalBrowserRequests = 0; let phase = 'startup';
page.on('pageerror', error => browserErrors.push(error.message));
page.on('request', request => {
  const url = new URL(request.url());
  if (url.origin !== base && ['http:', 'https:'].includes(url.protocol)) externalBrowserRequests++;
  if (url.pathname === '/api/evaluations' && request.method() === 'POST') browserInferencePosts++;
});
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
mkdirSync('private/reports', { recursive: true });
const records: unknown[] = [];
try {
  await page.goto(base);
  await page.getByRole('combobox', { name: 'Фильтр по каналу', exact: true }).selectOption('voice call');
  const beforeStatus = await (await page.request.get(`${base}/api/status`)).json();
  const beforeAttempts = await (await page.request.get(`${base}/api/evaluation-attempts`)).json();
  const list = await (await page.request.get(`${base}/api/conversations`)).json() as Conversation[];
  const calls = list.filter(c => c.channel === 'voice call' && c.groupId === 'DEV');
  const checklists = await (await page.request.get(`${base}/api/checklists`)).json() as Checklist[];
  const checklist = checklists.find(c => c.version === 'official-v1');
  assert(checklist); assert.equal(calls.length, 5);
  for (const [callIndex, summary] of calls.entries()) {
    phase = `open-call-${callIndex + 1}`;
    const conversation = await (await page.request.get(`${base}/api/conversations/${summary.version}`)).json() as Conversation;
    await page.locator(`.conversation[data-version="${summary.version}"]`).click();
    await page.getByRole('heading', { name: conversation.conversationId, exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'Чек-лист', exact: true }).selectOption('official-v1');
    const player = page.locator('audio');
    await player.waitFor();
    phase = `decode-play-call-${callIndex + 1}`;
    await expect.poll(() => player.evaluate(element => {
      const audio = element as HTMLAudioElement;
      return audio.readyState >= 2 && Number.isFinite(audio.duration) && audio.duration > 0;
    }), { timeout: 30000 }).toBe(true);
    await player.evaluate(async element => { const audio = element as HTMLAudioElement; audio.muted = true; audio.currentTime = 0; await audio.play(); });
    await expect.poll(() => player.evaluate(element => (element as HTMLAudioElement).currentTime), { timeout: 10000 }).toBeGreaterThan(0.15);
    const playback = await player.evaluate(element => { const audio = element as HTMLAudioElement; const state = { durationSeconds: audio.duration, advancedSeconds: audio.currentTime, pausedDuringProof: audio.paused, readyState: audio.readyState, mediaError: audio.error?.code ?? null }; audio.pause(); return state; });
    assert.equal(playback.pausedDuringProof, false); assert.equal(playback.mediaError, null);
    const middle = conversation.messages[Math.floor(conversation.messages.length / 2)];
    await page.getByRole('button', { name: `Перейти к аудио реплики ${middle.position + 1}`, exact: true }).click();
    const expectedOffset = Math.max(0, (Date.parse(middle.timestamp) - Date.parse(conversation.messages[0].timestamp)) / 1000);
    const actualOffset = await player.evaluate(element => (element as HTMLAudioElement).currentTime);
    assert(Math.abs(Math.min(expectedOffset, playback.durationSeconds) - actualOffset) < 1);
    phase = `manual-call-${callIndex + 1}`;
    const panel = page.getByRole('region', { name: 'Ручная локальная оценка', exact: true });
    await panel.getByRole('combobox', { name: 'Тип ручной записи', exact: true }).selectOption('agent_demo');
    await panel.getByRole('textbox', { name: 'Проверяющий ручной оценки', exact: true }).fill('Техническая проверка (агент)');
    const source = conversation.messages.find(m => m.speaker === 'operator' && m.text.trim())!;
    assert(source);
    for (const criterion of checklist.criteria) {
      await panel.getByRole('combobox', { name: 'Критерий ручной оценки', exact: true }).selectOption(criterion.id);
      const answer = criterion.answerType === 'numeric' ? '0' : 'NO';
      await panel.getByRole('combobox', { name: 'Ответ ручной оценки', exact: true }).selectOption(answer);
      await panel.getByRole('textbox', { name: 'Обоснование ручной оценки', exact: true }).fill(`Техническая демонстрация формы ${criterion.id}: выбран ответ ${answer} для проверки сохранения и арифметики. Это не экспертная оценка звонка и не человеческий эталон.`);
      await panel.getByRole('combobox', { name: 'Исходная реплика для цитаты', exact: true }).selectOption(source.id);
      await panel.getByRole('button', { name: 'Добавить точную цитату', exact: true }).click();
      await panel.getByRole('combobox', { name: 'Начало ручного диапазона', exact: true }).selectOption(conversation.messages[0].id);
      await panel.getByRole('combobox', { name: 'Конец ручного диапазона', exact: true }).selectOption(conversation.messages.at(-1)!.id);
    }
    const savedResponse = page.waitForResponse(response => response.url().endsWith('/api/manual-evaluations') && response.request().method() === 'POST');
    await panel.getByRole('button', { name: 'Сохранить ручную оценку', exact: true }).click();
    const response = await savedResponse;
    assert(response.ok(), 'Manual save request failed.');
    const evaluation = await response.json() as Evaluation;
    assert.equal(evaluation.status, 'manual_demo'); assert.equal(evaluation.origin, 'agent_demo'); assert.equal(evaluation.providerCallCount, 0);
    assert.equal(evaluation.configuration.humanAttestation, false); assert.equal(evaluation.score.total, 0);
    assert.equal(evaluation.results.length, 8);
    if (callIndex === 0) {
      phase = 'appeal-change-and-restore';
      for (const [index, changedAnswer] of ['YES', 'NO'].entries()) {
        await page.getByRole('button', { name: 'Заявитель', exact: true }).click();
        await page.getByRole('combobox', { name: /^Критерий апелляции/ }).selectOption('C1');
        await page.getByRole('textbox', { name: 'Комментарий к апелляции', exact: true }).fill(index ? 'Восстановление исходного технического ответа NO после демонстрации. Не экспертное решение.' : 'Техническое изменение C1 для проверки пересчёта. Не экспертная разметка.');
        const appealResponse = page.waitForResponse(r => r.url().endsWith('/appeals') && r.request().method() === 'POST');
        await page.getByRole('button', { name: 'Подать апелляцию', exact: true }).click();
        assert((await appealResponse).ok());
        await page.getByRole('button', { name: 'Проверяющий', exact: true }).click();
        const form = page.getByRole('form', { name: 'Решение по C1', exact: true });
        await form.getByRole('combobox', { name: /^Действие/ }).selectOption('change');
        await form.getByRole('combobox', { name: /^Новый ответ/ }).selectOption(changedAnswer);
        await form.getByRole('textbox', { name: 'Причина решения', exact: true }).fill(index ? 'Восстановлено NO после технического теста. Данные не считаются экспертной разметкой.' : 'Временное YES только для технической демонстрации пересчёта. Оценка звонка человеком не проводилась.');
        const decisionResponse = page.waitForResponse(r => r.url().endsWith('/decisions') && r.request().method() === 'POST');
        await form.getByRole('button', { name: 'Сохранить решение', exact: true }).click();
        const decision = await decisionResponse; assert(decision.ok());
        const body = await decision.json(); assert.equal(body.finalScore.total, index ? 0 : 10);
      }
    }
    await page.reload();
    await page.getByRole('combobox', { name: 'Фильтр по каналу', exact: true }).selectOption('voice call');
    const stored = await (await page.request.get(`${base}/api/evaluations/${evaluation.id}`)).json();
    const history = await (await page.request.get(`${base}/api/evaluations/${evaluation.id}/history`)).json();
    assert.equal(stored.status, 'manual_demo'); assert.equal(history.finalScore.total, 0);
    records.push({ conversationId: conversation.conversationId, conversationVersion: conversation.version, audio: playback, seek: { expectedOffset, actualOffset }, evaluationId: evaluation.id, provenance: stored.status, score: stored.score.total, finalScore: history.finalScore.total, appeals: history.appeals.length, decisions: history.decisions.length, evaluationSha256: digest(stored), historySha256: digest(history) });
  }
  const afterStatus = await (await page.request.get(`${base}/api/status`)).json();
  const afterAttempts = await (await page.request.get(`${base}/api/evaluation-attempts`)).json();
  assert.equal(browserInferencePosts, 0); assert.equal(externalBrowserRequests, 0); assert.equal(browserErrors.length, 0);
  assert.equal(afterStatus.liveEvaluationCount, beforeStatus.liveEvaluationCount); assert.equal(afterAttempts.length, beforeAttempts.length);
  const report = { status: 'PASS', source: 'actual-running-app-no-network-mocks', humanJudgmentsAuthored: 0, agentDemoAssessments: records.length, audioPlaybackVerified: records.length, browserInferencePosts, externalBrowserRequests, beforeLiveEvaluations: beforeStatus.liveEvaluationCount, afterLiveEvaluations: afterStatus.liveEvaluationCount, beforeAttemptCount: beforeAttempts.length, afterAttemptCount: afterAttempts.length, browserErrorCount: browserErrors.length, records };
  writeFileSync('private/reports/voice-acceptance.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch {
  await page.screenshot({ path: 'private/reports/voice-acceptance-failure.png', fullPage: true }).catch(() => undefined);
  writeFileSync('private/reports/voice-acceptance-partial.json', JSON.stringify({ status: 'FAIL', phase, records, browserErrorCount: browserErrors.length }, null, 2));
  console.error(JSON.stringify({ status: 'FAIL', phase, completedCalls: records.length, privateDiagnostic: 'private/reports/voice-acceptance-partial.json' }));
  process.exitCode = 1;
} finally { await browser.close(); }
