import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { config } from '../server/config.js';
import { competitionTeamName, readCompetitionDataset, validateCompetitionResults, type CompetitionTarget } from '../server/competition.js';

try {
  const args = process.argv.slice(2); const named = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    if (!['--group', '--target', '--team', '--file'].includes(args[index]) || !args[index + 1] || args[index + 1].startsWith('--') || named.has(args[index])) throw new Error('INVALID_VALIDATOR_ARGUMENTS');
    named.set(args[index], args[index + 1]);
  }
  const groupId = named.get('--group'); const target = named.get('--target'); const input = named.get('--file');
  if (!groupId || !input || !['dev', 'prod'].includes(target ?? '')) throw new Error('GROUP_TARGET_AND_FILE_REQUIRED');
  const file = resolve(input); const child = relative(resolve('.'), file);
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('VALIDATOR_FILE_OUTSIDE_WORKSPACE');
  const actualChild = relative(realpathSync(resolve('.')), realpathSync(file));
  if (!actualChild || actualChild.startsWith('..') || isAbsolute(actualChild)) throw new Error('VALIDATOR_FILE_OUTSIDE_WORKSPACE');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
  const dataset = readCompetitionDataset(config.dbPath, groupId);
  const document = validateCompetitionResults(JSON.parse(text), dataset, { target: target as CompetitionTarget, teamName: named.get('--team') ?? competitionTeamName, configuredModel: config.model });
  console.log(JSON.stringify({ status: 'PASS', groupId, target, file, records: document.results.length, success: document.results.filter(result => result.status === 'ok').length, error: document.results.filter(result => result.status === 'error').length, exactSourceIdsVerified: true, sourceDatabaseReadOnly: true, modelCalls: 0, publicationPerformed: false }));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', code: error instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message) ? error.message : 'COMPETITION_RESULTS_VALIDATION_FAILED', privateValuesPrinted: false })); process.exitCode = 1;
}
