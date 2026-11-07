/** One explicitly real current-model request outside the independent validation split.
 * Replaying its requestId verifies persistence without another inference call. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { config } from '../server/config.js';
import { validateEvidence } from '../server/evidence.js';
import { calculateScore } from '../src/scoring.js';
import type { Checklist, Conversation, Evaluation } from '../src/domain.js';
import type { AttemptView } from '../src/AttemptStatus.js';

const base = `http://127.0.0.1:${config.port}`;
async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${base}${path}`);
  assert(response.ok, `LOCAL_GET_HTTP_${response.status}`);
  return await response.json() as T;
}
const status = await get<{ model: string; apiKeyPresent: boolean; freeTierConfirmed: boolean }>('/api/status');
assert.equal(status.model, 'gemini-3.1-flash-lite');
assert(status.apiKeyPresent && status.freeTierConfirmed, 'LIVE_CONFIGURATION_NOT_READY');
const summaries = await get<Conversation[]>('/api/conversations');
const summary = summaries.find(c => c.groupId === 'DEV' && c.conversationId === 'p1-ru-001');
assert(summary && summary.classification === 'synthetic_allowed', 'APPROVED_TUNING_CHAT_NOT_FOUND');
const conversation = await get<Conversation>(`/api/conversations/${summary.version}`);
const checklist = (await get<Checklist[]>('/api/checklists')).find(c => c.version === 'official-v1');
assert(checklist && checklist.criteria.length === 8);
const resumeAt = process.argv.indexOf('--resume');
const resumeId = resumeAt >= 0 ? process.argv[resumeAt + 1] : undefined;
if (resumeAt >= 0) assert(resumeId && /^[a-f0-9-]{36}$/.test(resumeId), 'INVALID_RESUME_ID');
const requestId = resumeId || randomUUID();
const currentEvaluations = await get<Evaluation[]>('/api/evaluations');
const currentAttempts = await get<AttemptView[]>('/api/evaluation-attempts');
if (resumeId) assert(currentAttempts.some(a => a.id === resumeId && a.conversationVersion === conversation.version && a.checklistVersion === checklist.version && a.model === status.model), 'RESUME_SOURCE_NOT_FOUND');
const before = currentEvaluations.filter(e => e.attemptId !== requestId);
const attemptsBefore = currentAttempts.filter(a => a.id !== requestId);
mkdirSync('private/reports', { recursive: true });
writeFileSync('private/reports/live-request-pending.json', JSON.stringify({ requestId, createdAt: new Date().toISOString(), resumed: Boolean(resumeId) }, null, 2));
console.log(JSON.stringify({ progress: 'request-registered-locally', requestId, resumed: Boolean(resumeId) }));
const payload = { conversationVersion: conversation.version, checklistVersion: checklist.version, requestId };
async function post() {
  return await fetch(`${base}/api/evaluations`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(payload), signal: AbortSignal.timeout(130000) });
}
const observations: Array<{ status: string; calls: number | null; at: string }> = [];
let polling = false;
const poll = setInterval(async () => {
  if (polling) return;
  polling = true;
  try {
    const response = await fetch(`${base}/api/evaluation-attempts/${requestId}`);
    if (response.ok) {
      const attempt = await response.json() as AttemptView;
      const previous = observations.at(-1);
      const observation = { status: attempt.status, calls: attempt.providerCallCount ?? null, at: new Date().toISOString() };
      if (!previous || previous.status !== observation.status || previous.calls !== observation.calls) { observations.push(observation); console.log(JSON.stringify({ progress: 'actual-live-request', ...observation })); }
    }
  } catch { /* The primary HTTP response determines success/failure. */ }
  finally { polling = false; }
}, 1000);
let transportFailure = false;
let response: Response | undefined;
try { response = await post(); }
catch { transportFailure = true; }
finally { clearInterval(poll); }
const body = response ? await response.json() as Evaluation & { error?: string } : undefined;
const attempt = await get<AttemptView>(`/api/evaluation-attempts/${requestId}`);
const after = await get<Evaluation[]>('/api/evaluations');
let idempotentReplay = false;
if (response?.ok && body) {
  assert.equal(body.model, status.model); assert.equal(body.checklistVersion, checklist.version);
  assert.equal(body.attemptId, requestId); assert.equal(body.status, 'live_validated');
  const validated = validateEvidence(conversation, checklist, { results: body.results });
  assert.deepEqual(JSON.parse(JSON.stringify(calculateScore(checklist, validated))), body.score);
  const replay = await post(); assert(replay.ok);
  const replayed = await replay.json() as Evaluation;
  assert.equal(replayed.id, body.id);
  const afterReplay = await get<AttemptView>(`/api/evaluation-attempts/${requestId}`);
  assert.deepEqual(afterReplay, attempt);
  assert.equal((await get<Evaluation[]>('/api/evaluations')).length, before.length + 1);
  idempotentReplay = true;
} else assert.equal(after.length, before.length, 'FAILED_CALL_MUST_NOT_SAVE_SCORE');
const report = {
  status: response?.ok ? 'PASS' : 'FAIL', capturedAt: new Date().toISOString(), actualProvider: true, networkMocks: false,
  model: status.model, checklistVersion: checklist.version, conversationId: conversation.conversationId,
  resumedSavedRequest: Boolean(resumeId), actualNewRequestsThisInvocation: resumeId ? 0 : 1,
  originalStartedAt: attempt.startedAt, originalFinishedAt: attempt.finishedAt,
  outsideIndependentValidationSplit: true, requestId, httpStatus: response?.status ?? null, transportFailure,
  errorCode: body?.error ?? null, evaluationId: response?.ok ? body?.id : null, score: response?.ok ? body?.score.total : null,
  latencyMs: attempt.latencyMs, providerCallCount: attempt.providerCallCount ?? null,
  unknownUsageCalls: attempt.telemetry?.unknownUsageCalls ?? null, reportedUsage: attempt.usage, events: attempt.events,
  recovery: attempt.recovery, observations, idempotentReplay,
  originalRequestSavedEvaluationDelta: after.length - before.length, originalRequestAttemptDelta: (await get<AttemptView[]>('/api/evaluation-attempts')).length - attemptsBefore.length,
  humanLabelsAuthored: 0, realCallContentSent: false,
};
mkdirSync('private/reports', { recursive: true });
writeFileSync('private/reports/live-request-acceptance.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASS') process.exitCode = 1;
