import { useEffect, useRef, useState, type FormEvent } from 'react';
import { validateChecklist } from './checklist.js';
import type { Checklist, Criterion } from './domain.js';

interface ChecklistEditorProps {
  checklists: Checklist[];
  selectedVersion: string;
  onSaved: (checklist: Checklist) => void;
  onError?: (message: string) => void;
}
type DraftCriterion = Omit<Criterion, 'weight' | 'scaleMax' | 'allowedValues'> & {
  localKey: string;
  weightText: string;
  scaleMaxText: string;
  valuesText: string;
};
interface DraftChecklist { id: string; title: string; criteria: DraftCriterion[] }

function editableCriterion(criterion: Criterion): DraftCriterion {
  const { weight, scaleMax, allowedValues, ...fields } = criterion;
  return { ...fields, localKey: crypto.randomUUID(), weightText: String(weight), scaleMaxText: String(scaleMax), valuesText: allowedValues.join(', ') };
}
function editableChecklist(checklist: Checklist): DraftChecklist {
  return { id: checklist.id, title: checklist.title, criteria: checklist.criteria.map(editableCriterion) };
}
function emptyCriterion(): DraftCriterion {
  return editableCriterion({ id: `criterion-${crypto.randomUUID()}`, title: '', instructions: '', weight: 10, answerType: 'boolean', allowedValues: ['YES', 'NO'], scaleMax: 1, naAllowed: false, naCondition: '', section: 'Основная оценка', evidenceRequirement: 'Точная цитата и ID исходной реплики; для отсутствующего действия — проверенный диапазон.', flag: false });
}
function snapshot(draft: DraftChecklist): Checklist {
  if (!draft.title.trim()) throw new Error('Укажите название чек-листа.');
  if (!draft.criteria.length) throw new Error('Добавьте хотя бы один критерий.');
  const criteria = draft.criteria.map((item, index): Criterion => {
    const { localKey: _localKey, weightText, scaleMaxText, valuesText, ...criterion } = item;
    void _localKey;
    const prefix = `Критерий ${index + 1}`;
    if (!criterion.title.trim()) throw new Error(`${prefix}: укажите название.`);
    if (!criterion.instructions.trim()) throw new Error(`${prefix}: опишите правила оценки.`);
    if (!criterion.section.trim()) throw new Error(`${prefix}: укажите раздел.`);
    if (!criterion.evidenceRequirement.trim()) throw new Error(`${prefix}: опишите необходимые доказательства.`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(criterion.id)) throw new Error(`${prefix}: ID должен содержать латинские буквы, цифры, точку, дефис, двоеточие или подчёркивание.`);
    if (!weightText.trim() || !Number.isFinite(Number(weightText)) || Number(weightText) < 0 || Number(weightText) > 1_000_000_000) throw new Error(`${prefix}: вес должен быть числом от 0 до 1 000 000 000.`);
    const weight = Number(weightText);
    const scaleMax = Number(scaleMaxText);
    if (!scaleMaxText.trim() || !Number.isFinite(scaleMax) || scaleMax <= 0 || scaleMax > 1_000_000_000) throw new Error(`${prefix}: укажите положительный максимум шкалы.`);
    const allowedValues = criterion.answerType === 'boolean' ? ['YES', 'NO'] : valuesText.split(',').map(value => value.trim());
    if (criterion.answerType === 'numeric') {
      const values = allowedValues.map(Number);
      if (allowedValues.length < 2 || allowedValues.length > 100 || !allowedValues.every(value => /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) || values.some(value => !Number.isFinite(value) || value > scaleMax)) throw new Error(`${prefix}: введите от 2 до 100 неотрицательных значений через запятую в пределах максимума. Для дробей используйте точку.`);
      if (new Set(values).size !== values.length) throw new Error(`${prefix}: значения шкалы должны различаться.`);
      if (!values.includes(0) || !values.includes(scaleMax)) throw new Error(`${prefix}: шкала должна включать 0 и свой максимум.`);
    }
    if (criterion.naAllowed && !criterion.naCondition.trim()) throw new Error(`${prefix}: укажите точное условие допустимости N/A.`);
    return { ...criterion, title: criterion.title.trim(), instructions: criterion.instructions.trim(), section: criterion.section.trim(), evidenceRequirement: criterion.evidenceRequirement.trim(), naCondition: criterion.naAllowed ? criterion.naCondition.trim() : '', weight, scaleMax: criterion.answerType === 'boolean' ? 1 : scaleMax, allowedValues };
  });
  if (new Set(criteria.map(criterion => criterion.id)).size !== criteria.length) throw new Error('ID каждого критерия должен быть уникальным.');
  // Shared client validation provides fast feedback. The server independently validates this snapshot.
  return validateChecklist({ id: draft.id, version: `custom-${crypto.randomUUID()}`, title: draft.title.trim(), criteria });
}

