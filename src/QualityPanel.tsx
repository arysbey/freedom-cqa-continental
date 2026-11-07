import { useEffect, useRef, useState } from 'react';
import type { Checklist, Conversation, CriterionResult, Score } from './domain.js';
import type { HumanJudgment, HumanReference, HumanReviewRound, ValidationCase, ValidationManifest } from '../server/quality.js';

type MetricCount = { matches: number; total: number; agreement: number | null };
interface Dashboard {
  manifest: ValidationManifest | null; manifests: Array<{ id: string; title: string }>;
  cases: Array<ValidationCase & { humanReferenceSaved: boolean; lastRunStatus: string }>;
  referenceCount: number;
  reviewRound?: HumanReviewRound;
  metrics: null | {
    humanReviewedCases: number; resolvedHumanJudgments: number; unresolvedHumanJudgments: number; comparedCases: number;
    selectionPolicy: string;
    coverage: { coreCases: number; expectedHumanJudgments: number; unannotatedJudgments: number; casesWithoutReference: number; fullyResolvedCases: number; weightedCompleteCases: number; casesWithoutAcceptedModel: number };
    byCriterion: Record<string, MetricCount>; byLanguage: Record<string, MetricCount>;
    bySplit: Record<string, MetricCount>;
    totalScoreError: { dialogs: number; meanAbsoluteError: number | null; maxAbsoluteError: number | null };
    na: { total: number; falseNA: number; missedNA: number; available: boolean };
    grossViolations: { total: number; falsePositive: number; falseNegative: number; available: boolean; referencePositives: number; recall: number | null; precision: number | null };
    evidence: { evaluationValidity: number | null; quotesChecked: number; quotesValid: number; humanSemantic: { supported: number; unsupported: number; unresolved: number; available: boolean } };
    reliability: { attempts: number; successes: number; failures: number; errors: Record<string, number>; latencyMs: { median: number | null; p95: number | null }; reportedTokens: number; unknownTokenUsageAttempts: number };
    materialDisagreements: Array<{ caseId: string; criterionId: string; language: string; expected: string; actual: string; category: string }>;
  };
}
interface CaseView { reviewRound: HumanReviewRound; case: ValidationCase; conversation: Conversation; checklist: Checklist; reference: HumanReference | null; referenceNumericScore: Score | null; modelEvaluation: { id: string; model: string; results: CriterionResult[]; score: Score | null } | null }
const emptyJudgment = (criterionId: string): HumanJudgment => ({ criterionId, resolved: false, answer: null, explanation: '', applicabilityRationale: '', evidence: [], checkedRange: null });
const answerLabel = (answer: string | null) => answer === 'YES' ? 'Да' : answer === 'NO' ? 'Нет' : answer || 'Не решено';
const percent = (value: number | null) => value === null ? 'Нет данных' : `${(value * 100).toFixed(1)}%`;
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'REQUEST_FAILED');
  return result as T;
}
function friendly(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  const messages: Record<string, string> = { REVIEW_ROUND_CHANGED: 'Начат новый раунд разметки. Старый черновик не сохранён; обновите страницу и начните с пустой формы.', BLIND_REFERENCE_FROZEN: 'Уже подтверждённые слепые ответы неизменяемы. Можно дополнить только ранее не решённые пункты.', INVALID_EVIDENCE: 'Проверьте точные цитаты и диапазон. Для Нет и частичного балла диапазон обязателен.', INVALID_REFERENCE_CRITERIA: 'Каждый критерий должен присутствовать один раз.', VALIDATION_SOURCE_RESTRICTED: 'Этот источник не входит в разрешённую проверочную выборку.', IDEMPOTENCY_CONFLICT: 'Повтор запроса отличается от ранее сохранённого. Обновите страницу.' };
  return messages[code] || 'Не удалось сохранить. Проверьте обязательные поля, точность цитат, условие N/A и проверенный диапазон.';
}
export function QualityPanel({ onError }: { onError?: (message: string) => void }) {
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [manifestId, setManifestId] = useState('');
  const [caseId, setCaseId] = useState('');
  const [view, setView] = useState<CaseView>();
  const [draft, setDraft] = useState<HumanJudgment[]>([]);
  const [criterionId, setCriterionId] = useState('');
  const [reviewerId, setReviewerId] = useState('');
  const [human, setHuman] = useState(false);
  const [blind, setBlind] = useState(false);
  const [messageId, setMessageId] = useState('');
  const [quote, setQuote] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [evidenceVerdict, setEvidenceVerdict] = useState('supports');
  const [evidenceCategory, setEvidenceCategory] = useState('evidence');
  const [evidenceComment, setEvidenceComment] = useState('');
  const pending = useRef<{ signature: string; requestId: string } | null>(null);
  const requestedCriterion = useRef('');
  const activeRound = useRef('');
  const selected = draft.find(j => j.criterionId === criterionId);
  const criterion = view?.checklist.criteria.find(c => c.id === criterionId);
  const frozen = view?.reference?.judgments.some(j => j.criterionId === criterionId && j.resolved) ?? false;
  const modelResult = view?.modelEvaluation?.results.find(r => r.criterionId === criterionId);
  async function loadDashboard(id = manifestId) {
    const result = await request<Dashboard>(`/api/quality${id ? `?manifestId=${encodeURIComponent(id)}` : ''}`);
    setDashboard(result); setManifestId(result.manifest?.id || '');
    const roundKey = `${result.manifest?.id || ''}:${result.reviewRound?.id || 'legacy'}`;
    const changed = activeRound.current !== roundKey;
    activeRound.current = roundKey;
    if (changed) {
      setView(undefined); setDraft([]); setCriterionId(''); setReviewerId(''); setHuman(false); setBlind(false);
      setMessageId(''); setQuote(''); setEvidenceVerdict('supports'); setEvidenceCategory('evidence'); setEvidenceComment('');
      pending.current = null; requestedCriterion.current = '';
      setCaseId(result.cases.find(c => !c.humanReferenceSaved)?.id || result.cases[0]?.id || '');
    } else setCaseId(current => result.cases.some(c => c.id === current) ? current : result.cases.find(c => !c.humanReferenceSaved)?.id || result.cases[0]?.id || '');
  }
  useEffect(() => { void loadDashboard().catch(() => setError('Не удалось загрузить выборку.')).finally(() => setLoading(false)); }, []);
  useEffect(() => {
    if (!manifestId) return;
    // Detect an externally opened round without overwriting an unfinished form in the same round.
    const timer = setInterval(() => { void loadDashboard(manifestId).catch(() => undefined); }, 10000);
    return () => clearInterval(timer);
  }, [manifestId]);
  useEffect(() => {
    if (!caseId || !manifestId) return;
    let active = true; setLoading(true); setView(undefined); setError(''); setNotice('');
    request<CaseView>(`/api/quality/cases/${encodeURIComponent(caseId)}?manifestId=${encodeURIComponent(manifestId)}`).then(result => {
      if (!active) return;
      setView(result); setDraft(result.reference?.judgments || result.checklist.criteria.map(c => emptyJudgment(c.id))); setCriterionId(result.checklist.criteria.some(c => c.id === requestedCriterion.current) ? requestedCriterion.current : result.checklist.criteria[0]?.id || ''); requestedCriterion.current = ''; setMessageId(''); setQuote(''); setHuman(false); setBlind(false); pending.current = null;
    }).catch(() => { if (active) setError('Не удалось загрузить проверочный диалог.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [caseId, manifestId, dashboard?.reviewRound?.id]);
  function patch(changes: Partial<HumanJudgment>) { if (!frozen) setDraft(current => current.map(j => j.criterionId === criterionId ? { ...j, ...changes } : j)); }
  function jump(id: string) { document.getElementById(`quality-${id}`)?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); document.getElementById(`quality-${id}`)?.focus({ preventScroll: true }); }
  async function save() {
    if (!view || busy) return;
    setBusy(true); setError(''); setNotice('');
    const payload = { manifestId, caseId, reviewRoundId: view.reviewRound.id, reviewerId: reviewerId.trim(), origin: 'human_declared', humanAttestation: human, blindReviewAttested: blind, judgments: draft };
    const signature = JSON.stringify(payload);
    if (pending.current?.signature !== signature) pending.current = { signature, requestId: crypto.randomUUID() };
    try {
      await request('/api/quality/references', { ...payload, requestId: pending.current.requestId });
      pending.current = null;
      const result = await request<CaseView>(`/api/quality/cases/${encodeURIComponent(caseId)}?manifestId=${encodeURIComponent(manifestId)}`);
      setView(result); setDraft(result.reference?.judgments || result.checklist.criteria.map(c => emptyJudgment(c.id))); setHuman(false); setBlind(false);
      await loadDashboard(); setNotice('Человеческая разметка сохранена отдельно от модели. Подтверждённые ответы зафиксированы; нерешённые можно дополнить.');
    } catch (cause) { const message = friendly(cause); setError(message); onError?.(message); } finally { setBusy(false); }
  }
  async function saveEvidenceReview() {
    if (!view?.modelEvaluation || !human || !reviewerId.trim()) return;
    setBusy(true); setError('');
    try {
      await request('/api/quality/evidence-reviews', { manifestId, caseId, reviewRoundId: view.reviewRound.id, evaluationId: view.modelEvaluation.id, criterionId, reviewerId: reviewerId.trim(), humanAttestation: true, verdict: evidenceVerdict, category: evidenceCategory, comment: evidenceComment.trim(), requestId: crypto.randomUUID() });
      await loadDashboard(); setNotice('Проверка смысловой поддержки и категория сохранены отдельно.'); setEvidenceComment('');
    } catch (cause) { setError(friendly(cause)); } finally { setBusy(false); }
  }
  async function downloadComparison() {
    setBusy(true); setError('');
    try {
      const report = await request<{ cutoff: string; reportHash: string }>(`/api/quality/export?manifestId=${encodeURIComponent(manifestId)}`);
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `cqa-comparison-${report.reportHash.slice(0, 12)}.json`; link.click(); URL.revokeObjectURL(url);
      setNotice(`Локальный отчёт сохранён на срез ${report.cutoff}. Он содержит человеческие пояснения и предназначен для частной проверки.`);
    } catch { setError('Не удалось выгрузить сравнение. Обновите метрики и повторите.'); } finally { setBusy(false); }
  }
  const metrics = dashboard?.metrics;
  return <section className="quality-workspace">
    <div className="quality-summary"><p className="eyebrow">Независимая проверка качества</p><h1>Человек → эталон → сравнение</h1><p>12 разрешённых синтетических чатов, по 4 на RU/KZ/EN. Разбиение 6 рабочих / 6 отложенных зафиксировано до нового прогона. Машинных эталонов нет.</p>
      {dashboard?.manifests.length ? <label>Набор<select aria-label="Проверочная выборка" value={manifestId} onChange={event => { setCaseId(''); void loadDashboard(event.target.value); }}>{dashboard.manifests.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</select></label> : <p className="notice">Выборка ещё не подготовлена. Выполните локальный prepare-validation.</p>}
      <p className="notice">Сначала самостоятельно прочитайте разговор и сохраните ответы. Оценки модели скрыты до подтверждения соответствующих пунктов. Пропуски остаются нерешёнными и не входят в метрики; нулевая разметка не означает нулевую точность.</p>
      {dashboard?.reviewRound && dashboard.reviewRound.id !== 'legacy' && <p className="notice" data-review-round={dashboard.reviewRound.id}>Новый раунд разметки: прогресс начинается заново. Прежние ответы сохранены в аудите и исключены из текущего сравнения. Новый раунд не отменяет ранее увиденные ответы модели.</p>}
      <button disabled={busy || loading} onClick={() => void loadDashboard().catch(() => setError('Не удалось обновить сравнение.'))}>Обновить сравнение</button>
      <button disabled={busy || loading || !manifestId} onClick={() => void downloadComparison()}>Скачать частный отчёт JSON</button>
    </div>
    {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
    <div className="quality-grid">
      <aside className="quality-case-list"><h2>Примеры · {dashboard?.cases.length || 0}</h2>{dashboard?.cases.map(item => <button key={item.id} className={item.id === caseId ? 'conversation selected' : 'conversation'} aria-pressed={item.id === caseId} onClick={() => setCaseId(item.id)}><strong>{item.conversationId}</strong><span>{item.language} · {item.split === 'holdout' ? 'Отложенный' : 'Рабочий'}</span><span>{item.humanReferenceSaved ? 'Есть человеческая разметка' : 'Разметка отсутствует'} · {item.lastRunStatus === 'success' ? 'API сохранён' : item.lastRunStatus === 'failed' ? 'Ошибка API' : 'API не запускался'}</span></button>)}</aside>
      <section className="quality-transcript"><div className="panel-heading"><div><p className="eyebrow">Только исходный текст</p><h2>{view?.conversation.conversationId || 'Загрузка…'}</h2></div><span className="badge">{view?.case.language}</span></div><p className="provider">{view?.case.selectionReason}</p>{loading && <p role="status">Загружаем разговор…</p>}<div className="messages">{view?.conversation.messages.map(m => <article id={`quality-${m.id}`} tabIndex={-1} key={m.id} className={`message ${m.speaker} ${selected?.evidence.some(e => e.messageId === m.id) ? 'evidenced' : ''}`}><div><strong>{({ client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' })[m.speaker]}</strong><time>{m.timestamp}</time><span>#{m.position + 1}</span></div><p>{m.text}</p><button type="button" disabled={frozen || busy} aria-pressed={messageId === m.id} onClick={() => { setMessageId(m.id); setQuote(m.text); }}>{messageId === m.id ? 'Реплика выбрана' : 'Выбрать как доказательство'}</button></article>)}</div></section>
      <section className="quality-reference-form"><h2>Слепая разметка</h2><p className="provider">Модель: Gemini 3.1 Flash Lite. Версия чек-листа: {view?.checklist.version}. Статистика не заменяет предметную проверку консультации.</p>
        <label>Проверяющий<input aria-label="Проверяющий эталона" value={reviewerId} onChange={event => setReviewerId(event.target.value)} minLength={2} maxLength={128} placeholder="Ваше имя или локальный ID"/></label>
        {view?.referenceNumericScore && <p className="notice">Итог по проверенным взвешенным критериям: <strong>{view.referenceNumericScore.total === null ? 'Не рассчитывается' : `${view.referenceNumericScore.total.toFixed(2)} / 100`}</strong>. Итог модели: <strong>{view.modelEvaluation?.score?.total == null ? 'Ещё не доступен' : `${view.modelEvaluation.score.total.toFixed(2)} / 100`}</strong>. Независимые флаги сравниваются после отдельной разметки.</p>}
        <label>Критерий<select aria-label="Критерий эталона" value={criterionId} onChange={event => { setCriterionId(event.target.value); setMessageId(''); setQuote(''); }}>{view?.checklist.criteria.map(c => <option key={c.id} value={c.id}>{c.id} · {c.title}{draft.find(j => j.criterionId === c.id)?.resolved ? ' · проверен' : ''}</option>)}</select></label>
        {criterion && selected && <><h3>{criterion.title}</h3><p>{criterion.instructions}</p><p className="provider">{criterion.evidenceRequirement}</p>{criterion.naAllowed && <p><strong>N/A:</strong> {criterion.naCondition}</p>}{frozen && <p className="notice">Этот ответ уже подтверждён вслепую и сохранён. Дополните другие нерешённые пункты.</p>}
          <fieldset disabled={frozen || busy}><legend>Ваше решение</legend><label>Ответ<select aria-label="Ответ эталона" value={selected.answer ?? ''} onChange={event => patch({ answer: event.target.value || null, resolved: Boolean(event.target.value), explanation: selected.explanation === 'Не проверено человеком.' ? '' : selected.explanation })}><option value="">Не решено / нужна предметная проверка</option>{[...criterion.allowedValues, ...(criterion.naAllowed ? ['N/A'] : [])].map(a => <option key={a} value={a}>{answerLabel(a)}</option>)}</select></label><label>Обоснование<textarea aria-label="Обоснование эталона" rows={3} value={selected.explanation} onChange={event => patch({ explanation: event.target.value })}/></label>{selected.answer === 'N/A' && <label>Почему выполнено условие N/A<textarea aria-label="Причина N/A эталона" rows={2} value={selected.applicabilityRationale} onChange={event => patch({ applicabilityRationale: event.target.value })}/></label>}
          <label>Реплика<select aria-label="Источник доказательства эталона" value={messageId} onChange={event => { const m = view?.conversation.messages.find(m => m.id === event.target.value); setMessageId(m?.id || ''); setQuote(m?.text || ''); }}><option value="">Выберите исходную реплику</option>{view?.conversation.messages.map(m => <option key={m.id} value={m.id}>#{m.position + 1} · {m.speaker} · {m.timestamp}</option>)}</select></label><label>Точная цитата<textarea aria-label="Цитата эталона" rows={3} value={quote} onChange={event => setQuote(event.target.value)} placeholder="Полная реплика либо точная подстрока"/></label><button disabled={!messageId || !quote.trim()} onClick={() => { patch({ evidence: [...selected.evidence, { messageId, quote }] }); setMessageId(''); setQuote(''); }}>Добавить цитату</button>
          <p>Проверенный диапазон обязателен для Нет и частичного балла.</p><label>Начало<select aria-label="Начало диапазона эталона" value={selected.checkedRange?.startMessageId || ''} onChange={event => patch({ checkedRange: event.target.value ? { startMessageId: event.target.value, endMessageId: selected.checkedRange?.endMessageId || event.target.value } : null })}><option value="">Не задано</option>{view?.conversation.messages.map(m => <option key={m.id} value={m.id}>#{m.position + 1} · {m.speaker} · {m.timestamp}</option>)}</select></label><label>Конец<select aria-label="Конец диапазона эталона" value={selected.checkedRange?.endMessageId || ''} onChange={event => patch({ checkedRange: event.target.value ? { startMessageId: selected.checkedRange?.startMessageId || event.target.value, endMessageId: event.target.value } : null })}><option value="">Не задано</option>{view?.conversation.messages.map(m => <option key={m.id} value={m.id}>#{m.position + 1} · {m.speaker} · {m.timestamp}</option>)}</select></label><button onClick={() => view && patch({ checkedRange: { startMessageId: view.conversation.messages[0].id, endMessageId: view.conversation.messages.at(-1)!.id } })}>Я проверил весь диалог</button></fieldset>
          {selected.evidence.map((e, index) => <div key={index}><button className="evidence-link" onClick={() => jump(e.messageId)}>«{e.quote}» ↗</button>{!frozen && <button onClick={() => patch({ evidence: selected.evidence.filter((_, i) => i !== index) })}>Удалить цитату</button>}</div>)}
        </>}
        <p>Решено: {draft.filter(j => j.resolved).length} / {draft.length}. Остальные пункты сохранятся как нерешённые.</p>
        <label><input type="checkbox" checked={human} onChange={event => setHuman(event.target.checked)}/> Я человек и самостоятельно проверил отмеченные пункты. Это не агентная демонстрация.</label><label><input type="checkbox" checked={blind} onChange={event => setBlind(event.target.checked)}/> Для новых решений я не смотрел ответы оценивающей модели.</label>
        <button className="primary" disabled={busy || loading || !human || !blind || reviewerId.trim().length < 2 || !draft.some(j => j.resolved) || draft.some(j => j.resolved && !j.explanation.trim())} onClick={() => void save()}>{busy ? 'Сохраняется…' : 'Сохранить человеческую разметку'}</button>
        {modelResult && view?.modelEvaluation && <div className="reasoning"><h3>Сравнение после фиксации эталона</h3><p>Человек: <strong>{answerLabel(selected?.answer || null)}</strong> · Модель: <strong>{answerLabel(modelResult.answer)}</strong></p><p>{modelResult.explanation}</p>{modelResult.evidence.map((e, i) => <button className="evidence-link" key={i} onClick={() => jump(e.messageId)}>«{e.quote}» ↗</button>)}<label>Подтверждают ли доказательства вывод модели?<select aria-label="Смысловая поддержка доказательства" value={evidenceVerdict} onChange={event => setEvidenceVerdict(event.target.value)}><option value="supports">Подтверждают</option><option value="does_not_support">Не подтверждают</option><option value="unclear">Нужна дополнительная проверка</option></select></label><label>Категория разбора<select aria-label="Категория расхождения" value={evidenceCategory} onChange={event => setEvidenceCategory(event.target.value)}>{Object.entries({ role: 'Роль / действие бота', na: 'N/A', verification_timing: 'Порядок идентификации', consultation: 'Консультация / вопрос без ответа', empathy: 'Эмпатия', closing: 'Завершение', gross_violation: 'Грубое нарушение', evidence: 'Доказательство', language: 'Языковая ошибка', other: 'Другое' }).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label><label>Комментарий проверяющего<textarea aria-label="Комментарий к смысловой проверке" rows={3} value={evidenceComment} onChange={event => setEvidenceComment(event.target.value)}/></label><button disabled={busy || !human || !reviewerId.trim() || !evidenceComment.trim()} onClick={() => void saveEvidenceReview()}>Сохранить разбор доказательства</button></div>}
      </section>
    </div>
    <section className="quality-metrics"><h2>Метрики по человеческому эталону</h2>{!metrics || metrics.humanReviewedCases === 0 ? <p className="notice">BLOCKED: человеческих ответов пока нет. Согласие, ошибки N/A, ложные и пропущенные грубые нарушения не измерены. Технические успехи API не являются точностью.</p> : <p>Человеческих примеров: {metrics.humanReviewedCases}; решённых пунктов: {metrics.resolvedHumanJudgments}; сопоставленных диалогов: {metrics.comparedCases}. Нерешённых пунктов: {metrics.unresolvedHumanJudgments}.</p>}
      {metrics && <p>Срез: первый валидный сохранённый результат каждого примера; повторные прогоны его не заменяют. Покрытие: {metrics.resolvedHumanJudgments}/{metrics.coverage.expectedHumanJudgments} решений, {metrics.coverage.unannotatedJudgments} без решения, {metrics.coverage.casesWithoutReference} примеров без эталона. Чувствительность к грубым нарушениям: {percent(metrics.grossViolations.recall)}; положительных человеческих примеров: {metrics.grossViolations.referencePositives}. При отсутствии положительных примеров пропуски не измерены.</p>}
      {metrics && <><table><caption>Согласие по языкам</caption><thead><tr><th>Язык</th><th>Совпало / проверено</th><th>Согласие</th></tr></thead><tbody>{Object.entries(metrics.byLanguage).map(([language, item]) => <tr key={language}><td>{language}</td><td>{item.matches} / {item.total}</td><td>{percent(item.agreement)}</td></tr>)}</tbody></table><table><caption>Согласие по критериям</caption><thead><tr><th>Критерий</th><th>Совпало / проверено</th><th>Согласие</th></tr></thead><tbody>{Object.entries(metrics.byCriterion).map(([id, item]) => <tr key={id}><td>{id}</td><td>{item.matches} / {item.total}</td><td>{percent(item.agreement)}</td></tr>)}</tbody></table><p>Ошибки N/A: {metrics.na.available ? `ложные ${metrics.na.falseNA}, пропущенные ${metrics.na.missedNA}` : 'Нет человеческого эталона'}.</p><p>Грубые нарушения: {metrics.grossViolations.available ? `ложные флаги ${metrics.grossViolations.falsePositive}, пропуски ${metrics.grossViolations.falseNegative}` : 'Нет человеческого эталона'}.</p><p>Ошибка итогового балла: MAE {metrics.totalScoreError.meanAbsoluteError?.toFixed(2) ?? 'не измерено'}, максимум {metrics.totalScoreError.maxAbsoluteError?.toFixed(2) ?? 'не измерено'}; диалогов со всеми проверенными взвешенными критериями {metrics.totalScoreError.dialogs}.</p><p>Техническая валидность ответов: {percent(metrics.evidence.evaluationValidity)}; точных цитат {metrics.evidence.quotesValid}/{metrics.evidence.quotesChecked}. Смысловая поддержка человеком: {metrics.evidence.humanSemantic.available ? `${metrics.evidence.humanSemantic.supported} подтверждают, ${metrics.evidence.humanSemantic.unsupported} не подтверждают, ${metrics.evidence.humanSemantic.unresolved} спорные` : 'не проверена'}.</p><p>Попыток API {metrics.reliability.attempts}; успехов {metrics.reliability.successes}; ошибок {metrics.reliability.failures}. Медиана {metrics.reliability.latencyMs.median === null ? '—' : `${(metrics.reliability.latencyMs.median / 1000).toFixed(1)}с`}; p95 {metrics.reliability.latencyMs.p95 === null ? '—' : `${(metrics.reliability.latencyMs.p95 / 1000).toFixed(1)}с`}. Reported tokens {metrics.reliability.reportedTokens}; неизвестный usage у {metrics.reliability.unknownTokenUsageAttempts} попыток.</p>{Object.entries(metrics.reliability.errors).map(([code, count]) => <p key={code}>{code}: {count}</p>)}<h3>Содержательные расхождения · {metrics.materialDisagreements.length}</h3>{metrics.materialDisagreements.length ? <table><thead><tr><th>Пример</th><th>Критерий</th><th>Человек</th><th>Модель</th><th>Категория</th></tr></thead><tbody>{metrics.materialDisagreements.map((d, i) => <tr key={i}><td><button onClick={() => { requestedCriterion.current = d.criterionId; setCaseId(d.caseId); setCriterionId(d.criterionId); }}>{d.caseId} · {d.language}</button></td><td>{d.criterionId}</td><td>{answerLabel(d.expected)}</td><td>{answerLabel(d.actual)}</td><td>{d.category}</td></tr>)}</tbody></table> : <p>Без сопоставленных человеческих решений отсутствие записей не означает отсутствие ошибок модели.</p>}</>}
      {metrics && <table><caption>Рабочие и отложенные примеры</caption><thead><tr><th>Разбиение</th><th>Совпало / проверено</th><th>Согласие</th></tr></thead><tbody>{Object.entries(metrics.bySplit).map(([name, value]) => <tr key={name}><td>{name === 'development' ? 'Рабочие' : 'Отложенные'}</td><td>{value.matches} / {value.total}</td><td>{percent(value.agreement)}</td></tr>)}</tbody></table>}
    </section>
  </section>;
}
