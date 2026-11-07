import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createSecondOpinionBundle, renderSecondOpinionReview, secondOpinionTemplate } from '../server/second-opinion.js';

try {
  const args = process.argv.slice(2);
  if (args.length % 2 || args.some((a, i) => i % 2 === 0 && !['--db', '--manifest', '--out'].includes(a))) throw new Error('SECOND_OPINION_ARGUMENTS');
  const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const db = resolve(option('--db') || process.env.CQA_DB_PATH || 'private/cqa.sqlite');
  const bundle = createSecondOpinionBundle(db, option('--manifest'));
  const directory = resolve(option('--out') || join('private/second-opinion', bundle.createdAt.replace(/[:.]/g, '_')));
  if (!directory.startsWith(resolve('private') + sep)) throw new Error('SECOND_OPINION_PRIVATE_OUTPUT_REQUIRED');
  mkdirSync(directory, { recursive: true });
  for (const [name, body] of [['bundle.json', JSON.stringify(bundle, null, 2)], ['review.md', renderSecondOpinionReview(bundle)], ['response-template.json', JSON.stringify(secondOpinionTemplate(bundle), null, 2)]]) writeFileSync(join(directory, name), body + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ status: 'PASS', directory, bundleHash: bundle.bundleHash, conversations: bundle.cases.length, turns: bundle.cases.reduce((n, c) => n + c.turns.length, 0), languages: bundle.cases.map(c => c.language), sourceReadOnly: true, modelCalls: 0, humanAnswers: 0, modelAnswers: 0 }));
} catch (error) { console.error(error instanceof Error && /^SECOND_OPINION_[A-Z_]+$/.test(error.message) ? error.message : 'SECOND_OPINION_EXPORT_REJECTED'); process.exitCode = 1; }
