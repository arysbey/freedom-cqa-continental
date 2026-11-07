import type { Checklist, Conversation, CriterionResult } from '../src/domain.js';
import { initialChecklist } from '../src/checklist.js';
import { canonicalJson } from './importer.js';
import { EvidenceValidationError } from './evidence.js';

export const operatorEvidenceVersion = 'canonical-discovery-closing-role-v1' as const;
/** Generation-only: an operator reference is necessary, not proof of semantic truth. */
export function validateGeneratedOperatorEvidence(source: Conversation, checklist: Checklist, results: CriterionResult[]): void {
  const operatorIds = new Set(source.messages.filter(m => m.speaker === 'operator').map(m => m.id));
  for (const [index, result] of results.entries()) {
    if (result.answer !== 'YES' || !['C2', 'C7'].includes(result.criterionId)) continue;
    const criterion = checklist.criteria.find(c => c.id === result.criterionId);
    const original = initialChecklist.criteria.find(c => c.id === result.criterionId);
    if (!criterion || canonicalJson(criterion) !== canonicalJson(original)) continue;
    if (!result.evidence.some(e => operatorIds.has(e.messageId))) throw new EvidenceValidationError('positive operator action requires operator evidence', index);
  }
}
