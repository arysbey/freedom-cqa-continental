import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { Checklist, Conversation, CriterionResult, Evaluation, Message } from './domain.js';
import { ChecklistEditor } from './ChecklistEditor.js';
import { ReviewPanel } from './ReviewPanel.js';
import { ManualEvaluationPanel } from './ManualEvaluationPanel.js';
import { AudioPlayer } from './AudioPlayer.js';
import { QualityPanel } from './QualityPanel.js';
import { DataPermissionPanel } from './DataPermissionPanel.js';
import { AttemptStatus } from './AttemptStatus.js';
import type { AttemptView } from './AttemptStatus.js';

type Summary = Pick<Conversation, 'version' | 'conversationId' | 'groupId' | 'language' | 'channel' | 'classification'> & { messageCount: number; audioAvailable: boolean };
type Status = { model: string; apiKeyPresent: boolean; freeTierConfirmed: boolean; liveEvaluationCount: number; manualEvaluationCount?: number };
type Tab = 'review' | 'checklist' | 'quality';
type Filters = { search: string; language: string; channel: string; group: string; status: string; sort: string };
const defaultFilters: Filters = { search: '', language: '', channel: '', group: 'DEV', status: '', sort: 'id' };
const speakers = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };
const answerLabel = (answer: string) => ({ YES: 'Да', NO: 'Нет', 'N/A': 'N/A' }[answer] || answer);
const displayTime = (value: string) => new Date(value).toLocaleString('ru', { timeZone: 'Asia/Qyzylorda' });
const isAi = (evaluation: Evaluation) => evaluation.status === 'live_validated';
const originLabel = (evaluation: Evaluation) => isAi(evaluation) ? 'Сохранённый результат API' : evaluation.status === 'manual_demo' ? 'Демонстрационная запись' : 'Ручная оценка';
const countLabel = (count: number, one: string, few: string, many: string) => {
  const last = count % 10, lastTwo = count % 100;
  return `${count} ${lastTwo >= 11 && lastTwo <= 14 ? many : last === 1 ? one : last >= 2 && last <= 4 ? few : many}`;
};
type ApiFailure = { error?: string; attempt?: AttemptView; recovery?: { canRetry: boolean; reason: string } };
class ApiRequestError extends Error {
  constructor(readonly payload: ApiFailure) { super(payload.error || 'REQUEST_FAILED'); }
}
function rememberAttempt(current: AttemptView[], attempt: AttemptView) {
  const existing = current.find(item => item.id === attempt.id);
  if (existing && existing.status !== 'running' && attempt.status === 'running') return current;
  return [attempt, ...current.filter(item => item.id !== attempt.id)];
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new ApiRequestError(data);
  return data;
}

