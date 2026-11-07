import assert from 'node:assert/strict';
import test from 'node:test';
import { initialChecklist, validateChecklist } from '../src/checklist.js';
import { calculateScore } from '../src/scoring.js';
import type { Checklist, Criterion } from '../src/domain.js';

function answers(values: string[]) { return values.map((answer, i) => ({ criterionId: `C${i + 1}`, answer })); }
function customCriterion(overrides: Partial<Criterion> = {}): Criterion {
  return {
    id: 'custom', title: 'Custom', instructions: 'Check the configured condition.', weight: 1,
    answerType: 'numeric', allowedValues: ['0', '1', '3'], scaleMax: 3, naAllowed: true,
    naCondition: 'The relevant context is absent.', section: 'Custom', evidenceRequirement: 'Reference the source.', flag: false,
    ...overrides,
  };
}
function custom(criteria: Criterion[]): Checklist { return { id: 'test', version: 'v1', title: 'Test', criteria }; }

test('official version matches eight criteria, titles, weights, scales, applicability and independent flag', () => {
  assert.equal(initialChecklist.criteria.length, 8);
  assert.deepEqual(initialChecklist.criteria.map(c => c.title), [
    'Установление контакта', 'Выявление потребности', 'Идентификация', 'Корректная и полная консультация',
    'Эмпатия и клиентоориентированность', 'Управление диалогом, скорость и грамотность', 'Завершение', 'Грубые ошибки',
  ]);
  assert.deepEqual(initialChecklist.criteria.map(c => c.weight), [10, 15, 20, 20, 15, 15, 5, 0]);
  assert.equal(initialChecklist.criteria.reduce((sum, c) => sum + c.weight, 0), 100);
  assert.deepEqual(initialChecklist.criteria[3].allowedValues, ['0', '5', '10', '15', '20']);
  assert.deepEqual(initialChecklist.criteria[5].allowedValues, ['0', '4', '7', '10']);
  assert.deepEqual(initialChecklist.criteria.map(c => c.naAllowed), [false, true, true, true, false, false, true, false]);
  assert.equal(initialChecklist.criteria[7].flag, true);
  assert.ok(Object.isFrozen(initialChecklist));
  assert.ok(Object.isFrozen(initialChecklist.criteria[0]));
});

const officialCases = [
  { name: 'all full', values: ['YES', 'YES', 'YES', '20', 'YES', '10', 'YES', 'NO'], total: 100, weight: 100, raw: 100 },
  { name: 'all zero', values: ['NO', 'NO', 'NO', '0', 'NO', '0', 'NO', 'NO'], total: 0, weight: 100, raw: 0 },
  { name: 'gross flag leaves perfect score', values: ['YES', 'YES', 'YES', '20', 'YES', '10', 'YES', 'YES'], total: 100, weight: 100, raw: 100 },
  { name: 'mixed scales', values: ['YES', 'NO', 'YES', '15', 'YES', '7', 'NO', 'NO'], total: 70.5, weight: 100, raw: 70.5 },
  { name: 'one N/A', values: ['YES', 'YES', 'N/A', '10', 'YES', '4', 'NO', 'NO'], total: 70, weight: 80, raw: 56 },
  { name: 'two N/A exact fraction rounded at total', values: ['YES', 'N/A', 'N/A', '15', 'YES', '7', 'NO', 'NO'], total: 77.69, weight: 65, raw: 50.5 },
  { name: 'all eligible N/A', values: ['YES', 'N/A', 'N/A', 'N/A', 'YES', '10', 'N/A', 'NO'], total: 100, weight: 40, raw: 40 },
];
for (const sample of officialCases) {
  test(`official scoring: ${sample.name}`, () => {
    const score = calculateScore(initialChecklist, answers(sample.values));
    assert.equal(score.total, sample.total);
    assert.equal(score.applicableWeight, sample.weight);
    assert.equal(score.rawPoints, sample.raw);
    assert.equal(score.flags.C8, sample.values[7] === 'YES');
    assert.equal(score.rows.length, 8);
    assert.equal(score.rows[7].contribution, 0);
  });
}

test('numeric maximum gives full configured weight, including arbitrary decimal scales', () => {
  const checklist = custom([customCriterion({ allowedValues: ['0', '0.25', '0.75'], scaleMax: 0.75, weight: 7.5 })]);
  const score = calculateScore(checklist, [{ criterionId: 'custom', answer: '0.25' }]);
  assert.equal(score.total, 33.33);
  assert.equal(score.rows[0].contribution, 2.5);
  assert.equal(score.rows[0].normalizedContribution, 100 / 3);
  assert.equal(calculateScore(checklist, [{ criterionId: 'custom', answer: '0.75' }]).total, 100);
});

test('no intermediate rounding and exact positive half-cent rounding', () => {
  const checklist = custom([customCriterion({ allowedValues: ['0', '0.01005', '1'], scaleMax: 1 })]);
  assert.equal(calculateScore(checklist, [{ criterionId: 'custom', answer: '0.01005' }]).total, 1.01);
  const thirds = custom([customCriterion({ id: 'a' }), customCriterion({ id: 'b' }), customCriterion({ id: 'c' })]);
  assert.equal(calculateScore(thirds, ['a', 'b', 'c'].map(criterionId => ({ criterionId, answer: '1' }))).total, 33.33);
});

test('large rational denominators still produce finite display values', () => {
  const checklist = custom(Array.from({ length: 100 }, (_, i) => customCriterion({
    id: `c${i}`, allowedValues: ['0', '1', String(900_000_001 + 2 * i)], scaleMax: 900_000_001 + 2 * i,
  })));
  const score = calculateScore(checklist, checklist.criteria.map(c => ({ criterionId: c.id, answer: '1' })));
  assert.equal(score.total, 0);
  assert.ok(Number.isFinite(score.rawPoints));
  assert.ok(score.rawPoints > 0);
  assert.ok(Number.isFinite(score.sections.Custom.rawPoints));
});

