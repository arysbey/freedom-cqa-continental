import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Conversation } from './domain.js';

interface Props {
  conversation: Conversation;
  onApproved: () => void | Promise<void>;
  onError?: (message: string) => void;
}

/** A local human declaration covers this exact unknown chat version, never a voice call. */
export function DataPermissionPanel(props: Props) {
  if (props.conversation.classification !== 'unknown' || props.conversation.channel !== 'agent chat' || props.conversation.audioAvailable) return null;
  return <PermissionForm key={props.conversation.version} {...props}/>;
}

function PermissionForm({ conversation, onApproved, onError }: Props) {
  const [reviewer, setReviewer] = useState('');
  const [reason, setReason] = useState('');
  const [syntheticAttestation, setSyntheticAttestation] = useState(false);
  const [freeTierUseApproved, setFreeTierUseApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const attempted = useRef<{ signature: string; requestId: string } | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || submitted || reviewer.trim().length < 2 || !reason.trim() || !syntheticAttestation || !freeTierUseApproved) return;
    const payload = { reviewer: reviewer.trim(), reason: reason.trim(), origin: 'human_declared', syntheticAttestation, freeTierUseApproved };
    const signature = JSON.stringify({ conversationVersion: conversation.version, ...payload });
    if (attempted.current?.signature !== signature) attempted.current = { signature, requestId: crypto.randomUUID() };
    setBusy(true); setError('');
    let persisted = false;
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversation.version)}/permission`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, requestId: attempted.current.requestId }),
      });
      if (!response.ok) throw new Error('PERMISSION_SAVE_FAILED');
      persisted = true; setSubmitted(true);
      await onApproved();
    } catch {
      const message = persisted
        ? 'Разрешение сохранено, но интерфейс не обновился. Обновите страницу перед запуском оценки.'
        : 'Разрешение не сохранено. Проверьте имя проверяющего, причину и оба подтверждения. Для реальных звонков такое разрешение недоступно.';
      setError(message); onError?.(message);
    } finally { setBusy(false); }
  }

  return <details className="manual-panel data-permission-panel">
    <summary>Разрешение для синтетического чата</summary>
    <p>Для новой группы происхождение данных пока неизвестно. Проверяющий может разрешить бесплатную AI-оценку только полностью синтетического чата без реальных персональных данных, аудио и фрагментов настоящих звонков.</p>
    <p className="notice">Бесплатный Gemini может использовать отправленный текст для улучшения своих продуктов. Подтверждайте разрешение только после проверки содержимого и права передать его этому сервису.</p>
    <p className="provider">Разрешение относится к диалогу <strong>{conversation.conversationId}</strong>, группа {conversation.groupId}, версия <code>{conversation.version}</code>. Сохранение разрешения и запуск оценки — отдельные действия.</p>
    <form onSubmit={event => void save(event)}>
      <fieldset disabled={busy || submitted}>
        <legend>Явное решение проверяющего</legend>
        <label>Проверяющий разрешения<input aria-label="Проверяющий разрешения" value={reviewer} onChange={event => setReviewer(event.target.value)} required minLength={2} maxLength={128} autoComplete="off"/></label>
        <label>Основание разрешения<textarea aria-label="Основание разрешения" value={reason} onChange={event => setReason(event.target.value)} required maxLength={2000} rows={3} placeholder="Укажите происхождение синтетического чата и основание для внешней обработки."/></label>
        <label className="checkbox-label"><input type="checkbox" checked={syntheticAttestation} onChange={event => setSyntheticAttestation(event.target.checked)}/> Я проверил(а), что эта версия диалога полностью синтетическая и не содержит реальных персональных данных или материалов настоящих звонков.</label>
        <label className="checkbox-label"><input type="checkbox" checked={freeTierUseApproved} onChange={event => setFreeTierUseApproved(event.target.checked)}/> Я разрешаю передать эту версию чата бесплатному Gemini и понимаю условия использования отправленного текста.</label>
        <button className="primary" type="submit" disabled={busy || submitted || reviewer.trim().length < 2 || !reason.trim() || !syntheticAttestation || !freeTierUseApproved}>{busy ? 'Сохраняется разрешение…' : submitted ? 'Разрешение сохранено' : 'Сохранить разрешение для этого чата'}</button>
      </fieldset>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
  </details>;
}
