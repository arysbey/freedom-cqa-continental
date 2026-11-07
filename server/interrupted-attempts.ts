import type { Store } from './store.js';

/** Only IDs captured before a successful server listen may be classified as interrupted.
 * This says nothing about the provider's final outcome or its unreported usage. */
export function interruptRecordedAttempts(store: Store, ids: string[], finishedAt = new Date().toISOString()): number {
  let count = 0;
  for (const id of ids) {
    const attempt = store.getEvaluationAttempt(id);
    if (attempt?.status !== 'running') continue;
    store.finishEvaluationAttempt({ ...attempt, status: 'failed', finishedAt, evaluationId: null, errorCode: 'REQUEST_INTERRUPTED', usage: null });
    count++;
  }
  return count;
}
