import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Checklist, Conversation, CriterionResult, Evaluation, EvaluationAttempt } from '../src/domain.js';
import { initialChecklist } from '../src/checklist.js';
import { calculateScore } from '../src/scoring.js';
import { canonicalJson } from './importer.js';
import { validateEvidence } from './evidence.js';

export const competitionTeamName = 'Continental';
export const competitionCriterionIds = ['contact', 'discovery', 'identification', 'consultation', 'empathy', 'dialogue', 'closure', 'critical'] as const;
export type CompetitionTarget = 'dev' | 'prod';
export interface CompetitionOptions { target: CompetitionTarget; teamName: string; configuredModel: string; expectedIds?: string[] }
export interface CompetitionDataset {
  groupId: string; conversations: Conversation[]; checklists: Checklist[]; evaluations: Evaluation[];
  attempts: EvaluationAttempt[]; originals: Map<string, unknown>;
}
const meaningful = z.string().trim().min(12).max(800);
const turns = z.array(z.number().int().positive()).min(1).max(100_000).superRefine((values, ctx) => {
  if (new Set(values).size !== values.length || values.some((value, index) => index > 0 && value <= values[index - 1])) ctx.addIssue({ code: 'custom', message: 'Evidence turns must be unique and ascending.' });
});
const criterion = <T extends typeof competitionCriterionIds[number], V extends z.ZodType>(id: T, value: V) => z.object({ criterion_id: z.literal(id), value, rationale: meaningful, evidence_turns: turns }).strict();
const boolean = z.boolean();
const nullableBoolean = boolean.nullable();
const criteriaSchema = z.tuple([
  criterion('contact', boolean), criterion('discovery', nullableBoolean), criterion('identification', nullableBoolean),
  criterion('consultation', z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(15), z.literal(20), z.null()])),
  criterion('empathy', boolean), criterion('dialogue', z.union([z.literal(0), z.literal(4), z.literal(7), z.literal(10)])),
  criterion('closure', nullableBoolean), criterion('critical', boolean),
]);
const okSchema = z.object({ conversation_id: z.string().trim().min(1).max(256), status: z.literal('ok'), criteria: criteriaSchema,
  score: z.object({ final_score: z.number().finite().min(0).max(100).refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7), critical_flag: z.boolean() }).strict() }).strict();
const errorSchema = z.object({ conversation_id: z.string().trim().min(1).max(256), status: z.literal('error'), criteria: z.tuple([]), score: z.null(), error: z.string().trim().min(5).max(400) }).strict();
export const competitionDocumentSchema = z.object({ schema_version: z.literal('1.0'), team_name: z.string().trim().min(2).max(100),
  model: z.object({ mode: z.enum(['local', 'external_api', 'hybrid']), name: z.string().trim().min(1).max(200) }).strict(),
  results: z.array(z.discriminatedUnion('status', [okSchema, errorSchema])).min(1),
}).strict();
export type CompetitionDocument = z.infer<typeof competitionDocumentSchema>;
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail = (code: string): never => { throw new Error(code); };

/** No constructors, schema migration, network path or write connection is used. */
export function readCompetitionDataset(dbPath: string, groupId: string): CompetitionDataset {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const rows = db.prepare('SELECT json,original_json FROM conversations WHERE group_id=? AND rowid IN (SELECT MAX(rowid) FROM conversations GROUP BY group_id,conversation_id) ORDER BY conversation_id').all(groupId) as Array<{ json: string; original_json: string }>;
    const conversations = rows.map(row => JSON.parse(row.json) as Conversation);
    const values = <T>(sql: string) => (db.prepare(sql).all() as Array<{ json: string }>).map(row => JSON.parse(row.json) as T);
    const output = { groupId, conversations, originals: new Map(rows.map((row, index) => [conversations[index].version, JSON.parse(row.original_json) as unknown])),
      checklists: values<Checklist>('SELECT json FROM checklists ORDER BY rowid DESC'), evaluations: values<Evaluation>('SELECT json FROM evaluations ORDER BY rowid DESC'), attempts: values<EvaluationAttempt>('SELECT json FROM evaluation_attempts ORDER BY rowid DESC') };
    db.exec('COMMIT'); return output;
  } finally { db.close(); }
}

