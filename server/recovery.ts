import type { EvaluationAttempt } from '../src/domain.js';
import type { Store } from './store.js';
import { config } from './config.js';

const recoverable = new Set(['PROVIDER_FAILED', 'PROVIDER_NETWORK_ERROR', 'PROVIDER_TIMEOUT', 'INVALID_EVIDENCE', 'INVALID_MODEL_JSON', 'PROVIDER_EMPTY_RESULT', 'REQUEST_INTERRUPTED']);
export function recoveryPolicy(store: Store, attempt: EvaluationAttempt) {
  if (attempt.status !== 'failed') return { canRetry: false, reason: attempt.status === 'running' ? 'Запрос ещё выполняется; новый вызов не нужен.' : 'Результат уже сохранён.' };
  if (attempt.model !== config.model) return { canRetry: false, reason: 'Эта историческая попытка использовала другую модель. Восстановление не переключает текущую модель; выберите отдельный новый запрос с текущими правилами.' };
  if ((attempt.recoveryDepth ?? 0) >= 1) return { canRetry: false, reason: 'Однократное восстановление уже использовано. Изучите журнал и проверьте источник или настройки.' };
  if (store.getEvaluationRecovery(attempt.id)) return { canRetry: false, reason: 'Для этой ошибки уже зарегистрирован повтор. Откройте его журнал.' };
  if (attempt.errorCode === 'PROVIDER_RATE_LIMIT') return { canRetry: false, reason: 'Квота ограничена. Дождитесь её восстановления; платный fallback не включается.' };
  if (!recoverable.has(attempt.errorCode || '')) return { canRetry: false, reason: 'Сначала исправьте конфигурацию или причину отказа. Автоматического повторения нет.' };
  return { canRetry: true, reason: attempt.errorCode === 'INVALID_EVIDENCE' ? 'Можно один раз заново запросить полный ответ. Доказательства проверяются теми же строгими правилами; исправления цитат не подставляются.' : 'Доступен один явный повтор той же версии и модели. Исходная ошибка останется в журнале.' };
}

export function publicAttempt(store: Store, attempt: EvaluationAttempt) {
  return { ...attempt, requestId: attempt.requestId || attempt.id, providerCallCount: attempt.telemetry?.providerCallCount ?? null, providerCallCountObservedOnly: attempt.errorCode === 'REQUEST_INTERRUPTED', events: attempt.telemetry?.attempts ?? [], recovery: recoveryPolicy(store, attempt) };
}
