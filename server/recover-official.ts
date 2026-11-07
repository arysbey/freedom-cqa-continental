/** Bounded explicit recovery of official failures. No model client, source repair or permission grant. */
import { createHash } from 'node:crypto';
import type { GroupBatch } from './batches.js';
import { officialChecklistFingerprint } from './batches.js';
import type { CompetitionDataset } from './competition.js';
import { selectOfficialEvaluation } from './competition.js';
import { initialChecklist } from '../src/checklist.js';
import { canonicalJson, isApprovedSyntheticConversation } from './importer.js';
import { config } from './config.js';
import { getProviderConfigurationIdentity } from './provider.js';

export interface OfficialRecoveryState { batch: GroupBatch; batches: GroupBatch[]; dataset: CompetitionDataset; approvedSyntheticVersions?: string[] }
export interface OfficialRecoveryItem {
  conversationId: string; conversationVersion: string; parentId: string | null; requestId: string | null;
  action: 'eligible' | 'reused' | 'exhausted' | 'ineligible'; reason: string; evaluationId: string | null;
}
export const officialRecoveryRequestId = (parentId: string) => 'recover_' + createHash('sha256').update(parentId).digest('hex').slice(0, 56);
const recoverable = new Set(['INVALID_EVIDENCE', 'INVALID_MODEL_JSON', 'PROVIDER_EMPTY_RESULT', 'PROVIDER_TIMEOUT']);
export interface OfficialRecoveryOptions { acceptRequiredRangeUpgrade?: boolean }
export function officialRecoveryConfigurationAudit(state: OfficialRecoveryState, options: OfficialRecoveryOptions = {}) {
  const identity = getProviderConfigurationIdentity(config);
  return { acceptRequiredRangeUpgrade: options.acceptRequiredRangeUpgrade === true, generationConstraintVersion: identity.generationConstraintVersion,
    batchConfigurationFingerprint: state.batch.configurationFingerprint, currentConfigurationFingerprint: identity.configurationFingerprint,
    compatiblePreviousFingerprint: identity.compatiblePreviousFingerprint, compatibleSourceSpanFingerprint: identity.compatibleSourceSpanFingerprint, compatibleExactQuotesFingerprint: identity.compatibleExactQuotesFingerprint, compatibleFlatQuotesFingerprint: identity.compatibleFlatQuotesFingerprint, generationCompatibilityScope: identity.generationCompatibilityScope,
    upgradeScope: 'known-source-evidence-generation-constraints-only-no-prompt-model-rubric-change',
    requiredRangeUpgradeApplied: options.acceptRequiredRangeUpgrade === true && new Set<string>(['all-criteria-source-span-v1', 'all-criteria-source-span-exact-quotes-v2', 'all-criteria-source-span-flat-quotes-v3', 'all-criteria-source-span-copy-quotes-v4']).has(identity.generationConstraintVersion) && [identity.compatiblePreviousFingerprint, identity.compatibleSourceSpanFingerprint, identity.compatibleExactQuotesFingerprint, identity.compatibleFlatQuotesFingerprint].includes(state.batch.configurationFingerprint) };
}
/** Reject a stale local server before spending the sole child recovery request. */
export function assertRecoveryServerConfiguration(status: unknown): void {
  const value = status !== null && typeof status === 'object' ? status as Record<string, unknown> : {};
  const identity = getProviderConfigurationIdentity(config);
  if (value.model !== config.model || value.provider !== 'gemini' || value.mode !== 'free' || value.configurationFingerprint !== identity.configurationFingerprint || value.generationConstraintVersion !== identity.generationConstraintVersion) throw new Error('LOCAL_SERVER_GENERATION_CONFIGURATION_MISMATCH');
}
export function planOfficialRecovery(state: OfficialRecoveryState, options: OfficialRecoveryOptions = {}): OfficialRecoveryItem[] {
  const { batch, dataset } = state;
  if (state.batches.some(b => b.status === 'running') || dataset.attempts.some(a => a.status === 'running')) throw new Error('OFFICIAL_RECOVERY_BUSY');
  const official = dataset.checklists.find(c => c.version === initialChecklist.version);
  const configuration = officialRecoveryConfigurationAudit(state, options);
  if (!official || dataset.groupId !== batch.groupId || batch.model !== config.model || batch.configurationFingerprint !== configuration.currentConfigurationFingerprint && !configuration.requiredRangeUpgradeApplied || batch.checklistVersion !== initialChecklist.version || batch.checklistFingerprint !== officialChecklistFingerprint || canonicalJson(official) !== canonicalJson(initialChecklist)) throw new Error('OFFICIAL_RECOVERY_CONFIGURATION_MISMATCH');
  return batch.records.map(record => {
    const source = dataset.conversations.find(c => c.version === record.conversationVersion && c.groupId === batch.groupId && c.conversationId === record.conversationId);
    const lastRun = record.runs.at(-1); const parentId = lastRun?.requestId || null;
    const item: OfficialRecoveryItem = { conversationId: record.conversationId, conversationVersion: record.conversationVersion, parentId, requestId: parentId ? officialRecoveryRequestId(parentId) : null, action: 'ineligible', reason: 'NO_RECOVERABLE_ORIGINAL_FAILURE', evaluationId: null };
    if (!source) return { ...item, reason: 'ORIGINAL_SOURCE_VERSION_NOT_CURRENT' };
    const selected = selectOfficialEvaluation(source, dataset.checklists, dataset.evaluations, config.model).evaluation;
    if (selected) return { ...item, action: 'reused', reason: 'VALID_OFFICIAL_RESULT_ALREADY_SAVED', evaluationId: selected.id };
    if (source.channel !== 'agent chat' || source.audioAvailable || source.classification === 'real_restricted') return { ...item, reason: 'LOCAL_HUMAN_REVIEW_REQUIRED' };
    if (!isApprovedSyntheticConversation(source) && !(source.classification === 'unknown' && state.approvedSyntheticVersions?.includes(source.version))) return { ...item, reason: 'DATA_PERMISSION_REQUIRED' };
    if (lastRun?.status !== 'failed' || !recoverable.has(lastRun.errorCode || '')) return item;
    const parent = dataset.attempts.find(a => a.id === parentId);
    if (!parent || parent.status !== 'failed' || !recoverable.has(parent.errorCode || '')) return item;
    if (parent.conversationVersion !== source.version || parent.checklistVersion !== initialChecklist.version || parent.model !== batch.model) return { ...item, reason: 'PARENT_SOURCE_MODEL_MISMATCH' };
    if ((parent.recoveryDepth ?? 0) !== 0 || parent.recoveryOf) return { ...item, action: 'exhausted', reason: 'PARENT_RECOVERY_ALREADY_USED' };
    const child = dataset.attempts.find(a => a.recoveryOf === parent.id);
    if (child) return { ...item, action: 'exhausted', reason: child.status === 'succeeded' ? 'CHILD_RESULT_NOT_VALID_OFFICIAL' : 'CHILD_ALREADY_ATTEMPTED', requestId: child.id };
    if (dataset.attempts.some(a => a.id === item.requestId)) return { ...item, action: 'exhausted', reason: 'DETERMINISTIC_REQUEST_ID_ALREADY_USED' };
    return { ...item, action: 'eligible', reason: parent.errorCode! };
  });
}
export interface RecoveryOutcome {
  conversationId: string; parentId: string; requestId: string; status: 'succeeded' | 'failed' | 'skipped' | 'unknown'; errorCode: string | null;
  evaluationId: string | null; providerCallCount: number | null; usage: Record<string, number | null> | null; latencyMs: number | null;
}
export interface RecoveryClient {
  load(): Promise<OfficialRecoveryState>;
  beforePost?(): Promise<void>;
  post(payload: { conversationVersion: string; checklistVersion: string; requestId: string; retryOf: string }): Promise<{ ok: boolean; errorCode?: string }>;
}
export async function executeOfficialRecoveries(client: RecoveryClient, options: OfficialRecoveryOptions & { limit?: number; budgetMs?: number; spacingMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; onProgress?: (outcome: RecoveryOutcome) => void } = {}) {
  const limit = options.limit ?? 10; const budgetMs = options.budgetMs ?? 600000; const spacingMs = options.spacingMs ?? 12000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(budgetMs) || budgetMs < 1000 || budgetMs > 2700000 || !Number.isInteger(spacingMs) || spacingMs < 0 || spacingMs > 600000) throw new Error('INVALID_OFFICIAL_RECOVERY_BOUNDS');
  const now = options.now || Date.now; const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))); const deadline = now() + budgetMs;
  const initial = await client.load(); const candidates = planOfficialRecovery(initial, options).filter(item => item.action === 'eligible').slice(0, limit);
  const outcomes: RecoveryOutcome[] = []; let lastStarted: number | null = null; let stopReason: string | null = null;
  const stoppedCodes = new Set(['PROVIDER_RATE_LIMIT', 'PROVIDER_TIMEOUT', 'MISSING_API_KEY', 'FREE_TIER_UNCONFIRMED', 'MODEL_UNAVAILABLE', 'MODEL_NOT_FREE_APPROVED', 'EVALUATION_BUSY', 'LOCAL_RECOVERY_REQUEST_FAILED']);
  for (const candidate of candidates) {
    const waitMs = lastStarted === null ? 0 : Math.max(0, spacingMs - (now() - lastStarted));
    if (now() + waitMs + config.timeoutMs + 5000 > deadline) { stopReason = 'OFFICIAL_RECOVERY_BUDGET_EXHAUSTED'; break; }
    if (waitMs) await sleep(waitMs);
    const before = await client.load(); const current = planOfficialRecovery(before, options).find(item => item.parentId === candidate.parentId && item.conversationVersion === candidate.conversationVersion);
    if (!current || current.action !== 'eligible') { outcomes.push({ conversationId: candidate.conversationId, parentId: candidate.parentId!, requestId: candidate.requestId!, status: 'skipped', errorCode: current?.reason || 'SOURCE_CHANGED', evaluationId: current?.evaluationId ?? null, providerCallCount: 0, usage: null, latencyMs: null }); continue; }
    await client.beforePost?.();
    lastStarted = now(); let response: Awaited<ReturnType<RecoveryClient['post']>>;
    try { response = await client.post({ conversationVersion: current.conversationVersion, checklistVersion: initialChecklist.version, requestId: current.requestId!, retryOf: current.parentId! }); }
    catch { response = { ok: false, errorCode: 'LOCAL_RECOVERY_REQUEST_FAILED' }; }
    const after = await client.load(); const child = after.dataset.attempts.find(a => a.id === current.requestId);
    const valid = after.dataset.evaluations.find(e => e.attemptId === current.requestId);
    const source = after.dataset.conversations.find(c => c.version === current.conversationVersion);
    const accepted = source && valid && selectOfficialEvaluation(source, after.dataset.checklists, [valid], config.model).evaluation;
    const unknown = !child || child.status === 'running';
    const errorCode = unknown ? 'RECOVERY_OUTCOME_NOT_CONFIRMED' : child.status === 'succeeded' && accepted ? null : child.errorCode || response.errorCode || 'RECOVERY_RESULT_NOT_VALID_OFFICIAL';
    const outcome: RecoveryOutcome = { conversationId: current.conversationId, parentId: current.parentId!, requestId: current.requestId!, status: unknown ? 'unknown' : child.status === 'succeeded' && accepted ? 'succeeded' : 'failed', errorCode,
      evaluationId: accepted?.id ?? null, providerCallCount: child?.telemetry?.providerCallCount ?? null, usage: child?.usage ?? null, latencyMs: child?.latencyMs ?? null };
    outcomes.push(outcome); try { options.onProgress?.(structuredClone(outcome)); } catch { /* A report observer cannot change an actual saved result. */ }
    if (unknown || stoppedCodes.has(errorCode || '')) { stopReason = errorCode; break; }
  }
  return { batchId: initial.batch.id, groupId: initial.batch.groupId, model: initial.batch.model, checklistVersion: initialChecklist.version, configurationAudit: officialRecoveryConfigurationAudit(initial, options), limit, budgetMs, spacingMs, selectedParents: candidates.length, outcomes, stopReason };
}