export function ChecklistEditor({ checklists, selectedVersion, onSaved, onError }: ChecklistEditorProps) {
  const initial = checklists.find(checklist => checklist.version === selectedVersion) ?? checklists[0];
  const [draft, setDraft] = useState<DraftChecklist | undefined>(() => initial && editableChecklist(initial));
  const [baseVersion, setBaseVersion] = useState(initial?.version ?? '');
  const [activeKey, setActiveKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedVersion, setSavedVersion] = useState('');
  const externalVersion = useRef(initial?.version ?? '');

  useEffect(() => {
    const source = checklists.find(checklist => checklist.version === selectedVersion);
    if (!source || source.version === externalVersion.current) return;
    externalVersion.current = source.version;
    const next = editableChecklist(source);
    setDraft(next); setBaseVersion(source.version); setActiveKey(next.criteria[0]?.localKey ?? ''); setError('');
  }, [selectedVersion, checklists]);

  const active = draft?.criteria.find(criterion => criterion.localKey === activeKey) ?? draft?.criteria[0];
  const totalWeight = draft?.criteria.reduce((total, criterion) => total + (criterion.flag ? 0 : Number(criterion.weightText) || 0), 0) ?? 0;
  function patch(changes: Partial<DraftCriterion>) {
    if (!active) return;
    setDraft(current => current && ({ ...current, criteria: current.criteria.map(criterion => criterion.localKey === active.localKey ? { ...criterion, ...changes } : criterion) }));
    setSavedVersion('');
  }
  function loadSource(version: string) {
    const source = checklists.find(checklist => checklist.version === version);
    if (!source) return;
    const next = editableChecklist(source);
    setDraft(next); setBaseVersion(version); setActiveKey(next.criteria[0]?.localKey ?? ''); setError(''); setSavedVersion('');
  }
  function addCriterion() {
    const added = emptyCriterion();
    setDraft(current => current && ({ ...current, criteria: [...current.criteria, added] }));
    setActiveKey(added.localKey); setSavedVersion('');
  }
  function removeCriterion() {
    if (!draft || !active || draft.criteria.length === 1) return;
    const remaining = draft.criteria.filter(criterion => criterion.localKey !== active.localKey);
    setDraft({ ...draft, criteria: remaining }); setActiveKey(remaining[0].localKey); setSavedVersion('');
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || busy) return;
    setBusy(true); setError(''); setSavedVersion('');
    try {
      const candidate = snapshot(draft);
      const response = await fetch('/api/checklists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(candidate) });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error('Сервер отклонил конфигурацию. Проверьте поля и повторите сохранение.');
      const saved = validateChecklist(body);
      setSavedVersion(saved.version);
      setBaseVersion(saved.version);
      onSaved(saved);
    } catch (cause) {
      const message = cause instanceof TypeError || cause instanceof SyntaxError
        ? 'Не удалось получить корректный ответ сервера. Проверьте подключение и повторите сохранение.'
        : cause instanceof Error && cause.name !== 'ZodError' ? cause.message : 'Конфигурация не прошла проверку. Проверьте длину полей, шкалы и условия N/A.';
      setError(message); onError?.(message);
    } finally { setBusy(false); }
  }

  return <main className="editor">
    <p className="eyebrow">Версии чек-листа</p>
    <h1>Конфигурация оценки</h1>
    <p>Редактируйте копию выбранной версии. Сохранение создаёт новую неизменяемую версию; прежние оценки сохраняют свои правила.</p>
    <label>Основа для изменений
      <select aria-label="Основа чек-листа" value={baseVersion} disabled={busy || !checklists.length} onChange={event => loadSource(event.target.value)}>
        {!checklists.length && <option value="">Нет сохранённых чек-листов</option>}
        {!!checklists.length && !baseVersion && <option value="">Новый отдельный чек-лист</option>}
        {checklists.map(checklist => <option key={checklist.version} value={checklist.version}>{checklist.title} · {checklist.version}</option>)}
      </select>
    </label>
    <p className="provider">Переключение основы заменяет несохранённый черновик.</p>
    <button type="button" disabled={busy} onClick={() => {
      const added = emptyCriterion();
      setDraft({ id: `checklist-${crypto.randomUUID()}`, title: 'Новый чек-лист', criteria: [added] });
      setBaseVersion(''); setActiveKey(added.localKey); setError(''); setSavedVersion('');
    }}>Создать отдельный чек-лист</button>
    {!draft ? <p>Выберите основу или создайте новый чек-лист.</p> : <form onSubmit={event => void save(event)}>
      <fieldset disabled={busy}>
        <legend>Чек-лист</legend>
        <label>Название чек-листа<input aria-label="Название чек-листа" value={draft.title} maxLength={20000} required onChange={event => { setDraft({ ...draft, title: event.target.value }); setSavedVersion(''); }} /></label>
        <p className="provider">Критериев: {draft.criteria.length} · Сумма весов: {totalWeight}. Веса применимых критериев нормализуются до 100 баллов. Независимые флаги в сумму не входят.</p>
        <label>Редактируемый критерий
          <select aria-label="Редактируемый критерий" value={active?.localKey ?? ''} onChange={event => setActiveKey(event.target.value)}>
            {draft.criteria.map((criterion, index) => <option key={criterion.localKey} value={criterion.localKey}>{index + 1}. {criterion.title || 'Новый критерий'} · {criterion.id}</option>)}
          </select>
        </label>
        <div><button type="button" disabled={draft.criteria.length >= 100} onClick={addCriterion}>Добавить критерий</button>{' '}<button type="button" disabled={draft.criteria.length <= 1} onClick={removeCriterion}>Удалить выбранный критерий</button></div>
        {active && <fieldset>
          <legend>{active.title || 'Новый критерий'}</legend>
          <label>ID критерия<input aria-label="ID критерия" value={active.id} required maxLength={128} pattern="[a-zA-Z0-9][a-zA-Z0-9_.:\-]{0,127}" onChange={event => patch({ id: event.target.value })} /></label>
          <label>Название<input aria-label="Название критерия" value={active.title} required maxLength={20000} onChange={event => patch({ title: event.target.value })} /></label>
          <label>Правила оценки<textarea aria-label="Правила оценки" rows={5} value={active.instructions} required maxLength={20000} onChange={event => patch({ instructions: event.target.value })} /></label>
          <label><input type="checkbox" checked={active.flag} onChange={event => patch(event.target.checked ? { flag: true, weightText: '0', answerType: 'boolean', scaleMaxText: '1', valuesText: 'YES, NO', naAllowed: false, naCondition: '' } : { flag: false })} /> Независимый флаг без веса</label>
          <label>Вес<input aria-label="Вес критерия" type="number" min="0" max="1000000000" step="any" value={active.weightText} disabled={active.flag} required onChange={event => patch({ weightText: event.target.value })} /></label>
          <label>Тип ответа<select aria-label="Тип ответа" value={active.answerType} disabled={active.flag} onChange={event => patch(event.target.value === 'numeric' ? { answerType: 'numeric', valuesText: '0, 5, 10', scaleMaxText: '10' } : { answerType: 'boolean', valuesText: 'YES, NO', scaleMaxText: '1' })}><option value="boolean">Да / Нет</option><option value="numeric">Числовая шкала</option></select></label>
          {active.answerType === 'numeric' ? <>
            <label>Допустимые значения через запятую<input aria-label="Значения шкалы" value={active.valuesText} required onChange={event => patch({ valuesText: event.target.value })} /></label>
            <label>Максимум шкалы<input aria-label="Максимум шкалы" type="number" min="0.000000001" max="1000000000" step="any" value={active.scaleMaxText} required onChange={event => patch({ scaleMaxText: event.target.value })} /></label>
            <p className="provider">Включите 0 и максимум. Дробные значения записывайте через точку: 0, 0.5, 1. Меняя тип ответа, вы сбрасываете текущую шкалу.</p>
          </> : <p className="provider">Да даёт полный вес, Нет — 0. Для независимого флага ответ хранится отдельно от числового итога.</p>}
          <label><input type="checkbox" checked={active.naAllowed} disabled={active.flag} onChange={event => patch({ naAllowed: event.target.checked, naCondition: event.target.checked ? active.naCondition : '' })} /> Разрешить N/A</label>
          {active.naAllowed && <label>Точное условие допустимости N/A<textarea aria-label="Условие N/A" value={active.naCondition} required rows={3} maxLength={20000} onChange={event => patch({ naCondition: event.target.value })} /></label>}
          <label>Раздел<input aria-label="Раздел критерия" value={active.section} required maxLength={20000} onChange={event => patch({ section: event.target.value })} /></label>
          <label>Требования к доказательствам<textarea aria-label="Требования к доказательствам" value={active.evidenceRequirement} required rows={3} maxLength={20000} onChange={event => patch({ evidenceRequirement: event.target.value })} /></label>
        </fieldset>}
        <p>При следующем запуске оценки модель получит правила сохранённой версии. Сохранение чек-листа само по себе не запускает AI-запрос.</p>
        <button type="submit" className="primary">{busy ? 'Сохраняется…' : 'Сохранить новую версию'}</button>
      </fieldset>
    </form>}
    {error && <p role="alert" className="error">{error}</p>}
    {savedVersion && <p role="status" className="notice">Новая версия сохранена: <code>{savedVersion}</code>. Она доступна для следующей оценки.</p>}
  </main>;
}