function officialSnapshot(checklists: Checklist[]) {
  const official = checklists.find(checklist => checklist.version === initialChecklist.version);
  if (!official || canonicalJson(official) !== canonicalJson(initialChecklist)) fail('OFFICIAL_CHECKLIST_SNAPSHOT_MISMATCH');
  return official!;
}
export function verifyOriginalTranscript(conversation: Conversation, raw: unknown): Map<string, number> {
  const parsed = z.object({ conversation_id: z.string(), transcript: z.array(z.object({ timestamp: z.string(), speaker: z.string(), text: z.string() }).passthrough()) }).passthrough().safeParse(raw);
  if (!parsed.success || parsed.data.conversation_id !== conversation.conversationId || parsed.data.transcript.length !== conversation.messages.length || !conversation.messages.length) fail('ORIGINAL_TRANSCRIPT_MISMATCH');
  const map = new Map<string, number>();
  for (const [index, message] of conversation.messages.entries()) {
    const original = parsed.data!.transcript[index];
    if (message.position !== index || !message.id || map.has(message.id) || message.timestamp !== original.timestamp || message.speaker !== original.speaker || message.text !== original.text) fail('ORIGINAL_TRANSCRIPT_MISMATCH');
    map.set(message.id, index + 1);
  }
  return map;
}

/** Latest eligible official result, never the highest score. Legacy AI origin may be absent. */
export function selectOfficialEvaluation(conversation: Conversation, checklists: Checklist[], evaluations: Evaluation[], configuredModel: string) {
  const official = officialSnapshot(checklists);
  const rejected: Array<{ evaluationId: string; reason: string }> = [];
  const candidates = evaluations.filter(evaluation => evaluation.conversationVersion === conversation.version).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  for (const evaluation of candidates) {
    let reason: string | null = null;
    const realCall = conversation.channel === 'voice call' || conversation.classification === 'real_restricted';
    if (evaluation.checklistVersion !== official.version) reason = 'NON_OFFICIAL_CHECKLIST';
    else if (evaluation.status === 'human_entered') {
      if (evaluation.origin !== 'human' || evaluation.provider !== 'local' || evaluation.mode !== 'local' || evaluation.model !== 'none' || (evaluation.reviewer?.trim().length ?? 0) < 2 || evaluation.configuration.humanAttestation !== true || evaluation.configuration.method !== 'manual-entry' || evaluation.configuration.policy !== 'local-only-no-provider' || evaluation.configuration.purpose !== 'user-entered-local-review') reason = 'UNAUTHENTICATED_HUMAN_RESULT';
    } else if (evaluation.status !== 'live_validated' || (evaluation.origin !== 'ai' && evaluation.origin !== undefined) || evaluation.provider !== 'gemini' || evaluation.mode !== 'free' || evaluation.model !== configuredModel || realCall) reason = realCall ? 'REAL_CALL_REQUIRES_LOCAL_HUMAN_REVIEW' : 'INELIGIBLE_AI_RESULT';
    if (!reason) {
      try { validateEvidence(conversation, official, { results: evaluation.results }); calculateScore(official, evaluation.results); }
      catch { reason = 'INVALID_SAVED_EVIDENCE_OR_VALUES'; }
    }
    if (!reason) return { evaluation, rejected };
    rejected.push({ evaluationId: evaluation.id, reason });
  }
  return { evaluation: undefined, rejected };
}

