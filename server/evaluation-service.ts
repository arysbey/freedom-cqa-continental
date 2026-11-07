import { randomUUID } from 'node:crypto';
import type { Evaluation } from '../src/domain.js';
import { calculateScore } from '../src/scoring.js';
import { config } from './config.js';
import { GeminiProvider } from './provider.js';
import type { Store } from './store.js';
import { isApprovedSyntheticConversation } from './importer.js';

let inFlight = false;
export async function evaluateAndSave(store: Store, conversationVersion: string, checklistVersion: string): Promise<Evaluation> {
  if (inFlight) throw new Error('EVALUATION_BUSY');
  const conversation = store.getConversation(conversationVersion);
  const checklist = store.getChecklist(checklistVersion);
  if (!conversation || !checklist) throw new Error('SOURCE_NOT_FOUND');
  if (!isApprovedSyntheticConversation(conversation)) throw new Error('DATA_POLICY_RESTRICTED');
  inFlight = true;
  try {
    const result = await new GeminiProvider(config).evaluate(conversation, checklist);
    const evaluation: Evaluation = {
      ...result,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      conversationVersion,
      checklistVersion,
      provider: config.provider,
      model: config.model,
      mode: config.mode,
      status: 'live_validated',
      score: calculateScore(checklist, result.results),
    };
    store.saveEvaluation(evaluation);
    return evaluation;
  } finally { inFlight = false; }
}
