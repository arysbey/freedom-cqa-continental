import { z } from 'zod';
import official from './data/official-checklist.json' with { type: 'json' };
import type { Checklist } from './domain.js';

const text = z.string().trim().min(1).max(20_000);
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
const finitePositive = z.number().finite().positive().max(1_000_000_000);
const decimalValue = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

const criterionSchema = z.object({
  id: identifier,
  title: text,
  instructions: text,
  weight: z.number().finite().nonnegative().max(1_000_000_000),
  answerType: z.enum(['boolean', 'numeric']),
  allowedValues: z.array(z.string().min(1).max(64)).min(2).max(100),
  scaleMax: finitePositive,
  naAllowed: z.boolean(),
  naCondition: z.string().max(20_000),
  section: text,
  evidenceRequirement: text,
  flag: z.boolean(),
}).strict().superRefine((criterion, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (new Set(criterion.allowedValues).size !== criterion.allowedValues.length) fail('Allowed values must be unique');
  if (criterion.allowedValues.includes('N/A')) fail('N/A belongs in naAllowed, not allowedValues');
  if (criterion.naAllowed && !criterion.naCondition.trim()) fail('N/A requires an explicit applicability condition');
  if (!criterion.naAllowed && criterion.naCondition.trim()) fail('N/A condition must be empty when N/A is disabled');
  if (criterion.flag && (criterion.weight !== 0 || criterion.answerType !== 'boolean' || criterion.naAllowed)) {
    fail('An independent flag must be unweighted, boolean, and always applicable');
  }
  if (criterion.answerType === 'boolean') {
    if (criterion.scaleMax !== 1 || criterion.allowedValues.length !== 2 || !criterion.allowedValues.includes('YES') || !criterion.allowedValues.includes('NO')) {
      fail('Boolean criteria must use YES/NO and scaleMax=1');
    }
  } else {
    const values = criterion.allowedValues.map(Number);
    if (!criterion.allowedValues.every(value => decimalValue.test(value) && Number.isFinite(Number(value)))) fail('Numeric answer values must be nonnegative decimal strings');
    if (new Set(values).size !== values.length) fail('Numeric answer values must be numerically distinct');
    if (values.some(value => value < 0 || value > criterion.scaleMax)) fail('Numeric answers must be within the declared scale');
    if (!values.includes(0) || !values.includes(criterion.scaleMax)) fail('Numeric scales must include zero and their maximum');
  }
});

const checklistSchema = z.object({
  id: identifier,
  version: identifier,
  title: text,
  criteria: z.array(criterionSchema).min(1).max(100),
}).strict().superRefine((checklist, ctx) => {
  if (new Set(checklist.criteria.map(criterion => criterion.id)).size !== checklist.criteria.length) {
    ctx.addIssue({ code: 'custom', message: 'Criterion IDs must be unique' });
  }
});

/** Validate and clone a configuration; no criterion meaning is hardcoded in scoring. */
export function validateChecklist(input: unknown): Checklist {
  return checklistSchema.parse(input);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Versioned source data based on the official three-page checklist. */
export const initialChecklist: Checklist = deepFreeze(validateChecklist(official));
