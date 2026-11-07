import type { Checklist, Score, ScoreRow } from './domain.js';
import { validateChecklist } from './checklist.js';

type Rational = { n: bigint; d: bigint };
const ZERO: Rational = { n: 0n, d: 1n };
const HUNDRED: Rational = { n: 100n, d: 1n };

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}
function rational(n: bigint, d: bigint): Rational {
  if (d === 0n) throw new Error('Division by zero');
  const factor = gcd(n < 0n ? -n : n, d);
  return { n: n / factor, d: d / factor };
}
/** Convert finite decimal configuration numbers exactly, including exponent notation. */
function decimal(value: number | string): Rational {
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const power = Number(exponent) - fraction.length;
  const numerator = BigInt(whole + fraction);
  return power >= 0
    ? rational(numerator * (10n ** BigInt(power)), 1n)
    : rational(numerator, 10n ** BigInt(-power));
}
function add(a: Rational, b: Rational): Rational { return rational(a.n * b.d + b.n * a.d, a.d * b.d); }
function multiply(a: Rational, b: Rational): Rational { return rational(a.n * b.n, a.d * b.d); }
function divide(a: Rational, b: Rational): Rational { return rational(a.n * b.d, a.d * b.n); }
function asNumber(value: Rational): number {
  // Rational sums can have denominators beyond Number.MAX_VALUE even while
  // the actual score is small. Convert leading digits only for display fields.
  const numerator = value.n.toString();
  const denominator = value.d.toString();
  const numeratorDigits = numerator.slice(0, 17);
  const denominatorDigits = denominator.slice(0, 17);
  return Number(numeratorDigits) / Number(denominatorDigits)
    * 10 ** ((numerator.length - numeratorDigits.length) - (denominator.length - denominatorDigits.length));
}
/** Positive totals use exact decimal half-up rounding only at the final boundary. */
function roundedPercent(points: Rational, weight: Rational): number | null {
  if (weight.n === 0n) return null;
  const percent = multiply(divide(points, weight), HUNDRED);
  const cents = (percent.n * 100n * 2n + percent.d) / (percent.d * 2n);
  return Number(cents) / 100;
}

/**
 * The model supplies bounded answers only. Application code owns every score.
 * N/A removes the criterion's weight. Independent flags never affect totals.
 */
export function calculateScore(checklist: Checklist, results: Array<{ criterionId: string; answer: string }>): Score {
  const config = validateChecklist(checklist);
  if (!Array.isArray(results)) throw new Error('Criterion results must be an array');
  if (results.length !== config.criteria.length) throw new Error('Exactly one result per criterion is required');
  const byId = new Map<string, string>();
  const criterionIds = new Set(config.criteria.map(criterion => criterion.id));
  for (const result of results) {
    if (!result || typeof result.criterionId !== 'string' || typeof result.answer !== 'string') throw new Error('Invalid criterion result');
    if (!criterionIds.has(result.criterionId)) throw new Error(`Unknown criterion: ${result.criterionId}`);
    if (byId.has(result.criterionId)) throw new Error(`Duplicate criterion result: ${result.criterionId}`);
    byId.set(result.criterionId, result.answer);
  }

  let applicableWeight = ZERO;
  let rawPoints = ZERO;
  const flags: Record<string, boolean> = Object.create(null);
  const sectionSums = new Map<string, { points: Rational; weight: Rational }>();
  const contributions = new Map<string, Rational | null>();
  for (const criterion of config.criteria) {
    const answer = byId.get(criterion.id)!;
    if (answer !== 'N/A' && !criterion.allowedValues.includes(answer)) throw new Error(`Answer is outside allowed values for ${criterion.id}`);
    if (answer === 'N/A' && !criterion.naAllowed) throw new Error(`N/A is not allowed for ${criterion.id}`);
    if (criterion.flag) {
      flags[criterion.id] = answer === 'YES';
      contributions.set(criterion.id, ZERO);
      continue;
    }
    const section = sectionSums.get(criterion.section) ?? { points: ZERO, weight: ZERO };
    sectionSums.set(criterion.section, section);
    if (answer === 'N/A') {
      contributions.set(criterion.id, null);
      continue;
    }
    const weight = decimal(criterion.weight);
    const value = criterion.answerType === 'boolean' ? (answer === 'YES' ? '1' : '0') : answer;
    const contribution = multiply(weight, divide(decimal(value), decimal(criterion.scaleMax)));
    contributions.set(criterion.id, contribution);
    rawPoints = add(rawPoints, contribution);
    applicableWeight = add(applicableWeight, weight);
    section.points = add(section.points, contribution);
    section.weight = add(section.weight, weight);
  }
  const rows: ScoreRow[] = config.criteria.map(criterion => {
    const contribution = contributions.get(criterion.id)!;
    return {
      criterionId: criterion.id,
      answer: byId.get(criterion.id)!,
      weight: criterion.weight,
      contribution: contribution === null ? null : asNumber(contribution),
      normalizedContribution: contribution === null || applicableWeight.n === 0n
        ? null : asNumber(multiply(divide(contribution, applicableWeight), HUNDRED)),
    };
  });
  const sections: Score['sections'] = Object.create(null);
  for (const [section, sums] of sectionSums) {
    sections[section] = {
      total: roundedPercent(sums.points, sums.weight),
      applicableWeight: asNumber(sums.weight),
      rawPoints: asNumber(sums.points),
    };
  }
  return {
    total: roundedPercent(rawPoints, applicableWeight),
    applicableWeight: asNumber(applicableWeight),
    rawPoints: asNumber(rawPoints),
    rows,
    sections,
    flags,
  };
}
