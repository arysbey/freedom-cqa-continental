import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Evaluation } from '../src/domain.js';
import { calculateScore } from '../src/scoring.js';
import { validateEvidence } from './evidence.js';
import { canonicalJson } from './importer.js';
import type { Store } from './store.js';

const inputSchema = z.object({
  conversationVersion: z.string().min(1).max(256),
  checklistVersion: z.string().min(1).max(256),
  reviewer: z.string().trim().min(2).max(200),
  origin: z.enum(['human', 'agent_demo']),
  humanAttestation: z.boolean(),
  requestId: z.string().trim().min(8).max(128),
  results: z.array(z.unknown()).min(1).max(100),
}).strict();

/** Entirely local manual entry. This module has no provider client or network path. */
export function saveManualEvaluation(store: Store, raw: unknown): Evaluation {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) throw new Error('INVALID_MANUAL_ASSESSMENT');
  const input = parsed.data;
  if (input.origin === 'human' && !input.humanAttestation) throw new Error('HUMAN_ATTESTATION_REQUIRED');
  if (input.origin === 'agent_demo' && input.humanAttestation) throw new Error('DEMO_CANNOT_ATTEST_HUMAN');
  const conversation = store.getConversation(input.conversationVersion);
  const checklist = store.getChecklist(input.checklistVersion);
  if (!conversation || !checklist) throw new Error('SOURCE_NOT_FOUND');
  if (!conversation.messages.length) throw new Error('EMPTY_TRANSCRIPT');
  const results = validateEvidence(conversation, checklist, { results: input.results });
  const id = 'manual_' + createHash('sha256').update(input.requestId).digest('hex');
  const fingerprint = createHash('sha256').update(canonicalJson(input)).digest('hex');
  const previous = store.getEvaluation(id);
  if (previous) {
    if (previous.configuration.manualRequestFingerprint !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT');
    return previous;
  }
  const evaluation: Evaluation = {
    id,
    createdAt: new Date().toISOString(),
    conversationVersion: conversation.version,
    checklistVersion: checklist.version,
    provider: 'local',
    model: 'none',
    mode: 'local',
    status: input.origin === 'human' ? 'human_entered' : 'manual_demo',
    origin: input.origin,
    reviewer: input.reviewer,
    results,
    score: calculateScore(checklist, results),
    usage: { inputTokens: null, outputTokens: null, thoughtTokens: null, totalTokens: null },
    latencyMs: 0,
    providerCallCount: 0,
    configuration: {
      method: 'manual-entry',
      policy: 'local-only-no-provider',
      humanAttestation: input.humanAttestation,
      purpose: input.origin === 'human' ? 'user-entered-local-review' : 'agent-acceptance-demo-not-human-gold',
      manualRequestFingerprint: fingerprint,
    },
  };
  store.saveEvaluation(evaluation);
  return evaluation;
}
