import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.js';
import { QualityStore } from '../server/quality.js';
import type { Checklist, Conversation, Evaluation } from '../src/domain.js';

// This command only reads existing annotations and results. It never calls a provider.
const args = process.argv.slice(2);
if (args.length % 2 || args.some((arg, index) => index % 2 === 0 && !['--manifest', '--cutoff'].includes(arg))) throw new Error('Use --manifest ID and/or --cutoff ISO_UTC_TIMESTAMP');
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const quality = new QualityStore(config.dbPath, { readOnly: true });
const db = new DatabaseSync(config.dbPath, { readOnly: true });
type Row = { json: string };
const parseRows = <T>(sql: string) => (db.prepare(sql).all() as Row[]).map(row => JSON.parse(row.json) as T);
try {
  const report = quality.exportComparison({
    getConversation(version: string) { const row = db.prepare('SELECT json FROM conversations WHERE version=?').get(version) as Row | undefined; return row ? JSON.parse(row.json) as Conversation : undefined; },
    listChecklists: () => parseRows<Checklist>('SELECT json FROM checklists ORDER BY rowid DESC'),
    listEvaluations: () => parseRows<Evaluation>('SELECT json FROM evaluations ORDER BY rowid DESC'),
  }, option('--manifest'), option('--cutoff'));
  const directory = resolve('private/reports');
  mkdirSync(directory, { recursive: true });
  const stem = `${report.manifest.id}-${report.cutoff}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  const jsonPath = join(directory, `${stem}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // Escape spreadsheet formulas as well as CSV delimiters in human/model prose.
  const cell = (value: unknown) => { let text = value == null ? '' : String(value); if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
  const csv = (name: string, rows: unknown[][]) => writeFileSync(join(directory, `${stem}-${name}.csv`), `\uFEFF${rows.map(row => row.map(cell).join(',')).join('\r\n')}\r\n`, { encoding: 'utf8', mode: 0o600 });
  const countRows = (dimension: string, values: Record<string, { matches: number; total: number; agreement: number | null }>) => [['dimension', 'value', 'matches', 'denominator', 'agreement'], ...Object.entries(values).map(([key, value]) => [dimension, key, value.matches, value.total, value.agreement])];
  csv('criteria', countRows('criterion', report.metrics.byCriterion));
  csv('languages', countRows('language', report.metrics.byLanguage));
  csv('splits', countRows('split', report.metrics.bySplit));
  csv('scores', [['caseId', 'language', 'split', 'referenceTotal', 'modelTotal', 'absoluteError'], ...report.metrics.totalScoreError.cases.map(row => [row.caseId, row.language, row.split, row.referenceTotal, row.modelTotal, row.absoluteError])]);
  csv('disagreements', [['caseId', 'split', 'language', 'criterionId', 'human', 'model', 'mechanicalCategory', 'reviewStatus', 'humanCategory', 'humanAnalysis', 'humanExplanation', 'modelExplanation', 'referenceId', 'evaluationId'], ...report.metrics.materialDisagreements.map(row => [row.caseId, row.split, row.language, row.criterionId, row.expected, row.actual, row.category, row.reviewStatus, row.humanCategory, row.humanAnalysis, row.humanExplanation, row.modelExplanation, row.referenceId, row.evaluationId])]);
  console.log(JSON.stringify({ status: 'PASS', jsonPath, reportHash: report.reportHash, cutoff: report.cutoff, selectionPolicy: report.selectionPolicy, humanReviewedCases: report.metrics.humanReviewedCases, resolvedHumanJudgments: report.metrics.resolvedHumanJudgments, comparedCases: report.metrics.comparedCases, modelCalls: 0, sourceDatabaseReadOnly: true, csvFiles: 5 }));
} finally { db.close(); quality.close(); }
