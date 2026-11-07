import { z } from 'zod';
import type { Checklist, Conversation, CriterionResult } from '../src/domain.js';

const nonempty = z.string().trim().min(1);
const resultSchema = z.object({
  criterionId: nonempty,
  answer: nonempty,
  applicabilityRationale: z.string(),
  explanation: nonempty,
  evidence: z.array(z.object({ messageId: nonempty, quote: z.string().min(1).refine(quote => quote.trim().length > 0) }).strict()),
  checkedRange: z.object({ startMessageId: nonempty, endMessageId: nonempty }).strict().nullable(),
  reviewRequired: z.boolean(),
  uncertainty: z.string(),
}).strict();
const responseSchema = z.object({ results: z.array(resultSchema) }).strict();

type EvidenceFailureReason = 'positive operator action requires operator evidence' | 'response schema does not match the contract' | 'criterion count mismatch' | 'ambiguous source message IDs' | 'unknown or duplicated criterion' | 'answer is outside the saved criterion scale' | 'N/A has no configured condition' | 'N/A requires an applicability rationale' | 'missing checked range for omission, partial answer or N/A' | 'no source evidence or checked range' | 'positive answer requires source evidence' | 'invalid checked source range' | 'quotation is not an exact source substring' | 'flag requires direct operator evidence' | 'review request must explain uncertainty';
export class EvidenceValidationError extends Error {
  readonly code = 'INVALID_EVIDENCE';
  constructor(readonly reason: EvidenceFailureReason, readonly resultIndex: number | null = null, readonly schemaIssues: Array<{ code: string; path: Array<string | number> }> = []) { super(`Evaluation rejected: ${reason}`); }
}

/** Quotes always refer to this exact conversation version, never timestamps alone. */
export function validateEvidence(conversation: Conversation, checklist: Checklist, raw: unknown): CriterionResult[] {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = new Set(['results', 'criterionId', 'answer', 'applicabilityRationale', 'explanation', 'evidence', 'messageId', 'quote', 'checkedRange', 'startMessageId', 'endMessageId', 'reviewRequired', 'uncertainty']);
    throw new EvidenceValidationError('response schema does not match the contract', null, parsed.error.issues.map(issue => ({ code: issue.code, path: issue.path.map(part => typeof part === 'number' ? part : typeof part === 'string' && fields.has(part) ? part : 'unknown-field') })));
  }
  if (parsed.data.results.length !== checklist.criteria.length) throw new EvidenceValidationError('criterion count mismatch');
  const messages = new Map(conversation.messages.map((message, index) => [message.id, { message, index }]));
  if (messages.size !== conversation.messages.length) throw new EvidenceValidationError('ambiguous source message IDs');
  const criteria = new Map(checklist.criteria.map(criterion => [criterion.id, criterion]));
  const seen = new Set<string>();
  for (const [resultIndex, result] of parsed.data.results.entries()) {
    const criterion = criteria.get(result.criterionId);
    if (!criterion || seen.has(result.criterionId)) throw new EvidenceValidationError('unknown or duplicated criterion', resultIndex);
    seen.add(result.criterionId);
    const isNa = result.answer === 'N/A';
    if (isNa && !result.applicabilityRationale.trim()) throw new EvidenceValidationError('N/A requires an applicability rationale', resultIndex);
    if (isNa ? !criterion.naAllowed : !criterion.allowedValues.includes(result.answer)) {
      throw new EvidenceValidationError('answer is outside the saved criterion scale', resultIndex);
    }
    if (isNa && !criterion.naCondition.trim()) throw new EvidenceValidationError('N/A has no configured condition', resultIndex);
    const negativeOrPartial = result.answer === 'NO' || (criterion.answerType === 'numeric' && !isNa && Number(result.answer) < criterion.scaleMax);
    if (negativeOrPartial && !result.checkedRange) throw new EvidenceValidationError('missing checked range for omission, partial answer or N/A', resultIndex);
    if (!result.evidence.length && !result.checkedRange) throw new EvidenceValidationError('no source evidence or checked range', resultIndex);
    if (!isNa && !negativeOrPartial && !result.evidence.length) throw new EvidenceValidationError('positive answer requires source evidence', resultIndex);
    if (result.checkedRange) {
      const start = messages.get(result.checkedRange.startMessageId);
      const end = messages.get(result.checkedRange.endMessageId);
      if (!start || !end || start.index > end.index) throw new EvidenceValidationError('invalid checked source range', resultIndex);
    }
    for (const reference of result.evidence) {
      const source = messages.get(reference.messageId);
      if (!source || !source.message.text.includes(reference.quote)) throw new EvidenceValidationError('quotation is not an exact source substring', resultIndex);
    }
    if (criterion.flag && result.answer === 'YES' && !result.evidence.some(reference => messages.get(reference.messageId)?.message.speaker === 'operator')) {
      throw new EvidenceValidationError('flag requires direct operator evidence', resultIndex);
    }
    if (result.reviewRequired && !result.uncertainty.trim()) throw new EvidenceValidationError('review request must explain uncertainty', resultIndex);
  }
  return parsed.data.results;
}

/** A compact API-supported JSON Schema; criterion-specific values are checked locally too. */
export function evaluationJsonSchema(checklist: Checklist, messageIds?: string[], options: { requireCheckedRange?: boolean } = {}): Record<string, unknown> {
  const sourceId = { type: 'string', ...(messageIds?.length && messageIds.length <= 500 ? { enum: messageIds } : {}), description: 'An exact stable message ID copied from this source conversation.' };
  return {
    type: 'object', additionalProperties: false, required: ['results'],
    properties: {
      results: {
        type: 'array', minItems: checklist.criteria.length, maxItems: checklist.criteria.length,
        items: {
          type: 'object', additionalProperties: false,
          required: ['criterionId', 'answer', 'applicabilityRationale', 'explanation', 'evidence', 'checkedRange', 'reviewRequired', 'uncertainty'],
          properties: {
            criterionId: { type: 'string', enum: checklist.criteria.map(c => c.id) },
            answer: { type: 'string', enum: [...new Set(checklist.criteria.flatMap(c => [...c.allowedValues, ...(c.naAllowed ? ['N/A'] : [])]))] },
            applicabilityRationale: { type: 'string' }, explanation: { type: 'string' },
            evidence: {
              type: 'array', items: { type: 'object', additionalProperties: false, required: ['messageId', 'quote'], properties: { messageId: sourceId, quote: { type: 'string', description: 'Copy the complete text of the selected source message exactly, preserving punctuation, capitalization, whitespace and line breaks. Do not paraphrase, add quotation marks or use ellipses. The messageId must identify that same source message.' } } },
            },
            checkedRange: {
              type: options.requireCheckedRange ? 'object' : ['object', 'null'], additionalProperties: false, required: ['startMessageId', 'endMessageId'],
              description: options.requireCheckedRange ? 'Required for every criterion and answer. Identify the ordered inclusive source range actually inspected, using exact source message IDs.' : 'Required for every NO, partial numeric answer and N/A. Identify the ordered inclusive source range actually inspected.',
              properties: { startMessageId: sourceId, endMessageId: sourceId },
            },
            reviewRequired: { type: 'boolean' }, uncertainty: { type: 'string' },
          },
        },
      },
    },
  };
}
