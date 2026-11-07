import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { validateChecklist } from '../src/checklist.js';
import type { Checklist, CriterionResult, Evaluation, Score } from '../src/domain.js';
import { calculateScore } from '../src/scoring.js';

export interface Appeal {
  id: string;
  evaluationId: string;
  checklistVersion: string;
  criterionId: string;
  originalAnswer: string;
  contestedAnswer: string;
  originalResult: CriterionResult;
  comment: string;
  requestId: string;
  createdAt: string;
}
export interface ReviewDecision {
  id: string;
  appealId: string;
  evaluationId: string;
  criterionId: string;
  action: 'uphold' | 'change';
  previousAnswer: string;
  answer: string;
  reason: string;
  requestId: string;
  createdAt: string;
  finalScore: Score;
}
export interface ReviewHistory {
  appeals: Appeal[];
  decisions: ReviewDecision[];
  finalAnswers: Record<string, string>;
  finalScore: Score;
}

const requestId = z.string().trim().min(1).max(128);
const rationale = z.string().trim().min(1).max(5_000);
const appealInput = z.object({
  criterionId: z.string().min(1).max(128), comment: rationale, requestId,
}).strict();
const decisionInput = z.object({
  appealId: z.string().min(1).max(128), action: z.enum(['uphold', 'change']),
  answer: z.string().min(1).max(64).optional(), reason: rationale, requestId,
}).strict().superRefine((input, ctx) => {
  if (input.action === 'change' && input.answer === undefined) ctx.addIssue({ code: 'custom', message: 'A changed answer is required' });
  if (input.action === 'uphold' && input.answer !== undefined) ctx.addIssue({ code: 'custom', message: 'Uphold must not replace the answer' });
});

function canonical(input: unknown): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
    return value;
  };
  return JSON.stringify(normalize(input));
}
type JsonRow = { json: string };

