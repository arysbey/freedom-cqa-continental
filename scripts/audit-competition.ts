/** Private read-only competition audit. Never prints transcripts, model answers or human judgments. */
import { backup, DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Checklist, Conversation, Evaluation, EvaluationAttempt } from '../src/domain.js';
import { calculateScore } from '../src/scoring.js';
import { validateEvidence } from '../server/evidence.js';
import { canonicalJson, isApprovedSyntheticConversation, parseOrganizerResponse } from '../server/importer.js';
import { config } from '../server/config.js';

type Row = Record<string, unknown>;
const root = resolve('.');
const stamp = new Date().toISOString().replaceAll(/[:.]/g, '_');
const output = resolve(`private/reports/competition-audit-${stamp}.json`);
const backupPath = resolve(`private/backups/competition-audit-${stamp}.sqlite`);
const officialIds = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'];
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const fileHash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const shortPath = (path: string) => relative(root, path).replaceAll('\\', '/');
function withinWorkspace(path: string) {
  const resolved = resolve(path), child = relative(root, resolved);
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('WORKSPACE_PATH_REQUIRED');
  return resolved;
}
function git(args: string[]) { return execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim(); }
function safeRemote(value: string) {
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
  catch { return /^[\w.-]+@[\w.-]+:[\w./-]+$/.test(value) ? value : 'REMOTE_ADDRESS_REDACTED'; }
}
function queryJson<T>(db: DatabaseSync, sql: string): T[] { return (db.prepare(sql).all() as Array<{ json: string }>).map(row => JSON.parse(row.json) as T); }
function isGenuineAi(evaluation: Evaluation) { return evaluation.status === 'live_validated' && evaluation.provider === 'gemini' && evaluation.mode === 'free' && evaluation.origin !== 'agent_demo' && evaluation.origin !== 'human' && evaluation.providerCallCount > 0; }
function isGenuineHuman(evaluation: Evaluation) { return evaluation.status === 'human_entered' && evaluation.origin === 'human' && evaluation.mode === 'local' && evaluation.providerCallCount === 0 && evaluation.configuration.humanAttestation === true; }
function technicalCheck(evaluation: Evaluation, conversation: Conversation | undefined, checklist: Checklist | undefined) {
  if (!conversation || !checklist || conversation.version !== evaluation.conversationVersion || checklist.version !== evaluation.checklistVersion) return { valid: false, reason: 'SOURCE_VERSION_MISSING_OR_MISMATCH' };
  try {
    validateEvidence(conversation, checklist, { results: evaluation.results });
    if (canonicalJson(calculateScore(checklist, evaluation.results)) !== canonicalJson(evaluation.score)) return { valid: false, reason: 'STORED_SCORE_MISMATCH' };
    return { valid: true, reason: null };
  } catch { return { valid: false, reason: 'EVIDENCE_OR_SCHEMA_REVALIDATION_FAILED' }; }
}

