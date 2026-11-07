import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { config } from '../server/config.js';
import { Store } from '../server/store.js';
import { initialChecklist } from '../src/checklist.js';
import { evaluateAndSave } from '../server/evaluation-service.js';
import { publicErrorCode } from '../server/errors.js';
import { EvidenceValidationError } from '../server/evidence.js';

const store = new Store(config.dbPath);
try {
  store.saveChecklist(initialChecklist);
  const id = process.argv[2] || 'p1-ru-001';
  const checklistIndex = process.argv.indexOf('--checklist');
  const checklistVersion = checklistIndex >= 0 ? process.argv[checklistIndex + 1] : initialChecklist.version;
  const conversation = store.listConversations('DEV').find(c => c.conversationId === id);
  if (!conversation) throw new Error('CONVERSATION_NOT_IMPORTED');
  const evaluation = await evaluateAndSave(store, conversation.version, checklistVersion);
  mkdirSync('private/reports', { recursive: true });
  writeFileSync(`private/reports/evaluation-${evaluation.id}.json`, JSON.stringify(evaluation, null, 2));
  if (!existsSync('private/reports/first-evaluation.json')) writeFileSync('private/reports/first-evaluation.json', JSON.stringify(evaluation, null, 2));
  console.log(JSON.stringify({ status: evaluation.status, id: evaluation.id, conversationId: id, model: evaluation.model, total: evaluation.score.total, applicableWeight: evaluation.score.applicableWeight, flags: evaluation.score.flags, answers: evaluation.results.map(r => ({ criterionId: r.criterionId, answer: r.answer, evidenceCount: r.evidence.length, reviewRequired: r.reviewRequired })), usage: evaluation.usage, latencyMs: evaluation.latencyMs, providerCallCount: evaluation.providerCallCount }, null, 2));
} catch (error) {
  // Only controlled error codes; raw SDK/network errors can contain credentials.
  const code = publicErrorCode(error);
  console.error(JSON.stringify({ status: 'error', code, reason: error instanceof EvidenceValidationError ? error.message : undefined, savedEvaluation: false }));
  process.exitCode = 1;
} finally { store.close(); }