function evidenceTurns(conversation: Conversation, result: CriterionResult, positions: Map<string, number>): number[] {
  const selected = new Set(result.evidence.map(reference => positions.get(reference.messageId) ?? fail('UNKNOWN_EVIDENCE_MESSAGE')));
  const configured = initialChecklist.criteria.find(criterion => criterion.id === result.criterionId)!;
  const rangeNeeded = result.answer === 'NO' || result.answer === 'N/A' || configured.answerType === 'numeric' && Number(result.answer) < configured.scaleMax || !selected.size;
  if (rangeNeeded && result.checkedRange) {
    const start = positions.get(result.checkedRange.startMessageId) ?? fail('INVALID_CHECKED_RANGE');
    const end = positions.get(result.checkedRange.endMessageId) ?? fail('INVALID_CHECKED_RANGE');
    if (start > end) fail('INVALID_CHECKED_RANGE');
    for (let turn = start; turn <= end; turn++) selected.add(turn);
  }
  if (!selected.size || [...selected].some(turn => turn > conversation.messages.length)) fail('MISSING_OFFICIAL_EVIDENCE_TURNS');
  return [...selected].sort((a, b) => a - b);
}

const sensitivePattern = /https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d[\d\s()+-]{4,}\d\b|AIza[A-Za-z0-9_-]{20,}|[?&](?:sig|token|signature)=/i;
function sourceNames(conversation: Conversation): string[] {
  return [...new Set(conversation.messages.flatMap(message => [
    ...(message.text.match(/\p{Lu}[\p{L}\p{M}'-]{2,}/gu) ?? []),
    ...[...message.text.matchAll(/(?:зовут|имя|есімім|атым|my name is|i am)\s+([\p{L}\p{M}'-]{3,})/giu)].map(match => match[1]),
  ]))].filter(word => !['Оператор', 'Клиент', 'Operator', 'Client'].includes(word)).sort((a, b) => b.length - a.length);
}
function redactPublicText(text: string, conversation: Conversation) {
  let output = text.replace(/https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b[\w-]+\.(?:com|ru|kz|global|net|org)(?:\/\S*)?/gi, '[ссылка скрыта]')
    .replace(/«[^»]*»|“[^”]*”|"[^"\n]*"/g, '[цитата скрыта]')
    .replace(/\d(?:[\d\s()+.,/-]*\d)?/g, '[число скрыто]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[идентификатор скрыт]');
  for (const name of sourceNames(conversation)) output = output.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), '[данные скрыты]');
  // Remove unquoted contiguous source fragments too. The original remains private.
  for (const message of conversation.messages) {
    const words = [...message.text.matchAll(/\S+/g)];
    for (let index = 0; index + 3 < words.length; index++) {
      const fragment = message.text.slice(words[index].index!, words[index + 3].index! + words[index + 3][0].length);
      if (fragment.length >= 24) output = output.replaceAll(fragment, '[фрагмент источника скрыт]');
    }
  }
  return output.replace(/\s+/g, ' ').trim().slice(0, 650).trim();
}
function publicRationale(conversation: Conversation, result: CriterionResult) {
  const raw = result.answer === 'N/A' ? `${result.explanation} ${result.applicabilityRationale}` : result.explanation;
  let output = redactPublicText(raw, conversation);
  const substantive = output.replace(/\[[^\]]*\]/g, '').match(/\p{L}{3,}/gu) ?? [];
  if (substantive.length < 3 || output.length < 12 || sensitivePattern.test(output)) fail('PUBLIC_RATIONALE_UNSAFE');
  if (result.reviewRequired) {
    const uncertainty = redactPublicText(result.uncertainty, conversation);
    output += ` Требуется предметная проверка: ${uncertainty && !sensitivePattern.test(uncertainty) ? uncertainty.slice(0, 110) : 'оговорка сохранена в частном аудите.'}`;
  }
  if (output.length > 800) output = output.slice(0, 800);
  return { rationale: output, redacted: output !== raw.trim(), originalExplanation: result.explanation, originalApplicability: result.applicabilityRationale, originalUncertainty: result.uncertainty, reviewRequired: result.reviewRequired };
}
const answerValue = (result: CriterionResult) => result.answer === 'N/A' ? null : result.answer === 'YES' ? true : result.answer === 'NO' ? false : Number(result.answer);
const publicErrors: Record<string, string> = {
  NO_VALID_OFFICIAL_EVALUATION: 'Нет допустимой сохранённой оценки по исходному официальному чек-листу.',
  REAL_CALL_REQUIRES_LOCAL_HUMAN_REVIEW: 'Реальный звонок требует подлинной локальной человеческой оценки; она ещё не сохранена.',
  PUBLIC_RATIONALE_UNSAFE: 'Оценка сохранена, но её обоснование требует безопасного редактирования перед публичной выгрузкой.',
  ORIGINAL_TRANSCRIPT_MISMATCH: 'Не подтверждено соответствие полной исходной транскрипции.',
  INVALID_SAVED_EVIDENCE_OR_VALUES: 'Сохранённый результат не прошёл повторную проверку доказательств или допустимых значений.',
};
const providerFailureReasons: Record<string, string> = {
  PROVIDER_QUOTA_EXHAUSTED: 'Лимит провайдера исчерпан; допустимая официальная оценка не получена.',
  PROVIDER_RATE_LIMITED: 'Провайдер ограничил частоту запросов; допустимая официальная оценка не получена.',
  PROVIDER_TIMEOUT: 'Провайдер не ответил в установленный срок; официальная оценка не получена.',
  PROVIDER_NETWORK_ERROR: 'Запрос к провайдеру завершился сетевой ошибкой; официальная оценка не получена.',
  INVALID_EVIDENCE: 'Ответ модели не прошёл проверку доказательств; официальный результат не сохранён.',
};
function validateDataset(dataset: CompetitionDataset, options: CompetitionOptions) {
  if (!['dev', 'prod'].includes(options.target)) fail('COMPETITION_TARGET_INVALID');
  if (!options.teamName.trim() || options.teamName !== competitionTeamName) fail('COMPETITION_TEAM_NAME_MISMATCH');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/+ -]{0,199}$/.test(options.configuredModel) || options.configuredModel === 'none') fail('COMPETITION_MODEL_METADATA_UNAVAILABLE');
  officialSnapshot(dataset.checklists);
  const expectedCount = options.target === 'dev' ? 65 : 10;
  if (dataset.conversations.length !== expectedCount || dataset.conversations.some(conversation => conversation.groupId !== dataset.groupId)) fail('COMPETITION_SOURCE_COVERAGE_MISMATCH');
  if (options.target === 'dev' && (dataset.groupId !== 'DEV' || dataset.conversations.filter(c => c.channel === 'agent chat').length !== 60 || dataset.conversations.filter(c => c.channel === 'voice call').length !== 5)) fail('COMPETITION_DEV_SOURCE_MISMATCH');
  const ids = dataset.conversations.map(conversation => conversation.conversationId);
  if (new Set(ids).size !== ids.length) fail('DUPLICATE_SOURCE_CONVERSATION_ID');
  if (options.expectedIds && (new Set(options.expectedIds).size !== options.expectedIds.length || canonicalJson([...options.expectedIds].sort()) !== canonicalJson([...ids].sort()))) fail('COMPETITION_EXPECTED_ID_SET_MISMATCH');
}

export function buildCompetitionExport(dataset: CompetitionDataset, options: CompetitionOptions) {
  validateDataset(dataset, options);
  const recordAudits: Array<Record<string, unknown>> = [];
  const modelSources: Evaluation[] = [];
  const results = [...dataset.conversations].sort((a, b) => a.conversationId.localeCompare(b.conversationId, 'en')).map(conversation => {
    const selection = selectOfficialEvaluation(conversation, dataset.checklists, dataset.evaluations, options.configuredModel);
    const evaluation = selection.evaluation;
    const lastFailure = dataset.attempts.filter(attempt => attempt.conversationVersion === conversation.version && attempt.checklistVersion === initialChecklist.version && attempt.model === options.configuredModel && attempt.status === 'failed').sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    const privateRecord: Record<string, unknown> = { conversationId: conversation.conversationId, conversationVersion: conversation.version, sourceHash: digest(conversation), rejected: selection.rejected, selectedEvaluationId: evaluation?.id ?? null, origin: evaluation?.origin ?? (evaluation ? 'legacy_ai_metadata' : null) };
    if (lastFailure) privateRecord.latestFailedAttempt = lastFailure;
    if (evaluation) Object.assign(privateRecord, { originalResults: evaluation.results, configuration: evaluation.configuration, reviewer: evaluation.reviewer ?? null, createdAt: evaluation.createdAt, provider: evaluation.provider, model: evaluation.model, mode: evaluation.mode, usage: evaluation.usage, latencyMs: evaluation.latencyMs, providerCallCount: evaluation.providerCallCount });
    try {
      const positions = verifyOriginalTranscript(conversation, dataset.originals.get(conversation.version));
      if (!evaluation) fail(conversation.channel === 'voice call' || conversation.classification === 'real_restricted' ? 'REAL_CALL_REQUIRES_LOCAL_HUMAN_REVIEW' : 'NO_VALID_OFFICIAL_EVALUATION');
      const score = calculateScore(initialChecklist, evaluation!.results);
      if (score.total === null) fail('INVALID_SAVED_EVIDENCE_OR_VALUES');
      const rationales: Array<Record<string, unknown>> = [];
      const criteria = initialChecklist.criteria.map((configured, index) => {
        const result = evaluation!.results.find(result => result.criterionId === configured.id)!;
        const rationale = publicRationale(conversation, result); rationales.push({ criterionId: result.criterionId, ...rationale });
        return { criterion_id: competitionCriterionIds[index], value: answerValue(result), rationale: rationale.rationale, evidence_turns: evidenceTurns(conversation, result, positions) };
      });
      if (evaluation!.status === 'live_validated') modelSources.push(evaluation!);
      Object.assign(privateRecord, { status: 'ok', provenance: evaluation!.status === 'human_entered' ? 'human-entered-local-attested' : 'actual-saved-ai-result', evaluationHash: digest(evaluation), checklistHash: digest(initialChecklist), configuration: evaluation!.configuration, reviewer: evaluation!.reviewer ?? null, rationales });
      recordAudits.push(privateRecord);
      return { conversation_id: conversation.conversationId, status: 'ok' as const, criteria, score: { final_score: score.total!, critical_flag: Boolean(score.flags.C8) } };
    } catch (error) {
      const rawCode = error instanceof Error ? error.message : 'NO_VALID_OFFICIAL_EVALUATION';
      const code = Object.hasOwn(publicErrors, rawCode) ? rawCode : 'INVALID_SAVED_EVIDENCE_OR_VALUES';
      Object.assign(privateRecord, { status: 'error', errorCode: code }); recordAudits.push(privateRecord);
      const publicReason = code === 'NO_VALID_OFFICIAL_EVALUATION' && lastFailure?.errorCode && Object.hasOwn(providerFailureReasons, lastFailure.errorCode) ? providerFailureReasons[lastFailure.errorCode] : publicErrors[code];
      return { conversation_id: conversation.conversationId, status: 'error' as const, criteria: [], score: null, error: publicReason };
    }
  });
  const fallback = dataset.evaluations.find(evaluation => evaluation.status === 'live_validated' && evaluation.provider === 'gemini' && evaluation.mode === 'free' && evaluation.model === options.configuredModel && (evaluation.origin === 'ai' || evaluation.origin === undefined));
  const humanSuccesses = recordAudits.filter(record => record.status === 'ok' && record.provenance === 'human-entered-local-attested').length;
  const humanOnly = humanSuccesses > 0 && !modelSources.length;
  const modelName = humanOnly ? 'human review (no AI model)' : (modelSources[0] ?? fallback)?.model ?? options.configuredModel;
  const mode = humanOnly ? 'local' : humanSuccesses ? 'hybrid' : 'external_api';
  const document = competitionDocumentSchema.parse({ schema_version: '1.0', team_name: options.teamName, model: { mode, name: modelName }, results });
  const audit = { schemaVersion: 1, createdAt: new Date().toISOString(), groupId: dataset.groupId, target: options.target, sourceDatabaseReadOnly: true, modelCalls: 0, selectionPolicy: 'latest-eligible-official-by-createdAt-then-id-never-best-score',
    documentHash: digest(document), officialChecklistHash: digest(initialChecklist), success: results.filter(result => result.status === 'ok').length, error: results.filter(result => result.status === 'error').length,
    modelMetadata: { configuredModel: options.configuredModel, observedSuccessfulEvaluationIds: [...new Set((modelSources.length ? modelSources : !humanOnly && fallback ? [fallback] : []).map(evaluation => evaluation.id))], selectedAiEvaluationCount: modelSources.length, selectedHumanEvaluationCount: humanSuccesses, noSuccessfulModelObserved: humanOnly || !modelSources.length && !fallback, fallbackFromConfigurationOnly: !humanOnly && !modelSources.length && !fallback,
      metadataSource: humanOnly ? 'human-review-no-ai' : modelSources.length ? 'selected-ai-results' : fallback ? 'observed-system-ai-fallback-no-exported-ai-success' : 'configured-model-only-all-errors' },
    rationalePolicy: 'Privacy-filtered saved explanations; no model-generated replacement. Unusable rationale fails closed. Uncertainty remains explicit. Private diagnostics are never part of official JSON.',
    privacyLimitations: ['Deterministic redaction is conservative and cannot prove removal of every personal identifier.', 'Original explanations and source hashes remain private; public publication still requires the release privacy audit and explicit authorization.', 'Technical grounding validates source references and exact quotations, not hidden Ground Truth accuracy.'], records: recordAudits };
  return { document, audit };
}
export type CompetitionExport = ReturnType<typeof buildCompetitionExport>;

export function validateCompetitionResults(raw: unknown, dataset: CompetitionDataset, options: CompetitionOptions): CompetitionDocument {
  validateDataset(dataset, options);
  const document = competitionDocumentSchema.parse(raw);
  if (document.team_name !== options.teamName) fail('COMPETITION_METADATA_MISMATCH');
  const expectedIds = dataset.conversations.map(conversation => conversation.conversationId).sort();
  const actualIds = document.results.map(result => result.conversation_id);
  if (new Set(actualIds).size !== actualIds.length || canonicalJson([...actualIds].sort()) !== canonicalJson(expectedIds)) fail('COMPETITION_RESULT_ID_COVERAGE_MISMATCH');
  for (const record of document.results) {
    const conversation = dataset.conversations.find(source => source.conversationId === record.conversation_id)!;
    if (record.status === 'error') { if (sensitivePattern.test(record.error)) fail('PUBLIC_ERROR_UNSAFE'); continue; }
    verifyOriginalTranscript(conversation, dataset.originals.get(conversation.version));
    for (const result of record.criteria) {
      if (result.evidence_turns.some(turn => turn > conversation.messages.length)) fail('EVIDENCE_TURN_OUT_OF_BOUNDS');
      if (sensitivePattern.test(result.rationale)) fail('PUBLIC_RATIONALE_UNSAFE');
    }
    const answers = record.criteria.map((criterion, index) => ({ criterionId: `C${index + 1}`, answer: criterion.value === null ? 'N/A' : typeof criterion.value === 'boolean' ? criterion.value ? 'YES' : 'NO' : String(criterion.value) }));
    const score = calculateScore(initialChecklist, answers);
    if (score.total !== record.score.final_score || Boolean(score.flags.C8) !== record.score.critical_flag) fail('COMPETITION_SCORE_OR_FLAG_MISMATCH');
  }
  // A structurally valid edited answer or citation is still rejected if it was not exported
  // from the eligible saved result. This comparison never writes annotations.
  const expected = buildCompetitionExport(dataset, options).document;
  if (canonicalJson(document) !== canonicalJson(expected)) fail('COMPETITION_SAVED_RESULT_PROVENANCE_MISMATCH');
  return document;
}

function containedPath(root: string, path: string) {
  const child = relative(root, path);
  if (!child || child.startsWith('..') || isAbsolute(child)) fail('UNSAFE_COMPETITION_OUTPUT_PATH');
  let parent = dirname(path);
  while (!existsSync(parent)) parent = dirname(parent);
  const resolvedParent = realpathSync(parent);
  const realRoot = realpathSync(root);
  const relation = relative(realRoot, resolvedParent);
  if (relation.startsWith('..') || isAbsolute(relation)) fail('UNSAFE_COMPETITION_OUTPUT_PATH');
}
/** Official writes are local only, validated before a same-directory atomic rename. */
export function writeCompetitionExport(bundle: CompetitionExport, dataset: CompetitionDataset, options: CompetitionOptions & { dryRun: boolean; workspaceRoot?: string }) {
  if (typeof options.dryRun !== 'boolean') fail('COMPETITION_EXPORT_MODE_REQUIRED');
  validateCompetitionResults(bundle.document, dataset, options);
  const root = resolve(options.workspaceRoot ?? '.');
  const fixtureSources = /LOCAL[_-]?REHEARSAL|CQA[_-]?ACCEPTANCE|SOFTWARE|FIXTURE|REHEARSAL/i.test(dataset.groupId) || dataset.conversations.some(conversation => /^(?:software|fixture|local[_-]rehearsal)[_-]/i.test(conversation.conversationId));
  const tmpChild = relative(resolve('tmp'), root);
  const realTmpChild = existsSync(root) && existsSync('tmp') && !lstatSync('tmp').isSymbolicLink() ? relative(realpathSync('tmp'), realpathSync(root)) : null;
  const isolatedTestRoot = options.workspaceRoot !== undefined && Boolean(tmpChild) && !tmpChild.startsWith('..') && !isAbsolute(tmpChild) && Boolean(realTmpChild) && !realTmpChild!.startsWith('..') && !isAbsolute(realTmpChild!);
  if (!options.dryRun && fixtureSources && !isolatedTestRoot) fail('FIXTURE_OFFICIAL_EXPORT_FORBIDDEN');
  const directory = options.dryRun ? resolve(root, 'private/reports/competition', `${options.target}-${Date.now()}-${randomUUID().slice(0, 8)}`) : resolve(root, 'results', options.target);
  const outputPath = resolve(directory, 'results.json');
  containedPath(resolve('.'), outputPath);
  containedPath(root, outputPath); mkdirSync(directory, { recursive: true }); containedPath(root, outputPath);
  if (existsSync(outputPath)) containedPath(root, realpathSync(outputPath));
  const temporary = resolve(directory, `.results-${randomUUID()}.tmp`);
  const content = `${JSON.stringify(bundle.document, null, 2)}\n`;
  writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
  try {
    // Parsing the serialized artifact catches encoding/serialization surprises before replacement.
    validateCompetitionResults(JSON.parse(readFileSync(temporary, 'utf8')), dataset, options);
    renameSync(temporary, outputPath);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  const auditDirectory = resolve(root, 'private/reports/competition-audits'); containedPath(root, resolve(auditDirectory, 'audit.json')); mkdirSync(auditDirectory, { recursive: true });
  const auditPath = resolve(auditDirectory, `${options.target}-${bundle.audit.documentHash}-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(auditPath, `${JSON.stringify({ ...bundle.audit, outputPath, dryRun: options.dryRun }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { outputPath, auditPath, documentHash: bundle.audit.documentHash, dryRun: options.dryRun, success: bundle.audit.success, error: bundle.audit.error, records: bundle.document.results.length };
}
