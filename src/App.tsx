import { useEffect, useState } from 'react';
import type { Checklist, Conversation, CriterionResult, Evaluation } from './domain.js';
import { ChecklistEditor } from './ChecklistEditor.js';
import { ReviewPanel } from './ReviewPanel.js';

type Summary = Pick<Conversation, 'version' | 'conversationId' | 'groupId' | 'language' | 'channel' | 'classification'> & { messageCount: number };
type Status = { model: string; apiKeyPresent: boolean; freeTierConfirmed: boolean; liveEvaluationCount: number };
async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'REQUEST_FAILED');
  return data;
}
const answerLabel = (answer: string) => ({ YES: 'Да', NO: 'Нет', 'N/A': 'N/A' }[answer] || answer);

export function App() {
  const [status, setStatus] = useState<Status>();
  const [conversations, setConversations] = useState<Summary[]>([]);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [checklistVersion, setChecklistVersion] = useState('');
  const [selectedVersion, setSelectedVersion] = useState('');
  const [conversation, setConversation] = useState<Conversation>();
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [evaluation, setEvaluation] = useState<Evaluation>();
  const [criterionId, setCriterionId] = useState('C1');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [group, setGroup] = useState('DEV');
  const [tab, setTab] = useState<'review' | 'checklist'>('review');
  const activeChecklist = checklists.find(c => c.version === (evaluation?.checklistVersion || checklistVersion));
  const result = evaluation?.results.find(r => r.criterionId === criterionId);
  const criterion = activeChecklist?.criteria.find(c => c.id === criterionId);

  async function reload() {
    const [s, c, k, e] = await Promise.all([request<Status>('/api/status'), request<Summary[]>('/api/conversations'), request<Checklist[]>('/api/checklists'), request<Evaluation[]>('/api/evaluations')]);
    setStatus(s); setConversations(c); setChecklists(k); setEvaluations(e);
    setChecklistVersion(v => v || k[0]?.version || '');
    setSelectedVersion(v => v || c.find(item => item.conversationId === 'p1-ru-001')?.version || c[0]?.version || '');
  }
  useEffect(() => { void reload().catch(e => setError(String(e.message))); }, []);
  useEffect(() => {
    if (!selectedVersion) return;
    let cancelled = false;
    setConversation(undefined); setEvaluation(undefined);
    request<Conversation>(`/api/conversations/${encodeURIComponent(selectedVersion)}`).then(c => { if (!cancelled) setConversation(c); }).catch(e => { if (!cancelled) setError(String(e.message)); });
    return () => { cancelled = true; };
  }, [selectedVersion]);
  useEffect(() => { setEvaluation(evaluations.find(e => e.conversationVersion === selectedVersion)); }, [evaluations, selectedVersion]);
  async function act(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'REQUEST_FAILED'); } finally { setBusy(false); }
  }
  function jump(messageId: string) { document.getElementById(messageId)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' }); document.getElementById(messageId)?.focus({ preventScroll: true }); }
  if (new URLSearchParams(location.search).has('designs')) return <DesignChoices />;
  return <>
    <header><a className="brand" href="/">FREEDOM <span>/ CQA</span></a><nav><button aria-pressed={tab === 'review'} onClick={() => setTab('review')}>Оценка диалогов</button><button aria-pressed={tab === 'checklist'} onClick={() => setTab('checklist')}>Чек-листы</button><a href="/?designs">Варианты интерфейса</a></nav><span className="badge">Локальное хранение · Free tier</span></header>
    {error && <div role="alert" className="error">{errorText(error)}</div>}
    {tab === 'checklist' ? <ChecklistEditor checklists={checklists} selectedVersion={checklistVersion} onSaved={saved => { void reload(); setChecklistVersion(saved.version); }} onError={setError}/> : <main className="workspace">
      <aside className="sidebar"><p className="eyebrow">Рабочий набор</p><h1>Диалоги <span>{conversations.length}</span></h1><form onSubmit={e => { e.preventDefault(); void act(async () => { await request('/api/import', { groupId: group }); await reload(); }); }}><label className="sr-only" htmlFor="group">Группа импорта</label><input id="group" value={group} onChange={e => setGroup(e.target.value)} required pattern="[A-Za-z0-9_-]{1,64}"/><button disabled={busy}>Импорт GET</button></form><div className="conversation-list">{conversations.map(c => <button key={c.version} className={c.version === selectedVersion ? 'conversation selected' : 'conversation'} onClick={() => { setSelectedVersion(c.version); setCriterionId('C1'); }}><strong>{c.conversationId}</strong><span>{c.language} · {c.channel === 'voice call' ? 'Звонок · AI ограничен' : 'Чат'} · {c.messageCount} реплик</span></button>)}</div></aside>
      <section className="transcript"><div className="panel-heading"><div><p className="eyebrow">Исходный разговор</p><h2>{conversation?.conversationId || 'Выберите диалог'}</h2></div><span className="badge">{conversation?.language}</span></div>{conversation?.classification !== 'synthetic_allowed' && conversation && <p className="notice">Автоматическая оценка ограничена политикой данных. Транскрипт доступен для локального просмотра.</p>}<div className="messages">{conversation?.messages.map(m => <article tabIndex={-1} id={m.id} key={m.id} className={`message ${m.speaker} ${result?.evidence.some(e => e.messageId === m.id) ? 'evidenced' : ''}`}><div><strong>{({ client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' })[m.speaker]}</strong><time>{m.timestamp}</time><span>#{m.position + 1}</span></div><p>{m.text}</p></article>)}</div></section>
      <section className="assessment"><div className="panel-heading"><div><p className="eyebrow">Оценка оператора</p><h2>{evaluation ? `${evaluation.score.total?.toFixed(2) ?? '—'} / 100` : 'Оценка не запускалась'}</h2></div>{evaluation && <span className="badge">Реальный API</span>}</div><label>Чек-лист <select value={checklistVersion} onChange={e => setChecklistVersion(e.target.value)}>{checklists.map(c => <option value={c.version} key={c.version}>{c.version}</option>)}</select></label><button className="primary" disabled={busy || !conversation || conversation.classification !== 'synthetic_allowed' || !status?.apiKeyPresent || !status.freeTierConfirmed} onClick={() => void act(async () => { const e = await request<Evaluation>('/api/evaluations', { conversationVersion: selectedVersion, checklistVersion }); setEvaluation(e); await reload(); })}>{busy ? 'Выполняется запрос…' : 'Оценить через бесплатную модель'}</button><p className="provider">{status?.model} · {status?.apiKeyPresent ? 'ключ настроен' : 'нужен API-ключ'}</p>
        {evaluations.filter(e => e.conversationVersion === selectedVersion).length > 0 && <label>Сохранённая оценка<select aria-label="Сохранённая оценка" value={evaluation?.id || ''} onChange={e => setEvaluation(evaluations.find(v => v.id === e.target.value))}>{evaluations.filter(e => e.conversationVersion === selectedVersion).map(e => <option key={e.id} value={e.id}>{new Date(e.createdAt).toLocaleString('ru', { timeZone: 'Asia/Qyzylorda' })} · {e.checklistVersion}</option>)}</select></label>}
        <div className="criteria">{activeChecklist?.criteria.map(c => { const r = evaluation?.results.find(r => r.criterionId === c.id); const row = evaluation?.score.rows.find(r => r.criterionId === c.id); return <button key={c.id} className={criterionId === c.id ? 'criterion selected' : 'criterion'} onClick={() => setCriterionId(c.id)}><span><small>{c.id} · {c.flag ? 'Флаг' : `Вес ${c.weight}`}</small><strong>{c.title}</strong></span><b>{r ? answerLabel(r.answer) : '—'}<small>{!c.flag && row?.normalizedContribution != null ? `${row.normalizedContribution.toFixed(2)} б.` : ''}</small></b></button>; })}</div>
        {evaluation && <details className="reasoning"><summary>Результаты разделов</summary>{Object.entries(evaluation.score.sections).map(([section, score]) => <p key={section}>{section}: <strong>{score.total === null ? 'Без числовой оценки' : `${score.total.toFixed(2)} / 100`}</strong></p>)}</details>}
        {criterion && <div className="reasoning"><h3>{criterion.title}</h3>{result ? <ResultDetails result={result} jump={jump} /> : <p>{criterion.instructions}</p>}</div>}
        {evaluation && <p className="provider">{evaluation.status} · {(evaluation.latencyMs / 1000).toFixed(1)} сек. · запросов: {evaluation.providerCallCount}<br/>Версия: {evaluation.checklistVersion}<br/>Грубые ошибки: {Object.values(evaluation.score.flags).some(Boolean) ? 'ДА' : 'нет'}<br/>Качество решения ещё требует проверки человеком.</p>}
        {evaluation && activeChecklist && <ReviewPanel key={evaluation.id} evaluation={evaluation} checklist={activeChecklist} onError={setError}/>}
      </section>
    </main>}
  </>;
}
function ResultDetails({ result, jump }: { result: CriterionResult; jump: (id: string) => void }) {
  return <><p>{result.explanation}</p>{result.applicabilityRationale && <p><strong>Применимость:</strong> {result.applicabilityRationale}</p>}{result.evidence.map((e, i) => <button className="evidence-link" key={i} onClick={() => jump(e.messageId)}>«{e.quote}» ↗</button>)}{result.checkedRange && <><button className="evidence-link" onClick={() => jump(result.checkedRange!.startMessageId)}>Начало проверенного участка ↗</button><button className="evidence-link" onClick={() => jump(result.checkedRange!.endMessageId)}>Конец проверенного участка ↗</button></>}{result.reviewRequired && <p className="notice">Нужна проверка: {result.uncertainty}</p>}</>;
}
function errorText(code: string) {
  const texts: Record<string, string> = { EVALUATION_BUSY: 'Другой запрос уже выполняется. Дождитесь результата.', FREE_TIER_UNCONFIRMED: 'Подтвердите Free tier в серверном .env.', MISSING_API_KEY: 'Настройте GEMINI_API_KEY в серверном окружении.', MODEL_UNAVAILABLE: 'Выбранная модель недоступна для генерации в этом проекте.', PROVIDER_RATE_LIMIT: 'Бесплатная квота временно исчерпана. Оценка не сохранена.', PROVIDER_TIMEOUT: 'Модель не ответила вовремя. Оценка не сохранена.', INVALID_EVIDENCE: 'Ответ модели отклонён: доказательства не прошли проверку.', DATA_POLICY_RESTRICTED: 'Внешняя AI-оценка запрещена для этого источника.', REQUEST_FAILED: 'Запрос не выполнен. Проверьте сервер и конфигурацию.' };
  return texts[code] || `Запрос не выполнен: ${code}`;
}
function DesignChoices() {
  const names = ['A · Evidence Desk', 'B · Operations Review', 'C · Conversation Timeline'];
  const descriptions = ['Транскрипт и доказательства рядом. Для подробного разбора одного диалога.', 'Список оценок на первом плане. Для последовательной проверки большого набора.', 'События, решения и доказательства на общей временной оси. Для сложных разговоров.'];
  return <main className="designs"><p className="eyebrow">Выбор направления · вымышленные данные</p><h1>Один разговор. Три способа проверить.</h1><p>Лёгкие прототипы основного экрана; окончательное оформление — после вашего выбора.</p><div className="design-grid">{names.map((n, i) => <section key={n}><h2>{n}</h2><div className={`mock option-${i}`}><div className="mock-bar">FREEDOM / CQA <b>DEMO-001</b></div><div className="mock-body"><div className="mock-list"><div>DEMO-001 · RU</div><div>DEMO-002 · KZ</div><div>DEMO-003 · EN</div></div><div className="mock-chat"><span>Клиент · 00:00</span><p>Где найти описание тарифов?</p><span>Оператор · 00:10</span><p>Здравствуйте! Я Дана. Откройте раздел «Тарифы».</p><span>Клиент · 00:25</span><p>Спасибо, нашёл.</p></div><div className="mock-score"><b>Доказательства</b><p>C1 · Контакт · Да</p><blockquote>«Здравствуйте! Я Дана.»</blockquote><p>C3 · N/A</p><p>Публичная информация</p></div></div></div><p>{descriptions[i]}</p></section>)}</div></main>;
}
