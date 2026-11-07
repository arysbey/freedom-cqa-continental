import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Conversation } from '../src/domain.js';
import { canonicalJson } from './importer.js';

const inputSchema = z.object({
  reviewer: z.string().trim().min(2).max(128), reason: z.string().trim().min(1).max(5000),
  syntheticAttestation: z.literal(true), freeTierUseApproved: z.literal(true),
  origin: z.literal('human_declared'), requestId: z.string().trim().min(1).max(128),
}).strict();
const batchInputSchema = inputSchema.extend({
  groupId: z.string().trim().min(1).max(128),
  conversationVersions: z.array(z.string().trim().min(1).max(512)).min(1).max(100_000),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export interface BatchPermissionPreview {
  groupId: string;
  conversationVersions: string[];
  sourceFingerprint: string;
  eligibleCount: number;
}
export interface BatchDataPermission extends z.infer<typeof batchInputSchema> {
  id: string;
  createdAt: string;
  eligibleCount: number;
  approvalIds: string[];
  scope: 'one-immutable-synthetic-chat-batch';
}
export interface DataPermission extends z.infer<typeof inputSchema> {
  id: string; conversationVersion: string; sourceFingerprint: string; createdAt: string;
  scope: 'one-immutable-synthetic-chat-version';
}
function eligible(conversation: Conversation): boolean {
  return conversation.classification === 'unknown' && conversation.channel === 'agent chat' && conversation.audioAvailable === false;
}
/** The original record's immutable version plus every normalized source field is bound. */
export function conversationFingerprint(conversation: Conversation): string {
  const { classification: _derivedClassification, ...source } = conversation;
  void _derivedClassification;
  return createHash('sha256').update(canonicalJson(source), 'utf8').digest('hex');
}

/** Local explicit consent only. This store never calls AI or rewrites imported records. */
export class PermissionStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS permission_approvals(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,conversation_version TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS permission_requests(request_id TEXT PRIMARY KEY,payload TEXT NOT NULL,result_json TEXT NOT NULL);`);
    for (const table of ['permission_approvals', 'permission_requests']) for (const operation of ['UPDATE', 'DELETE']) this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${operation.toLowerCase()}_blocked BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'Data permission history is append-only'); END;`);
  }
  approve(conversation: Conversation, raw: unknown): DataPermission {
    const input = inputSchema.parse(raw);
    if (!eligible(conversation)) throw new Error('DATA_PERMISSION_RESTRICTED');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const approval = this.approveInTransaction(conversation, input);
      this.db.exec('COMMIT'); return approval;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** The caller supplies the complete current raw group, never resolved classifications. */
  previewBatch(conversations: Conversation[]): BatchPermissionPreview {
    const ordered = this.batchSources(conversations);
    const groupId = ordered[0].groupId;
    const conversationVersions = ordered.map(conversation => conversation.version);
    const sourceFingerprint = createHash('sha256').update(canonicalJson({ groupId, sources: ordered.map(conversation => ({ conversationVersion: conversation.version, sourceFingerprint: conversationFingerprint(conversation) })) }), 'utf8').digest('hex');
    return { groupId, conversationVersions, sourceFingerprint, eligibleCount: ordered.length };
  }
  approveBatch(conversations: Conversation[], raw: unknown): BatchDataPermission {
    const input = batchInputSchema.parse(raw);
    const ordered = this.batchSources(conversations);
    const preview = this.previewBatch(ordered);
    const payload = canonicalJson({ operation: 'bound-batch-approval-v1', input });
    const previousRequest = this.request(input.requestId);
    if (previousRequest && previousRequest.payload !== payload) throw new Error('IDEMPOTENCY_CONFLICT');
    if (input.groupId !== preview.groupId || input.sourceFingerprint !== preview.sourceFingerprint || canonicalJson(input.conversationVersions) !== canonicalJson(preview.conversationVersions)) throw new Error('DATA_PERMISSION_BATCH_SOURCE_MISMATCH');
    // Validate the whole set before the first insert, including previous immutable bindings.
    for (const conversation of ordered) this.checkPreviousBinding(conversation);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const oldRequest = this.request(input.requestId);
      if (oldRequest) {
        if (oldRequest.payload !== payload) throw new Error('IDEMPOTENCY_CONFLICT');
        this.db.exec('COMMIT'); return JSON.parse(oldRequest.result_json) as BatchDataPermission;
      }
      for (const conversation of ordered) this.checkPreviousBinding(conversation);
      const approvalIds = ordered.map((conversation, index) => this.approveInTransaction(conversation, {
        reviewer: input.reviewer, reason: input.reason, syntheticAttestation: input.syntheticAttestation,
        freeTierUseApproved: input.freeTierUseApproved, origin: input.origin,
        requestId: `batch_permission_${createHash('sha256').update(input.requestId).digest('hex')}_${index}`,
      }).id);
      const approval: BatchDataPermission = { ...input, id: randomUUID(), createdAt: new Date().toISOString(), eligibleCount: ordered.length, approvalIds, scope: 'one-immutable-synthetic-chat-batch' };
      this.db.prepare('INSERT INTO permission_requests(request_id,payload,result_json) VALUES(?,?,?)').run(input.requestId, payload, canonicalJson(approval));
      this.db.exec('COMMIT'); return approval;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private batchSources(conversations: Conversation[]): Conversation[] {
    if (!conversations.length || conversations.length > 100_000 || new Set(conversations.map(conversation => conversation.version)).size !== conversations.length || new Set(conversations.map(conversation => conversation.conversationId)).size !== conversations.length || conversations.some(conversation => conversation.groupId !== conversations[0].groupId)) throw new Error('DATA_PERMISSION_BATCH_SOURCE_INVALID');
    if (conversations.some(conversation => !eligible(conversation))) throw new Error('DATA_PERMISSION_RESTRICTED');
    return [...conversations].sort((a, b) => a.conversationId < b.conversationId ? -1 : a.conversationId > b.conversationId ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0);
  }
  private request(requestId: string) {
    return this.db.prepare('SELECT payload,result_json FROM permission_requests WHERE request_id=?').get(requestId) as { payload: string; result_json: string } | undefined;
  }
  private checkPreviousBinding(conversation: Conversation) {
    const previous = this.getPermission(conversation.version);
    if (previous && previous.sourceFingerprint !== conversationFingerprint(conversation)) throw new Error('IMMUTABLE_PERMISSION_SOURCE');
  }
  /** Internal helper is always covered by the outer individual or batch transaction. */
  private approveInTransaction(conversation: Conversation, input: z.infer<typeof inputSchema>): DataPermission {
    const fingerprint = conversationFingerprint(conversation);
    const payload = canonicalJson({ conversationVersion: conversation.version, sourceFingerprint: fingerprint, input });
    const oldRequest = this.request(input.requestId);
    if (oldRequest) {
      if (oldRequest.payload !== payload) throw new Error('IDEMPOTENCY_CONFLICT');
      return JSON.parse(oldRequest.result_json) as DataPermission;
    }
    this.checkPreviousBinding(conversation);
    const approval: DataPermission = { ...input, id: randomUUID(), conversationVersion: conversation.version, sourceFingerprint: fingerprint, createdAt: new Date().toISOString(), scope: 'one-immutable-synthetic-chat-version' };
    const json = canonicalJson(approval);
    this.db.prepare('INSERT INTO permission_approvals(id,conversation_version,json) VALUES(?,?,?)').run(approval.id, approval.conversationVersion, json);
    this.db.prepare('INSERT INTO permission_requests(request_id,payload,result_json) VALUES(?,?,?)').run(input.requestId, payload, json);
    return approval;
  }
  getPermission(conversationVersion: string): DataPermission | undefined {
    const row = this.db.prepare('SELECT json FROM permission_approvals WHERE conversation_version=? ORDER BY sequence DESC LIMIT 1').get(conversationVersion) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as DataPermission : undefined;
  }
  resolve(conversation: Conversation): Conversation {
    if (!eligible(conversation)) return conversation;
    const permission = this.getPermission(conversation.version);
    if (!permission || permission.origin !== 'human_declared' || permission.syntheticAttestation !== true || permission.freeTierUseApproved !== true || permission.scope !== 'one-immutable-synthetic-chat-version' || permission.conversationVersion !== conversation.version || permission.sourceFingerprint !== conversationFingerprint(conversation)) return conversation;
    return { ...conversation, classification: 'synthetic_allowed' };
  }
  close(): void { this.db.close(); }
}