export function App() {
  const [status, setStatus] = useState<Status>();
  const [conversations, setConversations] = useState<Summary[]>([]);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [checklistVersion, setChecklistVersion] = useState('');
  const [selectedVersion, setSelectedVersion] = useState('');
  const [conversation, setConversation] = useState<Conversation>();
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [attempts, setAttempts] = useState<AttemptView[]>([]);
  const [activeRequestId, setActiveRequestId] = useState('');
  const [selectedAttemptId, setSelectedAttemptId] = useState('');
  const [selectedEvaluationId, setSelectedEvaluationId] = useState('');
  const [criterionId, setCriterionId] = useState('C1');
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [transcriptSearch, setTranscriptSearch] = useState('');
  const [manualMode, setManualMode] = useState(false);
  const [manualPicked, setManualPicked] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState('');
  const [initialLoading, setInitialLoading] = useState(true);
  const [group, setGroup] = useState('DEV');
  const [tab, setTab] = useState<Tab>(() => {
    const view = new URLSearchParams(location.search).get('view');
    return view === 'quality' || view === 'checklist' ? view : 'review';
  });
  const selectedRef = useRef(selectedVersion);
  const conversationButtons = useRef(new Map<string, HTMLButtonElement>());
  const fileInput = useRef<HTMLInputElement>(null);
  selectedRef.current = selectedVersion;

  const conversationEvaluations = useMemo(() => evaluations.filter(e => e.conversationVersion === selectedVersion), [evaluations, selectedVersion]);
  const evaluation = conversationEvaluations.find(e => e.id === selectedEvaluationId)
    ?? conversationEvaluations.find(e => e.checklistVersion === 'official-v1' && isAi(e))
    ?? conversationEvaluations.find(e => e.checklistVersion === 'official-v1')
    ?? conversationEvaluations[0];
  const activeChecklist = checklists.find(c => c.version === (evaluation?.checklistVersion || checklistVersion));
  const selectedRunChecklist = checklists.find(c => c.version === checklistVersion);
  const conversationAttempts = attempts.filter(item => item.conversationVersion === selectedVersion && item.checklistVersion === checklistVersion)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const selectedAttempt = conversationAttempts.find(item => item.id === selectedAttemptId) || conversationAttempts[0];
  const result = evaluation?.results.find(r => r.criterionId === criterionId);
  const criterion = activeChecklist?.criteria.find(c => c.id === criterionId);
  const busy = Boolean(pending);
  const countsByVersion = useMemo(() => {
    const map = new Map<string, Evaluation[]>();
    for (const item of evaluations) map.set(item.conversationVersion, [...(map.get(item.conversationVersion) || []), item]);
    return map;
  }, [evaluations]);
  const filtered = useMemo(() => {
    const query = filters.search.trim().toLocaleLowerCase();
    return conversations.filter(c => {
      const saved = countsByVersion.get(c.version) || [];
      return (!query || `${c.conversationId} ${c.groupId}`.toLocaleLowerCase().includes(query))
        && (!filters.language || c.language === filters.language)
        && (!filters.channel || c.channel === filters.channel)
        && (!filters.group || c.groupId === filters.group)
        && (!filters.status || (filters.status === 'none' ? !saved.length : filters.status === 'any' ? Boolean(saved.length) : filters.status === 'ai' ? saved.some(isAi) : saved.some(e => !isAi(e))));
    }).sort((a, b) => {
      if (filters.sort === 'length') return b.messageCount - a.messageCount || a.conversationId.localeCompare(b.conversationId);
      if (filters.sort === 'language') return a.language.localeCompare(b.language) || a.conversationId.localeCompare(b.conversationId);
      if (filters.sort === 'evaluated') return Number(countsByVersion.has(b.version)) - Number(countsByVersion.has(a.version)) || a.conversationId.localeCompare(b.conversationId);
      return a.groupId.localeCompare(b.groupId) || a.conversationId.localeCompare(b.conversationId);
    });
  }, [conversations, filters, countsByVersion]);
  const filterActive = Object.entries(filters).some(([key, value]) => value !== defaultFilters[key as keyof Filters]);
  const selectedHidden = Boolean(selectedVersion && !filtered.some(c => c.version === selectedVersion));
  const devCount = conversations.filter(c => c.groupId === 'DEV').length;
  const otherCount = conversations.length - devCount;

  async function reload() {
    const [s, c, k, e, a] = await Promise.all([
      request<Status>('/api/status'), request<Summary[]>('/api/conversations'),
      request<Checklist[]>('/api/checklists'), request<Evaluation[]>('/api/evaluations'), request<AttemptView[]>('/api/evaluation-attempts'),
    ]);
    setStatus(s); setConversations(c); setChecklists(k); setEvaluations(e); setAttempts(a);
    setChecklistVersion(v => v || k.find(item => item.version === 'official-v1')?.version || k[0]?.version || '');
    setSelectedVersion(v => v || c.find(item => item.groupId === 'DEV' && item.conversationId === 'p1-ru-001')?.version || c.find(item => item.groupId === 'DEV')?.version || c[0]?.version || '');
  }
  useEffect(() => {
    void reload().catch(e => setError(String(e.message))).finally(() => setInitialLoading(false));
  }, []);
  useEffect(() => {
    const url = new URL(location.href);
    if (tab === 'review') url.searchParams.delete('view'); else url.searchParams.set('view', tab);
    history.replaceState(null, '', url);
  }, [tab]);
  useEffect(() => {
    if (!selectedVersion) return;
    let active = true;
    setConversation(undefined); setSelectedEvaluationId(''); setTranscriptSearch(''); setManualPicked([]);
    request<Conversation>(`/api/conversations/${encodeURIComponent(selectedVersion)}`)
      .then(c => { if (active) { setConversation(c); setManualMode(c.channel === 'voice call'); } })
      .catch(e => { if (active) setError(String(e.message)); });
    return () => { active = false; };
  }, [selectedVersion]);
  useEffect(() => {
    if (activeChecklist && !activeChecklist.criteria.some(c => c.id === criterionId)) setCriterionId(activeChecklist.criteria[0]?.id || '');
  }, [activeChecklist, criterionId]);
  useEffect(() => {
    if (tab === 'review') conversationButtons.current.get(selectedVersion)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedVersion, filtered, tab]);
  useEffect(() => {
    if (!activeRequestId) return;
    let active = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const attempt = await request<AttemptView>(`/api/evaluation-attempts/${encodeURIComponent(activeRequestId)}`);
        if (active) setAttempts(current => rememberAttempt(current, attempt));
      } catch { /* A POST may not have registered yet; only its own response reports failure. */ }
      finally { polling = false; }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 1200);
    return () => { active = false; window.clearInterval(interval); };
  }, [activeRequestId]);

  async function act(label: string, action: () => Promise<void>) {
    setPending(label); setError(''); setNotice('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'REQUEST_FAILED'); }
    finally { setPending(''); }
  }
  async function acceptEvaluation(saved: Evaluation) {
    setEvaluations(current => [saved, ...current.filter(e => e.id !== saved.id)]);
    if (selectedRef.current === saved.conversationVersion) { setSelectedEvaluationId(saved.id); setManualMode(false); setManualPicked([]); }
    setNotice(isAi(saved) ? 'Оценка модели сохранена вместе с доказательствами и версией чек-листа.' : 'Локальная ручная запись сохранена. Для неё доступны апелляция и история пересмотра.');
    await reload();
  }
  async function evaluate(retryOf?: string) {
    const requestId = crypto.randomUUID();
    const sourceVersion = selectedVersion;
    const rubricVersion = checklistVersion;
    setSelectedAttemptId(requestId);
    setActiveRequestId(requestId);
    await act('Ожидаем ответ бесплатной модели…', async () => {
      try {
        const saved = await request<Evaluation>('/api/evaluations', { conversationVersion: sourceVersion, checklistVersion: rubricVersion, requestId, ...(retryOf ? { retryOf } : {}) });
        await acceptEvaluation(saved);
      } catch (cause) {
        if (cause instanceof ApiRequestError && cause.payload.attempt) {
          const attempt = { ...cause.payload.attempt, conversationVersion: sourceVersion, checklistVersion: rubricVersion, recovery: cause.payload.recovery || cause.payload.attempt.recovery };
          setAttempts(current => rememberAttempt(current, attempt));
        }
        throw cause;
      } finally {
        try {
          const attempt = await request<AttemptView>(`/api/evaluation-attempts/${encodeURIComponent(requestId)}`);
          setAttempts(current => rememberAttempt(current, attempt));
        } catch { /* The failed HTTP response remains authoritative when the ledger cannot be reached. */ }
        setActiveRequestId('');
      }
    });
  }
  function chooseConversation(version: string) { setSelectedVersion(version); setCriterionId('C1'); setError(''); setNotice(''); }
  function navigateList(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !filtered.length) return;
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button.conversation');
    if (!target) return;
    event.preventDefault();
    const index = filtered.findIndex(c => c.version === target.dataset.version);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? filtered.length - 1 : Math.max(0, Math.min(filtered.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    chooseConversation(filtered[next].version);
    conversationButtons.current.get(filtered[next].version)?.focus();
  }
  function jump(messageId: string) {
    const element = document.getElementById(messageId);
    element?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
    element?.focus({ preventScroll: true });
  }
  function selectEvidence(message: Message) {
    setManualPicked(current => current.includes(message.id) ? current : [...current, message.id]);
    window.dispatchEvent(new CustomEvent('cqa:evidence-select', { detail: { conversationVersion: conversation?.version, messageId: message.id } }));
  }
  function seekAudio(message: Message) {
    window.dispatchEvent(new CustomEvent('cqa:seek-source', { detail: { conversationVersion: conversation?.version, timestamp: message.timestamp } }));
  }
  const rangeStart = conversation?.messages.findIndex(m => m.id === result?.checkedRange?.startMessageId) ?? -1;
  const rangeEnd = conversation?.messages.findIndex(m => m.id === result?.checkedRange?.endMessageId) ?? -1;
  const canAiEvaluate = Boolean(conversation?.classification === 'synthetic_allowed' && status?.apiKeyPresent && status.freeTierConfirmed && selectedRunChecklist);
  const aiUnavailableReason = !conversation ? 'Сначала выберите диалог.' : conversation.classification !== 'synthetic_allowed' ? 'Для этого источника разрешена только локальная ручная оценка.' : !status?.apiKeyPresent ? 'На сервере не настроен ключ Gemini.' : !status.freeTierConfirmed ? 'Free tier проекта ещё не подтверждён на сервере.' : !selectedRunChecklist ? 'Выберите сохранённый чек-лист.' : '';

  if (new URLSearchParams(location.search).has('designs')) return <DesignChoices />;
  return <div className="app-shell">
    <a className="skip-link" href="#transcript-panel">К содержанию диалога</a>
    <header className="app-header">
      <a className="brand" href="/">FREEDOM <span>/ CQA</span></a>
      <nav aria-label="Разделы CQA">
        <button aria-pressed={tab === 'review'} onClick={() => setTab('review')}>Оценка диалогов</button>
        <button aria-pressed={tab === 'checklist'} onClick={() => setTab('checklist')}>Чек-листы</button>
        <button aria-pressed={tab === 'quality'} onClick={() => setTab('quality')}>Проверка качества</button>
      </nav>
      <span className="badge storage-badge"><span className="status-dot" />Локальное хранение</span>
    </header>
    {error && <div role="alert" className="global-message error"><span>{errorText(error)}</span>{!status && <button disabled={busy} onClick={() => void act('Загружаем рабочий набор…', reload)}>Повторить загрузку</button>}<button aria-label="Закрыть сообщение об ошибке" onClick={() => setError('')}>×</button></div>}
    {notice && <div role="status" className="global-message success"><span>{notice}</span><button aria-label="Закрыть уведомление" onClick={() => setNotice('')}>×</button></div>}
    {initialLoading ? <main className="loading-screen" aria-busy="true"><span className="loading-indicator" /><h1>Открываем рабочий набор</h1><p>Загружаются локальные диалоги, чек-листы и сохранённые оценки.</p></main>
      : tab === 'checklist' ? <ChecklistEditor checklists={checklists} selectedVersion={checklistVersion} onSaved={saved => { setChecklistVersion(saved.version); void reload().catch(e => setError(String(e.message))); }} onError={setError}/>
        : tab === 'quality' ? <QualityPanel onError={setError}/>
          : <main className="workspace">
            <aside className="sidebar" aria-label="Диалоги и фильтры">
              <div className="sidebar-heading"><p className="eyebrow">Рабочий набор</p><h1>DEV <span>{devCount}</span></h1><p className="dataset-separation">Официальный набор · {devCount} записей{otherCount > 0 && <><br/><button onClick={() => setFilters({ ...defaultFilters, group: '' })}>Другие группы: {otherCount}</button></>}</p></div>
              <form className="import-form" onSubmit={event => {
                event.preventDefault();
                void act('Импортируем группу…', async () => { const imported = await request<{ inserted: number; unchanged: number }>('/api/import', { groupId: group }); await reload(); setFilters({ ...defaultFilters, group }); setNotice(`Импорт ${group}: добавлено ${imported.inserted}, без изменений ${imported.unchanged}. В списке выбрана импортированная группа.`); });
              }}>
                <label className="sr-only" htmlFor="group">Группа импорта</label>
                <input id="group" value={group} onChange={event => setGroup(event.target.value)} required pattern="[A-Za-z0-9_-]{1,64}" maxLength={64}/>
                <button disabled={busy}>Импорт GET</button>
              </form>
              <div className="file-import"><button disabled={busy} onClick={() => fileInput.current?.click()}>Загрузить JSON локально</button><input ref={fileInput} type="file" accept=".json,application/json,text/plain" aria-label="Файл локального импорта" className="sr-only" onChange={event => {
                const file = event.target.files?.[0]; event.target.value = '';
                if (!file) return;
                void act('Импортируем локальный JSON…', async () => {
                  if (file.size > 15 * 1024 * 1024) throw new Error('Файл превышает допустимые 15 МБ.');
                  let payload: unknown;
                  try { payload = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); } catch { throw new Error('Файл не содержит корректный JSON организатора.'); }
                  const imported = await request<{ inserted: number; unchanged: number; groupId: string }>('/api/import-file', { payload });
                  await reload(); setFilters({ ...defaultFilters, group: imported.groupId }); setNotice(`Локальный JSON: добавлено ${imported.inserted}, без изменений ${imported.unchanged}. В списке выбрана группа ${imported.groupId}. Это не проверка доступности GET API.`);
                });
              }}/></div>
              <div className="filters">
                <label className="search-field"><span className="sr-only">Поиск по ID диалога или группе</span><input type="search" value={filters.search} onChange={e => setFilters({ ...filters, search: e.target.value })} placeholder="Найти ID диалога…" aria-label="Поиск диалога"/></label>
                <div className="filter-grid">
                  <label>Язык<select aria-label="Фильтр по языку" value={filters.language} onChange={e => setFilters({ ...filters, language: e.target.value })}><option value="">Все языки</option>{[...new Set(conversations.map(c => c.language))].sort().map(value => <option key={value}>{value}</option>)}</select></label>
                  <label>Канал<select aria-label="Фильтр по каналу" value={filters.channel} onChange={e => setFilters({ ...filters, channel: e.target.value })}><option value="">Все каналы</option>{[...new Set(conversations.map(c => c.channel))].sort().map(value => <option key={value} value={value}>{value === 'voice call' ? 'Звонки' : value === 'agent chat' ? 'Чаты' : value}</option>)}</select></label>
                </div>
                <label className="group-filter">Группа<select aria-label="Фильтр по группе" value={filters.group} onChange={e => setFilters({ ...filters, group: e.target.value })}><option value="DEV">DEV · официальный набор ({devCount})</option><option value="">Все группы</option>{[...new Set(conversations.map(c => c.groupId))].filter(value => value !== 'DEV').sort().map(value => <option key={value} value={value}>{value.startsWith('CQA_ACCEPTANCE_') ? `${value} · техническая группа` : value}</option>)}</select></label>
                <details className="extra-filters"><summary>Ещё фильтры</summary>
                  <label>Сохранённая оценка<select aria-label="Фильтр по оценке" value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}><option value="">Любой статус</option><option value="none">Без оценки</option><option value="any">Есть оценка</option><option value="ai">Есть AI-оценка</option><option value="manual">Есть ручная запись</option></select></label>
                  <label>Порядок<select aria-label="Сортировка диалогов" value={filters.sort} onChange={e => setFilters({ ...filters, sort: e.target.value })}><option value="id">По ID</option><option value="language">По языку</option><option value="length">Длинные сначала</option><option value="evaluated">С оценкой сначала</option></select></label>
                </details>
                <div className="filter-count"><span aria-live="polite">Показано {filtered.length}{filters.group === 'DEV' ? ` из ${devCount} DEV` : ` из ${conversations.length}`}</span>{filterActive && <button onClick={() => setFilters(defaultFilters)}>К DEV</button>}</div>
              </div>
              <div className="conversation-list" aria-label="Список диалогов" onKeyDown={navigateList}>
                {filtered.map(c => {
                  const saved = countsByVersion.get(c.version) || [];
                  return <button key={c.version} ref={element => { if (element) conversationButtons.current.set(c.version, element); else conversationButtons.current.delete(c.version); }} data-version={c.version} aria-pressed={c.version === selectedVersion} className={c.version === selectedVersion ? 'conversation selected' : 'conversation'} onClick={() => chooseConversation(c.version)}>
                    <span className="conversation-topline"><strong>{c.conversationId}</strong><span className="language-code">{c.language}</span></span>
                    <span>{c.channel === 'voice call' ? 'Звонок · локальная оценка' : 'Чат'} · {countLabel(c.messageCount, 'реплика', 'реплики', 'реплик')}</span>
                    <span className="conversation-footline"><span>{c.groupId}</span><span>{saved.length ? countLabel(saved.length, 'оценка', 'оценки', 'оценок') : 'Без оценки'}</span></span>
                  </button>;
                })}
                {!filtered.length && <div className="empty-state"><strong>{conversations.length ? 'Ничего не найдено' : 'Набор ещё не импортирован'}</strong><p>{conversations.length ? 'Измените условия поиска или сбросьте фильтры.' : 'Укажите group_id и выполните импорт GET.'}</p>{filterActive && <button onClick={() => setFilters(defaultFilters)}>Сбросить фильтры</button>}</div>}
              </div>
              <p className="keyboard-hint">↑ ↓ — переключение диалогов</p>
            </aside>

            <section className="transcript" id="transcript-panel" aria-labelledby="transcript-title" aria-busy={Boolean(selectedVersion && !conversation)}>
              <div className="transcript-toolbar">
                <div className="panel-heading"><div><p className="eyebrow">Исходный разговор</p><h2 id="transcript-title">{conversation?.conversationId || (selectedVersion ? 'Загрузка диалога…' : 'Выберите диалог')}</h2></div>{conversation && <span className="badge">{conversation.language}</span>}</div>
                {conversation && <><div className="source-meta"><span>{conversation.channel === 'voice call' ? 'Голосовой звонок' : 'Переписка'}</span><span>{countLabel(conversation.messages.length, 'реплика', 'реплики', 'реплик')}</span><span>Группа {conversation.groupId}</span></div><label className="transcript-search"><span className="sr-only">Поиск по транскрипту</span><input type="search" aria-label="Поиск по транскрипту" placeholder="Найти фрагмент в этом разговоре…" value={transcriptSearch} maxLength={200} onChange={e => setTranscriptSearch(e.target.value)}/></label></>}
                <a className="mobile-panel-link" href="#assessment-panel">Перейти к оценке ↓</a>
              </div>
              {selectedHidden && <p className="notice compact-notice">Выбранный диалог скрыт текущими фильтрами. <button onClick={() => setFilters({ ...defaultFilters, group: conversation?.groupId || '' })}>Показать в списке</button></p>}
              {conversation?.channel === 'voice call' && <><AudioPlayer conversation={conversation}/><p className="source-note">Звонок обрабатывается локально. Внутренняя консультация может иметь ту же роль «оператор»; проверяйте контекст и не оценивайте дикцию по тексту.</p></>}
              {conversation && conversation.classification !== 'synthetic_allowed' && <p className="notice compact-notice">Передача этого разговора в бесплатный Gemini запрещена. Доступны локальные доказательства, ручная оценка и пересмотр.</p>}
              {manualMode && conversation && <p className="source-note manual-source-note">Выберите критерий в ручной форме, затем нажмите «В доказательства» у нужной реплики. Исходный текст остаётся неизменным.</p>}
              {result?.checkedRange && !manualMode && <div className="range-notice">Проверяемый участок: реплики #{rangeStart + 1}–#{rangeEnd + 1}<button onClick={() => jump(result.checkedRange!.startMessageId)}>К началу ↗</button></div>}
              <div className="messages">
                {conversation?.messages.map((message, index) => {
                  const quotes = manualMode ? [] : result?.evidence.filter(e => e.messageId === message.id).map(e => e.quote) || [];
                  const inRange = !manualMode && rangeStart >= 0 && index >= rangeStart && index <= rangeEnd;
                  const highlighted = highlightText(message.text, quotes, transcriptSearch);
                  return <article tabIndex={-1} id={message.id} key={message.id} className={`message ${message.speaker}${quotes.length ? ' evidenced' : ''}${inRange ? ' in-checked-range' : ''}${manualMode && manualPicked.includes(message.id) ? ' manual-picked' : ''}`}>
                    <div className="message-meta"><strong>{speakers[message.speaker]}</strong><time>{message.timestamp}</time><span>#{message.position + 1}</span></div>
                    <p>{highlighted.content}</p>
                    {highlighted.searchLimited && <small className="source-note">Подсвечены первые 200 совпадений в этой реплике. Исходный текст показан полностью.</small>}
                    {(manualMode || (conversation.channel === 'voice call' && conversation.audioAvailable)) && <div className="message-actions">{manualMode && <button type="button" aria-label={`Выбрать реплику ${message.position + 1} в доказательства`} onClick={() => selectEvidence(message)}>В доказательства +</button>}{conversation.channel === 'voice call' && conversation.audioAvailable && <button type="button" aria-label={`Перейти к аудио реплики ${message.position + 1}`} onClick={() => seekAudio(message)}>К аудио ↗</button>}</div>}
                  </article>;
                })}
                {conversation && !conversation.messages.length && <div className="empty-state"><strong>Транскрипт пуст</strong><p>Автоматическая оценка недоступна. Исходная запись сохранена без добавленных реплик.</p></div>}
                {!selectedVersion && <div className="empty-state"><strong>Начните с выбора диалога</strong><p>Слева доступны импорт, языки и фильтры по каналу.</p></div>}
              </div>
            </section>

            <section className="assessment" id="assessment-panel" aria-labelledby="assessment-title">
              <div className="panel-heading"><div><p className="eyebrow">Оценка оператора</p><h2 id="assessment-title">{evaluation ? evaluation.score.total === null ? 'Не рассчитывается' : `${evaluation.score.total.toFixed(2)} / 100` : 'Оценки пока нет'}</h2></div>{evaluation && <span className={`badge ${isAi(evaluation) ? '' : 'local-badge'}`}>{originLabel(evaluation)}</span>}</div>
              <a className="mobile-panel-link" href="#transcript-panel">↑ Вернуться к транскрипту</a>
              {evaluation && <p className="result-version">Открыт сохранённый результат: <strong>{activeChecklist?.title || evaluation.checklistVersion}</strong><span>{evaluation.checklistVersion === 'official-v1' ? 'Официальный чек-лист · official-v1' : `Настроенная версия · ${evaluation.checklistVersion}`}</span>{isAi(evaluation) && <span>Запрос выполнен {displayTime(evaluation.createdAt)}. Открытие результата не вызывает модель.</span>}</p>}
              <div className="evaluation-actions">
                <label>Чек-лист для новой оценки<select aria-label="Чек-лист" value={checklistVersion} onChange={e => setChecklistVersion(e.target.value)}>{checklists.map(c => <option value={c.version} key={c.version}>{c.title} · {c.version}</option>)}</select></label>
                {checklistVersion === 'official-v1' && <p className="run-checklist-note">Новый запуск: официальный чек-лист, 8 критериев. Изменённую версию можно выбрать отдельно.</p>}
                {evaluation && evaluation.checklistVersion !== checklistVersion && <p className="availability-note">Показанные баллы относятся к сохранённой версии выше. Новый запрос будет использовать выбранный здесь чек-лист.</p>}
                <button className="primary" disabled={busy || !canAiEvaluate || !conversation?.messages.length} onClick={() => void evaluate()}>{pending === 'Ожидаем ответ бесплатной модели…' ? 'Выполняется запрос…' : 'Оценить через бесплатную модель'}</button>
                <p className="provider">{status?.model || 'Провайдер не настроен'} · Free tier · {status?.apiKeyPresent ? 'ключ настроен на сервере' : 'нужен API-ключ'}</p>
                {aiUnavailableReason && <p className="availability-note">{aiUnavailableReason}</p>}
                {pending && <p role="status" className="operation-status"><span className="loading-indicator"/>{pending}</p>}
                <button className="manual-toggle" aria-expanded={manualMode} disabled={!conversation || !selectedRunChecklist || busy} onClick={() => { setManualMode(!manualMode); setManualPicked([]); }}>{manualMode ? 'Закрыть ручную форму' : 'Создать ручную оценку'}</button>
              </div>
              {conversationAttempts.length > 1 && <label className="attempt-history-label">История запросов<select aria-label="История запросов" disabled={busy} value={selectedAttempt?.id || ''} onChange={event => setSelectedAttemptId(event.target.value)}>{conversationAttempts.map(item => <option key={item.id} value={item.id}>{displayTime(item.startedAt)} · {item.status === 'succeeded' ? 'Оценка сохранена' : item.status === 'failed' ? `Без оценки · ${item.errorCode}` : 'Выполняется'}</option>)}</select></label>}
              {selectedAttempt && (!activeRequestId || selectedAttempt.id === activeRequestId) && <AttemptStatus attempt={selectedAttempt} busy={busy} canRetry={Boolean(selectedAttempt.recovery?.canRetry && canAiEvaluate && conversation?.messages.length)} onRetry={() => void evaluate(selectedAttempt.id)}/>}
              {conversation && <DataPermissionPanel conversation={conversation} onApproved={async () => {
                const version = conversation.version;
                await reload();
                const updated = await request<Conversation>(`/api/conversations/${encodeURIComponent(version)}`);
                if (selectedRef.current === version) setConversation(updated);
                setNotice('Разрешение проверяющего сохранено для этой версии чата. Оценка запускается отдельным действием.');
              }} onError={setError}/>}
              {manualMode && conversation && selectedRunChecklist && <ManualEvaluationPanel key={`${conversation.version}:${selectedRunChecklist.version}`} conversation={conversation} checklist={selectedRunChecklist} onSaved={(saved: Evaluation) => { void acceptEvaluation(saved).catch(e => setError(String(e.message))); }} onError={setError}/>}
              {conversationEvaluations.length > 0 && <label className="saved-evaluation-label">Сохранённая оценка<select aria-label="Сохранённая оценка" value={evaluation?.id || ''} onChange={e => { setSelectedEvaluationId(e.target.value); setManualMode(false); }}>{conversationEvaluations.map(e => <option key={e.id} value={e.id}>{displayTime(e.createdAt)} · {originLabel(e)} · {e.checklistVersion}</option>)}</select></label>}
              {!evaluation && !manualMode && <div className="empty-state assessment-empty"><strong>Результат появится после сохранения</strong><p>{conversation?.classification === 'synthetic_allowed' ? 'Запустите реальную оценку модели либо заполните локальную ручную форму.' : 'Для этого источника используйте локальную ручную форму. AI-результат не создаётся автоматически.'}</p></div>}
              <div className="criteria" aria-label="Критерии оценки">{activeChecklist?.criteria.map(c => {
                const item = evaluation?.results.find(r => r.criterionId === c.id);
                const row = evaluation?.score.rows.find(r => r.criterionId === c.id);
                return <button key={c.id} aria-pressed={criterionId === c.id} className={criterionId === c.id ? 'criterion selected' : 'criterion'} onClick={() => setCriterionId(c.id)}><span><small>{c.id} · {c.flag ? 'Независимый флаг' : `Вес ${c.weight}`}</small><strong>{c.title}</strong></span><b>{item ? answerLabel(item.answer) : '—'}<small>{!c.flag && row?.normalizedContribution != null ? `${row.normalizedContribution.toFixed(2)} б.` : ''}</small></b></button>;
              })}</div>
              {criterion && <div className="reasoning criterion-details"><p className="eyebrow">Выбранный критерий · {criterion.id}</p><h3>{criterion.title}</h3><div className="criterion-config"><span>{criterion.flag ? 'Без числового веса' : `Вес ${criterion.weight}`}</span><span>Шкала: {criterion.allowedValues.map(answerLabel).join(' / ')}{criterion.naAllowed ? ' / N/A' : ''}</span></div><details><summary>Правила сохранённой версии</summary><p>{criterion.instructions}</p>{criterion.naAllowed && <p><strong>Условие N/A:</strong> {criterion.naCondition}</p>}<p><strong>Доказательства:</strong> {criterion.evidenceRequirement}</p></details>{result ? <ResultDetails result={result} jump={jump}/> : <p className="provider">Ответ по этому критерию ещё не сохранён.</p>}</div>}
              {evaluation && <>
                <details className="reasoning section-results"><summary>Результаты разделов</summary>{Object.entries(evaluation.score.sections).map(([section, score]) => <p key={section}>{section}<strong>{score.total === null ? 'Без числовой оценки' : `${score.total.toFixed(2)} / 100`}</strong></p>)}</details>
                <div className="evaluation-provenance"><p className="eyebrow">Происхождение результата</p><p><strong>{originLabel(evaluation)}</strong>{isAi(evaluation) ? ` · ${evaluation.model}` : evaluation.reviewer ? ` · ${evaluation.reviewer}` : ''}<br/>{displayTime(evaluation.createdAt)} · Asia/Qyzylorda</p>{isAi(evaluation) ? <p>Это сохранённый ответ предыдущего реального запроса. Новый вызов выполняется только кнопкой оценки.<br/>Время модели: {(evaluation.latencyMs / 1000).toFixed(1)} сек. · запросов: {evaluation.providerCallCount}<br/>Токенов в ответе провайдера: {evaluation.usage.totalTokens ?? 'не сообщено'}. Это не подтверждение смысловой точности.</p> : <p>{evaluation.status === 'manual_demo' ? 'Техническая демонстрация ручного ввода. Не является человеческим эталоном или AI-оценкой.' : 'Ответы внесены локально проверяющим. Вызов модели для этой оценки не выполнялся.'}</p>}<p className={Object.values(evaluation.score.flags).some(Boolean) ? 'gross-flag is-present' : 'gross-flag'}>Грубые ошибки: <strong>{Object.values(evaluation.score.flags).some(Boolean) ? 'ДА' : 'нет'}</strong></p></div>
                {activeChecklist && <ReviewPanel key={evaluation.id} evaluation={evaluation} checklist={activeChecklist} onError={setError}/>}
              </>}
            </section>
          </main>}
  </div>;
}

