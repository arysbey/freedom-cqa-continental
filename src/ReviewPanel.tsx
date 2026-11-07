import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Checklist, Criterion, Evaluation } from './domain.js';
import type { Appeal, ReviewDecision, ReviewHistory } from '../server/reviews.js';

export interface ReviewPanelProps {
  evaluation: Evaluation;
  checklist: Checklist;
  onError?: (message: string) => void;
}

const label = (answer: string) => ({ YES: 'Да', NO: 'Нет', 'N/A': 'N/A' })[answer] || answer;
const scoreLabel = (score: number | null) => score === null ? 'Не рассчитывается' : `${score.toFixed(2)} / 100`;

const errorMessages: Record<string, string> = {
  APPEAL_ALREADY_REVIEWED: 'По этой апелляции уже принято решение. Обновите историю.',
  STALE_APPEAL: 'Оценка критерия изменилась после подачи этой апелляции. Создайте новое обращение к текущему результату.',
  APPEAL_NOT_FOUND: 'Апелляция не найдена. Обновите историю.',
  IDEMPOTENCY_CONFLICT: 'Идентификатор запроса уже использован для другого действия. Обновите историю перед повтором.',
  CHANGED_ANSWER_MUST_DIFFER: 'Для пересмотра выберите ответ, который отличается от спорного.',
  CHECKLIST_VERSION_MISMATCH: 'Для пересмотра нужен исходный чек-лист сохранённой оценки.',
  IMMUTABLE_REVIEW_SOURCE_CHANGED: 'Исходная версия оценки или чек-листа не совпадает с сохранённой историей.',
  VALIDATION_ERROR: 'Проверьте критерий, допустимый ответ и обязательный комментарий.',
  INVALID_REQUEST: 'Проверьте обязательные поля и допустимый ответ.',
  NOT_FOUND: 'Оценка не найдена. Обновите страницу.',
};

function friendlyError(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  return errorMessages[code] || 'Не удалось выполнить запрос. Проверьте соединение с локальным сервером и повторите действие.';
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const code = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : 'REQUEST_FAILED';
    throw new Error(code);
  }
  return result as T;
}

function evidenceJump(messageId: string) {
  const message = document.getElementById(messageId);
  if (!message) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  message.scrollIntoView({ block: 'center', behavior: reduced ? 'instant' : 'smooth' });
  message.focus({ preventScroll: true });
}

/** Remount local form state when a different immutable evaluation is selected. */
export function ReviewPanel(props: ReviewPanelProps) {
  return <ReviewPanelContent key={props.evaluation.id} {...props} />;
}

