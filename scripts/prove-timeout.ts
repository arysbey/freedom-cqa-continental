/** One actual Gemini request through an isolated local UI with a one-second timeout. No mocks. */
import { chromium, expect } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseEnv } from 'dotenv';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { parseOrganizerResponse, isApprovedSyntheticConversation } from '../server/importer.js';
import { initialChecklist } from '../src/checklist.js';
import type { EvaluationAttempt } from '../src/domain.js';

const envFile = existsSync('.env') ? parseEnv(readFileSync('.env')) : {};
const mainPath = resolve(process.env.CQA_DB_PATH || envFile.CQA_DB_PATH || 'private/cqa.sqlite');
const main = new Store(mainPath);
const mainCounts = { evaluations: main.listEvaluations().length, attempts: main.listEvaluationAttempts().length };
const source = main.listConversations('DEV').find(c => c.conversationId === 'p1-ru-001');
assert(source && isApprovedSyntheticConversation(source));
const original = main.getOriginal(source.version);
main.close();
mkdirSync('private/acceptance', { recursive: true });
const isolatedPath = resolve(`private/acceptance/timeout-${randomUUID()}.sqlite`);
process.env.CQA_DB_PATH = isolatedPath;
process.env.CQA_TIMEOUT_MS = '1000';
process.env.CQA_RETRY_LIMIT = '0';
process.env.PORT = '3021';
const { config } = await import('../server/config.js');
assert.equal(config.model, 'gemini-3.1-flash-lite');
assert.equal(config.mode, 'free');
assert.equal(config.freeTierConfirmed, true);
assert.equal(config.timeoutMs, 1000);
const { createApp } = await import('../server/app.js');
const { ReviewStore } = await import('../server/reviews.js');
const { QualityStore } = await import('../server/quality.js');
const store = new Store(isolatedPath);
store.importDataset(parseOrganizerResponse({ error: '', isSuccess: true, data: { dataset_group_id: 'DEV', total_records: 1, records: [original] } }, 'DEV'));
store.saveChecklist(initialChecklist);
const diagnosticFilesBefore = new Set(existsSync('private/provider-attempts') ? readdirSync('private/provider-attempts') : []);
let app: FastifyInstance | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let phase = 'isolated-server';
try {
  app = await createApp(store, new ReviewStore(isolatedPath), new QualityStore(isolatedPath));
  await app.listen({ host: '127.0.0.1', port: 3021 });
  const windowsChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  browser = await chromium.launch({ executablePath: process.env.CQA_BROWSER_EXECUTABLE || (existsSync(windowsChrome) ? windowsChrome : undefined), headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, reducedMotion: 'reduce' });
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto('http://127.0.0.1:3021');
  await page.getByRole('heading', { name: 'p1-ru-001', exact: true }).waitFor();
  phase = 'actual-gemini-ui-request';
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/evaluations') && response.request().method() === 'POST', { timeout: 20000 });
  await page.getByRole('button', { name: 'Оценить через бесплатную модель', exact: true }).click();
  const response = await responsePromise;
  const body = await response.json() as { error?: string };
  assert(!response.ok(), 'The bounded error scenario unexpectedly returned success.');
  const observed = body.error;
  assert(observed === 'PROVIDER_TIMEOUT' || observed === 'PROVIDER_RATE_LIMIT' || observed === 'PROVIDER_FAILED', 'Unexpected safe error code.');
  if (observed === 'PROVIDER_TIMEOUT') await expect(page.getByRole('alert')).toContainText('Модель не ответила вовремя');
  if (observed === 'PROVIDER_RATE_LIMIT') await expect(page.getByRole('alert')).toContainText('Бесплатная квота');
  await expect(page.getByRole('heading', { name: 'Оценки пока нет', exact: true })).toBeVisible();
  const saved = await (await page.request.get('http://127.0.0.1:3021/api/evaluations')).json();
  const attempts = await (await page.request.get('http://127.0.0.1:3021/api/evaluation-attempts')).json() as EvaluationAttempt[];
  assert.equal(saved.length, 0); assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, 'failed'); assert.equal(attempts[0].errorCode, observed); assert.equal(attempts[0].usage, null);
  assert.equal(browserErrors.length, 0);
  await page.screenshot({ path: 'private/reports/provider-timeout-ui.png', fullPage: true });
  const diagnosticFilesAfter = readdirSync('private/provider-attempts').filter(file => !diagnosticFilesBefore.has(file) && file.endsWith('.json'));
  const diagnostics = diagnosticFilesAfter.map(file => {
    const value = JSON.parse(readFileSync(`private/provider-attempts/${file}`, 'utf8'));
    return { status: value.status, providerCallCount: value.providerCallCount, latencyMs: value.latencyMs, usage: value.usage, failure: value.failure ?? null };
  });
  assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0].providerCallCount, 1);
  const reopenedMain = new Store(mainPath);
  const afterMainCounts = { evaluations: reopenedMain.listEvaluations().length, attempts: reopenedMain.listEvaluationAttempts().length };
  reopenedMain.close();
  assert.deepEqual(afterMainCounts, mainCounts);
  const report = {
    status: observed === 'PROVIDER_TIMEOUT' ? 'PASS' : 'OBSERVED_DIFFERENT_PROVIDER_ERROR',
    test: 'actual-isolated-browser-provider-timeout', networkMocks: false, isolatedPort: 3021,
    model: config.model, mode: config.mode, timeoutMs: config.timeoutMs, retryLimit: config.retryLimit,
    observedError: observed, httpStatus: response.status(), savedEvaluations: saved.length,
    failedLedgerAttempts: attempts.length, fakeScoreFallback: false, usageKnown: false,
    mainDatabaseUnchanged: true, diagnostics, browserErrorCount: browserErrors.length,
    note: observed === 'PROVIDER_RATE_LIMIT' ? 'Quota exhaustion was observed, not induced.' : observed === 'PROVIDER_FAILED' ? 'A network/provider failure happened before the intended timeout; timeout remains unproved in this run.' : 'Actual request aborted at the configured timeout; no assessment was fabricated.',
  };
  writeFileSync('private/reports/provider-timeout-acceptance.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch {
  console.error(JSON.stringify({ status: 'FAIL', phase, savedReport: false, mainDatabasePathPrinted: false }));
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (app) await app.close(); else store.close();
}
