/** Actual UI import acceptance. All local test content below is fabricated and synthetic. */
import { chromium, expect } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { config } from '../server/config.js';

const base = `http://127.0.0.1:${config.port}`;
const reportDirectory = resolve('private/reports');
mkdirSync(reportDirectory, { recursive: true });
const fixturePath = resolve(reportDirectory, 'import-fixture-synthetic.json');
const invalidJsonPath = resolve(reportDirectory, 'import-invalid-json.json');
const invalidSchemaPath = resolve(reportDirectory, 'import-invalid-schema.json');
const fixtureGroup = 'CQA_ACCEPTANCE_LOCAL';
const fixtureId = 'demo-newgroup-001';
const fixture = {
  error: '', isSuccess: true,
  data: {
    dataset_group_id: fixtureGroup, total_records: 1,
    records: [{
      conversation_id: fixtureId, channel: 'agent chat', language: 'RU',
      transcript: [
        { timestamp: '00:00', speaker: 'client', text: 'Это вымышленный диалог для технической проверки импорта.' },
        { timestamp: '00:01', speaker: 'operator', text: 'Здравствуйте! Я тестовый оператор. Это безопасный синтетический пример.' },
        { timestamp: '00:02', speaker: 'client', text: 'Спасибо. Проверяем только локальный импорт.' },
      ],
      audio_url: null,
      test_provenance: 'fabricated_by_agent_for_local_import_acceptance_only',
    }],
  },
};
writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
writeFileSync(invalidJsonPath, '{not valid JSON');
writeFileSync(invalidSchemaPath, JSON.stringify({ isSuccess: true, data: { dataset_group_id: fixtureGroup, records: [] } }));

const windowsChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: process.env.CQA_BROWSER_EXECUTABLE || (existsSync(windowsChrome) ? windowsChrome : undefined), headless: true });
const page = await browser.newPage({ viewport: { width: 1540, height: 1000 }, reducedMotion: 'reduce' });
const browserErrors: string[] = [];
const initiatedPosts: string[] = [];
const observedRequestUrls: string[] = [];
page.on('pageerror', error => browserErrors.push(error.message));
page.on('request', request => {
  observedRequestUrls.push(request.url());
  if (request.method() === 'POST') initiatedPosts.push(new URL(request.url()).pathname);
});
type ImportResult = { inserted: number; unchanged: number; total: number };
type Summary = { version: string; groupId: string; conversationId: string; classification: string };
const report: Record<string, unknown> = {
  status: 'RUNNING', networkMocks: false,
  fixture: { groupId: fixtureGroup, conversationId: fixtureId, classificationExpected: 'unknown', provenance: 'fabricated-synthetic-technical-fixture' },
  officialControlGroupImport: { status: 'NOT_TESTED', reason: 'Organizer control group ID is unavailable. Local generic-group acceptance is not an official control import.' },
};
let step = 'open-application';
try {
  await page.goto(base);
  await page.getByRole('heading', { name: 'Диалоги', exact: false }).waitFor();
  await expect(page.locator('.conversation').first()).toBeVisible();
  async function conversations(): Promise<Summary[]> {
    const response = await page.request.get(`${base}/api/conversations`);
    assert(response.ok());
    return response.json() as Promise<Summary[]>;
  }
  const before = await conversations();
  const beforeDevCount = before.filter(c => c.groupId === 'DEV').length;
  const devResults: Array<ImportResult | { error: string; httpStatus: number }> = [];
  await page.getByRole('textbox', { name: 'Группа импорта', exact: true }).fill('DEV');
  for (let index = 0; index < 2; index++) {
    step = `live-dev-get-${index + 1}`;
    const received = page.waitForResponse(response => response.url().endsWith('/api/import') && response.request().method() === 'POST', { timeout: 65000 });
    await page.getByRole('button', { name: 'Импорт GET', exact: true }).click();
    const response = await received;
    const body = await response.json();
    if (!response.ok()) devResults.push({ error: typeof body.error === 'string' ? body.error : 'IMPORT_FAILED', httpStatus: response.status() });
    else {
      devResults.push(body as ImportResult);
      await expect(page.locator('.global-message.success')).toContainText('Импорт DEV:');
    }
  }
  const devSucceeded = devResults.every(result => 'inserted' in result);
  if (devSucceeded) {
    const repeated = devResults[1] as ImportResult;
    assert.equal(repeated.inserted, 0);
    assert.equal(repeated.unchanged, repeated.total);
  }
  report.liveDevGet = { status: devSucceeded ? 'PASS' : 'FAIL', source: 'actual-organizer-GET-via-UI', beforeDevCount, attempts: devResults, repeatIdempotent: devSucceeded };

  step = 'select-existing-dev-source';
  await page.getByRole('searchbox', { name: 'Поиск диалога', exact: true }).fill('p1-ru-001');
  await page.locator('.conversation').filter({ hasText: 'p1-ru-001' }).first().click();
  await page.getByRole('heading', { name: 'p1-ru-001', exact: true }).waitFor();
  await expect(page.locator('.messages .message').first()).toBeVisible();
  const sourceMessages = await page.locator('.messages .message').count();
  assert(sourceMessages > 0);
  report.existingSourceInspection = { status: 'PASS', conversationId: 'p1-ru-001', renderedMessageCount: sourceMessages, sourceTextNotCopiedToReport: true };

  step = 'local-json-import';
  async function upload(path: string) {
    const received = page.waitForResponse(response => response.url().endsWith('/api/import-file') && response.request().method() === 'POST', { timeout: 30000 });
    await page.getByLabel('Файл локального импорта', { exact: true }).setInputFiles(path);
    return received;
  }
  const firstResponse = await upload(fixturePath);
  assert(firstResponse.ok());
  const firstImport = await firstResponse.json() as ImportResult;
  if (firstImport.inserted > 0 && !existsSync(resolve(reportDirectory, 'import-initial-creation.json'))) {
    writeFileSync(resolve(reportDirectory, 'import-initial-creation.json'), JSON.stringify({
      status: 'PASS', source: 'actual-browser-import-response', groupId: fixtureGroup,
      conversationId: fixtureId, firstImport,
    }, null, 2));
  }
  await expect(page.locator('.global-message.success')).toContainText('Локальный JSON:');
  await expect(page.locator('.global-message.success')).toContainText('Это не проверка доступности GET API.');
  const afterFirst = await conversations();
  const imported = afterFirst.filter(c => c.groupId === fixtureGroup);
  assert.equal(imported.length, 1);
  assert.equal(imported[0].conversationId, fixtureId);
  assert.equal(imported[0].classification, 'unknown');
  const firstVersion = imported[0].version;

  step = 'select-new-generic-group';
  await page.getByRole('searchbox', { name: 'Поиск диалога', exact: true }).fill('');
  await page.locator('.extra-filters > summary').click();
  await page.getByRole('combobox', { name: 'Фильтр по группе', exact: true }).selectOption(fixtureGroup);
  await expect(page.locator('.conversation')).toHaveCount(1);
  await page.locator('.conversation').first().click();
  await page.getByRole('heading', { name: fixtureId, exact: true }).waitFor();
  await expect(page.getByRole('button', { name: 'Оценить через бесплатную модель', exact: true })).toBeDisabled();
  await expect(page.locator('.compact-notice').filter({ hasText: 'Передача этого разговора в бесплатный Gemini запрещена' })).toBeVisible();
  const sourceResponse = await page.request.get(`${base}/api/conversations/${encodeURIComponent(firstVersion)}`);
  assert(sourceResponse.ok());
  const source = await sourceResponse.json();
  assert.equal(source.classification, 'unknown');
  assert.deepEqual(source.messages.map((m: { timestamp: string; speaker: string; text: string }) => ({ timestamp: m.timestamp, speaker: m.speaker, text: m.text })), fixture.data.records[0].transcript);

  step = 'repeat-local-json-import';
  const secondResponse = await upload(fixturePath);
  assert(secondResponse.ok());
  const repeatedImport = await secondResponse.json() as ImportResult;
  assert.equal(repeatedImport.inserted, 0);
  assert.equal(repeatedImport.unchanged, 1);
  const afterRepeated = (await conversations()).filter(c => c.groupId === fixtureGroup);
  assert.equal(afterRepeated.length, 1);
  assert.equal(afterRepeated[0].version, firstVersion);
  report.genericGroupUiImport = { status: 'PASS', source: 'local-json-via-existing-interface', firstImport, repeatedImport, visibleFilteredRecords: 1, versionUnchangedOnRepeat: true, originalFieldsPreserved: true, permissionClassification: source.classification, aiButtonDisabled: true };

  step = 'malformed-json-file';
  const importsBeforeMalformed = initiatedPosts.filter(path => path === '/api/import-file').length;
  await page.getByLabel('Файл локального импорта', { exact: true }).setInputFiles(invalidJsonPath);
  await expect(page.getByRole('alert')).toContainText('Файл не содержит корректный JSON организатора.');
  assert.equal(initiatedPosts.filter(path => path === '/api/import-file').length, importsBeforeMalformed);
  report.malformedJson = { status: 'PASS', errorVisible: true, rejectedBeforeServerMutation: true };

  step = 'invalid-organizer-envelope';
  const invalidResponse = await upload(invalidSchemaPath);
  assert(!invalidResponse.ok());
  await expect(page.getByRole('alert')).toBeVisible();
  const afterInvalid = (await conversations()).filter(c => c.groupId === fixtureGroup);
  assert.deepEqual(afterInvalid, afterRepeated);
  report.invalidSchema = { status: 'PASS', httpStatus: invalidResponse.status(), errorVisible: true, importedVersionsUnchanged: true };
  const forbiddenPosts = initiatedPosts.filter(path => path === '/api/evaluations' || path === '/api/manual-evaluations' || path.startsWith('/api/quality/references'));
  assert.deepEqual(forbiddenPosts, []);
  assert.deepEqual(browserErrors, []);
  assert(observedRequestUrls.every(url => ['127.0.0.1', 'localhost'].includes(new URL(url).hostname)));
  const visibleText = await page.locator('body').innerText();
  const observedData = JSON.stringify({ devResults, source, firstImport, repeatedImport });
  for (const secret of [config.apiKey, config.organizerUrl].filter((value): value is string => Boolean(value))) {
    assert(!visibleText.includes(secret));
    assert(!observedData.includes(secret));
    assert(!observedRequestUrls.some(url => url.includes(secret)));
  }
  await page.screenshot({ path: resolve(reportDirectory, 'import-acceptance-synthetic.png'), fullPage: false });
  report.status = devSucceeded ? 'PASS' : 'PARTIAL';
  if (!devSucceeded) process.exitCode = 1;
  report.safety = { aiRequestsInitiated: 0, manualAssessmentsSaved: 0, humanAttestationsSubmitted: 0, realCallContentInFixture: false, signedUrlsExposed: false, externalBrowserRequests: 0, knownSecretsAbsentFromScreenAndImportResponses: true };
  report.browserErrors = browserErrors;
  report.screenshot = 'private/reports/import-acceptance-synthetic.png';
} catch {
  report.status = 'FAIL'; report.failedStep = step; report.error = 'BROWSER_IMPORT_ACCEPTANCE_FAILED';
  report.browserErrors = browserErrors;
  process.exitCode = 1;
} finally {
  writeFileSync(resolve(reportDirectory, 'import-acceptance.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
