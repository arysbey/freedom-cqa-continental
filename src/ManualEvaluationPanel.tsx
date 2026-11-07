import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Checklist, Conversation, CriterionResult, Evaluation } from './domain.js';
import { calculateScore } from './scoring.js';

interface Props { conversation: Conversation; checklist: Checklist; onSaved: (evaluation: Evaluation) => void; onError?: (message: string) => void }
interface Draft { results: CriterionResult[]; reviewer: string; origin: 'human' | 'agent_demo' }
const label = (value: string) => ({ YES: 'Да', NO: 'Нет', 'N/A': 'N/A' })[value] || value;
const emptyResult = (criterionId: string): CriterionResult => ({ criterionId, answer: '', applicabilityRationale: '', explanation: '', evidence: [], checkedRange: null, reviewRequired: false, uncertainty: '' });
function restore(key: string, checklist: Checklist): Draft {
  const fallback: Draft = { results: checklist.criteria.map(c => emptyResult(c.id)), reviewer: '', origin: 'human' };
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    if (!value || typeof value.reviewer !== 'string' || !['human', 'agent_demo'].includes(value.origin) || !Array.isArray(value.results) || value.results.length !== checklist.criteria.length) return fallback;
    for (let i = 0; i < value.results.length; i++) {
      const result = value.results[i];
      if (result.criterionId !== checklist.criteria[i].id || ['answer', 'applicabilityRationale', 'explanation', 'uncertainty'].some(field => typeof result[field] !== 'string') || typeof result.reviewRequired !== 'boolean' || !Array.isArray(result.evidence) || result.evidence.some((e: unknown) => !e || typeof e !== 'object' || !('messageId' in e) || typeof e.messageId !== 'string' || !('quote' in e) || typeof e.quote !== 'string')) return fallback;
      if (result.checkedRange && (typeof result.checkedRange.startMessageId !== 'string' || typeof result.checkedRange.endMessageId !== 'string')) return fallback;
    }
    return value;
  } catch { return fallback; }
}
function problems(result: CriterionResult, conversation: Conversation, checklist: Checklist): string[] {
  const criterion = checklist.criteria.find(c => c.id === result.criterionId)!;
  const errors: string[] = [];
  const isNa = result.answer === 'N/A';
  if (isNa ? !criterion.naAllowed : !criterion.allowedValues.includes(result.answer)) errors.push('Выберите допустимый ответ.');
  if (!result.explanation.trim()) errors.push('Добавьте обоснование.');
  if (isNa && !result.applicabilityRationale.trim()) errors.push('Объясните выполнение условия N/A.');
  const negative = result.answer === 'NO' || criterion.answerType === 'numeric' && !isNa && result.answer !== '' && Number(result.answer) < criterion.scaleMax;
  if (negative && !result.checkedRange) errors.push('Укажите проверенный диапазон для пропущенного действия или частичной оценки.');
  if (!result.evidence.length && !result.checkedRange) errors.push('Выберите подтверждающую реплику или проверенный диапазон.');
  if (!isNa && !negative && result.answer && !result.evidence.length) errors.push('Положительный ответ требует точной цитаты.');
  if (result.checkedRange) {
    const start = conversation.messages.findIndex(m => m.id === result.checkedRange!.startMessageId);
    const end = conversation.messages.findIndex(m => m.id === result.checkedRange!.endMessageId);
    if (start < 0 || end < start) errors.push('Укажите существующие начало и конец диапазона по порядку.');
  }
  if (result.evidence.some(e => !e.quote.trim() || !conversation.messages.find(m => m.id === e.messageId)?.text.includes(e.quote))) errors.push('Каждая цитата должна точно совпадать с исходной репликой.');
  if (criterion.flag && result.answer === 'YES' && !result.evidence.some(e => conversation.messages.find(m => m.id === e.messageId)?.speaker === 'operator')) errors.push('Флаг нарушения требует прямой реплики оператора.');
  if (result.reviewRequired && !result.uncertainty.trim()) errors.push('Опишите неопределённость.');
  return errors;
}
export function ManualEvaluationPanel(props: Props) { return <ManualContent key={`${props.conversation.version}:${props.checklist.version}`} {...props} />; }
function ManualContent({ conversation, checklist, onSaved, onError }: Props) {
  const storageKey = `cqa:manual-draft:v1:${conversation.version}:${checklist.version}`;
  const [draft, setDraft] = useState(() => restore(storageKey, checklist));
  const [activeId, setActiveId] = useState(checklist.criteria[0]?.id || '');
  const [sourceId, setSourceId] = useState('');
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const attempted = useRef<{ signature: string; requestId: string } | undefined>(undefined);
  const criterion = checklist.criteria.find(c => c.id === activeId)!;
  const result = draft.results.find(r => r.criterionId === activeId)!;
  const validity = draft.results.map(r => problems(r, conversation, checklist));
  const complete = validity.filter(errors => !errors.length).length;
  const preview = useMemo(() => { try { return calculateScore(checklist, draft.results).total; } catch { return null; } }, [checklist, draft.results]);
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(draft)); } catch { setNotice('Браузер не сохранил черновик. Сохраните готовую оценку перед закрытием страницы.'); } }, [draft, storageKey]);
  function update(changes: Partial<CriterionResult>) { setDraft(current => ({ ...current, results: current.results.map(r => r.criterionId === activeId ? { ...r, ...changes } : r) })); setError(''); }
  function addEvidence(messageId: string) {
    const message = conversation.messages.find(m => m.id === messageId);
    if (!message || !message.text.trim()) return;
    setDraft(current => ({ ...current, results: current.results.map(r => r.criterionId !== activeId || r.evidence.some(e => e.messageId === messageId && e.quote === message.text) ? r : { ...r, evidence: [...r.evidence, { messageId, quote: message.text }] }) }));
    setNotice('Исходная реплика добавлена в доказательства выбранного критерия. Можно сократить цитату до точного фрагмента.');
  }
  useEffect(() => {
    const add = (event: Event) => { const detail = (event as CustomEvent<{ conversationVersion: string; messageId: string }>).detail; if (detail?.conversationVersion === conversation.version) addEvidence(detail.messageId); };
    window.addEventListener('cqa:evidence-select', add); return () => window.removeEventListener('cqa:evidence-select', add);
  }, [conversation.version, activeId]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || complete !== checklist.criteria.length || draft.reviewer.trim().length < 2 || draft.origin === 'human' && !attested) return;
    const payload = { conversationVersion: conversation.version, checklistVersion: checklist.version, reviewer: draft.reviewer.trim(), origin: draft.origin, humanAttestation: draft.origin === 'human' && attested, results: draft.results };
    const signature = JSON.stringify(payload);
    if (attempted.current?.signature !== signature) attempted.current = { signature, requestId: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/manual-evaluations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, requestId: attempted.current.requestId }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'MANUAL_SAVE_FAILED');
      try { localStorage.removeItem(storageKey); } catch { /* The saved server record is authoritative. */ }
      attempted.current = undefined;
      setNotice('Ручная оценка сохранена локально. Она доступна для апелляции и пересмотра.');
      onSaved(body as Evaluation);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      const message = code === 'INVALID_EVIDENCE' ? 'Доказательства не прошли серверную проверку. Проверьте точные цитаты и диапазоны.' : code === 'IDEMPOTENCY_CONFLICT' ? 'Этот запрос уже сохранён с другим содержимым. Обновите список оценок.' : 'Не удалось сохранить ручную оценку. Проверьте ответы, обоснования и подключение к локальному серверу.';
      setError(message); onError?.(message);
    } finally { setBusy(false); }
  }
  const option = (id: string) => { const m = conversation.messages.find(m => m.id === id); return m ? `#${m.position + 1} · ${m.timestamp} · ${m.speaker === 'operator' ? 'Оператор' : m.speaker === 'client' ? 'Клиент' : m.speaker === 'bot' ? 'Бот' : 'Система'}` : ''; };
  return <section className="manual-panel" aria-label="Ручная локальная оценка">
    <p className="eyebrow">Человек → доказательства → баллы</p><h3>Ручная локальная оценка</h3>
    <p className="provider">Ручная оценка сохраняется локально. Ответы выбирает проверяющий; модель не вызывается. Реплики внутренней консультации и ошибки ASR требуют отдельного внимания.</p>
    <form onSubmit={event => void submit(event)}>
      <fieldset disabled={busy}><legend>Автор и происхождение</legend>
        <label>Проверяющий<input aria-label="Проверяющий ручной оценки" required minLength={2} maxLength={200} value={draft.reviewer} onChange={e => setDraft({ ...draft, reviewer: e.target.value })} /></label>
        <label>Тип записи<select aria-label="Тип ручной записи" value={draft.origin} onChange={e => { setDraft({ ...draft, origin: e.target.value as Draft['origin'] }); setAttested(false); }}><option value="human">Рабочая оценка человека</option><option value="agent_demo">Техническая демонстрация агента</option></select></label>
        {draft.origin === 'human' ? <label className="checkbox-label"><input type="checkbox" checked={attested} onChange={e => setAttested(e.target.checked)} /> Я лично проверил(а) диалог и внес(ла) собственные решения. Эта запись не утверждает эталон для проверки AI.</label> : <p className="notice">Техническая демонстрация сохраняется отдельно от оценок человека и не считается человеческим эталоном.</p>}
      </fieldset>
      <div className="manual-progress" role="status">Готово критериев: {complete}/{checklist.criteria.length}{preview !== null && <> · Предварительный расчёт: <strong>{preview.toFixed(2)} / 100</strong></>}</div>
      <label>Критерий ручной оценки<select aria-label="Критерий ручной оценки" value={activeId} onChange={e => { setActiveId(e.target.value); setNotice(''); }}>{checklist.criteria.map((c, i) => <option key={c.id} value={c.id}>{validity[i].length ? '○' : '✓'} {c.id} · {c.title}</option>)}</select></label>
      {criterion && result && <fieldset disabled={busy} className="manual-criterion"><legend>{criterion.title}</legend><p>{criterion.instructions}</p>
        <label>Ответ<select aria-label="Ответ ручной оценки" required value={result.answer} onChange={e => update({ answer: e.target.value })}><option value="">Выберите ответ</option>{[...criterion.allowedValues, ...(criterion.naAllowed ? ['N/A'] : [])].map(answer => <option value={answer} key={answer}>{label(answer)}</option>)}</select></label>
        {result.answer === 'N/A' && <><p className="provider">Условие N/A: {criterion.naCondition}</p><label>Причина N/A<textarea aria-label="Причина N/A ручной оценки" required rows={2} value={result.applicabilityRationale} onChange={e => update({ applicabilityRationale: e.target.value })} /></label></>}
        <label>Обоснование<textarea aria-label="Обоснование ручной оценки" required rows={3} value={result.explanation} onChange={e => update({ explanation: e.target.value })} /></label>
        <p className="provider">{criterion.evidenceRequirement}</p>
        <label>Исходная реплика<select aria-label="Исходная реплика для цитаты" value={sourceId} onChange={e => setSourceId(e.target.value)}><option value="">Выберите реплику</option>{conversation.messages.map(m => <option value={m.id} key={m.id}>{option(m.id)} · {m.text.slice(0, 60)}</option>)}</select></label>
        <button type="button" disabled={!sourceId} onClick={() => addEvidence(sourceId)}>Добавить точную цитату</button>
        {result.evidence.map((evidence, index) => <div className="manual-evidence" key={index}><label>Цитата {index + 1} · {option(evidence.messageId)}<textarea aria-label={`Точная цитата ${index + 1}`} rows={3} value={evidence.quote} onChange={e => update({ evidence: result.evidence.map((value, i) => i === index ? { ...value, quote: e.target.value } : value) })} /></label><button type="button" onClick={() => update({ evidence: result.evidence.filter((_, i) => i !== index) })}>Удалить цитату {index + 1}</button></div>)}
        <fieldset className="manual-range"><legend>Проверенный участок</legend><p className="provider">Указывайте реально просмотренный участок. Для пропущенного действия и частичного балла диапазон обязателен.</p>
          <label>Начало<select aria-label="Начало ручного диапазона" value={result.checkedRange?.startMessageId || ''} onChange={e => update({ checkedRange: { startMessageId: e.target.value, endMessageId: result.checkedRange?.endMessageId || '' } })}><option value="">Не выбрано</option>{conversation.messages.map(m => <option key={m.id} value={m.id}>{option(m.id)}</option>)}</select></label>
          <label>Конец<select aria-label="Конец ручного диапазона" value={result.checkedRange?.endMessageId || ''} onChange={e => update({ checkedRange: { startMessageId: result.checkedRange?.startMessageId || '', endMessageId: e.target.value } })}><option value="">Не выбрано</option>{conversation.messages.map(m => <option key={m.id} value={m.id}>{option(m.id)}</option>)}</select></label>
          {result.checkedRange && <button type="button" onClick={() => update({ checkedRange: null })}>Убрать диапазон</button>}
        </fieldset>
        <label className="checkbox-label"><input type="checkbox" checked={result.reviewRequired} onChange={e => update({ reviewRequired: e.target.checked, uncertainty: e.target.checked ? result.uncertainty : '' })} /> Нужна дополнительная проверка</label>
        {result.reviewRequired && <label>Неопределённость<textarea aria-label="Неопределённость ручной оценки" required rows={2} value={result.uncertainty} onChange={e => update({ uncertainty: e.target.value })} /></label>}
        {validity[checklist.criteria.findIndex(c => c.id === activeId)]?.length > 0 && <ul className="manual-missing">{validity[checklist.criteria.findIndex(c => c.id === activeId)].map(problem => <li key={problem}>{problem}</li>)}</ul>}
      </fieldset>}
      <button type="submit" className="primary" disabled={busy || complete !== checklist.criteria.length || draft.reviewer.trim().length < 2 || draft.origin === 'human' && !attested}>{busy ? 'Сохраняем локально…' : 'Сохранить ручную оценку'}</button>
    </form>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
  </section>;
}
