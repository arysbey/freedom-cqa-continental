import test from 'node:test';
import assert from 'node:assert/strict';
import type { Checklist, Conversation, CriterionResult } from '../src/domain.js';
import { evaluationJsonSchema, validateEvidence } from '../server/evidence.js';

const conversation: Conversation = {
  version: 'synthetic-v1', groupId: 'TEST', conversationId: 'invented', channel: 'chat', language: 'KZ', classification: 'synthetic_allowed', audioAvailable: false,
  messages: [
    { id: 'v1:0', position: 0, timestamp: '00:00', speaker: 'bot', text: 'Сәлеметсіз бе!' },
    { id: 'v1:1', position: 1, timestamp: '00:00', speaker: 'operator', text: 'Сәлеметсіз бе! Менің атым Айдана.' },
    { id: 'v1:2', position: 2, timestamp: '00:01', speaker: 'client', text: 'Рақмет.' },
  ],
};
const checklist: Checklist = { id: 'test', version: 'one', title: 'Test', criteria: [{ id: 'NEW', title: 'Greeting', instructions: 'Human greeting', weight: 10, answerType: 'boolean', allowedValues: ['YES', 'NO'], scaleMax: 1, naAllowed: false, naCondition: '', section: 'Test', evidenceRequirement: 'exact source', flag: false }] };
function result(changes: Partial<CriterionResult> = {}): CriterionResult {
  return { criterionId: 'NEW', answer: 'YES', applicabilityRationale: 'Применимо.', explanation: 'Оператор поздоровался.', evidence: [{ messageId: 'v1:1', quote: 'Сәлеметсіз бе!' }], checkedRange: null, reviewRequired: false, uncertainty: '', ...changes };
}
const inspect = (item: CriterionResult, rubric = checklist) => validateEvidence(conversation, rubric, { results: [item] });
const range = { startMessageId: 'v1:0', endMessageId: 'v1:2' };

