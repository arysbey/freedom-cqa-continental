import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Conversation, Evaluation, EvaluationAttempt } from '../src/domain.js';
import { initialChecklist } from '../src/checklist.js';
import { calculateScore } from '../src/scoring.js';
import { config } from './config.js';
import { canonicalJson, isApprovedSyntheticConversation } from './importer.js';
import { validateEvidence } from './evidence.js';
import { evaluateAndSave } from './evaluation-service.js';
import { publicErrorCode } from './errors.js';
import { PermissionStore } from './data-permissions.js';
import { getProviderConfigurationIdentity } from './provider.js';
import { probeExecutorPid, type ExecutorState } from './interrupted-attempts.js';
import type { Store } from './store.js';

export interface BatchRun {
  requestId: string; retryOf?: string; status: 'running' | 'succeeded' | 'failed'; startedAt: string; finishedAt: string | null;
  errorCode: string | null; providerCallCount: number | null; usage: Record<string, number | null> | null; latencyMs: number | null;
}
export interface BatchRecord {
  conversationId: string; conversationVersion: string; status: 'pending' | 'running' | 'retry_wait' | 'succeeded' | 'reused' | 'blocked' | 'error';
  evaluationId: string | null; errorCode: string | null; runs: BatchRun[]; retryAt: string | null;
}
export interface GroupBatch {
  id: string; groupId: string; model: string; configurationFingerprint: string; checklistVersion: string; checklistFingerprint: string; createdAt: string;
  minSpacingMs: number; runBudgetMs: number; revision: number; updatedAt: string;
  status: 'ready' | 'running' | 'paused' | 'completed' | 'cancelled'; control: 'run' | 'pause' | 'cancel'; reason: string | null;
  allowInterruptedRecovery: boolean; retryQuota: boolean; records: BatchRecord[];
  executorPid?: number; executorSessionId?: string;
}
const sha = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const identity = (batch: GroupBatch) => ({ id: batch.id, groupId: batch.groupId, model: batch.model, configurationFingerprint: batch.configurationFingerprint, checklistVersion: batch.checklistVersion, checklistFingerprint: batch.checklistFingerprint, createdAt: batch.createdAt, minSpacingMs: batch.minSpacingMs, runBudgetMs: batch.runBudgetMs, sources: batch.records.map(r => [r.conversationId, r.conversationVersion]) });
export const officialChecklistFingerprint = sha(initialChecklist);
export function batchRequestId(batch: Pick<GroupBatch, 'id' | 'checklistVersion'>, conversationVersion: string, generation: number) { return 'batch_' + sha([batch.id, conversationVersion, batch.checklistVersion, generation]).slice(0, 56); }

