import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compareSecondOpinion, SecondOpinionStore, validateSecondOpinionBundle, verifySecondOpinionSource } from '../server/second-opinion.js';
import { canonicalJson } from '../server/importer.js';

try {
  const args = process.argv.slice(2);
  if (args.length % 2 || args.some((a, i) => i % 2 === 0 && !['--db', '--bundle', '--input'].includes(a))) throw new Error('SECOND_OPINION_ARGUMENTS');
  const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const load = (path: string | undefined) => { if (!path || statSync(path).size > 3 * 1024 * 1024) throw new Error('SECOND_OPINION_INPUT_LIMIT'); return JSON.parse(readFileSync(path, 'utf8')) as unknown; };
  const sourceDatabasePath = resolve(option('--db') || process.env.CQA_DB_PATH || 'private/cqa.sqlite');
  const bundle = validateSecondOpinionBundle(load(option('--bundle'))), input = load(option('--input'));
  verifySecondOpinionSource(bundle, sourceDatabasePath);
  const comparison = compareSecondOpinion(bundle, input, sourceDatabasePath);
  const store = new SecondOpinionStore(resolve('private/second-opinion/ledger.sqlite'), { sourceDatabasePath });
  try {
    const saved = store.save(bundle, input, comparison);
    const directory = resolve('private/second-opinion/reports'), reportPath = resolve(directory, `${saved.id}.json`);
    mkdirSync(directory, { recursive: true });
    if (existsSync(reportPath)) {
      if (canonicalJson(JSON.parse(readFileSync(reportPath, 'utf8'))) !== canonicalJson(saved)) throw new Error('SECOND_OPINION_REPORT_CONFLICT');
    } else writeFileSync(reportPath, JSON.stringify(saved, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ status: 'PASS', id: saved.id, reportPath, origin: saved.origin, serviceAndModelVerification: saved.serviceAndModelVerification, cases: saved.cases.length, disagreements: saved.comparison?.cases.reduce((sum, c) => sum + c.criteria.filter(r => r.disagreement === true).length, 0) ?? null, humanGroundTruth: false, eligibleForOfficialExport: false, mainDatabaseReadOnly: true, modelCalls: 0 }));
  } finally { store.close(); }
} catch (error) { console.error(error instanceof Error && /^SECOND_OPINION_[A-Z_]+$/.test(error.message) ? error.message : 'SECOND_OPINION_IMPORT_REJECTED'); process.exitCode = 1; }