function ResultDetails({ result, jump }: { result: CriterionResult; jump: (id: string) => void }) {
  return <div className="result-details">
    <p className="result-answer">Ответ: <strong>{answerLabel(result.answer)}</strong></p><p>{result.explanation}</p>
    {result.applicabilityRationale && <p><strong>Применимость:</strong> {result.applicabilityRationale}</p>}
    {result.evidence.map((evidence, index) => <button className="evidence-link" key={index} onClick={() => jump(evidence.messageId)}>«{evidence.quote}» <span aria-hidden="true">↗</span></button>)}
    {result.checkedRange && <div className="checked-range-links"><span>Проверенный участок разговора</span><button className="evidence-link" onClick={() => jump(result.checkedRange!.startMessageId)}>Начало участка ↗</button><button className="evidence-link" onClick={() => jump(result.checkedRange!.endMessageId)}>Конец участка ↗</button></div>}
    {result.reviewRequired && <p className="notice">Нужна проверка: {result.uncertainty}</p>}
  </div>;
}

function highlightText(text: string, evidence: string[], search: string): { content: ReactNode; searchLimited: boolean } {
  const ranges: Array<{ start: number; end: number; kind: 'evidence' | 'search' }> = [];
  let searchLimited = false;
  for (const quote of evidence.filter(Boolean)) {
    let offset = 0;
    for (let count = 0; count < 100; count++) {
      const start = text.indexOf(quote, offset);
      if (start < 0) break;
      ranges.push({ start, end: start + quote.length, kind: 'evidence' }); offset = start + quote.length;
    }
  }
  const query = search.trim();
  if (query) {
    const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    let count = 0;
    for (const match of text.matchAll(expression)) {
      if (++count > 200) { searchLimited = true; break; }
      ranges.push({ start: match.index!, end: match.index! + match[0].length, kind: 'search' });
    }
  }
  if (!ranges.length) return { content: text, searchLimited };
  const boundaries = [...new Set([0, text.length, ...ranges.flatMap(range => [range.start, range.end])])].sort((a, b) => a - b);
  const content = boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    const covering = ranges.filter(range => range.start <= start && range.end >= end);
    return covering.length ? <mark key={start} className={covering.some(range => range.kind === 'evidence') ? 'evidence-fragment' : 'search-fragment'}>{text.slice(start, end)}</mark> : text.slice(start, end);
  });
  return { content, searchLimited };
}