test('all N/A and zero applicable weights produce unavailable totals, not zero', () => {
  const na = calculateScore(custom([customCriterion()]), [{ criterionId: 'custom', answer: 'N/A' }]);
  assert.equal(na.total, null);
  assert.equal(na.sections.Custom.total, null);
  assert.equal(na.rows[0].contribution, null);
  const zeroWeight = calculateScore(custom([customCriterion({ weight: 0 })]), [{ criterionId: 'custom', answer: '3' }]);
  assert.equal(zeroWeight.total, null);
  assert.equal(zeroWeight.rows[0].normalizedContribution, null);
});

test('section totals use their own applicable denominators and sum raw scores consistently', () => {
  const score = calculateScore(initialChecklist, answers(['YES', 'N/A', 'N/A', '15', 'YES', '7', 'NO', 'NO']));
  assert.equal(score.sections['Начало и понимание запроса'].total, 100);
  assert.equal(score.sections['Безопасность и решение'].total, 75);
  assert.equal(score.sections['Ведение и завершение диалога'].total, 72.86);
  assert.equal(Object.values(score.sections).reduce((sum, section) => sum + section.rawPoints, 0), score.rawPoints);
  assert.equal(Object.values(score.sections).reduce((sum, section) => sum + section.applicableWeight, 0), score.applicableWeight);
  assert.equal(score.sections['Грубые нарушения'], undefined);
});

test('configured sections and IDs cannot pollute object prototypes', () => {
  const checklist = custom([customCriterion({ id: 'safe', section: '__proto__' })]);
  const score = calculateScore(checklist, [{ criterionId: 'safe', answer: '1' }]);
  assert.equal(Object.getPrototypeOf(score.sections), null);
  assert.equal(score.sections.__proto__.total, 33.33);
});

test('score computation does not mutate configuration or original answers', () => {
  const checklist = structuredClone(initialChecklist);
  const result = answers(['YES', 'YES', 'YES', '20', 'YES', '10', 'YES', 'NO']);
  const original = JSON.stringify({ checklist, result });
  calculateScore(checklist, result);
  assert.equal(JSON.stringify({ checklist, result }), original);
  const revised = result.map(r => r.criterionId === 'C1' ? { ...r, answer: 'NO' } : r);
  assert.equal(calculateScore(checklist, revised).total, 90);
  assert.equal(calculateScore(checklist, result).total, 100);
});

test('validation creates an independent snapshot of the editable configuration', () => {
  const input = structuredClone(initialChecklist);
  const snapshot = validateChecklist(input);
  input.criteria[0].title = 'Changed';
  input.criteria[0].allowedValues.push('INVALID');
  assert.equal(snapshot.criteria[0].title, 'Установление контакта');
  assert.deepEqual(snapshot.criteria[0].allowedValues, ['YES', 'NO']);
});

const invalidAnswers = [
  ['NO', 'NO', 'NO', '13', 'NO', '0', 'NO', 'NO'],
  ['NO', 'NO', 'NO', '0', 'NO', '5', 'NO', 'NO'],
  ['N/A', 'NO', 'NO', '0', 'NO', '0', 'NO', 'NO'],
  ['NO', 'NO', 'NO', '0', 'N/A', '0', 'NO', 'NO'],
  ['NO', 'NO', 'NO', '0', 'NO', 'N/A', 'NO', 'NO'],
  ['NO', 'NO', 'NO', '0', 'NO', '0', 'NO', 'N/A'],
  ['yes', 'NO', 'NO', '0', 'NO', '0', 'NO', 'NO'],
];
for (const [i, values] of invalidAnswers.entries()) {
  test(`reject invalid answer selection ${i}`, () => assert.throws(() => calculateScore(initialChecklist, answers(values))));
}
test('reject missing, duplicate and unknown criterion result IDs', () => {
  const result = answers(officialCases[0].values);
  assert.throws(() => calculateScore(initialChecklist, result.slice(1)));
  assert.throws(() => calculateScore(initialChecklist, [...result.slice(1), result[1]]));
  assert.throws(() => calculateScore(initialChecklist, [{ criterionId: 'unknown', answer: 'YES' }, ...result.slice(1)]));
});

const invalidConfigs: Partial<Criterion>[] = [
  { weight: -1 }, { weight: Infinity }, { scaleMax: 0 }, { scaleMax: NaN },
  { allowedValues: ['0', '2'], scaleMax: 3 }, { allowedValues: ['1', '3'] },
  { allowedValues: ['0', '3', '4'] }, { allowedValues: ['0', '3', '3'] },
  { allowedValues: ['0', '3', 'N/A'] }, { allowedValues: ['0', '3', '0.0'] },
  { allowedValues: ['0', '3', 'bad'] }, { naCondition: '' },
  { naAllowed: false, naCondition: 'Not allowed' },
  { flag: true, weight: 1 }, { flag: true, weight: 0 },
  { answerType: 'boolean', allowedValues: ['YES', 'NO'], scaleMax: 3 },
  { answerType: 'boolean', allowedValues: ['YES', 'MAYBE'], scaleMax: 1 },
];
for (const [i, overrides] of invalidConfigs.entries()) {
  test(`reject invalid criterion configuration ${i}`, () => assert.throws(() => validateChecklist(custom([customCriterion(overrides)]))));
}
test('reject duplicate criteria and empty checklist', () => {
  assert.throws(() => validateChecklist(custom([customCriterion(), customCriterion()])));
  assert.throws(() => validateChecklist(custom([])));
});
