import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Checklist, Conversation, Evaluation, EvaluationAttempt } from '../src/domain.js';
import { canonicalJson, type ParsedDataset } from './importer.js';

type JsonRow = { json: string };

/** Local, immutable snapshots. Raw imported records never form part of API views. */
export class Store {
  private readonly db: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS conversations (
        version TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        json TEXT NOT NULL,
        original_json TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversations_group ON conversations(group_id, conversation_id);
      CREATE TABLE IF NOT EXISTS checklists (
        version TEXT PRIMARY KEY,
        checklist_id TEXT NOT NULL,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evaluations (
        id TEXT PRIMARY KEY,
        conversation_version TEXT NOT NULL REFERENCES conversations(version),
        checklist_version TEXT NOT NULL REFERENCES checklists(version),
        json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evaluation_attempts (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS evaluation_one_recovery ON evaluation_attempts(json_extract(json,'$.recoveryOf')) WHERE json_extract(json,'$.recoveryOf') IS NOT NULL;
    `);
  }

  importDataset(dataset: ParsedDataset): { inserted: number; unchanged: number; total: number } {
    if (dataset.conversations.length !== dataset.originals.length) throw new Error('Import records are inconsistent.');
    let inserted = 0;
    let unchanged = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const find = this.db.prepare('SELECT json, original_json FROM conversations WHERE version = ?');
      const insert = this.db.prepare('INSERT INTO conversations(version, group_id, conversation_id, json, original_json, imported_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (let index = 0; index < dataset.conversations.length; index++) {
        const conversation = dataset.conversations[index];
        if (conversation.groupId !== dataset.groupId) throw new Error('Import group does not match the conversation.');
        const json = canonicalJson(conversation);
        const original = canonicalJson(dataset.originals[index]);
        const existing = find.get(conversation.version) as { json: string; original_json: string } | undefined;
        if (existing) {
          if (existing.json !== json || existing.original_json !== original) throw new Error('An immutable conversation version cannot be changed.');
          unchanged++;
        } else {
          insert.run(conversation.version, conversation.groupId, conversation.conversationId, json, original, new Date().toISOString());
          inserted++;
        }
      }
      this.db.exec('COMMIT');
      return { inserted, unchanged, total: dataset.conversations.length };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listConversations(groupId?: string): Conversation[] {
    // Show the most recently imported version per (group, conversation ID), preserving history.
    const rows = groupId === undefined
      ? this.db.prepare('SELECT json FROM conversations WHERE rowid IN (SELECT MAX(rowid) FROM conversations GROUP BY group_id, conversation_id) ORDER BY group_id, conversation_id').all()
      : this.db.prepare('SELECT json FROM conversations WHERE group_id = ? AND rowid IN (SELECT MAX(rowid) FROM conversations GROUP BY group_id, conversation_id) ORDER BY conversation_id').all(groupId);
    return (rows as JsonRow[]).map(row => JSON.parse(row.json) as Conversation);
  }

  getConversation(version: string): Conversation | undefined {
    const row = this.db.prepare('SELECT json FROM conversations WHERE version = ?').get(version) as JsonRow | undefined;
    return row ? JSON.parse(row.json) as Conversation : undefined;
  }

  /** Server-only original data access for future authorized local playback. */
  getOriginal(version: string): unknown | undefined {
    const row = this.db.prepare('SELECT original_json AS json FROM conversations WHERE version = ?').get(version) as JsonRow | undefined;
    return row ? JSON.parse(row.json) as unknown : undefined;
  }

  saveChecklist(checklist: Checklist): void {
    const json = canonicalJson(checklist);
    const existing = this.db.prepare('SELECT json FROM checklists WHERE version = ?').get(checklist.version) as JsonRow | undefined;
    if (existing) {
      if (existing.json !== json) throw new Error('An immutable checklist version cannot be changed.');
      return;
    }
    this.db.prepare('INSERT INTO checklists(version, checklist_id, json, created_at) VALUES (?, ?, ?, ?)').run(checklist.version, checklist.id, json, new Date().toISOString());
  }

  listChecklists(): Checklist[] {
    return (this.db.prepare('SELECT json FROM checklists ORDER BY rowid DESC').all() as JsonRow[]).map(row => JSON.parse(row.json) as Checklist);
  }

  getChecklist(version: string): Checklist | undefined {
    const row = this.db.prepare('SELECT json FROM checklists WHERE version = ?').get(version) as JsonRow | undefined;
    return row ? JSON.parse(row.json) as Checklist : undefined;
  }

  saveEvaluation(evaluation: Evaluation): void {
    const json = canonicalJson(evaluation);
    const existing = this.db.prepare('SELECT json FROM evaluations WHERE id = ?').get(evaluation.id) as JsonRow | undefined;
    if (existing) {
      if (existing.json !== json) throw new Error('An immutable evaluation cannot be changed.');
      return;
    }
    this.db.prepare('INSERT INTO evaluations(id, conversation_version, checklist_version, json, created_at) VALUES (?, ?, ?, ?, ?)').run(evaluation.id, evaluation.conversationVersion, evaluation.checklistVersion, json, evaluation.createdAt);
  }

  listEvaluations(): Evaluation[] {
    return (this.db.prepare('SELECT json FROM evaluations ORDER BY rowid DESC').all() as JsonRow[]).map(row => JSON.parse(row.json) as Evaluation);
  }

  saveEvaluationWithAttempt(evaluation: Evaluation, attempt: EvaluationAttempt): void {
    if (attempt.status !== 'succeeded' || attempt.evaluationId !== evaluation.id) throw new Error('INVALID_ATTEMPT_RESULT');
    if (evaluation.attemptId !== attempt.id || evaluation.conversationVersion !== attempt.conversationVersion || evaluation.checklistVersion !== attempt.checklistVersion || evaluation.model !== attempt.model) throw new Error('ATTEMPT_RESULT_SOURCE_MISMATCH');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.saveEvaluation(evaluation);
      this.finishEvaluationAttempt(attempt);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  getEvaluation(id: string): Evaluation | undefined {
    const row = this.db.prepare('SELECT json FROM evaluations WHERE id = ?').get(id) as JsonRow | undefined;
    return row ? JSON.parse(row.json) as Evaluation : undefined;
  }

  startEvaluationAttempt(attempt: EvaluationAttempt): void {
    if (attempt.status !== 'running') throw new Error('INVALID_ATTEMPT_STATE');
    if (attempt.recoveryOf && this.getEvaluationRecovery(attempt.recoveryOf)) throw new Error('RECOVERY_ALREADY_STARTED');
    this.db.prepare('INSERT INTO evaluation_attempts(id,json) VALUES (?,?)').run(attempt.id, canonicalJson(attempt));
  }

  getEvaluationAttempt(id: string): EvaluationAttempt | undefined {
    const row = this.db.prepare('SELECT json FROM evaluation_attempts WHERE id=?').get(id) as JsonRow | undefined;
    return row ? JSON.parse(row.json) as EvaluationAttempt : undefined;
  }

  getEvaluationRecovery(id: string): EvaluationAttempt | undefined {
    const row = this.db.prepare("SELECT json FROM evaluation_attempts WHERE json_extract(json,'$.recoveryOf')=?").get(id) as JsonRow | undefined;
    return row ? JSON.parse(row.json) as EvaluationAttempt : undefined;
  }

  updateRunningEvaluationAttempt(attempt: EvaluationAttempt): void {
    const previous = this.getEvaluationAttempt(attempt.id);
    if (!previous || previous.status !== 'running' || attempt.status !== 'running') throw new Error('INVALID_ATTEMPT_STATE');
    this.assertAttemptSource(previous, attempt);
    this.db.prepare('UPDATE evaluation_attempts SET json=? WHERE id=?').run(canonicalJson(attempt), attempt.id);
  }

  private assertAttemptSource(previous: EvaluationAttempt, attempt: EvaluationAttempt): void {
    if (previous.conversationVersion !== attempt.conversationVersion || previous.checklistVersion !== attempt.checklistVersion || previous.model !== attempt.model || previous.startedAt !== attempt.startedAt || (previous.recoveryOf ?? null) !== (attempt.recoveryOf ?? null) || (previous.recoveryDepth ?? 0) !== (attempt.recoveryDepth ?? 0) || (previous.requestId ?? null) !== (attempt.requestId ?? null) || (previous.executorPid ?? null) !== (attempt.executorPid ?? null) || (previous.executorSessionId ?? null) !== (attempt.executorSessionId ?? null)) throw new Error('IMMUTABLE_ATTEMPT_SOURCE');
  }

  finishEvaluationAttempt(attempt: EvaluationAttempt): void {
    const row = this.db.prepare('SELECT json FROM evaluation_attempts WHERE id=?').get(attempt.id) as JsonRow | undefined;
    const previous = row ? JSON.parse(row.json) as EvaluationAttempt : undefined;
    if (!previous || previous.status !== 'running' || attempt.status === 'running') throw new Error('INVALID_ATTEMPT_STATE');
    this.assertAttemptSource(previous, attempt);
    this.db.prepare('UPDATE evaluation_attempts SET json=? WHERE id=?').run(canonicalJson(attempt), attempt.id);
  }

  listEvaluationAttempts(): EvaluationAttempt[] {
    return (this.db.prepare('SELECT json FROM evaluation_attempts ORDER BY rowid DESC').all() as JsonRow[]).map(row => JSON.parse(row.json) as EvaluationAttempt);
  }

  close(): void { this.db.close(); }
}