function ReviewPanelContent({ evaluation, checklist, onError }: ReviewPanelProps) {
  const [history, setHistory] = useState<ReviewHistory>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mode, setMode] = useState<'appellant' | 'reviewer'>('appellant');
  const [criterionId, setCriterionId] = useState(checklist.criteria[0]?.id || '');
  const [comment, setComment] = useState('');
  const callback = useRef(onError);
  const attemptedAppeal = useRef<{ signature: string; requestId: string } | null>(null);
  const path = `/api/evaluations/${encodeURIComponent(evaluation.id)}`;
  const sourceMatches = checklist.version === evaluation.checklistVersion;
  useEffect(() => { callback.current = onError; }, [onError]);

  const reportError = useCallback((cause: unknown) => {
    const message = friendlyError(cause);
    setError(message);
    callback.current?.(message);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try { setHistory(await request<ReviewHistory>(`${path}/history`)); }
    catch (cause) { reportError(cause); }
    finally { setLoading(false); }
  }, [path, reportError]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    request<ReviewHistory>(`${path}/history`)
      .then(result => { if (active) setHistory(result); })
      .catch(cause => { if (active) reportError(cause); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path, reportError]);

  async function submitAppeal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !sourceMatches || !history) return;
    const payload = { criterionId, comment: comment.trim() };
    if (!payload.comment) { setError('Добавьте комментарий к апелляции.'); return; }
    const signature = JSON.stringify({ evaluationId: evaluation.id, ...payload });
    if (attemptedAppeal.current?.signature !== signature) attemptedAppeal.current = { signature, requestId: crypto.randomUUID() };
    setBusy(true); setError(''); setNotice('');
    try {
      await request<Appeal>(`${path}/appeals`, { ...payload, requestId: attemptedAppeal.current.requestId });
      attemptedAppeal.current = null;
      setComment('');
      setNotice('Апелляция сохранена. Переключитесь в режим проверяющего для принятия решения.');
      await reload();
    } catch (cause) { reportError(cause); }
    finally { setBusy(false); }
  }

  const selectedCriterion = checklist.criteria.find(criterion => criterion.id === criterionId);
  const selectedResult = evaluation.results.find(result => result.criterionId === criterionId);
  const titleId = `review-title-${evaluation.id}`;

  return <section className="review-panel reasoning" aria-labelledby={titleId}>
    <p className="eyebrow">Апелляция и пересмотр</p>
    <h3 id={titleId}>История проверки</h3>
    <p>Исходная оценка: <strong>{scoreLabel(evaluation.score.total)}</strong><br />
      Финальная оценка: <strong>{history ? scoreLabel(history.finalScore.total) : 'Загрузка…'}</strong></p>
    <p className="provider">Исходный чек-лист: {evaluation.checklistVersion}. Локальная демонстрация ролей без учётных записей.</p>
    <div role="group" aria-label="Режим демонстрации пересмотра">
      <button type="button" aria-pressed={mode === 'appellant'} onClick={() => setMode('appellant')}>Заявитель</button>{' '}
      <button type="button" aria-pressed={mode === 'reviewer'} onClick={() => setMode('reviewer')}>Проверяющий</button>
    </div>
    {!sourceMatches && <p role="alert" className="error">Выберите исходную версию чек-листа для этой оценки.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {notice && <p role="status" className="notice">{notice}</p>}
    {loading && <p role="status">Загружаем сохранённую историю…</p>}
    <button type="button" disabled={loading || busy} onClick={() => void reload()}>Обновить историю</button>

    {mode === 'appellant' && <form aria-label="Подать апелляцию" onSubmit={event => void submitAppeal(event)}>
      <label>Критерий апелляции
        <select value={criterionId} onChange={event => setCriterionId(event.target.value)} disabled={busy || !sourceMatches}>
          {checklist.criteria.map(criterion => <option key={criterion.id} value={criterion.id}>{criterion.id} · {criterion.title}</option>)}
        </select>
      </label>
      {selectedResult && <p>Исходный ответ: <strong>{label(selectedResult.answer)}</strong>. Текущий ответ: <strong>{label(history?.finalAnswers[criterionId] ?? selectedResult.answer)}</strong>.</p>}
      {selectedResult && <SourceEvidence result={selectedResult} />}
      <label>Комментарий к апелляции
        <textarea required maxLength={5_000} rows={3} value={comment} onChange={event => setComment(event.target.value)} disabled={busy || !sourceMatches} placeholder="Укажите, какой вывод оспариваете и на какие реплики ссылаетесь." />
      </label>
      {selectedCriterion?.naAllowed && <p className="provider">Условие N/A: {selectedCriterion.naCondition}</p>}
      <button type="submit" disabled={busy || loading || !history || !sourceMatches || !comment.trim()}>{busy ? 'Сохраняем…' : 'Подать апелляцию'}</button>
    </form>}

    {history && <div className="appeal-list">
      <h4>Сохранённые апелляции · {history.appeals.length}</h4>
      {history.appeals.length === 0 && <p>Апелляций пока нет.</p>}
      {history.appeals.map(appeal => {
        const criterion = checklist.criteria.find(item => item.id === appeal.criterionId);
        const decision = history.decisions.find(item => item.appealId === appeal.id);
        const stale = !decision && history.finalAnswers[appeal.criterionId] !== appeal.contestedAnswer;
        return <article key={appeal.id} className="appeal-card">
          <h4>{appeal.criterionId} · {criterion?.title || appeal.criterionId}</h4>
          <p><time dateTime={appeal.createdAt}>{new Date(appeal.createdAt).toLocaleString('ru')}</time> · {decision ? 'Рассмотрена' : stale ? 'Требует нового обращения' : 'Ожидает решения'}</p>
          <p><strong>Комментарий заявителя:</strong> {appeal.comment}</p>
          <p>{evaluation.status === 'live_validated' ? 'Исходный ответ модели' : 'Исходный ответ проверяющего'}: <strong>{label(appeal.originalAnswer)}</strong>. Оспариваемый ответ: <strong>{label(appeal.contestedAnswer)}</strong>.</p>
          <details>
            <summary>Исходное обоснование и доказательства</summary>
            <SourceEvidence result={appeal.originalResult} />
          </details>
          {decision && <DecisionSummary decision={decision} />}
          {!decision && stale && <p className="notice">После подачи изменился ответ по этому критерию. Заявитель может подать апелляцию к текущему ответу.</p>}
          {!decision && !stale && mode === 'reviewer' && criterion && <DecisionForm
            appeal={appeal} criterion={criterion} path={path} disabled={!sourceMatches || loading}
            onSaved={async () => { setNotice('Решение сохранено. Финальный балл пересчитан.'); await reload(); }} onError={reportError}
          />}
        </article>;
      })}
      {history.decisions.length > 0 && <details>
        <summary>Полная история решений · {history.decisions.length}</summary>
        <ol>{history.decisions.map(decision => <li key={decision.id}><p><strong>{decision.criterionId}</strong> · {new Date(decision.createdAt).toLocaleString('ru')}</p><DecisionSummary decision={decision} /></li>)}</ol>
      </details>}
    </div>}
  </section>;
}

