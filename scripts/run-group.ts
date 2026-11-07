/** Official sequential batch runner. No publishing and no permission grants. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { config } from '../server/config.js';
import { Store } from '../server/store.js';
import { BatchStore, createGroupBatch, findValidOfficialEvaluation, runGroupBatch } from '../server/batches.js';
import { publicErrorCode } from '../server/errors.js';

const flags = new Set(['--execute', '--dry-run', '--resume', '--pause', '--cancel', '--recover-interrupted', '--retry-quota']);
const values = new Set(['--group', '--batch', '--id', '--min-spacing-ms', '--budget-ms']);
const argumentsMap = new Map<string, string>(); const selectedFlags = new Set<string>();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (flags.has(arg)) selectedFlags.add(arg);
  else if (values.has(arg) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) argumentsMap.set(arg, process.argv[++i]);
  else throw new Error('INVALID_RUN_GROUP_ARGUMENT');
}
const dryRun = selectedFlags.has('--dry-run') || !selectedFlags.has('--execute') && !selectedFlags.has('--pause') && !selectedFlags.has('--cancel');
const store = new Store(config.dbPath); let batches: BatchStore | undefined;
try {
  if (config.model !== 'gemini-3.1-flash-lite') throw new Error('MODEL_CHANGE_REQUIRES_USER_APPROVAL');
  const existingId = argumentsMap.get('--batch'); const group = argumentsMap.get('--group');
  if (dryRun && !existingId) {
    if (!group) throw new Error('GROUP_ID_REQUIRED');
    const records = store.listConversations(group); if (!records.length) throw new Error('GROUP_NOT_IMPORTED');
    console.log(JSON.stringify({ status: 'DRY_RUN', groupId: group, model: config.model, checklistVersion: 'official-v1', noCallsMade: true, noBatchWritten: true,
      records: records.map(c => ({ conversationId: c.conversationId, conversationVersion: c.version, validOfficialResult: Boolean(findValidOfficialEvaluation(store, c)), localHumanOnly: c.classification === 'real_restricted' || c.audioAvailable || c.channel !== 'agent chat', explicitPermissionCheckRequired: c.classification === 'unknown' })) }, null, 2));
  } else {
    batches = new BatchStore(config.dbPath, { readOnly: dryRun });
    let batch = existingId ? batches.required(existingId) : createGroupBatch(store, batches, { groupId: group || '', id: argumentsMap.get('--id'), minSpacingMs: argumentsMap.has('--min-spacing-ms') ? Number(argumentsMap.get('--min-spacing-ms')) : undefined, runBudgetMs: argumentsMap.has('--budget-ms') ? Number(argumentsMap.get('--budget-ms')) : undefined });
    if (dryRun) console.log(JSON.stringify({ status: 'DRY_RUN', noCallsMade: true, batch }, null, 2));
    else {
      if (selectedFlags.has('--cancel')) batch = batches.cancel(batch.id);
      else if (selectedFlags.has('--pause')) batch = batches.pause(batch.id);
      else {
        if (selectedFlags.has('--resume')) batch = batches.resume(batch.id, { allowInterruptedRecovery: selectedFlags.has('--recover-interrupted'), retryQuota: selectedFlags.has('--retry-quota') });
        const controller = new AbortController();
        const interrupt = () => controller.abort(); process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
        try { batch = await runGroupBatch(store, batches, batch.id, { signal: controller.signal, onProgress: snapshot => console.log(JSON.stringify({ event: 'batch-checkpoint', id: snapshot.id, revision: snapshot.revision, status: snapshot.status, reason: snapshot.reason, total: snapshot.records.length, succeeded: snapshot.records.filter(r => r.status === 'succeeded').length, reused: snapshot.records.filter(r => r.status === 'reused').length, errors: snapshot.records.filter(r => r.status === 'error').length, blocked: snapshot.records.filter(r => r.status === 'blocked').length, currentConversationId: snapshot.records.find(r => r.status === 'running' || r.status === 'retry_wait')?.conversationId ?? null })) }); }
        finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
      }
      mkdirSync('private/batches', { recursive: true }); writeFileSync(`private/batches/${batch.id}.json`, JSON.stringify(batch, null, 2));
      console.log(JSON.stringify({ id: batch.id, groupId: batch.groupId, status: batch.status, reason: batch.reason, model: batch.model, checklistVersion: batch.checklistVersion, records: batch.records.map(r => ({ conversationId: r.conversationId, status: r.status, evaluationId: r.evaluationId, errorCode: r.errorCode, evaluationsRequested: r.runs.length, reportedProviderCalls: r.runs.reduce((n, run) => n + (run.providerCallCount ?? 0), 0), unknownProviderCallRuns: r.runs.filter(run => run.providerCallCount === null).length })) }, null, 2));
      if (batch.status === 'paused') process.exitCode = 2;
    }
  }
} catch (error) { console.error(JSON.stringify({ status: 'FAILED', code: publicErrorCode(error) })); process.exitCode = 1; }
finally { batches?.close(); store.close(); }
