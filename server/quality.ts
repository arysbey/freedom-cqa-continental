import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
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
  reviewRoundId?: string;
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
  reviewRoundId?: string;
  reviewerId: string; humanAttestation: true; verdict: 'supports' | 'does_not_support' | 'unclear';
  category: 'role' | 'na' | 'verification_timing' | 'consultation' | 'empathy' | 'closing' | 'gross_violation' | 'evidence' | 'language' | 'other';
  comment: string; createdAt: string; requestId: string;
}
export interface HumanReviewRound {
  id: string; manifestId: string; reviewerId: string | null; createdAt: string | null;
  previousRoundId: string | null; requestId: string | null; supersededReviewerIds: string[];
  origin: 'legacy' | 'human_requested_reset'; note: string;
}
const identifier = z.string().trim().min(1).max(200);
const quote = z.string().min(1).refine(text => text.trim().length > 0);
const judgmentSchema = z.object({
  criterionId: identifier, resolved: z.boolean(), answer: z.string().nullable(),
  explanation: z.string().trim().max(5000), applicabilityRationale: z.string().max(5000),
  evidence: z.array(z.object({ messageId: identifier, quote }).strict()).max(100),
  checkedRange: z.object({ startMessageId: identifier, endMessageId: identifier }).strict().nullable(),
}).strict().superRefine((judgment, ctx) => {
  if (judgment.resolved && !judgment.explanation) ctx.addIssue({ code: 'custom', path: ['explanation'], message: 'Resolved human judgments require an explanation.' });
});
const referenceInputSchema = z.object({
  manifestId: identifier, caseId: identifier, reviewerId: z.string().trim().min(2).max(128),
  origin: z.literal('human_declared'), humanAttestation: z.literal(true), blindReviewAttested: z.literal(true),
  reviewRoundId: identifier.optional(),
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
  reviewRoundId: identifier.optional(),
  verdict: z.enum(['supports', 'does_not_support', 'unclear']),
  category: z.enum(['role', 'na', 'verification_timing', 'consultation', 'empathy', 'closing', 'gross_violation', 'evidence', 'language', 'other']),
  comment: z.string().trim().min(1).max(5000), requestId: identifier,
}).strict();
const freshRoundSchema = z.object({ manifestId: identifier, reviewerId: z.string().trim().min(2).max(128), requestId: identifier, expectedRoundId: identifier }).strict();
type JsonRow = { json: string };
const deserialize = <T>(row: JsonRow): T => JSON.parse(row.json) as T;
const resolvedResult = (judgment: HumanJudgment): CriterionResult => ({
  criterionId: judgment.criterionId, answer: judgment.answer!, explanation: judgment.explanation,
  applicabilityRationale: judgment.applicabilityRationale, evidence: judgment.evidence,
  checkedRange: judgment.checkedRange, reviewRequired: false, uncertainty: '',
});
const ratio = (matches: number, total: number) => total ? matches / total : null;
export const comparisonSelectionPolicy = 'first-valid-in-recorded-run-order' as const;
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const eligibleReference = (manifest: ValidationManifest, item: ValidationCase, references: HumanReference[]) => references.filter(r => r.origin === 'human_declared' && r.humanAttestation === true && r.blindReviewAttested === true && r.manifestId === manifest.id && r.caseId === item.id && r.conversationVersion === item.conversationVersion && r.checklistVersion === item.checklistVersion).at(-1);
function selectModel(manifest: ValidationManifest, item: ValidationCase, attempts: ValidationAttempt[], evaluations: Evaluation[], conversation?: Conversation, checklist?: Checklist) {
  const rejected: Evaluation[] = [];
  for (const run of attempts.filter(a => a.caseId === item.id && a.status === 'success' && a.model === manifest.model)) {
    const model = evaluations.find(e => e.id === run.evaluationId && e.status === 'live_validated' && e.origin === 'ai' && e.provider === 'gemini' && e.mode === 'free' && e.model === manifest.model && e.conversationVersion === item.conversationVersion && e.checklistVersion === item.checklistVersion);
    if (!model || !conversation || !checklist) continue;
    try { validateEvidence(conversation, checklist, { results: model.results }); calculateScore(checklist, model.results); }
    catch { rejected.push(model); continue; }
    return { model, run, rejected };
  }
  return { model: undefined, run: undefined, rejected };
}
/** A total needs every weighted criterion. Unresolved independent flags stay absent. */
function weightedReferenceScore(reference: HumanReference | undefined, checklist: Checklist): Score | null {
  const required = checklist.criteria.filter(c => !c.flag && c.weight > 0);
  if (!reference || !required.length || required.some(c => !reference.judgments.some(j => j.criterionId === c.id && j.resolved && j.answer !== null))) return null;
  const visible = checklist.criteria.filter(c => reference.judgments.some(j => j.criterionId === c.id && j.resolved && j.answer !== null));
  return calculateScore({ ...checklist, criteria: visible }, reference.judgments.filter(j => visible.some(c => c.id === j.criterionId)).map(resolvedResult));
}

