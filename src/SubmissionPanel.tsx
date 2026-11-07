import { useEffect, useRef, useState } from 'react';
import type { GroupBatch } from '../server/batches.js';
import type { BatchPermissionPreview } from '../server/data-permissions.js';
import './submission.css';

interface Groups { teamName: string; model: string; groups: Array<{ groupId: string; records: number; fixture: boolean }> }
interface Coverage { records: number; success: number; error: number; model: { mode: string; name: string }; recordsSummary: Array<{ conversationId: string; status: string; error?: string }> }
interface PermissionPreview { preview: BatchPermissionPreview | null; sources: Array<{ conversationId: string; conversationVersion: string; language: string }> }
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'REQUEST_FAILED'); return result as T;
}
const statusLabel: Record<string, string> = { ready: 'Готов', running: 'Выполняется', paused: 'Приостановлен', completed: 'Завершён', cancelled: 'Отменён', pending: 'Ожидает', retry_wait: 'Ожидает разрешённый повтор', succeeded: 'Сохранено', reused: 'Использован прошлый результат', blocked: 'Нужен разрешённый маршрут', error: 'Ошибка' };
function friendly(error: unknown) {
  const code = error instanceof Error ? error.message : 'REQUEST_FAILED';
  const messages: Record<string, string> = { BATCH_ALREADY_RUNNING: 'Прогон уже выполняется. Используйте его журнал; новый не запущен.', FIXTURE_OFFICIAL_EXPORT_FORBIDDEN: 'Тестовую группу можно выгрузить только в пробном режиме.', COMPETITION_DATASET_SIZE_MISMATCH: 'Для DEV нужны65 записей, для PROD —10. Проверьте импорт выбранной группы.', DATA_PERMISSION_BATCH_SOURCE_MISMATCH: 'Источник изменился. Обновите список и заново проверьте версии перед разрешением.', DATA_PERMISSION_RESTRICTED: 'Разрешение недоступно для реальных звонков, аудио или защищённых записей.' };
  return messages[code] || `Операция не завершена: ${code}. Данные и прошлые результаты сохранены.`;
}
export function SubmissionPanel() {
  const [groups, setGroups] = useState<Groups>();
  const [groupId, setGroupId] = useState('DEV');
  const [target, setTarget] = useState<'dev' | 'prod'>('dev');
  const [team, setTeam] = useState('Continental');
  const [coverage, setCoverage] = useState<Coverage>();
  const [batches, setBatches] = useState<GroupBatch[]>([]);
  const [batchId, setBatchId] = useState('');
  const [permissions, setPermissions] = useState<PermissionPreview>();
  const [reviewer, setReviewer] = useState('');
  const [reason, setReason] = useState('');
  const [synthetic, setSynthetic] = useState(false);
  const [free, setFree] = useState(false);
  const [recoverInterrupted, setRecoverInterrupted] = useState(false);
  const [retryQuota, setRetryQuota] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const permissionAttempt = useRef<{ signature: string; id: string } | null>(null);
  const groupRef = useRef(groupId); groupRef.current = groupId;
  const batch = batches.find(b => b.id === batchId) || batches.find(b => b.groupId === groupId);
  const running = batches.some(b => b.status === 'running');
  const query = () => new URLSearchParams({ groupId, target, teamName: team.trim() });
  async function refresh() {
    const [nextGroups, nextBatches] = await Promise.all([api<Groups>('/api/competition/groups'), api<GroupBatch[]>('/api/competition/batches')]);
    setGroups(nextGroups); setBatches(nextBatches);
    if (nextGroups.groups.some(g => g.groupId === groupId)) {
      const selectedGroup = groupId;
      const results = await Promise.allSettled([api<Coverage>(`/api/competition/coverage?${query()}`), api<PermissionPreview>(`/api/competition/permissions?groupId=${encodeURIComponent(groupId)}`)]);
      if (groupRef.current !== selectedGroup) return;
      if (results[0].status === 'fulfilled') setCoverage(results[0].value); else { setCoverage(undefined); setError(friendly(results[0].reason)); }
      if (results[1].status === 'fulfilled') setPermissions(results[1].value); else { setPermissions(undefined); setError(friendly(results[1].reason)); }
    } else { setCoverage(undefined); setPermissions(undefined); }
  }
  useEffect(() => {
    setCoverage(undefined); setPermissions(undefined); setError(''); setBatchId(''); setSynthetic(false); setFree(false); permissionAttempt.current = null;
    void refresh().catch(e => setError(friendly(e)));
  }, [groupId, target]);
  useEffect(() => { const timer = setInterval(() => { void refresh().catch(() => undefined); }, 3000); return () => clearInterval(timer); }, [groupId, target, team]);
  async function act(task: () => Promise<void>) {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { await task(); await refresh(); } catch (cause) { setError(friendly(cause)); } finally { setBusy(false); }
  }
  async function start(newBatch: boolean) {
    let current = batch;
    if (newBatch || !current) current = await api<GroupBatch>('/api/competition/batches', { groupId, id: crypto.randomUUID(), minSpacingMs: 12000, runBudgetMs: 2700000 });
    setBatchId(current.id);
    await api(`/api/competition/batches/${current.id}/run`, { resume: !newBatch, recoverInterrupted, retryQuota });
    setNotice('Запущен последовательный прогон по исходному официальному чек-листу. Звонки и неразрешённые записи во внешний API не отправляются.');
  }
  async function exportFile(dryRun: boolean) {
    const result = await api<{ outputPath: string; success: number; error: number; records: number; published: false }>('/api/competition/export', { groupId, target, teamName: team.trim(), dryRun });
    setNotice(`${dryRun ? 'Пробный файл' : 'Официальный локальный файл'}: ${result.outputPath}. Записей ${result.records}, ok ${result.success}, error ${result.error}. Файл не опубликован.`);
  }
  async function approve() {
    if (!permissions?.preview) return;
    const payload = { ...permissions.preview, reviewer: reviewer.trim(), reason: reason.trim(), origin: 'human_declared', syntheticAttestation: synthetic, freeTierUseApproved: free };
    // eligibleCount is preview information, not part of the approval input contract.
    const { eligibleCount: _count, ...input } = payload; void _count;
    const signature = JSON.stringify(input);
    if (permissionAttempt.current?.signature !== signature) permissionAttempt.current = { signature, id: crypto.randomUUID() };
    await api('/api/competition/permissions', { ...input, requestId: permissionAttempt.current.id });
    setSynthetic(false); setFree(false); setNotice('Разрешение сохранено только для проверенных неизменяемых версий. Оценивание запускается отдельно.');
  }
  return <main className="submission-workspace">
    <div className="quality-summary"><p className="eyebrow">Формат соревнования · JSON1.0</p><h1>Сдача результатов</h1><p>Официальные8 критериев. DEV:65 записей; PROD:10 исходных контрольных чатов. Локальная подготовка и публичная отправка — отдельные этапы.</p><p className="notice">Человеческая проверка12 примеров выполняется отдельно. Ни одна операция здесь не сбрасывает её прогресс. JSON содержит ответы модели: при слепой разметке открывайте его после фиксации своих решений.</p></div>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
    <section className="submission-card"><h2>Набор и покрытие</h2><div className="submission-controls">
      <label>Команда<input aria-label="Команда для результатов" value={team} onChange={e => setTeam(e.target.value)} maxLength={100}/></label>
      <label>group_id<input aria-label="Группа для сдачи" value={groupId} onChange={e => setGroupId(e.target.value)} pattern="[A-Za-z0-9_-]{1,64}" maxLength={64} list="submission-groups"/><datalist id="submission-groups">{groups?.groups.map(g => <option key={g.groupId} value={g.groupId}>{g.records} записей{g.fixture ? ' · тестовая группа' : ''}</option>)}</datalist></label>
      <label>Папка результатов<select aria-label="Набор результатов" value={target} onChange={e => setTarget(e.target.value as 'dev' | 'prod')}><option value="dev">DEV ·65</option><option value="prod">PROD ·10</option></select></label>
      <button disabled={busy || !/^[A-Za-z0-9_-]{1,64}$/.test(groupId)} onClick={() => void act(async () => { const result = await api<{ inserted: number; unchanged: number }>('/api/import', { groupId }); setNotice(`Импорт ${groupId}: добавлено ${result.inserted}, без изменений ${result.unchanged}.`); })}>Импорт GET</button>
      <button disabled={busy} onClick={() => void act(async () => { await refresh(); })}>Обновить покрытие</button>
    </div><p>Текущая модель: <strong>{groups?.model || 'Загрузка…'}</strong>. Новые оценки используют только <code>official-v1</code>; экспериментальный C9 в JSON не включается.</p>
      {coverage && <><p className="submission-counts" aria-live="polite">Всего {coverage.records} · готово {coverage.success} · error {coverage.error}</p><p className="provider">Это покрытие официального файла, не согласие с человеческим эталоном. Все ошибки сохраняют исходные ID.</p><details><summary>Статус каждой записи</summary><ul className="submission-records">{coverage.recordsSummary.map(record => <li key={record.conversationId}><code>{record.conversationId}</code><span>{record.status === 'ok' ? 'Есть допустимая оценка' : record.error}</span></li>)}</ul></details></>}
      {!groups?.groups.length && <p>Набор ещё не импортирован. Введите выданный group_id или загрузите JSON через «Оценку диалогов».</p>}
    </section>
    <section className="submission-card"><h2>Последовательная обработка</h2><p>Один запрос одновременно, интервал от12 с, бюджет45 минут. Результат фиксируется после каждой записи. Уже пригодные оценки повторно не вызывают модель.</p>
      <div className="submission-actions"><button className="primary" disabled={busy || running || !coverage} onClick={() => void act(() => start(true))}>Оценить недостающие записи</button>{batch && <><button disabled={busy || running || batch.status === 'cancelled'} onClick={() => void act(() => start(false))}>Продолжить прогон</button><button disabled={busy || batch.status !== 'running'} onClick={() => void act(async () => { await api(`/api/competition/batches/${batch.id}/pause`, {}); setNotice('Остановка после текущего запроса; сохранённые результаты останутся.'); })}>Пауза</button></>}</div>
      {batches.filter(b => b.groupId === groupId).length > 0 && <label>Журнал<select aria-label="Прогон группы" value={batch?.id || ''} onChange={e => setBatchId(e.target.value)}>{batches.filter(b => b.groupId === groupId).map(b => <option key={b.id} value={b.id}>{b.id} · {statusLabel[b.status]}</option>)}</select></label>}
      {batch && <><p role="status">{statusLabel[batch.status]} · {batch.records.filter(r => ['succeeded', 'reused'].includes(r.status)).length}/{batch.records.length} готово{batch.reason ? ` · ${batch.reason}` : ''}</p><details><summary>Записи, вызовы и ошибки</summary><ul className="submission-records">{batch.records.map(record => <li key={record.conversationVersion}><code>{record.conversationId}</code><span>{statusLabel[record.status]}{record.errorCode && ` · ${record.errorCode}`} · запусков {record.runs.length} · вызовов {record.runs.some(r => r.providerCallCount === null) ? 'часть неизвестна' : record.runs.reduce((sum, r) => sum + (r.providerCallCount || 0), 0)}</span></li>)}</ul></details>{batch.status === 'paused' && <><label className="checkbox-label"><input type="checkbox" checked={recoverInterrupted} onChange={e => setRecoverInterrupted(e.target.checked)}/> Явно разрешить однократное восстановление подтверждённо прерванного запроса.</label><label className="checkbox-label"><input type="checkbox" checked={retryQuota} onChange={e => setRetryQuota(e.target.checked)}/> Квота проверена и восстановилась; разрешить один повтор отказа по квоте.</label></>}</>}
    </section>
    {permissions?.preview && <section className="submission-card"><h2>Разрешение для новых синтетических чатов</h2><p>По умолчанию неизвестные данные не отправляются в бесплатный API. В разрешение войдут только перечисленные версии без аудио; реальные звонки исключены.</p><ul className="submission-records">{permissions.sources.map(source => <li key={source.conversationVersion}><code>{source.conversationId}</code><span>{source.language} · {source.conversationVersion}</span></li>)}</ul><p className="provider">Откройте и проверьте каждый исходный разговор во вкладке «Оценка диалогов». При изменении источника разрешение требуется заново.</p><label>Проверяющий<input aria-label="Проверяющий группового разрешения" value={reviewer} onChange={e => setReviewer(e.target.value)}/></label><label>Основание<textarea aria-label="Основание группового разрешения" value={reason} onChange={e => setReason(e.target.value)} rows={2}/></label><label className="checkbox-label"><input type="checkbox" checked={synthetic} onChange={e => setSynthetic(e.target.checked)}/> Я проверил(а) все перечисленные версии: они полностью синтетические, без реальных персональных данных и материалов настоящих звонков.</label><label className="checkbox-label"><input type="checkbox" checked={free} onChange={e => setFree(e.target.checked)}/> Я разрешаю обработку этих версий бесплатным Gemini и понимаю, что переданный текст может использоваться для улучшения продуктов.</label><button disabled={busy || !synthetic || !free || reviewer.trim().length < 2 || !reason.trim()} onClick={() => void act(approve)}>Разрешить только проверенные версии</button></section>}
    <section className="submission-card"><h2>Строгая выгрузка JSON1.0</h2><p>Сверяются все исходные ID,8 критериев, значения, индексы реплик, итог и critical_flag. Личные данные в объяснениях скрываются; подробный аудит остаётся в private. Перед публикацией проверьте публичные объяснения человеком.</p><div className="submission-actions"><button disabled={busy || !coverage || team.trim().length < 2} onClick={() => void act(() => exportFile(true))}>Пробная выгрузка в private</button><button className="primary" disabled={busy || !coverage || team.trim().length < 2} onClick={() => void act(() => exportFile(false))}>Подготовить results/{target}/results.json</button><a className="submission-download" aria-disabled={!coverage} href={coverage ? `/api/competition/download?${query()}` : undefined} download>Скачать проверенный JSON</a></div><p className="notice">Публикация не выполняется этими кнопками. Сдача завершена только после успешного push обоих настоящих файлов и проверки их в утверждённом публичном репозитории до стоп-кода.</p></section>
  </main>;
}
