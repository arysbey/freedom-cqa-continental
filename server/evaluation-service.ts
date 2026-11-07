import { randomUUID } from 'node:crypto';
import type { Evaluation, EvaluationAttempt } from '../src/domain.js';
import { calculateScore } from '../src/scoring.js';
import { config } from './config.js';
import { GeminiProvider } from './provider.js';
import type { Store } from './store.js';
import { isApprovedSyntheticConversation } from './importer.js';
import { publicErrorCode } from './errors.js';
import { PermissionStore } from './data-permissions.js';

let inFlight = false;
export async function evaluateAndSave(store: Store, conversationVersion: string, checklistVersion: string, options: { attemptId?: string; permissions?: PermissionStore } = {}): Promise<Evaluation> {
  if (inFlight) throw new Error('EVALUATION_BUSY');
  let conversation = store.getConversation(conversationVersion);
  const checklist = store.getChecklist(checklistVersion);
  if (!conversation || !checklist) throw new Error('SOURCE_NOT_FOUND');
  if (!isApprovedSyntheticConversation(conversation)) {
    if (conversation.classification !== 'unknown' || conversation.channel !== 'agent chat' || conversation.audioAvailable) throw new Error('DATA_POLICY_RESTRICTED');
    const permissions = options.permissions || new PermissionStore(store.path);
    try { conversation = permissions.resolve(conversation); }
    finally { if (!options.permissions) permissions.close(); }
    if (conversation.classification !== 'synthetic_allowed') throw new Error('DATA_POLICY_RESTRICTED');
  }
  inFlight = true;
  const started = Date.now();
  const attempt: EvaluationAttempt = { id: options.attemptId || randomUUID(), conversationVersion, checklistVersion, model: config.model, startedAt: new Date(started).toISOString(), finishedAt: null, status: 'running', evaluationId: null, errorCode: null, latencyMs: null, usage: null };
  try {
    store.startEvaluationAttempt(attempt);
    const result = await new GeminiProvider(config).evaluate(conversation, checklist);
    const evaluation: Evaluation = {
      ...result,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      conversationVersion,
      checklistVersion,
      provider: config.provider,
      model: config.model,
      mode: config.mode,
      status: 'live_validated',
      origin: 'ai',
      score: calculateScore(checklist, result.results),
    };
    store.saveEvaluation(evaluation);
    store.finishEvaluationAttempt({ ...attempt, status: 'succeeded', finishedAt: new Date().toISOString(), evaluationId: evaluation.id, latencyMs: Date.now() - started, usage: evaluation.usage });
    return evaluation;
  } catch (error) {
    const current = store.listEvaluationAttempts().find(a => a.id === attempt.id);
    if (current?.status === 'running') store.finishEvaluationAttempt({ ...attempt, status: 'failed', finishedAt: new Date().toISOString(), errorCode: publicErrorCode(error), latencyMs: Date.now() - started });
    throw error;
  } finally { inFlight = false; }
}