/** Append-only local audit trail. The original model evaluation is never edited. */
export class ReviewStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS review_sources (
        evaluation_id TEXT PRIMARY KEY,
        evaluation_json TEXT NOT NULL,
        checklist_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_appeals (
        id TEXT PRIMARY KEY,
        evaluation_id TEXT NOT NULL REFERENCES review_sources(evaluation_id),
        criterion_id TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS review_appeals_evaluation ON review_appeals(evaluation_id);
      CREATE TABLE IF NOT EXISTS review_decisions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        appeal_id TEXT NOT NULL UNIQUE REFERENCES review_appeals(id),
        evaluation_id TEXT NOT NULL REFERENCES review_sources(evaluation_id),
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS review_decisions_evaluation ON review_decisions(evaluation_id, sequence);
      CREATE TABLE IF NOT EXISTS review_requests (
        request_id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        payload TEXT NOT NULL,
        result_id TEXT NOT NULL
      );
    `);
    for (const table of ['review_sources', 'review_appeals', 'review_decisions', 'review_requests']) {
      for (const operation of ['UPDATE', 'DELETE']) {
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${operation.toLowerCase()}_blocked BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'Review history is append-only'); END;`);
      }
    }
  }

  createAppeal(evaluation: Evaluation, checklist: Checklist, input: z.input<typeof appealInput>): Appeal {
    const parsed = appealInput.parse(input);
    return this.transaction(() => {
      this.ensureSnapshot(evaluation, checklist);
      const payload = canonical({ evaluationId: evaluation.id, ...parsed });
      const replay = this.replay<Appeal>(parsed.requestId, 'appeal', payload);
      if (replay) return replay;
      const originalResult = evaluation.results.find(result => result.criterionId === parsed.criterionId);
      if (!originalResult) throw new Error('UNKNOWN_CRITERION');
      const history = this.readHistory(evaluation, checklist);
      const appeal: Appeal = {
        id: randomUUID(), evaluationId: evaluation.id, checklistVersion: evaluation.checklistVersion,
        criterionId: parsed.criterionId, originalAnswer: originalResult.answer,
        contestedAnswer: history.finalAnswers[parsed.criterionId], originalResult: structuredClone(originalResult),
        comment: parsed.comment, requestId: parsed.requestId, createdAt: new Date().toISOString(),
      };
      this.db.prepare('INSERT INTO review_appeals(id, evaluation_id, criterion_id, json) VALUES (?, ?, ?, ?)')
        .run(appeal.id, evaluation.id, appeal.criterionId, JSON.stringify(appeal));
      this.recordRequest(parsed.requestId, 'appeal', payload, appeal.id);
      return appeal;
    });
  }

  decide(evaluation: Evaluation, checklist: Checklist, input: z.input<typeof decisionInput>): ReviewDecision {
    const parsed = decisionInput.parse(input);
    return this.transaction(() => {
      this.ensureSnapshot(evaluation, checklist);
      const payload = canonical({ evaluationId: evaluation.id, ...parsed });
      const replay = this.replay<ReviewDecision>(parsed.requestId, 'decision', payload);
      if (replay) return replay;
      const row = this.db.prepare('SELECT json FROM review_appeals WHERE id = ? AND evaluation_id = ?')
        .get(parsed.appealId, evaluation.id) as JsonRow | undefined;
      if (!row) throw new Error('APPEAL_NOT_FOUND');
      const appeal = JSON.parse(row.json) as Appeal;
      if (this.db.prepare('SELECT id FROM review_decisions WHERE appeal_id = ?').get(appeal.id)) throw new Error('APPEAL_ALREADY_REVIEWED');
      const history = this.readHistory(evaluation, checklist);
      const previousAnswer = history.finalAnswers[appeal.criterionId];
      if (previousAnswer !== appeal.contestedAnswer) throw new Error('STALE_APPEAL');
      const answer = parsed.action === 'uphold' ? appeal.contestedAnswer : parsed.answer!;
      if (parsed.action === 'change' && answer === previousAnswer) throw new Error('CHANGED_ANSWER_MUST_DIFFER');
      const finalAnswers = { ...history.finalAnswers, [appeal.criterionId]: answer };
      // Validation uses the immutable original checklist version, with no model call.
      const finalScore = calculateScore(checklist, Object.entries(finalAnswers).map(([criterionId, value]) => ({ criterionId, answer: value })));
      const decision: ReviewDecision = {
        id: randomUUID(), appealId: appeal.id, evaluationId: evaluation.id, criterionId: appeal.criterionId,
        action: parsed.action, previousAnswer, answer, reason: parsed.reason, requestId: parsed.requestId,
        createdAt: new Date().toISOString(), finalScore,
      };
      this.db.prepare('INSERT INTO review_decisions(id, appeal_id, evaluation_id, json) VALUES (?, ?, ?, ?)')
        .run(decision.id, appeal.id, evaluation.id, JSON.stringify(decision));
      this.recordRequest(parsed.requestId, 'decision', payload, decision.id);
      return decision;
    });
  }

  getHistory(evaluation: Evaluation, checklist: Checklist): ReviewHistory {
    return this.transaction(() => {
      this.ensureSnapshot(evaluation, checklist);
      return this.readHistory(evaluation, checklist);
    });
  }

  private ensureSnapshot(evaluation: Evaluation, checklist: Checklist): void {
    validateChecklist(checklist);
    if (!evaluation.id || evaluation.checklistVersion !== checklist.version) throw new Error('CHECKLIST_VERSION_MISMATCH');
    const expectedScore = calculateScore(checklist, evaluation.results);
    if (canonical(expectedScore) !== canonical(evaluation.score)) throw new Error('ORIGINAL_SCORE_MISMATCH');
    const evaluationJson = canonical(evaluation);
    const checklistJson = canonical(checklist);
    const existing = this.db.prepare('SELECT evaluation_json, checklist_json FROM review_sources WHERE evaluation_id = ?')
      .get(evaluation.id) as { evaluation_json: string; checklist_json: string } | undefined;
    if (existing) {
      if (existing.evaluation_json !== evaluationJson || existing.checklist_json !== checklistJson) throw new Error('IMMUTABLE_REVIEW_SOURCE_CHANGED');
    } else {
      this.db.prepare('INSERT INTO review_sources(evaluation_id, evaluation_json, checklist_json) VALUES (?, ?, ?)')
        .run(evaluation.id, evaluationJson, checklistJson);
    }
  }

  private readHistory(evaluation: Evaluation, checklist: Checklist): ReviewHistory {
    const appeals = (this.db.prepare('SELECT json FROM review_appeals WHERE evaluation_id = ? ORDER BY rowid').all(evaluation.id) as JsonRow[])
      .map(row => JSON.parse(row.json) as Appeal);
    const decisions = (this.db.prepare('SELECT json FROM review_decisions WHERE evaluation_id = ? ORDER BY sequence').all(evaluation.id) as JsonRow[])
      .map(row => JSON.parse(row.json) as ReviewDecision);
    const finalAnswers: Record<string, string> = Object.create(null);
    for (const result of evaluation.results) finalAnswers[result.criterionId] = result.answer;
    for (const decision of decisions) finalAnswers[decision.criterionId] = decision.answer;
    const finalScore = calculateScore(checklist, Object.entries(finalAnswers).map(([criterionId, answer]) => ({ criterionId, answer })));
    return { appeals, decisions, finalAnswers, finalScore };
  }

  private replay<T extends Appeal | ReviewDecision>(id: string, operation: 'appeal' | 'decision', payload: string): T | undefined {
    const request = this.db.prepare('SELECT operation, payload, result_id FROM review_requests WHERE request_id = ?')
      .get(id) as { operation: string; payload: string; result_id: string } | undefined;
    if (!request) return undefined;
    if (request.operation !== operation || request.payload !== payload) throw new Error('IDEMPOTENCY_CONFLICT');
    const table = operation === 'appeal' ? 'review_appeals' : 'review_decisions';
    const row = this.db.prepare(`SELECT json FROM ${table} WHERE id = ?`).get(request.result_id) as JsonRow | undefined;
    if (!row) throw new Error('REVIEW_HISTORY_INCONSISTENT');
    return JSON.parse(row.json) as T;
  }

  private recordRequest(id: string, operation: string, payload: string, resultId: string): void {
    this.db.prepare('INSERT INTO review_requests(request_id, operation, payload, result_id) VALUES (?, ?, ?, ?)')
      .run(id, operation, payload, resultId);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.db.close(); }
}
