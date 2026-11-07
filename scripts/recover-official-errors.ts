/** Explicit local-API recovery only. Defaults to read-only planning; never copies an API key. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.js';
import { BatchStore } from '../server/batches.js';
import { conversationFingerprint } from '../server/data-permissions.js';
import { readCompetitionDataset } from '../server/competition.js';
import { assertRecoveryServerConfiguration, executeOfficialRecoveries, officialRecoveryConfigurationAudit, planOfficialRecovery, type OfficialRecoveryState, type RecoveryOutcome } from '../server/recover-official.js';
import { publicErrorCode } from '../server/errors.js';

const args = new Map<string, string>(); const flags = new Set<string>();
for (let i = 2; i < process.argv.length; i++) { const arg = process.argv[i]; if (['--execute', '--dry-run', '--accept-required-range-upgrade'].includes(arg)) flags.add(arg); else if (['--batch', '--limit', '--budget-ms', '--spacing-ms'].includes(arg) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) args.set(arg, process.argv[++i]); else throw new Error('INVALID_OFFICIAL_RECOVERY_ARGUMENT'); }
const requestedId = args.get('--batch'); if (!requestedId || !/^[A-Za-z0-9_-]{8,128}$/.test(requestedId)) throw new Error('BATCH_ID_REQUIRED'); const id: string = requestedId;
const batches = new BatchStore(config.dbPath, { readOnly: true }); const base = `http://127.0.0.1:${config.port}`;
const execute = flags.has('--execute') && !flags.has('--dry-run');
const limit = Number(args.get('--limit') || 10); const budgetMs = Number(args.get('--budget-ms') || 600000); const spacingMs = Number(args.get('--spacing-ms') || 12000);
const path = `private/reports/official-recovery-${id}-${Date.now()}.json`;
const checkpointOutcomes: RecoveryOutcome[] = [];
const recoveryOptions = { acceptRequiredRangeUpgrade: flags.has('--accept-required-range-upgrade') };
let configurationAudit: ReturnType<typeof officialRecoveryConfigurationAudit> | undefined;
async function load(): Promise<OfficialRecoveryState> {
  const batch = batches.required(id); const dataset = readCompetitionDataset(config.dbPath, batch.groupId); const approvedSyntheticVersions: string[] = [];
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  try {
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='permission_approvals'").get()) for (const source of dataset.conversations.filter(c => c.classification === 'unknown' && c.channel === 'agent chat' && !c.audioAvailable)) {
      const row = db.prepare('SELECT json FROM permission_approvals WHERE conversation_version=? ORDER BY sequence DESC LIMIT 1').get(source.version) as { json: string } | undefined;
      const permission = row ? JSON.parse(row.json) : undefined;
      if (permission?.origin === 'human_declared' && permission.syntheticAttestation === true && permission.freeTierUseApproved === true && permission.scope === 'one-immutable-synthetic-chat-version' && permission.conversationVersion === source.version && permission.sourceFingerprint === conversationFingerprint(source)) approvedSyntheticVersions.push(source.version);
    }
  } finally { db.close(); }
  return { batch, batches: batches.list(), dataset, approvedSyntheticVersions };
}
try {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(budgetMs) || budgetMs < 1000 || budgetMs > 2700000 || !Number.isInteger(spacingMs) || spacingMs < 0 || spacingMs > 600000) throw new Error('INVALID_OFFICIAL_RECOVERY_BOUNDS');
  const state = await load(); configurationAudit = officialRecoveryConfigurationAudit(state, recoveryOptions); const plan = planOfficialRecovery(state, recoveryOptions);
  let report: unknown;
  if (!execute) report = { status: 'DRY_RUN', noCallsMade: true, batchId: id, model: config.model, checklistVersion: state.batch.checklistVersion, configurationAudit, limit, budgetMs, spacingMs, eligible: plan.filter(item => item.action === 'eligible').length, records: plan };
  else {
    const beforePost = async () => { const statusResponse = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(5000) }); if (!statusResponse.ok) throw new Error('LOCAL_SERVER_NOT_READY'); const status = await statusResponse.json(); assertRecoveryServerConfiguration(status); if (!status.apiKeyPresent || !status.freeTierConfirmed) throw new Error('LOCAL_FREE_PROVIDER_NOT_READY'); };
    await beforePost();
    report = { status: 'EXECUTED_BOUNDED_RECOVERY', ...(await executeOfficialRecoveries({ load, beforePost, post: async payload => {
      const response = await fetch(`${base}/api/evaluations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(config.timeoutMs + 5000) });
      const result = await response.json(); return { ok: response.ok, ...(!response.ok ? { errorCode: typeof result.error === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(result.error) ? result.error : 'REQUEST_FAILED' } : {}) };
    } }, { ...recoveryOptions, limit, budgetMs, spacingMs, onProgress: outcome => { checkpointOutcomes.push(outcome); mkdirSync('private/reports', { recursive: true }); writeFileSync(path, JSON.stringify({ status: 'RECOVERY_CHECKPOINT', batchId: id, configurationAudit, outcomes: checkpointOutcomes }, null, 2)); console.log(JSON.stringify(outcome)); } })) };
  }
  if (execute && report && typeof report === 'object' && 'outcomes' in report && (('stopReason' in report && report.stopReason) || (report.outcomes as RecoveryOutcome[]).some(outcome => outcome.status === 'failed' || outcome.status === 'unknown'))) process.exitCode = 2;
  mkdirSync('private/reports', { recursive: true }); writeFileSync(path, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ report: path, ...report as object }));
} catch (error) { const report = { status: 'BLOCKED', code: publicErrorCode(error), configurationAudit, noAdditionalCallsMadeAfterBlock: true, outcomes: checkpointOutcomes }; mkdirSync('private/reports', { recursive: true }); writeFileSync(path, JSON.stringify(report, null, 2)); console.error(JSON.stringify({ ...report, report: path })); process.exitCode = 1; }
finally { batches.close(); }