/** Human judgments live in separate append-only tables, never inferred from evaluations. */
export class QualityStore {
  private readonly db: DatabaseSync;
  constructor(path: string, options: { readOnly?: boolean } = {}) {
    if (!options.readOnly && path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    if (options.readOnly) return;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS quality_manifests(id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quality_references(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, manifest_id TEXT NOT NULL, case_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quality_runs(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, manifest_id TEXT NOT NULL, case_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quality_evidence_reviews(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, manifest_id TEXT NOT NULL, case_id TEXT NOT NULL, evaluation_id TEXT NOT NULL, criterion_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quality_requests(request_id TEXT PRIMARY KEY, operation TEXT NOT NULL, payload TEXT NOT NULL, result_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quality_review_rounds(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, manifest_id TEXT NOT NULL, json TEXT NOT NULL);
    `);
    for (const table of ['quality_manifests', 'quality_references', 'quality_runs', 'quality_evidence_reviews', 'quality_requests', 'quality_review_rounds']) {
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
  listReviewRounds(manifestId: string, cutoff?: string): HumanReviewRound[] {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='quality_review_rounds'").get()) return [];
    return (this.db.prepare('SELECT json FROM quality_review_rounds WHERE manifest_id=? ORDER BY sequence').all(manifestId) as JsonRow[]).map(deserialize<HumanReviewRound>).filter(round => !cutoff || Date.parse(round.createdAt!) <= Date.parse(cutoff));
  }
  getReviewRound(manifestId: string, cutoff?: string): HumanReviewRound {
    return this.listReviewRounds(manifestId, cutoff).at(-1) ?? { id: 'legacy', manifestId, reviewerId: null, createdAt: null, previousRoundId: null, requestId: null, supersededReviewerIds: [], origin: 'legacy', note: 'Legacy blind-review history. Human origin and blindness are self-attested.' };
  }
  listReferenceHistory(manifestId: string, cutoff?: string): HumanReference[] {
    return (this.db.prepare('SELECT json FROM quality_references WHERE manifest_id=? ORDER BY sequence').all(manifestId) as JsonRow[]).map(deserialize<HumanReference>).filter(ref => !cutoff || Date.parse(ref.createdAt) <= Date.parse(cutoff));
  }
  listReferences(manifestId: string, options: { includeSuperseded?: boolean; cutoff?: string } = {}): HumanReference[] {
    const history = this.listReferenceHistory(manifestId, options.cutoff);
    const roundId = this.getReviewRound(manifestId, options.cutoff).id;
    return options.includeSuperseded ? history : history.filter(ref => (ref.reviewRoundId ?? 'legacy') === roundId);
  }
  getReference(manifestId: string, caseId: string): HumanReference | undefined { return this.listReferences(manifestId).filter(ref => ref.caseId === caseId).at(-1); }
  private assertReviewRound(manifestId: string, requested?: string) {
    const round = this.getReviewRound(manifestId);
    if ((requested ?? 'legacy') !== round.id) throw new Error('REVIEW_ROUND_CHANGED');
    return round;
  }
  private nextHumanTimestamp(manifestId: string) {
    const times = [...this.listReferenceHistory(manifestId).map(r => r.createdAt), ...this.listEvidenceReviewHistory(manifestId).map(r => r.createdAt), ...this.listReviewRounds(manifestId).flatMap(r => r.createdAt ? [r.createdAt] : [])].map(Date.parse);
    return new Date(Math.max(Date.now(), ...times.map(time => time + 1))).toISOString();
  }
  startFreshReviewRound(raw: unknown): HumanReviewRound {
    const input = freshRoundSchema.parse(raw);
    if (!this.getManifest(input.manifestId)) throw new Error('VALIDATION_SOURCE_RESTRICTED');
    return this.idempotent(input.requestId, 'fresh-human-review-round', input, () => {
      const previous = this.assertReviewRound(input.manifestId, input.expectedRoundId);
      const round: HumanReviewRound = { id: randomUUID(), manifestId: input.manifestId, reviewerId: input.reviewerId, createdAt: this.nextHumanTimestamp(input.manifestId), previousRoundId: previous.id, requestId: input.requestId,
        supersededReviewerIds: [...new Set(this.listReferences(input.manifestId).map(ref => ref.reviewerId))], origin: 'human_requested_reset',
        note: 'Progress reset by explicit human request. Previous labels remain immutable history and are excluded from this current round. Starting again does not restore blindness after prior model exposure; independent blind review remains self-attested.' };
      this.db.prepare('INSERT INTO quality_review_rounds(id,manifest_id,json) VALUES(?,?,?)').run(round.id, round.manifestId, canonicalJson(round));
      return round;
    }, existing => { if (this.getReviewRound(input.manifestId).id !== existing.id) throw new Error('REVIEW_ROUND_CHANGED'); });
  }
  private idempotent<T>(requestId: string, operation: string, payload: unknown, create: () => T, validateExisting?: (result: T) => void): T {
    const signature = canonicalJson(payload);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT operation,payload,result_json FROM quality_requests WHERE request_id=?').get(requestId) as { operation: string; payload: string; result_json: string } | undefined;
      if (existing) {
        if (existing.operation !== operation || existing.payload !== signature) throw new Error('IDEMPOTENCY_CONFLICT');
        const result = JSON.parse(existing.result_json) as T;
        validateExisting?.(result);
        this.db.exec('COMMIT'); return result;
      }
      const result = create();
      this.db.prepare('INSERT INTO quality_requests(request_id,operation,payload,result_json) VALUES(?,?,?,?)').run(requestId, operation, signature, canonicalJson(result));
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  saveReference(conversation: Conversation, checklist: Checklist, raw: unknown): HumanReference {
    const input = referenceInputSchema.parse(raw);
    this.assertReviewRound(input.manifestId, input.reviewRoundId);
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
      const round = this.assertReviewRound(input.manifestId, input.reviewRoundId);
      const reference: HumanReference = { ...input, reviewRoundId: round.id, id: randomUUID(), createdAt: this.nextHumanTimestamp(input.manifestId), conversationVersion: conversation.version, checklistVersion: checklist.version, score: resolved.length === checklist.criteria.length ? calculateScore(checklist, resolved.map(resolvedResult)) : null };
      this.db.prepare('INSERT INTO quality_references(id,manifest_id,case_id,json) VALUES(?,?,?,?)').run(reference.id, input.manifestId, input.caseId, canonicalJson(reference));
      return reference;
    }, () => { this.assertReviewRound(input.manifestId, input.reviewRoundId); });
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
    this.assertReviewRound(input.manifestId, input.reviewRoundId);
    const { manifest, item, checklist } = this.context(input.manifestId, input.caseId, store);
    if (!this.getReference(input.manifestId, input.caseId)?.judgments.some(j => j.criterionId === input.criterionId && j.resolved)) throw new Error('BLIND_REFERENCE_REQUIRED');
    const evaluation = store.getEvaluation(input.evaluationId);
    if (!evaluation || evaluation.status !== 'live_validated' || evaluation.provider !== 'gemini' || evaluation.model !== manifest.model || evaluation.conversationVersion !== item.conversationVersion || evaluation.checklistVersion !== checklist.version || !evaluation.results.some(r => r.criterionId === input.criterionId)) throw new Error('VALIDATION_RUN_MISMATCH');
    return this.idempotent(input.requestId, 'human-evidence-review', input, () => {
      const round = this.assertReviewRound(input.manifestId, input.reviewRoundId);
      const review: HumanEvidenceReview = { ...input, reviewRoundId: round.id, id: randomUUID(), createdAt: this.nextHumanTimestamp(input.manifestId) };
      this.db.prepare('INSERT INTO quality_evidence_reviews(id,manifest_id,case_id,evaluation_id,criterion_id,json) VALUES(?,?,?,?,?,?)').run(review.id, input.manifestId, input.caseId, input.evaluationId, input.criterionId, canonicalJson(review));
      return review;
    }, () => { this.assertReviewRound(input.manifestId, input.reviewRoundId); });
  }
  listEvidenceReviewHistory(manifestId: string, cutoff?: string): HumanEvidenceReview[] { return (this.db.prepare('SELECT json FROM quality_evidence_reviews WHERE manifest_id=? ORDER BY sequence').all(manifestId) as JsonRow[]).map(deserialize<HumanEvidenceReview>).filter(review => !cutoff || Date.parse(review.createdAt) <= Date.parse(cutoff)); }
  listEvidenceReviews(manifestId: string, options: { includeSuperseded?: boolean; cutoff?: string } = {}): HumanEvidenceReview[] {
    const history = this.listEvidenceReviewHistory(manifestId, options.cutoff);
    const roundId = this.getReviewRound(manifestId, options.cutoff).id;
    return options.includeSuperseded ? history : history.filter(review => (review.reviewRoundId ?? 'legacy') === roundId);
  }
  getCase(manifestId: string, caseId: string, store: Store) {
    const { manifest, item, conversation, checklist } = this.context(manifestId, caseId, store);
    const reference = this.getReference(manifestId, caseId);
    const selected = selectModel(manifest, item, this.listRuns(manifestId), store.listEvaluations(), conversation, checklist);
    // Model outputs are never returned by this blind route until an actual declared human reference exists.
    const model = reference ? selected.model : undefined;
    const visibleResults = model?.results.filter(result => reference!.judgments.some(j => j.criterionId === result.criterionId && j.resolved));
    const referenceScore = weightedReferenceScore(reference, checklist);
    const modelScore = model && referenceScore ? calculateScore({ ...checklist, criteria: checklist.criteria.filter(c => visibleResults!.some(r => r.criterionId === c.id)) }, visibleResults!) : null;
    return { case: item, conversation, checklist, reviewRound: this.getReviewRound(manifestId), reference: reference ?? null, referenceNumericScore: referenceScore, selectionPolicy: comparisonSelectionPolicy, modelEvaluation: model ? { id: model.id, model: model.model, results: visibleResults ?? [], score: modelScore } : null };
  }
  getDashboard(store: Store, manifestId?: string) {
    const manifest = this.getManifest(manifestId);
    if (!manifest) return { manifest: null, manifests: [], cases: [], referenceCount: 0, metrics: null };
    const references = manifest.cases.flatMap(c => { const ref = this.getReference(manifest.id, c.id); return ref ? [ref] : []; });
    const runs = this.listRuns(manifest.id);
    const cases = manifest.cases.map(item => ({ ...item, humanReferenceSaved: references.some(r => r.caseId === item.id), lastRunStatus: runs.filter(r => r.caseId === item.id).at(-1)?.status ?? 'not_run' }));
    const frozenSources = manifest.cases.flatMap(item => { const conversation = store.getConversation(item.conversationVersion); return conversation ? [conversation] : []; });
    const reviewRound = this.getReviewRound(manifest.id);
    return { manifest, manifests: this.listManifests().map(m => ({ id: m.id, title: m.title })), cases, reviewRound, referenceHistoryCount: this.listReferenceHistory(manifest.id).length, referenceCount: references.length, metrics: { ...computeValidationMetrics(manifest, references, runs, store.listEvaluations(), frozenSources, store.listChecklists(), this.listEvidenceReviews(manifest.id)), reviewRoundId: reviewRound.id, reviewRoundNote: reviewRound.note } };
  }
  /** Read-only snapshot. Never exports hidden model answers for unresolved human criteria. */
  exportComparison(store: Pick<Store, 'getConversation' | 'listEvaluations' | 'listChecklists'>, manifestId?: string, cutoff = new Date().toISOString()) {
    const parsedCutoff = z.string().datetime().parse(cutoff);
    const manifest = this.getManifest(manifestId);
    if (!manifest || Date.parse(manifest.createdAt) > Date.parse(parsedCutoff)) throw new Error('VALIDATION_MANIFEST_NOT_FOUND_AT_CUTOFF');
    const included = (value: { createdAt: string }) => Date.parse(value.createdAt) <= Date.parse(parsedCutoff);
    const reviewRound = this.getReviewRound(manifest.id, parsedCutoff);
    const referenceHistory = this.listReferenceHistory(manifest.id, parsedCutoff);
    const references = this.listReferences(manifest.id, { cutoff: parsedCutoff });
    const attempts = this.listRuns(manifest.id).filter(included);
    const evidenceReviews = this.listEvidenceReviews(manifest.id, { cutoff: parsedCutoff });
    const evaluations = store.listEvaluations().filter(included);
    const conversations = manifest.cases.flatMap(item => { const c = store.getConversation(item.conversationVersion); return c ? [c] : []; });
    const checklists = store.listChecklists().filter(c => manifest.cases.some(item => item.checklistVersion === c.version));
    const comparisons: Array<{ caseId: string; split: ValidationCase['split']; language: string; criterionId: string; referenceId: string; evaluationId: string; matches: boolean; human: HumanJudgment; model: CriterionResult }> = [];
    const selected = manifest.cases.map(item => {
      const source = conversations.find(c => c.version === item.conversationVersion);
      const checklist = checklists.find(c => c.version === item.checklistVersion);
      const ref = eligibleReference(manifest, item, references);
      const { model, run, rejected } = selectModel(manifest, item, attempts, evaluations, source, checklist);
      if (ref && model) for (const judgment of ref.judgments.filter(j => j.resolved && j.answer !== null)) {
        const result = model.results.find(r => r.criterionId === judgment.criterionId);
        if (result) comparisons.push({ caseId: item.id, split: item.split, language: item.language, criterionId: judgment.criterionId, referenceId: ref.id, evaluationId: model.id, matches: judgment.answer === result.answer, human: judgment, model: result });
      }
      return { caseId: item.id, split: item.split, language: item.language, conversationVersion: item.conversationVersion, sourceHash: source ? hash(source) : null, checklistVersion: item.checklistVersion, checklistHash: checklist ? hash(checklist) : null,
        humanReference: ref ? { id: ref.id, hash: hash(ref), createdAt: ref.createdAt, reviewerId: ref.reviewerId, origin: ref.origin, humanAttestation: ref.humanAttestation, blindReviewAttested: ref.blindReviewAttested, resolvedCriteria: ref.judgments.filter(j => j.resolved).map(j => j.criterionId), unresolvedCriteria: ref.judgments.filter(j => !j.resolved).map(j => j.criterionId) } : null,
        selectedEvaluation: model ? { id: model.id, hash: hash(model), recordedAttemptId: run!.id, createdAt: model.createdAt, provider: model.provider, model: model.model, mode: model.mode, configuration: model.configuration, configurationHash: hash(model.configuration), evidenceValidation: 'passed' } : null,
        rejectedSuccessfulEvaluationIds: rejected.map(e => e.id) };
    });
    const body = { schemaVersion: 1, comparisonProtocolVersion: 'human-comparison-v3-review-rounds', comparatorSourceHash: createHash('sha256').update(readFileSync(new URL(import.meta.url), 'utf8').replaceAll('\r\n', '\n')).digest('hex'), cutoff: parsedCutoff, selectionPolicy: comparisonSelectionPolicy, scope: 'private-local-human-comparison', reviewRound,
      manifest, manifestHash: hash(manifest), provenance: { hashAlgorithm: 'sha256-canonical-json', sourceRevision: manifest.sourceRevision, cases: selected,
        referenceHistory: referenceHistory.map(r => ({ id: r.id, hash: hash(r), createdAt: r.createdAt, reviewRoundId: r.reviewRoundId ?? 'legacy', includedInCurrentRound: (r.reviewRoundId ?? 'legacy') === reviewRound.id })), reviewRoundHistory: this.listReviewRounds(manifest.id, parsedCutoff),
        attemptHistory: attempts, evidenceReviewHistory: this.listEvidenceReviewHistory(manifest.id, parsedCutoff).map(r => ({ id: r.id, hash: hash(r), evaluationId: r.evaluationId, criterionId: r.criterionId, createdAt: r.createdAt, reviewRoundId: r.reviewRoundId ?? 'legacy', includedInCurrentRound: (r.reviewRoundId ?? 'legacy') === reviewRound.id })) },
      comparisons, metrics: { ...computeValidationMetrics(manifest, references, attempts, evaluations, conversations, checklists, evidenceReviews), reviewRoundId: reviewRound.id, reviewRoundNote: reviewRound.note },
      limitations: ['Human origin and blind review are self-attested, not externally authenticated.', 'A fresh round excludes prior progress but does not restore blindness after previous model exposure.', 'No missing labels are imputed. AI, manual demos and software fixtures are not independent gold.', 'Evidence exactness is technical; semantic support requires a separate human review.', 'First valid result in append-only recorded run order; later reruns never replace it.', 'Cutoff uses immutable record timestamps and the active review round at that cutoff; hashes identify exact private source snapshots.'] };
    return { ...body, generatedAt: new Date().toISOString(), reportHash: hash(body) };
  }
  close() { this.db.close(); }
}

/** This function compares declared human references only; model outputs never create labels. */
export function computeValidationMetrics(manifest: ValidationManifest, references: HumanReference[], attempts: ValidationAttempt[], evaluations: Evaluation[], conversations: Conversation[], checklists: Checklist[], evidenceReviews: HumanEvidenceReview[] = []) {
  attempts = attempts.filter(a => a.model === manifest.model && manifest.cases.some(c => c.id === a.caseId));
  const criterion: Record<string, { matches: number; total: number; agreement: number | null }> = Object.create(null);
  for (const checklist of checklists.filter(c => manifest.cases.some(item => item.checklistVersion === c.version))) for (const c of checklist.criteria) criterion[c.id] = { matches: 0, total: 0, agreement: null };
  const language: Record<string, { matches: number; total: number; agreement: number | null }> = Object.fromEntries(['RU', 'KZ', 'EN'].map(l => [l, { matches: 0, total: 0, agreement: null }]));
  const split: Record<string, { matches: number; total: number; agreement: number | null }> = Object.fromEntries(['development', 'holdout'].map(s => [s, { matches: 0, total: 0, agreement: null }]));
  const na = { total: 0, falseNA: 0, missedNA: 0, correctNA: 0, correctApplicable: 0 };
  const gross = { total: 0, truePositive: 0, trueNegative: 0, falsePositive: 0, falseNegative: 0 };
  const scoreErrors: Array<{ caseId: string; split: string; language: string; referenceTotal: number; modelTotal: number; absoluteError: number }> = [];
  const disagreements: Array<{ caseId: string; split: string; language: string; criterionId: string; expected: string; actual: string; category: string; humanExplanation: string; modelExplanation: string; referenceId: string; evaluationId: string }> = [];
  const semanticProbes: Array<{ caseId: string; humanReferenceAvailable: boolean; modelEvaluationAvailable: boolean; matches: number | null; resolved: number }> = [];
  const technical = { evaluationsChecked: 0, evaluationsValid: 0, quotesChecked: 0, quotesValid: 0, rangesChecked: 0, rangesValid: 0 };
  const coverage = { coreCases: manifest.cases.filter(c => c.kind === 'core').length, expectedHumanJudgments: 0, casesWithReference: 0, casesWithoutReference: 0, casesWithResolvedReference: 0, fullyResolvedCases: 0, weightedCompleteCases: 0, casesWithAcceptedModel: 0, casesWithoutAcceptedModel: 0, unannotatedJudgments: 0, excludedInvalidModelResults: 0 };
  const selectedModels = new Map<string, { item: ValidationCase; model: Evaluation; reference: HumanReference | undefined }>();
  let comparedCases = 0; let resolvedHumanJudgments = 0; let unresolvedHumanJudgments = 0;
  for (const item of manifest.cases) {
    const reference = eligibleReference(manifest, item, references);
    const conversation = conversations.find(c => c.version === item.conversationVersion);
    const checklist = checklists.find(c => c.version === item.checklistVersion);
    const selection = selectModel(manifest, item, attempts, evaluations, conversation, checklist);
    const model = selection.model;
    coverage.excludedInvalidModelResults += selection.rejected.length;
    if (model) selectedModels.set(item.id, { item, model, reference });
    for (const candidate of [...selection.rejected, ...(model ? [model] : [])]) if (conversation && checklist) {
      technical.evaluationsChecked++;
      try { validateEvidence(conversation, checklist, { results: candidate.results }); calculateScore(checklist, candidate.results); technical.evaluationsValid++; } catch { /* Never include an invalid result in agreement. */ }
      for (const result of candidate.results) {
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
    const resolved = reference?.judgments.filter(j => j.resolved && j.answer !== null) ?? [];
    coverage.expectedHumanJudgments += checklist?.criteria.length ?? 0;
    if (reference) {
      coverage.casesWithReference++;
      resolvedHumanJudgments += resolved.length; unresolvedHumanJudgments += reference.judgments.filter(j => !j.resolved).length;
      if (resolved.length) coverage.casesWithResolvedReference++;
      if (checklist && resolved.length === checklist.criteria.length) coverage.fullyResolvedCases++;
      if (checklist && weightedReferenceScore(reference, checklist)) coverage.weightedCompleteCases++;
    } else coverage.casesWithoutReference++;
    coverage.unannotatedJudgments += (checklist?.criteria.length ?? 0) - resolved.length;
    if (model) coverage.casesWithAcceptedModel++; else coverage.casesWithoutAcceptedModel++;
    if (!reference || !resolved.length || !model || !checklist) continue;
    comparedCases++;
    for (const human of resolved) {
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
    const referenceScore = weightedReferenceScore(reference, checklist);
    const modelScore = calculateScore(checklist, model.results);
    if (referenceScore?.total !== null && referenceScore?.total !== undefined && modelScore.total !== null) scoreErrors.push({ caseId: item.id, split: item.split, language: item.language, referenceTotal: referenceScore.total, modelTotal: modelScore.total, absoluteError: Math.abs(referenceScore.total - modelScore.total) });
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
  for (const review of evidenceReviews) {
    const selected = selectedModels.get(review.caseId);
    if (review.humanAttestation === true && review.manifestId === manifest.id && selected?.item.kind === 'core' && selected.model.id === review.evaluationId && selected.reference?.judgments.some(j => j.criterionId === review.criterionId && j.resolved && j.answer !== null) && selected.model.results.some(r => r.criterionId === review.criterionId)) evidenceReviewMap.set(`${review.caseId}:${review.evaluationId}:${review.criterionId}`, review);
  }
  const eligibleEvidenceReviews = [...evidenceReviewMap.values()];
  const semanticEvidence = { supported: eligibleEvidenceReviews.filter(r => r.verdict === 'supports').length, unsupported: eligibleEvidenceReviews.filter(r => r.verdict === 'does_not_support').length, unresolved: eligibleEvidenceReviews.filter(r => r.verdict === 'unclear').length };
  return {
    status: resolvedHumanJudgments ? coverage.fullyResolvedCases === coverage.coreCases ? 'complete_human_review' : 'partial_human_review' : 'awaiting_human_review',
    selectionPolicy: comparisonSelectionPolicy, coverage,
    humanReviewedCases: coverage.casesWithResolvedReference,
    resolvedHumanJudgments, unresolvedHumanJudgments, comparedCases,
    byCriterion: criterion, byLanguage: language, bySplit: split,
    na: { ...na, available: na.total > 0, referenceNA: na.correctNA + na.missedNA, referenceApplicable: na.correctApplicable + na.falseNA, falseNARate: ratio(na.falseNA, na.correctApplicable + na.falseNA), missedNARate: ratio(na.missedNA, na.correctNA + na.missedNA) },
    grossViolations: { ...gross, available: gross.total > 0, referencePositives: gross.truePositive + gross.falseNegative, referenceNegatives: gross.trueNegative + gross.falsePositive, precision: ratio(gross.truePositive, gross.truePositive + gross.falsePositive), recall: ratio(gross.truePositive, gross.truePositive + gross.falseNegative), specificity: ratio(gross.trueNegative, gross.trueNegative + gross.falsePositive) },
    totalScoreError: { basis: 'all-weighted-criteria-resolved-independent-flags-excluded', dialogs: scoreErrors.length, meanAbsoluteError: scoreErrors.length ? scoreErrors.reduce((n, r) => n + r.absoluteError, 0) / scoreErrors.length : null, maxAbsoluteError: scoreErrors.length ? Math.max(...scoreErrors.map(r => r.absoluteError)) : null, cases: scoreErrors,
      byLanguage: Object.fromEntries(Object.keys(language).map(key => { const values = scoreErrors.filter(e => e.language === key); return [key, { dialogs: values.length, meanAbsoluteError: values.length ? values.reduce((n, e) => n + e.absoluteError, 0) / values.length : null }]; })),
      bySplit: Object.fromEntries(Object.keys(split).map(key => { const values = scoreErrors.filter(e => e.split === key); return [key, { dialogs: values.length, meanAbsoluteError: values.length ? values.reduce((n, e) => n + e.absoluteError, 0) / values.length : null }]; })) },
    evidence: { ...technical, evaluationValidity: ratio(technical.evaluationsValid, technical.evaluationsChecked), quoteValidity: ratio(technical.quotesValid, technical.quotesChecked), humanSemantic: { ...semanticEvidence, reviewed: eligibleEvidenceReviews.length, resolvedVerdicts: semanticEvidence.supported + semanticEvidence.unsupported, supportRate: ratio(semanticEvidence.supported, semanticEvidence.supported + semanticEvidence.unsupported), available: eligibleEvidenceReviews.length > 0 } },
    reliability: { attempts: attempts.length, successes: attempts.filter(a => a.status === 'success').length, failures: attempts.filter(a => a.status === 'failed').length, errors, latencyMs: { count: latencies.length, min: latencies[0] ?? null, median: medianLatency, p95: latencies.length ? latencies[Math.max(0, Math.ceil(latencies.length * .95) - 1)] : null, max: latencies.at(-1) ?? null }, reportedTokens: attempts.reduce((n, a) => n + (a.usage.totalTokens ?? 0), 0), unknownTokenUsageAttempts: attempts.filter(a => a.usage.totalTokens == null).length, knownProviderCalls: attempts.reduce((n, a) => n + (a.providerCallCount ?? 0), 0), unknownProviderCallAttempts: attempts.filter(a => a.providerCallCount === null).length },
    materialDisagreements: disagreements.map(disagreement => {
      const review = evidenceReviewMap.get(`${disagreement.caseId}:${disagreement.evaluationId}:${disagreement.criterionId}`);
      return { ...disagreement, reviewStatus: review ? 'human_analyzed' : 'awaiting_human_analysis', humanCategory: review?.category ?? null, humanAnalysis: review?.comment ?? null, evidenceVerdict: review?.verdict ?? null };
    }), semanticProbes,
    note: 'Only explicitly declared blind human judgments enter agreement metrics. Missing and unresolved references are excluded; coverage is separate. First technically valid saved Gemini result is selected in recorded run order, never a best or latest rerun. Total-score error requires all weighted criteria; independent flags are compared separately. Agent proposals, manual demos and model-generated labels never form a reference. A self-attestation is not independently authenticated identity.',
  };
}