function SourceEvidence({ result }: { result: Evaluation['results'][number] }) {
  return <div className="review-evidence">
    <p>{result.explanation}</p>
    {result.applicabilityRationale && <p><strong>Применимость:</strong> {result.applicabilityRationale}</p>}
    {result.evidence.map((evidence, index) => <button type="button" className="evidence-link" key={`${evidence.messageId}-${index}`} onClick={() => evidenceJump(evidence.messageId)}>«{evidence.quote}» ↗</button>)}
    {result.checkedRange && <p>Проверенный участок:{' '}
      <button type="button" className="evidence-link" onClick={() => evidenceJump(result.checkedRange!.startMessageId)}>Начало ↗</button>{' '}
      <button type="button" className="evidence-link" onClick={() => evidenceJump(result.checkedRange!.endMessageId)}>Конец ↗</button>
    </p>}
    {result.reviewRequired && <p className="notice">Нужна проверка: {result.uncertainty}</p>}
  </div>;
}

function DecisionSummary({ decision }: { decision: ReviewDecision }) {
  return <div className="review-decision">
    <p><strong>{decision.action === 'uphold' ? 'Ответ подтверждён' : 'Ответ изменён'}:</strong> {label(decision.previousAnswer)} → {label(decision.answer)}</p>
    <p><strong>Причина проверяющего:</strong> {decision.reason}</p>
    <p>Баллы после решения: <strong>{scoreLabel(decision.finalScore.total)}</strong>. Грубые ошибки: {Object.values(decision.finalScore.flags).some(Boolean) ? 'Да' : 'Нет'}.</p>
  </div>;
}

function DecisionForm({ appeal, criterion, path, disabled, onSaved, onError }: {
  appeal: Appeal; criterion: Criterion; path: string; disabled: boolean;
  onSaved: () => Promise<void>; onError: (cause: unknown) => void;
}) {
  const values = [...criterion.allowedValues, ...(criterion.naAllowed ? ['N/A'] : [])];
  const [action, setAction] = useState<'uphold' | 'change'>('uphold');
  const [answer, setAnswer] = useState(values.find(value => value !== appeal.contestedAnswer) || values[0]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const attempted = useRef<{ signature: string; requestId: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || disabled || !reason.trim()) return;
    const payload = { appealId: appeal.id, action, ...(action === 'change' ? { answer } : {}), reason: reason.trim() };
    const signature = JSON.stringify(payload);
    if (attempted.current?.signature !== signature) attempted.current = { signature, requestId: crypto.randomUUID() };
    setBusy(true);
    try {
      await request<ReviewDecision>(`${path}/decisions`, { ...payload, requestId: attempted.current.requestId });
      attempted.current = null;
      await onSaved();
    } catch (cause) { onError(cause); }
    finally { setBusy(false); }
  }

  return <form aria-label={`Решение по ${appeal.criterionId}`} onSubmit={event => void submit(event)}>
    <fieldset disabled={disabled || busy}>
      <legend>Решение проверяющего</legend>
      <label>Действие
        <select value={action} onChange={event => setAction(event.target.value as 'uphold' | 'change')}>
          <option value="uphold">Подтвердить спорный ответ</option>
          <option value="change">Изменить ответ</option>
        </select>
      </label>
      {action === 'change' && <label>Новый ответ
        <select value={answer} onChange={event => setAnswer(event.target.value)}>{values.map(value => <option key={value} value={value}>{label(value)}</option>)}</select>
      </label>}
      {action === 'change' && answer === 'N/A' && <p>Условие N/A: {criterion.naCondition}</p>}
      <label>Причина решения
        <textarea required maxLength={5_000} rows={3} value={reason} onChange={event => setReason(event.target.value)} placeholder="Объясните решение со ссылкой на исходные реплики." />
      </label>
      <button type="submit" disabled={!reason.trim() || (action === 'change' && answer === appeal.contestedAnswer)}>{busy ? 'Сохраняем решение…' : 'Сохранить решение'}</button>
    </fieldset>
  </form>;
}
