import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium, expect, type Browser } from '@playwright/test';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { ReviewStore } from '../server/reviews.js';
import { QualityStore } from '../server/quality.js';
import { PermissionStore } from '../server/data-permissions.js';
import { parseOrganizerResponse } from '../server/importer.js';

// A genuinely absent source in an isolated fabricated fixture, not an emulated HTTP failure.
// This scenario says nothing about playback availability of the five real DEV recordings.
const base = 'http://127.0.0.1:3022';
const store = new Store(':memory:');
const dataset = parseOrganizerResponse({ error: '', isSuccess: true, data: {
  dataset_group_id: 'AUDIO_BRANCH_FIXTURE', total_records: 1, records: [{
    conversation_id: 'fabricated-voice-without-audio', channel: 'voice call', language: 'RU', audio_url: null,
    transcript: [
      { timestamp: '2026-11-07T10:00:00+05:00', speaker: 'client', text: 'Вымышленный сценарий проверки: где найти описание тарифов?' },
      { timestamp: '2026-11-07T10:00:10+05:00', speaker: 'operator', text: 'Здравствуйте! Я Дана. Это вымышленный разговор без ссылки на запись.' },
      { timestamp: '2026-11-07T10:00:20+05:00', speaker: 'client', text: 'Спасибо. Проверяем доступность локальных элементов интерфейса.' },
    ],
  }],
} });
store.importDataset(dataset);
const nativeFetch = globalThis.fetch;
let blockedBackendExternalRequests = 0;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== '127.0.0.1') { blockedBackendExternalRequests++; throw new Error('UNEXPECTED_EXTERNAL_REQUEST'); }
  return nativeFetch(input, init);
}) as typeof fetch;
const app = await createApp(store, new ReviewStore(':memory:'), new QualityStore(':memory:'), new PermissionStore(':memory:'));
let browser: Browser | undefined;
const browserErrors: string[] = [];
const blockedBrowserExternalRequests: string[] = [];
const forbiddenMutations: string[] = [];
const sourceStatusResponses: string[] = [];
try {
  if (!existsSync('dist/index.html')) throw new Error('PRODUCTION_BUILD_REQUIRED');
  await app.listen({ host: '127.0.0.1', port: 3022 });
  const windowsChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  browser = await chromium.launch({ executablePath: process.env.CQA_BROWSER_EXECUTABLE || (existsSync(windowsChrome) ? windowsChrome : undefined), headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--disable-default-apps'] });
  const context = await browser.newContext({ viewport: { width: 1540, height: 1100 }, reducedMotion: 'reduce' });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) { blockedBrowserExternalRequests.push(url.hostname); await route.abort('blockedbyclient'); return; }
    if (!['GET', 'HEAD'].includes(request.method())) { forbiddenMutations.push(url.pathname); await route.abort('blockedbyclient'); return; }
    await route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('response', response => { if (new URL(response.url()).pathname.endsWith('/audio/status')) sourceStatusResponses.push(response.url()); });
  await page.goto(base);
  await page.getByRole('heading', { name: 'fabricated-voice-without-audio', exact: true }).waitFor();
  const player = page.getByRole('region', { name: 'Аудиозапись звонка', exact: true });
  await expect(player.getByText('Ссылка на запись не предоставлена.', { exact: false })).toBeVisible();
  const conversation = dataset.conversations[0];
  const statusResponse = await page.request.get(`${base}/api/conversations/${conversation.version}/audio/status`);
  assert(statusResponse.ok());
  const audioStatus = await statusResponse.json();
  assert.equal(audioStatus.state, 'unavailable'); assert.equal(audioStatus.code, 'AUDIO_NOT_PROVIDED');
  assert.equal(await player.locator('audio').count(), 0);
  const aiButton = page.getByRole('button', { name: 'Оценить через бесплатную модель', exact: true });
  await expect(aiButton).toBeDisabled();
  await expect(page.locator('.transcript .message')).toHaveCount(3);
  const toggle = page.locator('.manual-toggle');
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  const manual = page.getByRole('region', { name: 'Ручная локальная оценка', exact: true });
  await expect(manual.getByRole('combobox', { name: 'Ответ ручной оценки', exact: true })).toBeEnabled();
  assert.equal(await manual.getByRole('checkbox').first().isChecked(), false);
  await manual.getByRole('combobox', { name: 'Тип ручной записи', exact: true }).selectOption('agent_demo');
  await manual.getByRole('combobox', { name: 'Ответ ручной оценки', exact: true }).selectOption('YES');
  await expect(manual.getByRole('combobox', { name: 'Ответ ручной оценки', exact: true })).toHaveValue('YES');
  await expect(manual.getByRole('button', { name: 'Сохранить ручную оценку', exact: true })).toBeDisabled();
  await player.getByRole('button', { name: 'Повторить проверку записи', exact: true }).click();
  await expect(player.getByText('Ссылка на запись не предоставлена.', { exact: false })).toBeVisible();
  await expect(aiButton).toBeDisabled();
  assert.equal(store.listEvaluations().length, 0); assert.equal(store.listEvaluationAttempts().length, 0);
  assert.deepEqual(browserErrors, []); assert.deepEqual(forbiddenMutations, []);
  assert.equal(blockedBackendExternalRequests, 0); assert.deepEqual(blockedBrowserExternalRequests, []);
  mkdirSync('private/reports', { recursive: true });
  await page.locator('.transcript').evaluate(element => { element.scrollTop = 0; });
  await page.locator('.assessment').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: 'private/reports/missing-audio-fixture.png', fullPage: true });
  const report = {
    status: 'PASS', scenario: 'fabricated-voice-fixture-with-no-audio-url', actualApplication: true, responseMocks: false,
    isolatedInMemoryDatabase: true, mainDatabaseMutated: false, port: 3022,
    audioStatus: { state: audioStatus.state, code: audioStatus.code }, playbackVerified: false,
    unavailableCauseVerified: 'No audio URL supplied in this fabricated fixture.',
    transcriptMessagesVisible: 3, manualControlsEnabled: true, manualDraftControlChangedOnly: true,
    aiButtonDisabled: true, modelCallsMade: 0, humanAttestationsMade: 0, manualEvaluationsSaved: 0,
    forbiddenMutations, externalRequests: blockedBackendExternalRequests + blockedBrowserExternalRequests.length,
    sourceStatusResponses: sourceStatusResponses.length, browserErrors,
    screenshot: 'private/reports/missing-audio-fixture.png',
    limitation: 'This verifies the actual missing-source UI branch only. It is not evidence that any of the five real DEV recordings is unavailable.',
  };
  writeFileSync('private/reports/missing-audio-acceptance.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await app.close(); globalThis.fetch = nativeFetch; }
