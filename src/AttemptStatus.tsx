import type { EvaluationAttempt } from './domain.js';

type ProviderEvent = {
  call: number;
  status: 'running' | 'response-received' | 'request-failed';
  elapsedMs: number;
  failure?: { httpStatus?: number | null; errorName?: string | null; errorCode?: string | number | null; causeName?: string | null; causeCode?: string | number | null };
  retryPlanned?: boolean;
  retryDelayMs?: number;
  stopReason?: string;
};
export type AttemptView = EvaluationAttempt & {
  requestId?: string;
  providerCallCount?: number | null;
  providerCallCountObservedOnly?: boolean;
  events?: ProviderEvent[];
  retryOf?: string | null;
  recoveryDepth?: number;
  recovery?: { canRetry: boolean; reason: string };
};

function failureCategory(event: ProviderEvent) {
  const failure = event.failure;
  const codes = [failure?.errorCode, failure?.causeCode];
  if (failure?.httpStatus === 429 || codes.includes('RESOURCE_EXHAUSTED')) return 'Квота провайдера';
  if (codes.some(code => typeof code === 'string' && /TIMEOUT|ETIMEDOUT|DEADLINE|ABORT/.test(code))) return 'Время ожидания истекло';
  if (failure?.httpStatus === 401 || failure?.httpStatus === 403) return 'Доступ к провайдеру';
  if (failure?.httpStatus && failure.httpStatus >= 500) return `Сбой провайдера · HTTP ${failure.httpStatus}`;
  if (event.status === 'request-failed') return 'Сетевой запрос не выполнен';
  return '';
}

export function AttemptStatus({ attempt, busy, canRetry, onRetry }: { attempt: AttemptView; busy: boolean; canRetry: boolean; onRetry: () => void }) {
  const running = attempt.status === 'running';
  const failed = attempt.status === 'failed';
  const events = attempt.events || [];
  const invalid = attempt.errorCode === 'INVALID_EVIDENCE' || attempt.errorCode === 'INVALID_MODEL_JSON';
  const exhausted = attempt.recoveryDepth != null && attempt.recoveryDepth >= 1;
  const recoveredFrom = attempt.retryOf || attempt.recoveryOf;
  return <section className={`attempt-status ${failed ? 'attempt-failed' : ''}`} aria-label="История запроса модели" aria-busy={running}>
    <div className="attempt-heading"><strong>{running ? 'Выполняется новый запрос' : failed ? 'Запрос завершён без новой оценки' : 'Запрос завершён, оценка сохранена'}</strong><span>{attempt.providerCallCount == null ? 'Число вызовов не зарегистрировано' : `${attempt.providerCallCountObservedOnly ? 'Зафиксировано вызовов' : 'Вызовов API'}: ${attempt.providerCallCount}`}</span></div>
    {attempt.errorCode === 'REQUEST_INTERRUPTED' && <p>Выполнение прервано перезапуском приложения. Итог провайдера и окончательный расход неизвестны; журнал содержит только успевшие сохраниться события.</p>}
    <p>{recoveredFrom ? 'Явный повтор предыдущей попытки.' : 'Отдельная попытка оценки.'} {new Date(attempt.startedAt).toLocaleString('ru', { timeZone: 'Asia/Qyzylorda' })}{attempt.latencyMs != null && ` · ${(attempt.latencyMs / 1000).toFixed(1)} сек.`}{attempt.telemetry && <><br/>Автоповторов: {attempt.telemetry.retryCount} из {attempt.telemetry.retryLimit} · общий срок: {(attempt.telemetry.totalBudgetMs / 1000).toFixed(0)} сек.</>}</p>
    {events.length > 0 && <ol className="attempt-events">{events.map(event => <li key={event.call}><strong>Вызов {event.call}</strong><span>{event.status === 'running' ? 'Ожидание ответа' : event.status === 'response-received' ? 'Ответ получен; затем проверяются структура и доказательства' : failureCategory(event)}</span>{event.retryPlanned && <span>Назначен один автоматический повтор{event.retryDelayMs != null ? ` через ${event.retryDelayMs} мс` : ''}.</span>}{event.stopReason && <span>{event.stopReason === 'retry_limit' ? 'Лимит автоматических повторов достигнут.' : event.stopReason === 'budget_exhausted' ? 'Общий срок запроса истёк.' : event.stopReason === 'timeout' ? 'Ожидание остановлено по времени.' : 'Для этой причины автоматический повтор не выполняется.'}</span>}</li>)}</ol>}
    {failed && <>
      <p>{invalid ? 'Ответ отклонён проверкой. Баллы и доказательства из него не сохранены.' : attempt.errorCode === 'PROVIDER_RATE_LIMIT' ? 'Провайдер ограничил частоту запросов или бесплатную квоту. Повтор имеет смысл после снятия ограничения.' : 'Новая оценка не сохранена. Ранее сохранённый результат остаётся доступен ниже.'}</p>
      <p>{attempt.recovery?.reason || (canRetry ? invalid ? 'Можно один раз запросить полностью новый ответ. Проверка доказательств останется прежней.' : 'Доступен один явный повтор. Модель, чек-лист и строгая проверка доказательств остаются прежними.' : exhausted ? 'Однократное восстановление уже использовано. Автоматического продолжения нет.' : 'Повтор этой попытки сейчас недоступен. Причина и пределы сохранены в истории запроса.')}</p>
      {attempt.recovery?.canRetry && <button type="button" disabled={busy || !canRetry} onClick={onRetry}>Повторить оценку один раз</button>}
    </>}
    <details><summary>Идентификатор и диагностика</summary><p>ID запроса: <code>{attempt.requestId || attempt.id}</code>{attempt.errorCode && <><br/>Код: <code>{attempt.errorCode}</code></>}{recoveredFrom && <><br/>Повтор запроса: <code>{recoveredFrom}</code></>}</p>{events.filter(event => event.failure).map(event => <p key={event.call}>Вызов {event.call}: <code>{[event.failure?.httpStatus && `HTTP ${event.failure.httpStatus}`, event.failure?.errorName, event.failure?.errorCode, event.failure?.causeName, event.failure?.causeCode].filter(Boolean).join(' · ') || 'Точная причина не сообщена провайдером'}</code></p>)}<p>Неудавшийся запрос мог быть обработан провайдером. Неизвестное использование токенов не считается нулевым.</p></details>
  </section>;
}