test('exact Kazakh evidence remains unchanged despite duplicate timestamps', () => { assert.deepEqual(inspect(result()), [result()]); });
test('rejects foreign conversation message IDs', () => { assert.throws(() => inspect(result({ evidence: [{ messageId: 'v2:1', quote: 'Сәлеметсіз бе!' }] })), /quotation/); });
test('rejects fabricated and paraphrased quotations', () => { assert.throws(() => inspect(result({ evidence: [{ messageId: 'v1:1', quote: 'Hello!' }] })), /quotation/); });
test('rejects whitespace-only quotations without altering authentic quote text', () => {
  assert.throws(() => inspect(result({ evidence: [{ messageId: 'v1:1', quote: ' ' }] })), /schema/);
  const quote = ' Менің атым Айдана.';
  assert.equal(inspect(result({ evidence: [{ messageId: 'v1:1', quote }] }))[0].evidence[0].quote, quote);
});
test('rejects unknown criteria, duplicate criteria, and missing criteria', () => {
  assert.throws(() => inspect(result({ criterionId: 'UNKNOWN' })), /criterion/);
  assert.throws(() => validateEvidence(conversation, checklist, { results: [] }), /count/);
  assert.throws(() => validateEvidence(conversation, { ...checklist, criteria: [...checklist.criteria, { ...checklist.criteria[0], id: 'OTHER' }] }, { results: [result(), result()] }), /duplicated/);
});
test('rejects answer outside saved scale', () => { assert.throws(() => inspect(result({ answer: 'MAYBE' })), /scale/); });
test('forbidden N/A is rejected', () => { assert.throws(() => inspect(result({ answer: 'N/A', checkedRange: range })), /scale/); });
test('permitted N/A requires condition, rationale, and exact evidence or a checked range', () => {
  const rubric = { ...checklist, criteria: [{ ...checklist.criteria[0], naAllowed: true, naCondition: 'No opportunity.' }] };
  assert.equal(inspect(result({ answer: 'N/A', evidence: [], checkedRange: range }), rubric)[0].answer, 'N/A');
  assert.equal(inspect(result({ answer: 'N/A' }), rubric)[0].answer, 'N/A');
  assert.throws(() => inspect(result({ answer: 'N/A', evidence: [], checkedRange: null }), rubric), /no source evidence/);
  assert.throws(() => inspect(result({ answer: 'N/A', applicabilityRationale: ' ', checkedRange: range }), rubric), /rationale/);
  assert.throws(() => inspect(result({ answer: 'N/A', checkedRange: range }), { ...rubric, criteria: [{ ...rubric.criteria[0], naCondition: '' }] }), /condition/);
});
test('applicable YES and NO may omit applicability rationale while N/A must explain its condition', () => {
  assert.equal(inspect(result({ applicabilityRationale: '' }))[0].applicabilityRationale, '');
  assert.equal(inspect(result({ answer: 'NO', applicabilityRationale: '', evidence: [], checkedRange: range }))[0].answer, 'NO');
  const rubric = { ...checklist, criteria: [{ ...checklist.criteria[0], naAllowed: true, naCondition: 'No opportunity.' }] };
  for (const applicabilityRationale of ['', '   ']) assert.throws(() => inspect(result({ answer: 'N/A', applicabilityRationale, checkedRange: range }), rubric), /rationale/);
});
test('missing actions and partial numeric answers require checked source ranges', () => {
  assert.throws(() => inspect(result({ answer: 'NO', evidence: [] })), /checked range/);
  assert.equal(inspect(result({ answer: 'NO', evidence: [], checkedRange: range }))[0].answer, 'NO');
  const numeric: Checklist = { ...checklist, criteria: [{ ...checklist.criteria[0], answerType: 'numeric', scaleMax: 10, allowedValues: ['0', '4', '7', '10'] }] };
  assert.throws(() => inspect(result({ answer: '7' }), numeric), /checked range/);
  assert.equal(inspect(result({ answer: '7', checkedRange: range }), numeric)[0].answer, '7');
});
test('range endpoints must exist and preserve source order', () => {
  assert.throws(() => inspect(result({ answer: 'NO', checkedRange: { startMessageId: 'v1:2', endMessageId: 'v1:0' } })), /range/);
  assert.throws(() => inspect(result({ answer: 'NO', checkedRange: { startMessageId: 'v1:0', endMessageId: 'foreign' } })), /range/);
});
test('positive assessment needs direct source quotation', () => { assert.throws(() => inspect(result({ evidence: [], checkedRange: range })), /positive/); });
test('flag assertion needs human operator evidence', () => {
  const flagged = { ...checklist, criteria: [{ ...checklist.criteria[0], flag: true, weight: 0 }] };
  assert.throws(() => inspect(result({ evidence: [{ messageId: 'v1:0', quote: 'Сәлеметсіз бе!' }] }), flagged), /operator/);
  assert.equal(inspect(result(), flagged)[0].answer, 'YES');
});
test('review uncertainty must be explicit', () => { assert.throws(() => inspect(result({ reviewRequired: true })), /uncertainty/); });
test('rejects unknown output properties and non-string answers', () => {
  assert.throws(() => validateEvidence(conversation, checklist, { results: [result()], total: 100 }), /schema/);
  assert.throws(() => validateEvidence(conversation, checklist, { results: [{ ...result(), answer: 1 }] }), /schema/);
});
test('dynamic JSON schema contains newly added criterion and permitted N/A', () => {
  const schema = JSON.stringify(evaluationJsonSchema({ ...checklist, criteria: [{ ...checklist.criteria[0], id: 'NEW_SEMANTIC_RULE', allowedValues: ['0', '3', '9'], naAllowed: true }] }));
  assert.match(schema, /NEW_SEMANTIC_RULE/);
  assert.match(schema, /N\/A/);
  assert.match(schema, /"9"/);
});

test('output JSON schema constrains references to this conversation message IDs', () => {
  const schema = JSON.stringify(evaluationJsonSchema(checklist, ['v1:0', 'v1:1', 'v1:2']));
  assert.equal((schema.match(/"enum":\["v1:0","v1:1","v1:2"\]/g) ?? []).length, 3);
});
