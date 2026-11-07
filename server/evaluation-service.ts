import { randomUUID } from 'node:crypto';
import type { Evaluation, EvaluationAttempt } from '../src/domain.js';
import { calculateScore } from '../src/scoring.js';
import { config } from './config.js';
import { GeminiProvider, getProviderTelemetry } from './provider.js';
import type { Store } from './store.js';
import { isApprovedSyntheticConversation } from './importer.js';
import { EvaluationRunError, publicErrorCode } from './errors.js';
import { PermissionStore } from './data-permissions.js';
import { recoveryPolicy } from './recovery.js';

let inFlight = false;
const executorSessionId = randomUUID();
export async function evaluateAndSave(store: Store, conversationVersion: string, checklistVersion: string, options: { attemptId?: string; retryOf?: string; permissions?: PermissionStore } = {}): Promise<Evaluation> {
  const id = options.attemptId || randomUUID();
  const existing = store.getEvaluationAttempt(id);
  if (existing) {
    if (existing.conversationVersion !== conversationVersion || existing.checklistVersion !== checklistVersion || (existing.recoveryOf ?? null) !== (options.retryOf ?? null)) throw new Error('IDEMPOTENCY_CONFLICT');
    if (existing.status === 'succeeded' && existing.evaluationId) {
      const saved = store.getEvaluation(existing.evaluationId);
      if (saved) return saved;
    }
    throw new EvaluationRunError(existing.status === 'running' ? 'EVALUATION_BUSY' : existing.errorCode || 'REQUEST_FAILED', id);
  }
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
  let recoveryDepth = 0;
  if (options.retryOf) {
    const parent = store.getEvaluationAttempt(options.retryOf);
    if (!parent || parent.conversationVersion !== conversationVersion || parent.checklistVersion !== checklistVersion || parent.model !== config.model) throw new Error('RECOVERY_SOURCE_MISMATCH');
    if ((parent.recoveryDepth ?? 0) >= 1) throw new EvaluationRunError('RECOVERY_LIMIT_REACHED', parent.id);
    const child = store.getEvaluationRecovery(parent.id);
    if (child) throw new EvaluationRunError('RECOVERY_ALREADY_STARTED', child.id);
    if (!recoveryPolicy(store, parent).canRetry) throw new EvaluationRunError('RECOVERY_NOT_AVAILABLE', parent.id);
    recoveryDepth = 1;
  }
  inFlight = true;
  const started = Date.now();
  let attempt: EvaluationAttempt = { id, requestId: id, ...(options.retryOf ? { recoveryOf: options.retryOf } : {}), recoveryDepth, executorPid: process.pid, executorSessionId, conversationVersion, checklistVersion, model: config.model, startedAt: new Date(started).toISOString(), finishedAt: null, status: 'running', evaluationId: null, errorCode: null, latencyMs: null, usage: null };
  let registered = false;
  try {
    store.startEvaluationAttempt(attempt); registered = true;
    const result = await new GeminiProvider(config, undefined, telemetry => {
      attempt = { ...attempt, telemetry, latencyMs: telemetry.elapsedMs };
      store.updateRunningEvaluationAttempt(attempt);
    }).evaluate(conversation, checklist);
    const { telemetry, ...assessment } = result;
    const evaluation: Evaluation = { ...assessment, id: randomUUID(), attemptId: id, createdAt: new Date().toISOString(), conversationVersion, checklistVersion, provider: config.provider, model: config.model, mode: config.mode, status: 'live_validated', origin: 'ai', score: calculateScore(checklist, result.results) };
    store.saveEvaluationWithAttempt(evaluation, { ...attempt, telemetry, status: 'succeeded', finishedAt: new Date().toISOString(), evaluationId: evaluation.id, latencyMs: Date.now() - started, usage: evaluation.usage });
    return evaluation;
  } catch (error) {
    if (!registered) throw error;
    const code = publicErrorCode(error);
    const telemetry = getProviderTelemetry(error) || attempt.telemetry;
    const current = store.getEvaluationAttempt(id);
    if (current?.status === 'running') store.finishEvaluationAttempt({ ...attempt, ...(telemetry ? { telemetry } : {}), status: 'failed', finishedAt: new Date().toISOString(), errorCode: code, latencyMs: Date.now() - started, usage: telemetry ? { ...telemetry.reportedUsage } : null });
    throw new EvaluationRunError(code, id);
  } finally { inFlight = false; }
}