function errorText(code: string) {
  const messages: Record<string, string> = {
    EVALUATION_BUSY: 'Другой запрос модели уже выполняется. Дождитесь результата.',
    FREE_TIER_UNCONFIRMED: 'Подтвердите Free tier в серверной конфигурации.',
    MISSING_API_KEY: 'Настройте GEMINI_API_KEY в серверном окружении.',
    MODEL_UNAVAILABLE: 'Выбранная модель недоступна для генерации в этом проекте.',
    PROVIDER_RATE_LIMIT: 'Бесплатная квота временно исчерпана. Новая оценка не сохранена. Платный fallback не включался.',
    PROVIDER_TIMEOUT: 'Модель не ответила вовремя. Новая оценка не сохранена; предыдущие результаты доступны.',
    PROVIDER_FAILED: 'Провайдер не выполнил оценку. Новый результат не создан.',
    PROVIDER_NETWORK_ERROR: 'Связь с провайдером прервалась. Новая оценка не сохранена; сведения о повторах доступны в истории запроса.',
    PROVIDER_EMPTY_RESULT: 'Провайдер вернул пустой ответ. Новая оценка не сохранена.',
    INVALID_MODEL_JSON: 'Ответ модели отклонён: формат результата некорректен. Новая оценка не сохранена.',
    INVALID_EVIDENCE: 'Ответ модели отклонён: доказательства не прошли проверку. Новая оценка не сохранена.',
    IDEMPOTENCY_CONFLICT: 'Этот идентификатор запроса уже связан с другим диалогом или чек-листом. Новая оценка не запущена.',
    RECOVERY_LIMIT_REACHED: 'Однократный повтор этой попытки уже использован. Новый автоматический запрос не выполнялся.',
    RECOVERY_ALREADY_STARTED: 'Для этой попытки уже начат явный повтор. Его состояние доступно в истории запросов.',
    RECOVERY_NOT_AVAILABLE: 'Для этой причины повтор недоступен. Сначала устраните указанное ограничение.',
    RECOVERY_SOURCE_MISMATCH: 'Повтор должен использовать тот же диалог, чек-лист и модель. Новый запрос не выполнен.',
    DATA_POLICY_RESTRICTED: 'Внешняя AI-оценка запрещена для этого источника. Используйте локальную ручную форму.',
    REQUEST_FAILED: 'Запрос не выполнен. Проверьте соединение с локальным сервером и конфигурацию.',
    IMPORT_SCHEMA_INVALID: 'Файл не соответствует формату набора организаторов. Выберите исходный JSON.',
    IMPORT_COUNT_MISMATCH: 'Заявленное число диалогов не совпадает с содержимым набора.',
    IMPORT_DUPLICATE_IDS: 'Набор содержит повторяющиеся ID диалогов. Импорт не сохранён.',
    IMPORT_REJECTED: 'Организатор не вернул успешный набор. Проверьте group_id и доступность группы.',
    IMPORT_GROUP_MISMATCH: 'Организатор вернул другую группу. Импорт не сохранён.',
    IMPORT_NOT_CONFIGURED: 'Серверная ссылка импорта не настроена. Используйте локальный JSON или настройте .env.',
    IMPORT_HTTP_ERROR: 'Источник отказал в GET-запросе. Проверьте доступность группы и срок серверной ссылки.',
    IMPORT_TIMEOUT: 'Источник не ответил вовремя. Данные не изменены; можно повторить запрос.',
    IMPORT_NETWORK_FAILED: 'Сетевой запрос к организатору не выполнен. Можно загрузить JSON локально.',
    IMPORT_TOO_LARGE: 'Набор превышает допустимый размер импорта.',
    IMPORT_JSON_INVALID: 'Источник вернул некорректный JSON. Импорт не сохранён.',
  };
  return messages[code] || (/^[A-Z0-9_]+$/.test(code) ? `Запрос не выполнен: ${code}` : code);
}

