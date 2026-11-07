import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Checklist, Conversation, CriterionResult, Evaluation, Evidence, Score } from '../src/domain.js';
import { calculateScore } from '../src/scoring.js';
import { validateChecklist } from '../src/checklist.js';
import { validateEvidence } from './evidence.js';
import { canonicalJson, isApprovedSyntheticConversation } from './importer.js';
import type { Store } from './store.js';

export interface ValidationCase {
  id: string; conversationId: string; conversationVersion: string; checklistVersion: string;
  language: string; split: 'development' | 'holdout'; kind: 'core' | 'semantic_probe';
  tags: string[]; selectionReason: string;
}
export interface ValidationManifest {
  id: string; title: string; createdAt: string; sourceRevision: string; model: 'gemini-3.1-flash-lite';
  selectionFrozen: true; priorTuningExcluded: string[]; cases: ValidationCase[];
}
export interface HumanJudgment {
  criterionId: string; resolved: boolean; answer: string | null; explanation: string;
  applicabilityRationale: string; evidence: Evidence[]; checkedRange: CriterionResult['checkedRange'];
}
export interface HumanReference {
  id: string; manifestId: string; caseId: string; conversationVersion: string; checklistVersion: string;
  reviewerId: string; origin: 'human_declared'; humanAttestation: true; blindReviewAttested: true;
  createdAt: string; requestId: string; judgments: HumanJudgment[]; score: Score | null;
}
export interface ValidationAttempt {
  id: string; caseId: string; status: 'success' | 'failed'; evaluationId?: string; errorCode?: string;
  createdAt: string; model: string; latencyMs: number; providerCallCount: number | null;
  usage: Record<string, number | null>;
}
export interface HumanEvidenceReview {
  id: string; manifestId: string; caseId: string; evaluationId: string; criterionId: string;
  reviewerId: string; humanAttestation: true; verdict: 'supports' | 'does_not_support' | 'unclear';
  category: 'role' | 'na' | 'verification_timing' | 'consultation' | 'empathy' | 'closing' | 'gross_violation' | 'evidence' | 'language' | 'other';
  comment: string; createdAt: string; requestId: string;
}
const identifier = z.string().trim().min(1).max(200);
const quote = z.string().min(1).refine(text => text.trim().length > 0);
const judgmentSchema = z.object({
  criterionId: identifier, resolved: z.boolean(), answer: z.string().nullable(),
  explanation: z.string().trim().min(1).max(5000), applicabilityRationale: z.string().max(5000),
  evidence: z.array(z.object({ messageId: identifier, quote }).strict()).max(100),
  checkedRange: z.object({ startMessageId: identifier, endMessageId: identifier }).strict().nullable(),
}).strict();
const referenceInputSchema = z.object({
  manifestId: identifier, caseId: identifier, reviewerId: z.string().trim().min(2).max(128),
  origin: z.literal('human_declared'), humanAttestation: z.literal(true), blindReviewAttested: z.literal(true),
  requestId: identifier, judgments: z.array(judgmentSchema).min(1).max(100),
}).strict();
export type HumanReferenceInput = z.infer<typeof referenceInputSchema>;
const caseSchema = z.object({
  id: identifier, conversationId: identifier, conversationVersion: identifier, checklistVersion: identifier,
  language: identifier, split: z.enum(['development', 'holdout']), kind: z.enum(['core', 'semantic_probe']),
  tags: z.array(identifier).min(1), selectionReason: z.string().trim().min(1).max(5000),
}).strict();
const manifestSchema = z.object({
  id: identifier, title: identifier, createdAt: z.string().datetime(), sourceRevision: identifier,
  model: z.literal('gemini-3.1-flash-lite'), selectionFrozen: z.literal(true),
  priorTuningExcluded: z.array(identifier), cases: z.array(caseSchema).min(1).max(100),
}).strict();
const attemptSchema = z.object({
  id: identifier, caseId: identifier, status: z.enum(['success', 'failed']), evaluationId: identifier.optional(),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,80}$/).optional(), createdAt: z.string().datetime(),
  model: identifier, latencyMs: z.number().finite().nonnegative(), providerCallCount: z.number().int().nonnegative().nullable(),
  usage: z.record(z.string(), z.number().finite().nonnegative().nullable()),
}).strict();
const evidenceReviewSchema = z.object({
  manifestId: identifier, caseId: identifier, evaluationId: identifier, criterionId: identifier,
  reviewerId: z.string().trim().min(2).max(128), humanAttestation: z.literal(true),
  verdict: z.enum(['supports', 'does_not_support', 'unclear']),
  category: z.enum(['role', 'na', 'verification_timing', 'consultation', 'empathy', 'closing', 'gross_violation', 'evidence', 'language', 'other']),
  comment: z.string().trim().min(1).max(5000), requestId: identifier,
}).strict();
type JsonRow = { json: string };
const deserialize = <T>(row: JsonRow): T => JSON.parse(row.json) as T;
const resolvedResult = (judgment: HumanJudgment): CriterionResult => ({
  criterionId: judgment.criterionId, answer: judgment.answer!, explanation: judgment.explanation,
  applicabilityRationale: judgment.applicabilityRationale, evidence: judgment.evidence,
  checkedRange: judgment.checkedRange, reviewRequired: false, uncertainty: '',
});
const ratio = (matches: number, total: number) => total ? matches / total : null;

