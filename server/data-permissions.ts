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
    const fingerprint = conversationFingerprint(conversation);
    const payload = canonicalJson({ conversationVersion: conversation.version, sourceFingerprint: fingerprint, input });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const oldRequest = this.db.prepare('SELECT payload,result_json FROM permission_requests WHERE request_id=?').get(input.requestId) as { payload: string; result_json: string } | undefined;
      if (oldRequest) {
        if (oldRequest.payload !== payload) throw new Error('IDEMPOTENCY_CONFLICT');
        this.db.exec('COMMIT'); return JSON.parse(oldRequest.result_json) as DataPermission;
      }
      const previous = this.getPermission(conversation.version);
      if (previous && previous.sourceFingerprint !== fingerprint) throw new Error('IMMUTABLE_PERMISSION_SOURCE');
      const approval: DataPermission = { ...input, id: randomUUID(), conversationVersion: conversation.version, sourceFingerprint: fingerprint, createdAt: new Date().toISOString(), scope: 'one-immutable-synthetic-chat-version' };
      const json = canonicalJson(approval);
      this.db.prepare('INSERT INTO permission_approvals(id,conversation_version,json) VALUES(?,?,?)').run(approval.id, approval.conversationVersion, json);
      this.db.prepare('INSERT INTO permission_requests(request_id,payload,result_json) VALUES(?,?,?)').run(input.requestId, payload, json);
      this.db.exec('COMMIT'); return approval;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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
