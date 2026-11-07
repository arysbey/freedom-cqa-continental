import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { config } from '../server/config.js';

const windowsChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: process.env.CQA_BROWSER_EXECUTABLE || (existsSync(windowsChrome) ? windowsChrome : undefined), headless: true });
const base = `http://127.0.0.1:${config.port}`;
const page = await browser.newPage({ viewport: { width: 1540, height: 1000 }, reducedMotion: 'reduce' });
const errors: string[] = [];
page.on('pageerror', e => errors.push(e.message));
mkdirSync('private/reports', { recursive: true });
try {
  await page.goto(`${base}/?designs`);
  await page.getByRole('heading', { name: 'Один разговор. Три способа проверить.' }).waitFor();
  await page.screenshot({ path: 'private/reports/design-options.png', fullPage: true });
  await page.goto(base);
  await page.getByRole('heading', { name: 'p1-ru-001', exact: true }).waitFor();
  const conversations = await (await page.request.get(`${base}/api/conversations`)).json();
  assert.equal(await page.locator('.conversation').count(), conversations.length);
  const evaluationCount = (await (await page.request.get(`${base}/api/status`)).json()).liveEvaluationCount;
  if (evaluationCount) {
    await page.locator('.assessment > .panel-heading .badge').filter({ hasText: 'Реальный API' }).waitFor();
    await page.locator('.criterion').first().click();
    await page.locator('.evidence-link').first().click();
    assert(await page.locator('.message:focus').count() > 0);
  }
  await page.locator('.transcript').evaluate(e => { e.scrollTop = 0; });
  await page.locator('.assessment').evaluate(e => { e.scrollTop = 0; });
  await page.evaluate(() => { window.scrollTo(0, 0); });
  await page.screenshot({ path: 'private/reports/workspace-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'private/reports/workspace-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.deepEqual(errors, []);
  const report = { status: 'PASS', source: 'actual-local-backend-no-network-mocks', conversations: conversations.length, devRecords: conversations.filter((c: { groupId: string }) => c.groupId === 'DEV').length, savedLiveEvaluations: evaluationCount, browserErrors: errors, screenshots: ['design-options.png', 'workspace-desktop.png', 'workspace-mobile.png'] };
  writeFileSync('private/reports/browser-smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
