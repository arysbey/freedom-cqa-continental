import assert from 'node:assert/strict';
import test from 'node:test';
import { initialChecklist } from '../src/checklist.js';
import type { Conversation, CriterionResult } from '../src/domain.js';
import { validateGeneratedOperatorEvidence } from '../server/operator-evidence.js';

const source = { messages: [{ id: 'c', speaker: 'client' }, { id: 'b', speaker: 'bot' }, { id: 'o', speaker: 'operator' }] } as Conversation;
const result = (criterionId: string, answer: string, ids: string[]) => ({ criterionId, answer, evidence: ids.map(messageId => ({ messageId, quote: 'software fixture' })) }) as CriterionResult;
test('canonical discovery/closing YES require actual operator evidence without assigning another answer', () => {
  for (const id of ['C2', 'C7']) {
    for (const refs of [[], ['c'], ['b'], ['c', 'b']]) {
      const rows = [result(id, 'YES', refs)], before = JSON.stringify(rows);
      assert.throws(() => validateGeneratedOperatorEvidence(source, initialChecklist, rows), /positive operator action requires operator evidence/);
      assert.equal(JSON.stringify(rows), before);
    }
    validateGeneratedOperatorEvidence(source, initialChecklist, [result(id, 'YES', ['c', 'o'])]);
  }
});
test('negative and N/A decisions do not require a positive action and are never changed', () => {
  for (const id of ['C2', 'C7']) for (const answer of ['NO', 'N/A']) validateGeneratedOperatorEvidence(source, initialChecklist, [result(id, answer, ['c'])]);
});
test('changed criterion semantics skip canonical role assumptions', () => {
  for (const id of ['C2', 'C7']) {
    const rubric = { ...initialChecklist, criteria: initialChecklist.criteria.map(c => c.id === id ? { ...c, instructions: 'Customer reports an action; independent software rule.' } : c) };
    validateGeneratedOperatorEvidence(source, rubric, [result(id, 'YES', ['c'])]);
  }
  validateGeneratedOperatorEvidence(source, initialChecklist, [result('C9', 'YES', ['c'])]);
});
test('the guard makes no semantic assertion merely from an operator quote', () => {
  validateGeneratedOperatorEvidence(source, initialChecklist, [result('C2', 'YES', ['o']), result('C7', 'YES', ['o'])]);
  // Presence alone intentionally does not establish clarification or a full closing.
});