/** Human judgments live in separate append-only tables, never inferred from evaluations. */
export class QualityStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS quality_manifests(id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quality_references(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, manifest_id TEXT NOT NULL, case_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quality_runs(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, manifest_id TEXT NOT NULL, case_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quality_evidence_reviews(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, manifest_id TEXT NOT NULL, case_id TEXT NOT NULL, evaluation_id TEXT NOT NULL, criterion_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quality_requests(request_id TEXT PRIMARY KEY, operation TEXT NOT NULL, payload TEXT NOT NULL, result_json TEXT NOT NULL);
    `);
    for (const table of ['quality_manifests', 'quality_references', 'quality_runs', 'quality_evidence_reviews', 'quality_requests']) {
      for (const op of ['UPDATE', 'DELETE']) this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${op.toLowerCase()}_blocked BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT, 'Quality history is append-only'); END;`);
    }
  }
  saveManifest(input: unknown, conversations: Conversation[], checklists: Checklist | Checklist[]): ValidationManifest {
    const manifest = manifestSchema.parse(input);
    if (new Set(manifest.cases.map(item => item.id)).size !== manifest.cases.length) throw new Error('DUPLICATE_VALIDATION_CASE');
    const configurations = Array.isArray(checklists) ? checklists : [checklists];
    for (const item of manifest.cases) {
      const conversation = conversations.find(c => c.version === item.conversationVersion);
      const checklist = configurations.find(c => c.version === item.checklistVersion);
      if (!conversation || !isApprovedSyntheticConversation(conversation) || conversation.conversationId !== item.conversationId || conversation.language !== item.language || !checklist) throw new Error('VALIDATION_SOURCE_RESTRICTED');
      validateChecklist(checklist);
      if (manifest.priorTuningExcluded.includes(item.conversationId)) throw new Error('TUNING_CASE_IN_VALIDATION');
    }
    const json = canonicalJson(manifest);
    const old = this.db.prepare('SELECT json FROM quality_manifests WHERE id=?').get(manifest.id) as JsonRow | undefined;
    if (old && old.json !== json) throw new Error('IMMUTABLE_MANIFEST');
    if (!old) this.db.prepare('INSERT INTO quality_manifests(id,json) VALUES(?,?)').run(manifest.id, json);
    return manifest;
  }
  getManifest(id?: string): ValidationManifest | undefined {
    const row = id ? this.db.prepare('SELECT json FROM quality_manifests WHERE id=?').get(id) : this.db.prepare('SELECT json FROM quality_manifests ORDER BY rowid DESC LIMIT 1').get();
    return row ? deserialize<ValidationManifest>(row as JsonRow) : undefined;
  }
  listManifests(): ValidationManifest[] { return (this.db.prepare('SELECT json FROM quality_manifests ORDER BY rowid DESC').all() as JsonRow[]).map(deserialize<ValidationManifest>); }
  private context(manifestId: string, caseId: string, store: Store) {
    const manifest = this.getManifest(manifestId);
    const item = manifest?.cases.find(c => c.id === caseId);
    const conversation = item && store.getConversation(item.conversationVersion);
    const checklist = item && store.getChecklist(item.checklistVersion);
    if (!manifest || !item || !conversation || !checklist || !isApprovedSyntheticConversation(conversation)) throw new Error('VALIDATION_SOURCE_RESTRICTED');
    return { manifest, item, conversation, checklist };
  }
  getReference(manifestId: string, caseId: string): HumanReference | undefined {
    const row = this.db.prepare('SELECT json FROM quality_references WHERE manifest_id=? AND case_id=? ORDER BY sequence DESC LIMIT 1').get(manifestId, caseId) as JsonRow | undefined;
    return row && deserialize<HumanReference>(row);
  }
  listReferences(manifestId: string): HumanReference[] { return (this.db.prepare('SELECT json FROM quality_references WHERE manifest_id=? ORDER BY sequence').all(manifestId) as JsonRow[]).map(deserialize<HumanReference>); }
  private idempotent<T>(requestId: string, operation: string, payload: unknown, create: () => T): T {
    const signature = canonicalJson(payload);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT operation,payload,result_json FROM quality_requests WHERE request_id=?').get(requestId) as { operation: string; payload: string; result_json: string } | undefined;
      if (existing) {
        if (existing.operation !== operation || existing.payload !== signature) throw new Error('IDEMPOTENCY_CONFLICT');
        this.db.exec('COMMIT'); return JSON.parse(existing.result_json) as T;
      }
      const result = create();
      this.db.prepare('INSERT INTO quality_requests(request_id,operation,payload,result_json) VALUES(?,?,?,?)').run(requestId, operation, signature, canonicalJson(result));
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  saveReference(conversation: Conversation, checklist: Checklist, raw: unknown): HumanReference {
    const input = referenceInputSchema.parse(raw);
    const item = this.getManifest(input.manifestId)?.cases.find(c => c.id === input.caseId);
    if (!item || !isApprovedSyntheticConversation(conversation) || item.conversationVersion !== conversation.version || item.checklistVersion !== checklist.version) throw new Error('VALIDATION_SOURCE_RESTRICTED');
    if (input.judgments.length !== checklist.criteria.length || new Set(input.judgments.map(j => j.criterionId)).size !== input.judgments.length || input.judgments.some(j => !checklist.criteria.some(c => c.id === j.criterionId))) throw new Error('INVALID_REFERENCE_CRITERIA');
    if (input.judgments.some(j => j.resolved ? j.answer === null : j.answer !== null)) throw new Error('INVALID_REFERENCE_RESOLUTION');
    const previous = this.getReference(input.manifestId, input.caseId);
    for (const old of previous?.judgments.filter(j => j.resolved) ?? []) {
      const next = input.judgments.find(j => j.criterionId === old.criterionId);
      if (canonicalJson(old) !== canonicalJson(next)) throw new Error('BLIND_REFERENCE_FROZEN');
    }
    const resolved = input.judgments.filter(j => j.resolved);
    if (resolved.length) validateEvidence(conversation, { ...checklist, criteria: checklist.criteria.filter(c => resolved.some(j => j.criterionId === c.id)) }, { results: resolved.map(resolvedResult) });
    // Even unresolved annotations cannot cite invented text or foreign messages.
    for (const judgment of input.judgments.filter(j => !j.resolved)) {
      for (const evidence of judgment.evidence) if (!conversation.messages.some(m => m.id === evidence.messageId && m.text.includes(evidence.quote))) throw new Error('INVALID_REFERENCE_EVIDENCE');
      if (judgment.checkedRange) {
        const start = conversation.messages.findIndex(m => m.id === judgment.checkedRange!.startMessageId);
        const end = conversation.messages.findIndex(m => m.id === judgment.checkedRange!.endMessageId);
        if (start < 0 || end < start) throw new Error('INVALID_REFERENCE_EVIDENCE');
      }
    }
    return this.idempotent(input.requestId, 'human-reference', input, () => {
      const reference: HumanReference = { ...input, id: randomUUID(), createdAt: new Date().toISOString(), conversationVersion: conversation.version, checklistVersion: checklist.version, score: resolved.length === checklist.criteria.length ? calculateScore(checklist, resolved.map(resolvedResult)) : null };
      this.db.prepare('INSERT INTO quality_references(id,manifest_id,case_id,json) VALUES(?,?,?,?)').run(reference.id, input.manifestId, input.caseId, canonicalJson(reference));
      return reference;
    });
  }
  recordRun(manifestId: string, raw: unknown, store?: Store): ValidationAttempt {
    const attempt = attemptSchema.parse(raw);
    const manifest = this.getManifest(manifestId);
    const item = manifest?.cases.find(c => c.id === attempt.caseId);
    if (!manifest || !item || attempt.model !== manifest.model) throw new Error('VALIDATION_RUN_MISMATCH');
    if (attempt.status === 'success') {
      if (!attempt.evaluationId || !store) throw new Error('VALIDATION_RUN_MISSING_EVALUATION');
      const evaluation = store.getEvaluation(attempt.evaluationId);
      if (!evaluation || evaluation.status !== 'live_validated' || evaluation.provider !== 'gemini' || evaluation.model !== manifest.model || evaluation.conversationVersion !== item.conversationVersion || evaluation.checklistVersion !== item.checklistVersion) throw new Error('VALIDATION_RUN_MISMATCH');
    } else if (!attempt.errorCode || attempt.evaluationId) throw new Error('VALIDATION_RUN_MISMATCH');
    const existing = this.db.prepare('SELECT json,manifest_id FROM quality_runs WHERE id=?').get(attempt.id) as (JsonRow & { manifest_id: string }) | undefined;
    if (existing && (existing.manifest_id !== manifestId || existing.json !== canonicalJson(attempt))) throw new Error('IMMUTABLE_VALIDATION_RUN');
    if (!existing) this.db.prepare('INSERT INTO quality_runs(id,manifest_id,case_id,json) VALUES(?,?,?,?)').run(attempt.id, manifestId, attempt.caseId, canonicalJson(attempt));
    return attempt;
  }
  listRuns(manifestId: string): ValidationAttempt[] { return (this.db.prepare('SELECT json FROM quality_runs WHERE manifest_id=? ORDER BY sequence').all(manifestId) as JsonRow[]).map(deserialize<ValidationAttempt>); }
  saveEvidenceReview(raw: unknown, store: Store): HumanEvidenceReview {
    const input = evidenceReviewSchema.parse(raw);
    const { manifest, item, checklist } = this.context(input.manifestId, input.caseId, store);
    if (!this.getReference(input.manifestId, input.caseId)?.judgments.some(j => j.criterionId === input.criterionId && j.resolved)) throw new Error('BLIND_REFERENCE_REQUIRED');
    const evaluation = store.getEvaluation(input.evaluationId);
    if (!evaluation || evaluation.status !== 'live_validated' || evaluation.provider !== 'gemini' || evaluation.model !== manifest.model || evaluation.conversationVersion !== item.conversationVersion || evaluation.checklistVersion !== checklist.version || !evaluation.results.some(r => r.criterionId === input.criterionId)) throw new Error('VALIDATION_RUN_MISMATCH');
    return this.idempotent(input.requestId, 'human-evidence-review', input, () => {
      const review: HumanEvidenceReview = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO quality_evidence_reviews(id,manifest_id,case_id,evaluation_id,criterion_id,json) VALUES(?,?,?,?,?,?)').run(review.id, input.manifestId, input.caseId, input.evaluationId, input.criterionId, canonicalJson(review));
      return review;
    });
  }
  listEvidenceReviews(manifestId: string): HumanEvidenceReview[] { return (this.db.prepare('SELECT json FROM quality_evidence_reviews WHERE manifest_id=? ORDER BY sequence').all(manifestId) as JsonRow[]).map(deserialize<HumanEvidenceReview>); }
  getCase(manifestId: string, caseId: string, store: Store) {
    const { item, conversation, checklist } = this.context(manifestId, caseId, store);
    const reference = this.getReference(manifestId, caseId);
    const lastSuccess = this.listRuns(manifestId).filter(r => r.caseId === caseId && r.status === 'success').at(-1);
    // Model outputs are never returned by this blind route until an actual declared human reference exists.
    const model = reference && lastSuccess?.evaluationId ? store.getEvaluation(lastSuccess.evaluationId) : undefined;
    const visibleResults = model?.results.filter(result => reference!.judgments.some(j => j.criterionId === result.criterionId && j.resolved));
    return { case: item, conversation, checklist, reference: reference ?? null, modelEvaluation: model ? { id: model.id, model: model.model, results: visibleResults ?? [], score: reference?.score ? model.score : null } : null };
  }
  getDashboard(store: Store, manifestId?: string) {
    const manifest = this.getManifest(manifestId);
    if (!manifest) return { manifest: null, manifests: [], cases: [], referenceCount: 0, metrics: null };
    const references = manifest.cases.flatMap(c => { const ref = this.getReference(manifest.id, c.id); return ref ? [ref] : []; });
    const runs = this.listRuns(manifest.id);
    const cases = manifest.cases.map(item => ({ ...item, humanReferenceSaved: references.some(r => r.caseId === item.id), lastRunStatus: runs.filter(r => r.caseId === item.id).at(-1)?.status ?? 'not_run' }));
    const frozenSources = manifest.cases.flatMap(item => { const conversation = store.getConversation(item.conversationVersion); return conversation ? [conversation] : []; });
    return { manifest, manifests: this.listManifests().map(m => ({ id: m.id, title: m.title })), cases, referenceCount: references.length, metrics: computeValidationMetrics(manifest, references, runs, store.listEvaluations(), frozenSources, store.listChecklists(), this.listEvidenceReviews(manifest.id)) };
  }
  close() { this.db.close(); }
}

/** This function compares declared human references only; model outputs never create labels. */
export function computeValidationMetrics(manifest: ValidationManifest, references: HumanReference[], attempts: ValidationAttempt[], evaluations: Evaluation[], conversations: Conversation[], checklists: Checklist[], evidenceReviews: HumanEvidenceReview[] = []) {
  const criterion: Record<string, { matches: number; total: number; agreement: number | null }> = Object.create(null);
  for (const checklist of checklists.filter(c => manifest.cases.some(item => item.checklistVersion === c.version))) for (const c of checklist.criteria) criterion[c.id] = { matches: 0, total: 0, agreement: null };
  const language: Record<string, { matches: number; total: number; agreement: number | null }> = Object.fromEntries(['RU', 'KZ', 'EN'].map(l => [l, { matches: 0, total: 0, agreement: null }]));
  const split: Record<string, { matches: number; total: number; agreement: number | null }> = Object.fromEntries(['development', 'holdout'].map(s => [s, { matches: 0, total: 0, agreement: null }]));
  const na = { total: 0, falseNA: 0, missedNA: 0, correctNA: 0, correctApplicable: 0 };
  const gross = { total: 0, truePositive: 0, trueNegative: 0, falsePositive: 0, falseNegative: 0 };
  const scoreErrors: Array<{ caseId: string; language: string; referenceTotal: number; modelTotal: number; absoluteError: number }> = [];
  const disagreements: Array<{ caseId: string; split: string; language: string; criterionId: string; expected: string; actual: string; category: string; humanExplanation: string; modelExplanation: string; referenceId: string; evaluationId: string }> = [];
  const semanticProbes: Array<{ caseId: string; humanReferenceAvailable: boolean; modelEvaluationAvailable: boolean; matches: number | null; resolved: number }> = [];
  const technical = { evaluationsChecked: 0, evaluationsValid: 0, quotesChecked: 0, quotesValid: 0, rangesChecked: 0, rangesValid: 0 };
  let comparedCases = 0; let resolvedHumanJudgments = 0; let unresolvedHumanJudgments = 0;
  for (const item of manifest.cases) {
    const reference = references.filter(r => r.origin === 'human_declared' && r.humanAttestation === true && r.blindReviewAttested === true && r.manifestId === manifest.id && r.caseId === item.id && r.conversationVersion === item.conversationVersion && r.checklistVersion === item.checklistVersion).at(-1);
    const run = attempts.filter(a => a.caseId === item.id && a.status === 'success' && a.model === manifest.model).at(-1);
    const model = run && evaluations.find(e => e.id === run.evaluationId && e.status === 'live_validated' && e.provider === 'gemini' && e.model === manifest.model && e.conversationVersion === item.conversationVersion && e.checklistVersion === item.checklistVersion);
    const conversation = conversations.find(c => c.version === item.conversationVersion);
    const checklist = checklists.find(c => c.version === item.checklistVersion);
    if (model && conversation && checklist) {
      technical.evaluationsChecked++;
      try { validateEvidence(conversation, checklist, { results: model.results }); technical.evaluationsValid++; } catch { /* An invalid result remains a failed technical check. */ }
      for (const result of model.results) {
        for (const quote of result.evidence) { technical.quotesChecked++; if (quote.quote.trim() && conversation.messages.some(m => m.id === quote.messageId && m.text.includes(quote.quote))) technical.quotesValid++; }
        if (result.checkedRange) {
          technical.rangesChecked++;
          const start = conversation.messages.findIndex(m => m.id === result.checkedRange!.startMessageId);
          const end = conversation.messages.findIndex(m => m.id === result.checkedRange!.endMessageId);
          if (start >= 0 && end >= start) technical.rangesValid++;
        }
      }
    }
    if (item.kind === 'semantic_probe') {
      const resolved = reference?.judgments.filter(j => j.resolved && j.answer !== null) ?? [];
      semanticProbes.push({ caseId: item.id, humanReferenceAvailable: Boolean(reference), modelEvaluationAvailable: Boolean(model), matches: reference && model ? resolved.filter(j => model.results.some(r => r.criterionId === j.criterionId && r.answer === j.answer)).length : null, resolved: resolved.length });
      continue;
    }
    if (reference) { resolvedHumanJudgments += reference.judgments.filter(j => j.resolved && j.answer !== null).length; unresolvedHumanJudgments += reference.judgments.filter(j => !j.resolved).length; }
    if (!reference || !model || !checklist) continue;
    comparedCases++;
    for (const human of reference.judgments.filter(j => j.resolved && j.answer !== null)) {
      const result = model.results.find(r => r.criterionId === human.criterionId);
      if (!result) continue;
      const key = human.criterionId;
      criterion[key] ??= { matches: 0, total: 0, agreement: null };
      language[item.language] ??= { matches: 0, total: 0, agreement: null };
      const equal = human.answer === result.answer;
      criterion[key].total++; language[item.language].total++; split[item.split].total++;
      if (equal) { criterion[key].matches++; language[item.language].matches++; split[item.split].matches++; }
      na.total++;
      if (human.answer === 'N/A' && result.answer === 'N/A') na.correctNA++;
      else if (human.answer === 'N/A') na.missedNA++;
      else if (result.answer === 'N/A') na.falseNA++;
      else na.correctApplicable++;
      const configured = checklist.criteria.find(c => c.id === key);
      if (configured?.flag) {
        gross.total++;
        if (human.answer === 'YES') { if (result.answer === 'YES') gross.truePositive++; else gross.falseNegative++; }
        else if (result.answer === 'YES') gross.falsePositive++; else gross.trueNegative++;
      }
      if (!equal) disagreements.push({ caseId: item.id, split: item.split, language: item.language, criterionId: key, expected: human.answer!, actual: result.answer,
        category: human.answer === 'N/A' ? 'missed_na' : result.answer === 'N/A' ? 'false_na' : configured?.flag ? result.answer === 'YES' ? 'gross_false_positive' : 'gross_false_negative' : 'answer_mismatch',
        humanExplanation: human.explanation, modelExplanation: result.explanation, referenceId: reference.id, evaluationId: model.id });
    }
    if (reference.score?.total !== null && reference.score?.total !== undefined && model.score.total !== null) scoreErrors.push({ caseId: item.id, language: item.language, referenceTotal: reference.score.total, modelTotal: model.score.total, absoluteError: Math.abs(reference.score.total - model.score.total) });
  }
  for (const item of Object.values(criterion)) item.agreement = ratio(item.matches, item.total);
  for (const item of Object.values(language)) item.agreement = ratio(item.matches, item.total);
  for (const item of Object.values(split)) item.agreement = ratio(item.matches, item.total);
  const latencies = attempts.map(a => a.latencyMs).sort((a, b) => a - b);
  const middle = Math.floor(latencies.length / 2);
  const medianLatency = latencies.length ? latencies.length % 2 ? latencies[middle] : (latencies[middle - 1] + latencies[middle]) / 2 : null;
  const errors: Record<string, number> = Object.create(null);
  for (const attempt of attempts.filter(a => a.status === 'failed')) errors[attempt.errorCode || 'UNKNOWN'] = (errors[attempt.errorCode || 'UNKNOWN'] || 0) + 1;
  const evidenceReviewMap = new Map<string, HumanEvidenceReview>();
  for (const review of evidenceReviews.filter(r => r.humanAttestation && r.manifestId === manifest.id && references.some(ref => ref.caseId === r.caseId && ref.origin === 'human_declared'))) evidenceReviewMap.set(`${review.evaluationId}:${review.criterionId}`, review);
  const eligibleEvidenceReviews = [...evidenceReviewMap.values()];
  const semanticEvidence = { supported: eligibleEvidenceReviews.filter(r => r.verdict === 'supports').length, unsupported: eligibleEvidenceReviews.filter(r => r.verdict === 'does_not_support').length, unresolved: eligibleEvidenceReviews.filter(r => r.verdict === 'unclear').length };
  return {
    status: references.some(r => r.origin === 'human_declared' && r.humanAttestation && r.blindReviewAttested) ? 'partial_human_review' : 'awaiting_human_review',
    humanReviewedCases: manifest.cases.filter(c => c.kind === 'core' && references.some(r => r.caseId === c.id && r.origin === 'human_declared' && r.humanAttestation && r.blindReviewAttested)).length,
    resolvedHumanJudgments, unresolvedHumanJudgments, comparedCases,
    byCriterion: criterion, byLanguage: language, bySplit: split,
    na: { ...na, available: na.total > 0 }, grossViolations: { ...gross, available: gross.total > 0 },
    totalScoreError: { dialogs: scoreErrors.length, meanAbsoluteError: scoreErrors.length ? scoreErrors.reduce((n, r) => n + r.absoluteError, 0) / scoreErrors.length : null, maxAbsoluteError: scoreErrors.length ? Math.max(...scoreErrors.map(r => r.absoluteError)) : null, cases: scoreErrors },
    evidence: { ...technical, evaluationValidity: ratio(technical.evaluationsValid, technical.evaluationsChecked), quoteValidity: ratio(technical.quotesValid, technical.quotesChecked), humanSemantic: { ...semanticEvidence, available: eligibleEvidenceReviews.length > 0 } },
    reliability: { attempts: attempts.length, successes: attempts.filter(a => a.status === 'success').length, failures: attempts.filter(a => a.status === 'failed').length, errors, latencyMs: { count: latencies.length, min: latencies[0] ?? null, median: medianLatency, p95: latencies.length ? latencies[Math.max(0, Math.ceil(latencies.length * .95) - 1)] : null, max: latencies.at(-1) ?? null }, reportedTokens: attempts.reduce((n, a) => n + (a.usage.totalTokens ?? 0), 0), unknownTokenUsageAttempts: attempts.filter(a => a.usage.totalTokens == null).length, knownProviderCalls: attempts.reduce((n, a) => n + (a.providerCallCount ?? 0), 0), unknownProviderCallAttempts: attempts.filter(a => a.providerCallCount === null).length },
    materialDisagreements: disagreements, semanticProbes,
    note: 'Only explicitly declared blind human judgments enter agreement metrics. Agent proposals, manual demos and model-generated labels never form a reference. A self-attestation is not independently authenticated identity.',
  };
}