function DesignChoices() {
  const names = ['A · Evidence Desk', 'B · Operations Review', 'C · Conversation Timeline'];
  const descriptions = ['Транскрипт и доказательства рядом. Для подробного разбора одного диалога.', 'Список оценок на первом плане. Для последовательной проверки набора.', 'События и доказательства на общей временной оси.'];
  return <main className="designs"><p className="eyebrow">Архив выбора · вымышленные данные</p><h1>Один разговор. Три способа проверить.</h1><p>Выбрано направление A: Evidence Desk. <a href="/">Открыть рабочий интерфейс →</a></p><div className="design-grid">{names.map((name, index) => <section key={name}><h2>{name}</h2><div className={`mock option-${index}`}><div className="mock-bar">FREEDOM / CQA <b>DEMO-001</b></div><div className="mock-body"><div className="mock-list"><div>DEMO-001 · RU</div><div>DEMO-002 · KZ</div><div>DEMO-003 · EN</div></div><div className="mock-chat"><span>Клиент · 00:00</span><p>Где найти описание тарифов?</p><span>Оператор · 00:10</span><p>Здравствуйте! Я Дана. Откройте раздел «Тарифы».</p><span>Клиент · 00:25</span><p>Спасибо, нашёл.</p></div><div className="mock-score"><b>Доказательства</b><p>C1 · Контакт · Да</p><blockquote>«Здравствуйте! Я Дана.»</blockquote><p>C3 · N/A</p><p>Публичная информация</p></div></div></div><p>{descriptions[index]}</p></section>)}</div></main>;
}
