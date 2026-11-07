/** Reprocess an actual saved provider response after a validator fix. Never synthesizes answers. */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { config } from '../server/config.js';
import { Store } from '../server/store.js';
import { isApprovedSyntheticConversation } from '../server/importer.js';
import { validateEvidence } from '../server/evidence.js';
import { minimizeConversation } from '../server/provider.js';
import { calculateScore } from '../src/scoring.js';
import type { Evaluation } from '../src/domain.js';

const store = new Store(config.dbPath);
try {
  const files = readdirSync('private/provider-attempts').filter(f => f.endsWith('.json')).sort();
  const path = `private/provider-attempts/${files.at(-1)}`;
  const diagnostic = JSON.parse(readFileSync(path, 'utf8'));
  if (!diagnostic.raw || diagnostic.status !== 'validation-rejected') throw new Error('NO_REVALIDATABLE_RESPONSE');
  const conversation = store.listConversations('DEV').find(c => c.conversationId === 'p1-ru-001');
  const checklist = store.getChecklist(diagnostic.checklistVersion);
  if (!conversation || !checklist || !isApprovedSyntheticConversation(conversation)) throw new Error('SOURCE_NOT_FOUND');
  const minimized = minimizeConversation(conversation);
  const results = validateEvidence(conversation, checklist, { results: minimized.restore(validateEvidence(minimized.conversation, checklist, diagnostic.raw)) });
  const evaluation: Evaluation = {
    id: randomUUID(), createdAt: new Date().toISOString(), conversationVersion: conversation.version,
    checklistVersion: checklist.version, provider: 'gemini', model: diagnostic.model, mode: 'free', status: 'live_validated',
    results, score: calculateScore(checklist, results), usage: diagnostic.usage,
    latencyMs: diagnostic.latencyMs, providerCallCount: diagnostic.providerCallCount,
    configuration: { revalidatedSavedActualResponse: true, originalRequestAt: diagnostic.createdAt, originalDiagnostic: files.at(-1), validatorFix: 'official-NA-support-contract', api: 'generateContent', policy: 'synthetic-only', promptVersion: 'evidence-first-v2' },
  };
  store.saveEvaluation(evaluation);
  diagnostic.status = 'live-validated-after-validator-fix';
  diagnostic.savedEvaluationId = evaluation.id;
  writeFileSync(path, JSON.stringify(diagnostic, null, 2));
  writeFileSync(`private/reports/evaluation-${evaluation.id}.json`, JSON.stringify(evaluation, null, 2));
  if (!existsSync('private/reports/first-evaluation.json')) writeFileSync('private/reports/first-evaluation.json', JSON.stringify(evaluation, null, 2));
  console.log(JSON.stringify({ status: evaluation.status, evaluationId: evaluation.id, model: evaluation.model,
    total: evaluation.score.total, applicableWeight: evaluation.score.applicableWeight,
    answers: results.map(r => ({ criterionId: r.criterionId, answer: r.answer })),
    usage: evaluation.usage, originalLatencyMs: evaluation.latencyMs,
    note: 'Actual saved provider response revalidated without modifying model answers or making another request.' }, null, 2));
} finally { store.close(); }
