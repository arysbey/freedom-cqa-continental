import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { config } from '../server/config.js';
import { Store } from '../server/store.js';
import { QualityStore } from '../server/quality.js';
import { evaluateAndSave } from '../server/evaluation-service.js';
import { publicErrorCode } from '../server/errors.js';

const valueAfter = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const store = new Store(config.dbPath);
const quality = new QualityStore(config.dbPath);
try {
  const manifest = quality.getManifest(valueAfter('--manifest'));
  if (!manifest) throw new Error('VALIDATION_MANIFEST_MISSING');
  if (config.model !== manifest.model || config.model !== 'gemini-3.1-flash-lite') throw new Error('MODEL_CHANGE_REQUIRES_USER_APPROVAL');
  const split = valueAfter('--split');
  if (split && !['development', 'holdout'].includes(split)) throw new Error('INVALID_VALIDATION_SPLIT');
  const caseId = valueAfter('--case');
  if (process.argv.includes('--case') && (!caseId || !manifest.cases.some(item => item.id === caseId))) throw new Error('VALIDATION_CASE_NOT_FOUND');
  if (caseId && split && !manifest.cases.some(item => item.id === caseId && item.split === split)) throw new Error('VALIDATION_CASE_SPLIT_MISMATCH');
  const limit = Number(valueAfter('--limit') || manifest.cases.length);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_VALIDATION_LIMIT');
  const allowUnreviewed = process.argv.includes('--allow-unreviewed');
  const rerun = process.argv.includes('--rerun');
  const selected = manifest.cases.filter(item => (!caseId || item.id === caseId) && (!split || item.split === split) && (allowUnreviewed || quality.getReference(manifest.id, item.id)?.judgments.some(j => j.resolved)) && (rerun || !quality.listRuns(manifest.id).some(r => r.caseId === item.id && r.status === 'success'))).slice(0, limit);
  if (!selected.length) {
    console.log(JSON.stringify({ status: 'BLOCKED', code: 'HUMAN_REFERENCE_REQUIRED_OR_ALREADY_EVALUATED', noCallsMade: true, manifestId: manifest.id, note: 'Default runner requires declared human references. --allow-unreviewed records an explicitly technical baseline, never invents a reference or accuracy.' }));
    process.exitCode = 2;
  } else if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({ status: 'DRY_RUN', noCallsMade: true, manifestId: manifest.id, model: config.model, allowUnreviewed, cases: selected.map(c => ({ caseId: c.id, split: c.split, language: c.language, humanReferenceSaved: Boolean(quality.getReference(manifest.id, c.id)) })) }, null, 2));
  } else {
    mkdirSync('private/validation', { recursive: true });
    for (const item of selected) {
      const attemptId = randomUUID();
      const started = Date.now();
      try {
        const evaluation = await evaluateAndSave(store, item.conversationVersion, item.checklistVersion, { attemptId });
        quality.recordRun(manifest.id, { id: attemptId, caseId: item.id, status: 'success', evaluationId: evaluation.id, createdAt: new Date().toISOString(), model: evaluation.model, latencyMs: evaluation.latencyMs, providerCallCount: evaluation.providerCallCount, usage: evaluation.usage }, store);
        console.log(JSON.stringify({ caseId: item.id, language: item.language, split: item.split, status: 'success', evaluationId: evaluation.id, latencyMs: evaluation.latencyMs, providerCallCount: evaluation.providerCallCount, reportedTokens: evaluation.usage.totalTokens, humanReferenceSaved: Boolean(quality.getReference(manifest.id, item.id)) }));
      } catch (error) {
        const code = publicErrorCode(error);
        const ledger = store.listEvaluationAttempts().find(a => a.id === attemptId);
        quality.recordRun(manifest.id, { id: attemptId, caseId: item.id, status: 'failed', errorCode: code, createdAt: new Date().toISOString(), model: config.model, latencyMs: ledger?.latencyMs ?? Date.now() - started, providerCallCount: null, usage: ledger?.usage ?? { totalTokens: null } });
        console.log(JSON.stringify({ caseId: item.id, language: item.language, split: item.split, status: 'failed', code, latencyMs: ledger?.latencyMs ?? Date.now() - started, noEvaluationSaved: true }));
        if (['PROVIDER_RATE_LIMIT', 'MISSING_API_KEY', 'FREE_TIER_UNCONFIRMED', 'MODEL_UNAVAILABLE'].includes(code)) break;
      }
      writeFileSync(`private/validation/${manifest.id}-metrics.json`, JSON.stringify(quality.getDashboard(store, manifest.id), null, 2));
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const dashboard = quality.getDashboard(store, manifest.id);
    writeFileSync(`private/validation/${manifest.id}-metrics.json`, JSON.stringify(dashboard, null, 2));
    console.log(JSON.stringify({ manifestId: manifest.id, humanReviewedCases: dashboard.metrics?.humanReviewedCases ?? 0, reliability: dashboard.metrics?.reliability, agreementByCriterion: dashboard.metrics?.byCriterion, agreementByLanguage: dashboard.metrics?.byLanguage, note: dashboard.metrics?.note }, null, 2));
  }
} finally { quality.close(); store.close(); }