/** Constructor migrations must run only after the application's database backup. */
export class BatchStore {
  private readonly db: DatabaseSync;
  constructor(path: string, options: { readOnly?: boolean } = {}) {
    this.db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    if (options.readOnly) return;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS official_batches(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS official_batch_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,batch_id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,UNIQUE(batch_id,revision));`);
    for (const table of ['official_batches', 'official_batch_events']) for (const op of ['UPDATE', 'DELETE']) this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${op.toLowerCase()}_blocked BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT,'Official batch history is append-only'); END;`);
  }
  get(id: string): GroupBatch | undefined {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='official_batch_events'").get()) return undefined;
    const row = this.db.prepare('SELECT json FROM official_batch_events WHERE batch_id=? ORDER BY revision DESC LIMIT 1').get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as GroupBatch : undefined;
  }
  list(): GroupBatch[] {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='official_batches'").get()) return [];
    return (this.db.prepare('SELECT id FROM official_batches ORDER BY rowid DESC').all() as Array<{ id: string }>).map(row => this.get(row.id)!);
  }
  create(batch: GroupBatch): GroupBatch {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('INSERT INTO official_batches(id,json) VALUES(?,?)').run(batch.id, canonicalJson(identity(batch))); this.db.prepare('INSERT INTO official_batch_events(batch_id,revision,json) VALUES(?,?,?)').run(batch.id, 0, canonicalJson(batch)); this.db.exec('COMMIT'); return batch; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  save(batch: GroupBatch): GroupBatch {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.get(batch.id); if (!previous || previous.revision !== batch.revision) throw new Error('BATCH_REVISION_CONFLICT');
      if (canonicalJson(identity(previous)) !== canonicalJson(identity(batch))) throw new Error('IMMUTABLE_BATCH_SOURCE');
      if (batch.records.some(r => r.runs.length > 2 || r.runs.some((run, index) => run.requestId !== batchRequestId(batch, r.conversationVersion, index)))) throw new Error('INVALID_BATCH_REQUEST_CHAIN');
      const next = { ...batch, revision: batch.revision + 1, updatedAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO official_batch_events(batch_id,revision,json) VALUES(?,?,?)').run(next.id, next.revision, canonicalJson(next)); this.db.exec('COMMIT'); return next;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  pause(id: string) { const batch = this.required(id); return this.save({ ...batch, status: 'paused', control: 'pause', reason: 'USER_PAUSED_AFTER_CURRENT_REQUEST' }); }
  cancel(id: string) { const batch = this.required(id); return this.save({ ...batch, status: 'cancelled', control: 'cancel', reason: 'USER_CANCELLED_AFTER_CURRENT_REQUEST' }); }
  resume(id: string, options: { allowInterruptedRecovery?: boolean; retryQuota?: boolean } = {}) {
    const batch = this.required(id); if (batch.status === 'cancelled') throw new Error('BATCH_CANCELLED');
    return this.save({ ...batch, status: 'ready', control: 'run', reason: null, allowInterruptedRecovery: options.allowInterruptedRecovery ?? false, retryQuota: options.retryQuota ?? false });
  }
  required(id: string) { const batch = this.get(id); if (!batch) throw new Error('BATCH_NOT_FOUND'); return batch; }
  close() { this.db.close(); }
}

export function isValidOfficialEvaluation(store: Store, conversation: Conversation, evaluation: Evaluation, model = config.model): boolean {
  const checklist = store.getChecklist(evaluation.checklistVersion);
  if (!checklist || evaluation.conversationVersion !== conversation.version || evaluation.checklistVersion !== initialChecklist.version || canonicalJson(checklist) !== canonicalJson(initialChecklist)) return false;
  const ai = conversation.classification !== 'real_restricted' && conversation.channel === 'agent chat' && !conversation.audioAvailable && evaluation.status === 'live_validated' && evaluation.origin === 'ai' && evaluation.provider === 'gemini' && evaluation.mode === 'free' && evaluation.model === model;
  const human = evaluation.status === 'human_entered' && evaluation.origin === 'human' && evaluation.provider === 'local' && evaluation.mode === 'local' && evaluation.model === 'none' && !!evaluation.reviewer?.trim() && evaluation.configuration.humanAttestation === true;
  if (!ai && !human) return false;
  try { validateEvidence(conversation, initialChecklist, { results: evaluation.results }); return canonicalJson(calculateScore(initialChecklist, evaluation.results)) === canonicalJson(evaluation.score); } catch { return false; }
}
export function findValidOfficialEvaluation(store: Store, conversation: Conversation, model = config.model) { return store.listEvaluations().toReversed().find(e => isValidOfficialEvaluation(store, conversation, e, model)); }
export function createGroupBatch(store: Store, batches: BatchStore, options: { groupId: string; id?: string; minSpacingMs?: number; runBudgetMs?: number }): GroupBatch {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.groupId)) throw new Error('INVALID_GROUP_ID');
  const minSpacingMs = options.minSpacingMs ?? 12000; const runBudgetMs = options.runBudgetMs ?? 45 * 60000;
  if (!Number.isInteger(minSpacingMs) || minSpacingMs < 0 || minSpacingMs > 600000 || !Number.isInteger(runBudgetMs) || runBudgetMs < 1000 || runBudgetMs > 7200000) throw new Error('INVALID_BATCH_BUDGET');
  const id = options.id || randomUUID(); if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error('INVALID_BATCH_ID');
  const existing = batches.get(id); if (existing) { if (existing.groupId !== options.groupId || existing.minSpacingMs !== minSpacingMs || existing.runBudgetMs !== runBudgetMs) throw new Error('BATCH_IDEMPOTENCY_CONFLICT'); return existing; }
  if (canonicalJson(store.getChecklist(initialChecklist.version)) !== canonicalJson(initialChecklist)) throw new Error('OFFICIAL_CHECKLIST_SNAPSHOT_REQUIRED');
  const conversations = store.listConversations(options.groupId); if (!conversations.length) throw new Error('GROUP_NOT_IMPORTED');
  const timestamp = new Date().toISOString();
  return batches.create({ id, groupId: options.groupId, model: config.model, configurationFingerprint: getProviderConfigurationIdentity(config).configurationFingerprint, checklistVersion: initialChecklist.version, checklistFingerprint: officialChecklistFingerprint, createdAt: timestamp, minSpacingMs, runBudgetMs, revision: 0, updatedAt: timestamp, status: 'ready', control: 'run', reason: null, allowInterruptedRecovery: false, retryQuota: false,
    records: conversations.map(c => ({ conversationId: c.conversationId, conversationVersion: c.version, status: 'pending', evaluationId: null, errorCode: null, runs: [], retryAt: null })) });
}
const transientCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
function recoverableTransport(attempt: EvaluationAttempt | undefined) {
  const failure = attempt?.telemetry?.attempts.at(-1)?.failure;
  return attempt?.errorCode === 'PROVIDER_FAILED' && !!failure && (failure.httpStatus === 503 || failure.httpStatus === null && [failure.errorCode, failure.causeCode].some(c => typeof c === 'string' && transientCodes.has(c)));
}
const stopCodes = new Set(['PROVIDER_RATE_LIMIT', 'MISSING_API_KEY', 'FREE_TIER_UNCONFIRMED', 'MODEL_UNAVAILABLE', 'MODEL_NOT_FREE_APPROVED', 'PROVIDER_TIMEOUT', 'EVALUATION_BUSY']);
const executing = new Set<string>();
const executorSessionId = randomUUID();
/** Batch ownership is per-run provenance, separate from immutable input identity. */
export function batchExecutorState(batch: Pick<GroupBatch, 'executorPid'>, probe: (pid: number) => ExecutorState = probeExecutorPid): ExecutorState {
  return batch.executorPid === undefined ? 'unknown' : probe(batch.executorPid);
}
export async function runGroupBatch(store: Store, batches: BatchStore, id: string, options: { signal?: AbortSignal; permissions?: PermissionStore; execute?: typeof evaluateAndSave; sleep?: (ms: number) => Promise<void>; now?: () => number; random?: () => number; onProgress?: (batch: GroupBatch) => void } = {}): Promise<GroupBatch> {
  let batch = batches.required(id);
  if (executing.has(id) || batch.status === 'running') throw new Error('BATCH_ALREADY_RUNNING');
  if (batch.control !== 'run' || batch.status === 'cancelled') return batch;
  if (batch.model !== config.model || batch.configurationFingerprint !== getProviderConfigurationIdentity(config).configurationFingerprint || batch.checklistFingerprint !== officialChecklistFingerprint || canonicalJson(store.getChecklist(batch.checklistVersion)) !== canonicalJson(initialChecklist)) throw new Error('BATCH_CONFIGURATION_CHANGED');
  const now = options.now || Date.now; const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))); const random = options.random || Math.random;
  const started = now(); const deadline = started + batch.runBudgetMs; const execute = options.execute || evaluateAndSave;
  let permissionStore = options.permissions; let ownPermissions = false;
  const current = () => batches.required(id);
  const observe = (snapshot: GroupBatch) => { try { options.onProgress?.(structuredClone(snapshot)); } catch { /* Progress observers cannot invalidate saved scores. */ } };
  const checkpoint = (index: number, record: BatchRecord) => { const latest = current(); batch = batches.save({ ...latest, records: latest.records.map((r, i) => i === index ? record : r) }); observe(batch); };
  const pause = (reason: string) => { const latest = current(); batch = batches.save({ ...latest, status: latest.control === 'cancel' ? 'cancelled' : 'paused', reason }); observe(batch); };
  const controlled = () => { const latest = current(); return options.signal?.aborted || latest.control !== 'run'; };
  executing.add(id); batch = batches.save({ ...batch, status: 'running', reason: null, executorPid: process.pid, executorSessionId }); observe(batch);
  try {
    for (let index = 0; index < batch.records.length; index++) {
      if (controlled()) { pause(options.signal?.aborted ? 'RUN_ABORTED_AFTER_CURRENT_REQUEST' : current().reason || 'USER_PAUSED'); return current(); }
      let record = current().records[index]; const conversation = store.getConversation(record.conversationVersion);
      if (!conversation) { checkpoint(index, { ...record, status: 'error', errorCode: 'SOURCE_NOT_FOUND' }); continue; }
      const saved = findValidOfficialEvaluation(store, conversation, batch.model);
      if (saved) {
        const owned = record.runs.some(run => run.requestId === saved.attemptId);
        const runs = record.runs.map(run => {
          if (run.requestId !== saved.attemptId) return run;
          const ledger = store.getEvaluationAttempt(run.requestId);
          return { ...run, status: 'succeeded' as const, finishedAt: ledger?.finishedAt ?? saved.createdAt, errorCode: null, providerCallCount: ledger?.telemetry?.providerCallCount ?? saved.providerCallCount, usage: ledger?.usage ?? saved.usage, latencyMs: ledger?.latencyMs ?? saved.latencyMs };
        });
        checkpoint(index, { ...record, runs, status: owned ? 'succeeded' : 'reused', evaluationId: saved.id, errorCode: null, retryAt: null }); continue;
      }
      if (conversation.classification === 'real_restricted' || conversation.channel !== 'agent chat' || conversation.audioAvailable) { checkpoint(index, { ...record, status: 'blocked', errorCode: 'LOCAL_HUMAN_REVIEW_REQUIRED' }); continue; }
      if (!isApprovedSyntheticConversation(conversation)) {
        if (!permissionStore) { permissionStore = new PermissionStore(store.path); ownPermissions = true; }
        if (permissionStore.resolve(conversation).classification !== 'synthetic_allowed') { checkpoint(index, { ...record, status: 'blocked', errorCode: 'DATA_PERMISSION_REQUIRED' }); continue; }
      }
      while (record.runs.length <= 2) {
        record = current().records[index];
        const last = record.runs.at(-1); const ledger = last && store.getEvaluationAttempt(last.requestId);
        if (last && ledger?.status === 'running') { pause('REQUEST_OUTCOME_UNKNOWN_RESTART_OR_REVIEW_REQUIRED'); return current(); }
        if (last && ledger?.status === 'succeeded') { const completed = ledger.evaluationId && store.getEvaluation(ledger.evaluationId); if (completed && isValidOfficialEvaluation(store, conversation, completed, batch.model)) { checkpoint(index, { ...record, status: 'succeeded', evaluationId: completed.id, errorCode: null }); break; } }
        if (last?.status === 'running' && !ledger) { pause('REQUEST_NOT_RECORDED_EXPLICIT_REVIEW_REQUIRED'); return current(); }
        if (last?.status === 'running' && ledger?.status === 'failed') {
          record = { ...record, status: 'error', errorCode: ledger.errorCode, runs: [...record.runs.slice(0, -1), { ...last, status: 'failed', finishedAt: ledger.finishedAt, errorCode: ledger.errorCode, providerCallCount: ledger.telemetry?.providerCallCount ?? null, usage: ledger.usage, latencyMs: ledger.latencyMs }] }; checkpoint(index, record);
        }
        const interrupted = ledger?.errorCode === 'REQUEST_INTERRUPTED';
        if (interrupted && !batch.allowInterruptedRecovery) { pause('INTERRUPTED_RECOVERY_REQUIRES_EXPLICIT_APPROVAL'); return current(); }
        if (ledger?.errorCode === 'PROVIDER_RATE_LIMIT' && !batch.retryQuota) { pause('PROVIDER_RATE_LIMIT'); return current(); }
        const quotaResume = ledger?.errorCode === 'PROVIDER_RATE_LIMIT' && batch.retryQuota;
        const canRetry = record.runs.length === 1 && (recoverableTransport(ledger) || interrupted && batch.allowInterruptedRecovery || quotaResume);
        if (record.runs.length >= 2 || record.runs.length && !canRetry) { if (record.status === 'running' || record.status === 'retry_wait') checkpoint(index, { ...record, status: 'error', errorCode: ledger?.errorCode || record.errorCode || 'REQUEST_FAILED' }); break; }
        const previousStart = current().records.flatMap(r => r.runs).map(r => Date.parse(r.startedAt)).filter(Number.isFinite).sort((a, b) => b - a)[0];
        const backoffMs = canRetry ? Math.min(10000, 2000 * 2 ** (record.runs.length - 1)) + Math.floor(Math.max(0, Math.min(1, random())) * 500) : 0;
        const waitMs = Math.max(backoffMs, previousStart ? batch.minSpacingMs - (now() - previousStart) : 0, 0);
        if (now() + waitMs + config.timeoutMs + 1000 > deadline) { pause('RUN_TIME_BUDGET_EXHAUSTED'); return current(); }
        if (waitMs) { checkpoint(index, { ...record, status: 'retry_wait', retryAt: new Date(now() + waitMs).toISOString() }); await sleep(waitMs); }
        if (controlled()) { pause('USER_PAUSED_AFTER_CURRENT_REQUEST'); return current(); }
        const requestId = batchRequestId(batch, record.conversationVersion, record.runs.length);
        const retryOf = canRetry && !quotaResume ? last?.requestId : undefined;
        const run: BatchRun = { requestId, ...(retryOf ? { retryOf } : {}), status: 'running', startedAt: new Date(now()).toISOString(), finishedAt: null, errorCode: null, providerCallCount: null, usage: null, latencyMs: null };
        record = { ...record, status: 'running', runs: [...record.runs, run], errorCode: null, retryAt: null }; checkpoint(index, record);
        let errorCode: string | null = null; let evaluation: Evaluation | undefined;
        try { evaluation = await execute(store, record.conversationVersion, batch.checklistVersion, { attemptId: requestId, ...(retryOf ? { retryOf } : {}), permissions: permissionStore }); if (!store.getEvaluation(evaluation.id) || !isValidOfficialEvaluation(store, conversation, evaluation, batch.model)) throw new Error('INVALID_OFFICIAL_RESULT'); }
        catch (error) { errorCode = publicErrorCode(error); }
        const finished = store.getEvaluationAttempt(requestId);
        const completedRun: BatchRun = { ...run, status: errorCode ? 'failed' : 'succeeded', finishedAt: new Date(now()).toISOString(), errorCode,
          providerCallCount: finished?.telemetry?.providerCallCount ?? evaluation?.providerCallCount ?? null, usage: finished?.usage ?? evaluation?.usage ?? null, latencyMs: finished?.latencyMs ?? evaluation?.latencyMs ?? null };
        record = { ...record, status: errorCode ? 'error' : 'succeeded', errorCode, evaluationId: evaluation && !errorCode ? evaluation.id : null, runs: [...record.runs.slice(0, -1), completedRun] }; checkpoint(index, record);
        if (!errorCode) break;
        if (stopCodes.has(errorCode)) { pause(errorCode); return current(); }
        if (!recoverableTransport(finished) || record.runs.length >= 2) break;
      }
    }
    const latest = current(); const completed = batches.save({ ...latest, status: latest.control === 'cancel' ? 'cancelled' : latest.control === 'pause' ? 'paused' : 'completed', reason: latest.records.some(r => r.status === 'blocked' || r.status === 'error') ? 'COMPLETED_WITH_UNAVAILABLE_RECORDS' : null }); observe(completed); return completed;
  } finally { executing.delete(id); if (ownPermissions) permissionStore?.close(); }
}