withinWorkspace(config.dbPath); withinWorkspace(output); withinWorkspace(backupPath);
mkdirSync(resolve('private/reports'), { recursive: true }); mkdirSync(resolve('private/backups'), { recursive: true });
if (existsSync(backupPath) || existsSync(output)) throw new Error('AUDIT_OUTPUT_ALREADY_EXISTS');
const source = new DatabaseSync(config.dbPath, { readOnly: true });
try { await backup(source, backupPath); } finally { source.close(); }
const db = new DatabaseSync(backupPath, { readOnly: true });
try {
  db.exec('PRAGMA query_only=ON');
  const sources = queryJson<Conversation>(db, 'SELECT json FROM conversations WHERE rowid IN(SELECT MAX(rowid) FROM conversations GROUP BY group_id,conversation_id) ORDER BY group_id,conversation_id');
  const allSources = queryJson<Conversation>(db, 'SELECT json FROM conversations');
  const originals = new Map((db.prepare('SELECT version,original_json FROM conversations').all() as Array<{ version: string; original_json: string }>).map(row => [row.version, JSON.parse(row.original_json) as { conversation_id: string; transcript: Array<{ timestamp: string; speaker: string; text: string }> }]));
  const checklists = queryJson<Checklist>(db, 'SELECT json FROM checklists');
  const evaluations = queryJson<Evaluation>(db, 'SELECT json FROM evaluations ORDER BY rowid DESC');
  const attempts = queryJson<EvaluationAttempt>(db, 'SELECT json FROM evaluation_attempts');
  const official = checklists.find(item => item.version === 'official-v1');
  const officialFile = JSON.parse(readFileSync('src/data/official-checklist.json', 'utf8')) as Checklist;
  const officialSnapshotMatchesSource = Boolean(official && canonicalJson(official) === canonicalJson(officialFile) && canonicalJson(official.criteria.map(item => item.id)) === canonicalJson(officialIds));
  const dev = sources.filter(item => item.groupId === 'DEV');
  const validation = new Map(evaluations.filter(item => isGenuineAi(item) || isGenuineHuman(item)).map(item => [item.id, technicalCheck(item, allSources.find(source => source.version === item.conversationVersion), checklists.find(checklist => checklist.version === item.checklistVersion))]));
  const valid = evaluations.filter(item => validation.get(item.id)?.valid);
  const records = dev.map(conversation => {
    const saved = evaluations.filter(item => item.conversationVersion === conversation.version);
    const genuine = valid.filter(item => item.conversationVersion === conversation.version);
    const officialAi = genuine.filter(item => item.checklistVersion === 'official-v1' && isGenuineAi(item) && officialSnapshotMatchesSource);
    const currentAi = officialAi.filter(item => item.model === config.model);
    const human = genuine.filter(item => item.checklistVersion === 'official-v1' && isGenuineHuman(item) && officialSnapshotMatchesSource);
    const experimental = genuine.filter(item => item.checklistVersion !== 'official-v1');
    const original = originals.get(conversation.version);
    const originalPreserved = original?.conversation_id === conversation.conversationId && original.transcript.length === conversation.messages.length && original.transcript.every((message, index) => message.timestamp === conversation.messages[index].timestamp && message.speaker === conversation.messages[index].speaker && message.text === conversation.messages[index].text && conversation.messages[index].position === index);
    return { conversationId: conversation.conversationId, version: conversation.version, language: conversation.language, channel: conversation.channel, classification: conversation.classification, messageCount: conversation.messages.length, originalPreserved,
      permittedSyntheticHashVerified: conversation.channel === 'agent chat' ? isApprovedSyntheticConversation(conversation) : false,
      officialCurrentAi: currentAi.map(item => ({ id: item.id, model: item.model, createdAt: item.createdAt })), officialOtherAi: officialAi.filter(item => item.model !== config.model).map(item => ({ id: item.id, model: item.model, createdAt: item.createdAt })),
      officialHuman: human.map(item => ({ id: item.id, createdAt: item.createdAt })), experimentalValidatedCount: experimental.length, savedEvaluationCount: saved.length, manualDemoCount: saved.filter(item => item.status === 'manual_demo').length,
      category: currentAi.length ? 'official_current_model_ai' : human.length ? 'official_authentic_human' : officialAi.length ? 'official_other_model_only' : experimental.length ? 'experimental_only' : saved.length ? 'no_authentic_result' : 'no_saved_evaluation',
      needsOfficialCurrentEvaluation: !currentAi.length && !human.length };
  });
  const categories = Object.fromEntries(['official_current_model_ai', 'official_authentic_human', 'official_other_model_only', 'experimental_only', 'no_authentic_result', 'no_saved_evaluation'].map(category => [category, records.filter(item => item.category === category).length]));
  const humanProgress = db.prepare(`WITH active AS(SELECT id,manifest_id FROM quality_review_rounds ORDER BY sequence DESC LIMIT 1), refs AS(SELECT q.* FROM quality_references q,active a WHERE q.manifest_id=a.manifest_id AND COALESCE(json_extract(q.json,'$.reviewRoundId'),'legacy')=a.id AND q.sequence IN(SELECT MAX(q2.sequence) FROM quality_references q2 WHERE q2.manifest_id=a.manifest_id AND COALESCE(json_extract(q2.json,'$.reviewRoundId'),'legacy')=a.id GROUP BY q2.case_id)) SELECT json_extract(j.value,'$.criterionId') AS criterionId,SUM(CASE WHEN json_extract(j.value,'$.resolved')=1 THEN 1 ELSE 0 END) AS resolved,SUM(CASE WHEN json_extract(j.value,'$.resolved')=1 THEN 0 ELSE 1 END) AS unresolved FROM refs q,json_each(q.json,'$.judgments')j GROUP BY criterionId ORDER BY criterionId`).all();
  const activeRound = db.prepare('SELECT id,manifest_id FROM quality_review_rounds ORDER BY sequence DESC LIMIT 1').get();
  const activeManifest = db.prepare('SELECT json FROM quality_manifests WHERE id=(SELECT manifest_id FROM quality_review_rounds ORDER BY sequence DESC LIMIT 1)').get() as { json: string } | undefined;
  const manifest = activeManifest ? JSON.parse(activeManifest.json) as { id: string; selectionFrozen: boolean; cases: Array<{ id: string; split: string; language: string }> } : undefined;
  const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; sql: string }>;
  const tableHashes = Object.fromEntries(tables.map(table => {
    const quoted = '"' + table.name.replaceAll('"', '""') + '"';
    const rows = db.prepare(`SELECT * FROM ${quoted}`).all() as Row[];
    const rowHashes = rows.map(hash).sort();
    return [table.name, { count: rows.length, hash: hash(rowHashes), schemaHash: hash(table.sql) }];
  }));
  const calls = records.filter(item => item.channel === 'voice call').map(item => ({ conversationId: item.conversationId, classification: item.classification, genuineHumanResults: item.officialHuman.length, genuineAiResults: item.officialCurrentAi.length + item.officialOtherAi.length, technicalDemoRecords: item.manualDemoCount, needsHumanReview: !item.officialHuman.length, localReviewWorkflowAvailable: true, contentSentToFreeApiByAudit: false }));
  const statusCounts = (list: Array<{ status: string; errorCode?: string | null }>) => ({ total: list.length, byStatus: Object.fromEntries([...new Set(list.map(item => item.status))].map(status => [status, list.filter(item => item.status === status).length])), failuresByCode: Object.fromEntries([...new Set(list.filter(item => item.status === 'failed').map(item => item.errorCode || 'UNKNOWN'))].map(code => [code, list.filter(item => item.status === 'failed' && (item.errorCode || 'UNKNOWN') === code).length])) });
  const runs = db.prepare("SELECT json_extract(json,'$.status') AS status,json_extract(json,'$.errorCode') AS errorCode FROM quality_runs").all() as Array<{ status: string; errorCode?: string | null }>;
  const remotes = git(['remote']).split(/\r?\n/).filter(Boolean).map(name => ({ name, url: safeRemote(git(['remote', 'get-url', name])) }));
  const fixture = parseOrganizerResponse(JSON.parse(readFileSync('tests/fixtures/prod-rehearsal.json', 'utf8')), 'LOCAL_REHEARSAL_10');
  const report = { schemaVersion: 1, capturedAt: new Date().toISOString(), teamName: 'Continental', databaseAccess: 'read-only-source-and-read-only-backup', database: shortPath(config.dbPath), backup: { path: shortPath(backupPath), sha256: fileHash(backupPath) },
    privacy: { transcriptsPrinted: false, modelAnswersPrinted: false, humanAnswersOrExplanationsSelected: false, humanProgressAccess: 'SQL aggregate criterionId/resolved only; other human contents opaque for backup and hashing', apiCalls: 0, databaseMutations: 0 },
    git: { head: git(['rev-parse', 'HEAD']), branch: git(['branch', '--show-current']), workingTree: git(['status', '--short']).split(/\r?\n/).filter(Boolean), remotes, publicUrl: null, publicPublicationAuthorized: false, remoteSubmissionVerified: false },
    deadline: { absoluteDeadline: null, prodReleaseHoursAfterStart: 23, codeFreezeHoursAfterStart: 24, prodWindowHours: 1, absoluteDeadlineRequiresOrganizerConfirmation: true, source: 'private/source-audit/CQA_Student_Guide_Appendix_Results.txt' },
    officialChecklist: { version: 'official-v1', criteria: official?.criteria.length ?? 0, snapshotMatchesSource: officialSnapshotMatchesSource, hash: official ? hash(official) : null },
    coverage: { expectedDevRecords: 65, actualDevRecords: dev.length, uniqueOriginalIds: new Set(dev.map(item => item.conversationId)).size, originalIdsOrderRolesAndTextPreserved: records.every(item => item.originalPreserved), synthetic: records.filter(item => item.classification === 'synthetic_allowed').length, realCalls: calls.length, otherGroupRecords: sources.length - dev.length, categories,
      officialAnyAuthenticSources: records.filter(item => item.officialCurrentAi.length || item.officialOtherAi.length || item.officialHuman.length).length,
      officialCurrentOrAuthenticHumanSources: records.filter(item => !item.needsOfficialCurrentEvaluation).length,
      needsOfficialCurrentSynthetic: records.filter(item => item.channel === 'agent chat' && item.needsOfficialCurrentEvaluation).length, needsHumanCallReview: calls.filter(item => item.needsHumanReview).length,
      noGenuineResult: records.filter(item => !item.officialCurrentAi.length && !item.officialOtherAi.length && !item.officialHuman.length && !item.experimentalValidatedCount).length,
      noSavedEvaluation: records.filter(item => !item.savedEvaluationCount).length },
    savedEvaluations: { count: evaluations.length, genuineAi: evaluations.filter(isGenuineAi).length, genuineHuman: evaluations.filter(isGenuineHuman).length, manualDemo: evaluations.filter(item => item.status === 'manual_demo').length, technicalRevalidationFailures: [...validation].filter(([, value]) => !value.valid).map(([id, value]) => ({ id, reason: value.reason })), interpretation: 'Exact evidence/schema and deterministic score revalidation; does not establish semantic accuracy.' },
    provider: { configuredModel: config.model, configuredProvider: config.provider, configuredMode: config.mode, mainLedger: statusCounts(attempts), separateValidationRunLog: statusCounts(runs), doNotSumLedgersWithoutDeduplication: true,
      savedAiReportedTokens: evaluations.filter(isGenuineAi).reduce((sum, item) => sum + (item.usage.totalTokens ?? 0), 0), savedAiUnknownUsage: evaluations.filter(isGenuineAi).filter(item => item.usage.totalTokens == null).length,
      mainLedgerTelemetryKnown: attempts.filter(item => Boolean(item.telemetry)).length, mainLedgerRecordedRetries: attempts.filter(item => item.telemetry).reduce((sum, item) => sum + item.telemetry!.retryCount, 0), mainLedgerUnknownRetryHistory: attempts.filter(item => !item.telemetry).length },
    humanProgress: { activeRound, manifestId: manifest?.id ?? null, selectionFrozen: manifest?.selectionFrozen ?? false, development: manifest?.cases.filter(item => item.split === 'development').length ?? 0, holdout: manifest?.cases.filter(item => item.split === 'holdout').length ?? 0, countsOnly: humanProgress, noAccuracyComparisonPerformed: true },
    calls, records, tableHashes,
    rehearsalFixture: { path: 'tests/fixtures/prod-rehearsal.json', groupId: fixture.groupId, count: fixture.conversations.length, allUnknownByDefault: fixture.conversations.every(item => item.classification === 'unknown' && !isApprovedSyntheticConversation(item)), allIdsObviouslyLocal: fixture.conversations.every(item => item.conversationId.startsWith('LOCAL_REHEARSAL_')), languageCounts: Object.fromEntries(['RU', 'KZ', 'EN'].map(language => [language, fixture.conversations.filter(item => item.language === language).length])), goldLabels: false, realProd: false, importedIntoMainDatabase: false } };
  writeFileSync(output, JSON.stringify(report, null, 2));
  writeFileSync('private/reports/competition-audit-latest.json', JSON.stringify({ report: shortPath(output), backup: shortPath(backupPath), capturedAt: report.capturedAt }, null, 2));
  console.log(JSON.stringify({ status: 'AUDIT_COMPLETE_READ_ONLY', output: shortPath(output), backup: shortPath(backupPath), head: report.git.head, coverage: report.coverage, humanProgress: report.humanProgress, fixture: report.rehearsalFixture, technicalRevalidationFailures: report.savedEvaluations.technicalRevalidationFailures, calls }, null, 2));
} finally { db.close(); }
