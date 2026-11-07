import { useEffect, useRef, useState } from 'react';
import type { Conversation } from './domain.js';

interface AudioStatus { state: 'available' | 'unavailable'; code: string; upstreamStatus?: number; contentType?: string; byteLength?: number }
const messages: Record<string, string> = {
  AUDIO_NOT_PROVIDED: 'Ссылка на запись не предоставлена.', AUDIO_HTTP_401: 'Источник записи требует авторизации (HTTP401).',
  AUDIO_HTTP_403: 'Источник отказал в доступе (HTTP403). Возможно, срок ссылки истёк.', AUDIO_HTTP_404: 'Запись не найдена у источника (HTTP404).',
  AUDIO_TIMEOUT: 'Источник записи не ответил вовремя.', AUDIO_RESPONSE_NOT_MEDIA: 'Источник вернул данные, которые не являются поддерживаемым аудио.',
  AUDIO_SOURCE_MISSING: 'В странице источника не найдена ссылка на аудиофайл.', AUDIO_UNSAFE_SOURCE: 'Адрес записи не прошёл проверку разрешённого источника.',
  AUDIO_UNSAFE_ADDRESS: 'Адрес записи разрешается во внутреннюю сеть и заблокирован.', AUDIO_NETWORK_FAILED: 'Не удалось получить запись из источника.',
  AUDIO_CACHE_WRITE_FAILED: 'Не удалось сохранить запись в локальный закрытый кеш. Проверьте доступ к папке проекта и свободное место.',
};
function seconds(timestamp: string, first: string) {
  if (/^\d+:\d{2}(?:\.\d+)?$/.test(timestamp)) { const [m, s] = timestamp.split(':').map(Number); return m * 60 + s; }
  const difference = (Date.parse(timestamp) - Date.parse(first)) / 1000;
  return Number.isFinite(difference) ? Math.max(0, difference) : null;
}
export function AudioPlayer({ conversation }: { conversation: Conversation }) {
  const [status, setStatus] = useState<AudioStatus>();
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [playback, setPlayback] = useState<'not-started' | 'ready' | 'playing' | 'error'>('not-started');
  const [notice, setNotice] = useState('');
  const audio = useRef<HTMLAudioElement>(null);
  const path = `/api/conversations/${encodeURIComponent(conversation.version)}/audio`;
  useEffect(() => {
    const controller = new AbortController();
    setStatus(undefined); setLoading(true); setPlayback('not-started'); setNotice('');
    fetch(`${path}/status`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('AUDIO_NETWORK_FAILED');
      return response.json() as Promise<AudioStatus>;
    }).then(result => { setStatus(result); }).catch(() => { if (!controller.signal.aborted) setStatus({ state: 'unavailable', code: 'AUDIO_NETWORK_FAILED' }); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, attempt]);
  useEffect(() => {
    const seek = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationVersion: string; timestamp: string }>).detail;
      if (detail?.conversationVersion !== conversation.version || !audio.current) return;
      const offset = seconds(detail.timestamp, conversation.messages[0]?.timestamp || '');
      if (offset === null) { setNotice('Не удалось сопоставить метку времени с записью.'); return; }
      const target = audio.current;
      if (!Number.isFinite(target.duration)) { setNotice('Дождитесь загрузки метаданных записи.'); return; }
      target.currentTime = Math.min(offset, target.duration);
      setNotice(`Переход к ${Math.floor(offset / 60)}:${String(Math.floor(offset % 60)).padStart(2, '0')} от начала транскрипта. Метки ASR могут отличаться от записи.`);
      target.focus();
    };
    window.addEventListener('cqa:seek-source', seek);
    return () => window.removeEventListener('cqa:seek-source', seek);
  }, [conversation]);
  return <section className="audio-player" aria-label="Аудиозапись звонка">
    <div className="audio-heading"><strong>Запись звонка</strong><span className="badge">Локальное воспроизведение</span></div>
    {loading && <p role="status">Проверяем источник и готовим запись…</p>}
    {status?.state === 'available' && <>
      <audio ref={audio} controls preload="metadata" src={path} aria-label="Прослушать запись звонка" onCanPlay={() => setPlayback('ready')} onPlaying={() => setPlayback('playing')} onError={() => setPlayback('error')} />
      <p className="provider" role="status">{playback === 'error' ? 'Браузер не смог декодировать или загрузить запись. Доступность источника не подтверждает воспроизведение.' : playback === 'playing' ? 'Браузер воспроизводит запись.' : playback === 'ready' ? 'Метаданные загружены. Запись готова к прослушиванию.' : 'Источник доступен. Загружаем метаданные в браузере…'}</p>
    </>}
    {status?.state === 'unavailable' && <p role="status" className="notice">{messages[status.code] || `Запись недоступна: ${status.code}.`} Транскрипт и ручная оценка остаются доступны.</p>}
    <button type="button" disabled={loading} onClick={() => setAttempt(value => value + 1)}>Повторить проверку записи</button>
    {notice && <p className="provider" role="status">{notice}</p>}
    <p className="provider">Аудио и содержание звонка не передаются бесплатной модели. Привязка времени считается от первой метки транскрипта.</p>
  </section>;
}
