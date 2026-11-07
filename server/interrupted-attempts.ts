import type { Store } from './store.js';

export type ExecutorState = 'alive' | 'dead' | 'unknown';
/** Signal 0 only checks existence/permissions; it never signals or terminates an owner. */
export function probeExecutorPid(pid: number): ExecutorState {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2147483647) return 'unknown';
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ESRCH' ? 'dead' : 'unknown'; }
}
/** Only IDs captured before a successful server listen may be classified as interrupted.
 * Known live/uncertain owners are preserved. Legacy ownerless attempts retain the
 * previous cleanup behavior. A dead owner says nothing about the provider outcome. */
export function interruptRecordedAttempts(store: Store, ids: string[], finishedAt = new Date().toISOString(), probe: (pid: number) => ExecutorState = probeExecutorPid): number {
  let count = 0;
  for (const id of ids) {
    const attempt = store.getEvaluationAttempt(id);
    if (attempt?.status !== 'running') continue;
    if (attempt.executorPid !== undefined && probe(attempt.executorPid) !== 'dead') continue;
    store.finishEvaluationAttempt({ ...attempt, status: 'failed', finishedAt, evaluationId: null, errorCode: 'REQUEST_INTERRUPTED', usage: null });
    count++;
  }
  return count;
}
