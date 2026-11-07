import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { config } from '../server/config.js';
import { Store } from '../server/store.js';
import { QualityStore, type ValidationCase, type ValidationManifest } from '../server/quality.js';
import validationChecklist from '../src/data/validation-checklist.json' with { type: 'json' };
import { validateChecklist } from '../src/checklist.js';

const selections: Array<{ id: string; split: ValidationCase['split']; tags: string[]; reason: string }> = [
  { id: 'p1-ru-003', split: 'development', tags: ['partial_consultation', 'unresolved_additional_question', 'na_vs_no'], reason: 'Несколько вопросов, уточнение среды, повторный вопрос клиента о комиссии.' },
  { id: 'p1-ru-014', split: 'holdout', tags: ['bot_vs_operator_greeting', 'known_context', 'clarity', 'closing'], reason: 'Бот представляет себя; первая реплика человека короткая, клиент повторяет ранее переданные сведения.' },
  { id: 'p1-ru-025', split: 'development', tags: ['na_vs_no', 'interrupted_conversation', 'request_not_formulated'], reason: 'Клиент выходит после подключения человека до формулировки предметного запроса.' },
  { id: 'p1-ru-029', split: 'holdout', tags: ['empathy_dissatisfaction', 'gross_violations', 'closing'], reason: 'Клиент выражает недовольство; требуется отдельно оценить корректность ответа и форму общения.' },
  { id: 'p1-kz-003', split: 'holdout', tags: ['identity_timing', 'system_verification', 'empathy_dissatisfaction', 'additional_questions'], reason: 'Проверка личности системным событием, проверка перевода и отдельные вопросы об отчёте.' },
  { id: 'p1-kz-005', split: 'development', tags: ['incorrect_or_general_consultation', 'clarity', 'closing'], reason: 'Клиент не находит названный раздел и получает уточнённый путь позже.' },
  { id: 'p1-kz-013', split: 'holdout', tags: ['gross_violations', 'unofficial_paid_service', 'closing'], reason: 'После навигационной помощи возникает предложение общения вне компании.' },
  { id: 'p1-kz-015', split: 'development', tags: ['identity_timing', 'account_specific_disclosure', 'na_vs_no', 'gross_violations'], reason: 'В хронологии есть сообщение о состоянии счёта и возражение клиента о проверке личности.' },
  { id: 'p1-en-006', split: 'development', tags: ['identity_timing', 'system_verification', 'empathy_dissatisfaction', 'additional_questions'], reason: 'Проверка перевода, подтверждение личности и несколько дополнительных вопросов.' },
  { id: 'p1-en-007', split: 'holdout', tags: ['partial_consultation', 'unresolved_additional_question', 'closing'], reason: 'Клиент спрашивает о месте подачи и возможности повторного вывода; нужно проверить оба вопроса.' },
  { id: 'p1-en-009', split: 'development', tags: ['interrupted_conversation', 'closing', 'na_vs_no'], reason: 'Системное событие потери соединения после ответа оператора.' },
  { id: 'p1-en-015', split: 'holdout', tags: ['bot_vs_operator_greeting', 'incorrect_or_general_consultation', 'clarity'], reason: 'Клиент уточняет среду после первоначального совета оператора; бот и человек имеют разные роли.' },
];
const store = new Store(config.dbPath);
const quality = new QualityStore(config.dbPath);
try {
  if (config.model !== 'gemini-3.1-flash-lite') throw new Error('MODEL_CHANGE_REQUIRES_USER_APPROVAL');
  const index = process.argv.indexOf('--checklist');
  const checklistVersion = index >= 0 ? process.argv[index + 1] : validationChecklist.version;
  if (checklistVersion === validationChecklist.version && !store.getChecklist(checklistVersion)) store.saveChecklist(validateChecklist(validationChecklist));
  const checklist = store.getChecklist(checklistVersion);
  if (!checklist) throw new Error('CHECKLIST_NOT_FOUND');
  const id = `dev-balanced12-${createHash('sha256').update(checklistVersion).digest('hex').slice(0, 12)}`;
  const existing = quality.getManifest(id);
  if (existing) {
    console.log(JSON.stringify({ status: 'PASS', manifestId: existing.id, cases: existing.cases.length, unchanged: true, humanReferencesCreated: 0 }));
  } else {
    const conversations = store.listConversations('DEV');
    const cases: ValidationCase[] = selections.map(item => {
      const conversation = conversations.find(c => c.conversationId === item.id);
      if (!conversation) throw new Error('VALIDATION_SOURCE_NOT_IMPORTED');
      return { id: item.id, conversationId: item.id, conversationVersion: conversation.version, checklistVersion, language: conversation.language, split: item.split, kind: 'core', tags: [...item.tags, ...(checklist.criteria.some(c => c.id === 'C9') ? ['configured_new_criterion'] : [])], selectionReason: item.reason };
    });
    let sourceRevision = 'unknown-local-revision';
    try { sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* Revision provenance stays explicitly unknown. */ }
    const manifest: ValidationManifest = { id, title: 'DEV · независимая проверка 12 чатов RU/KZ/EN', createdAt: new Date().toISOString(), sourceRevision, model: 'gemini-3.1-flash-lite', selectionFrozen: true, priorTuningExcluded: ['p1-ru-001', 'p1-kz-001', 'p1-en-001'], cases };
    quality.saveManifest(manifest, conversations, checklist);
    mkdirSync('private/validation', { recursive: true });
    writeFileSync(`private/validation/${id}.json`, JSON.stringify({ manifest, checklist }, null, 2));
    console.log(JSON.stringify({ status: 'PASS', manifestId: id, coreCases: cases.length, languages: { RU: 4, KZ: 4, EN: 4 }, development: 6, holdout: 6, checklistVersion, criteria: checklist.criteria.length, frozenBeforeNewEvaluation: true, humanReferencesCreated: 0 }, null, 2));
  }
} finally { quality.close(); store.close(); }
