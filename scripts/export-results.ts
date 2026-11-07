import { config } from '../server/config.js';
import { buildCompetitionExport, competitionTeamName, readCompetitionDataset, writeCompetitionExport, type CompetitionTarget } from '../server/competition.js';

try {
  const args = process.argv.slice(2); const named = new Map<string, string>(); const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (['--dry-run', '--write-official'].includes(name)) { if (flags.has(name)) throw new Error('DUPLICATE_ARGUMENT'); flags.add(name); }
    else if (['--group', '--target', '--team'].includes(name) && args[index + 1] && !args[index + 1].startsWith('--')) { if (named.has(name)) throw new Error('DUPLICATE_ARGUMENT'); named.set(name, args[++index]); }
    else throw new Error('INVALID_EXPORT_ARGUMENTS');
  }
  if (flags.has('--dry-run') && flags.has('--write-official')) throw new Error('CONFLICTING_EXPORT_MODES');
  const groupId = named.get('--group'); const target = named.get('--target');
  if (!groupId || !['dev', 'prod'].includes(target ?? '')) throw new Error('GROUP_AND_TARGET_REQUIRED');
  const dataset = readCompetitionDataset(config.dbPath, groupId);
  const options = { target: target as CompetitionTarget, teamName: named.get('--team') ?? competitionTeamName, configuredModel: config.model };
  const bundle = buildCompetitionExport(dataset, options);
  const result = writeCompetitionExport(bundle, dataset, { ...options, dryRun: !flags.has('--write-official') });
  console.log(JSON.stringify({ status: 'PASS', ...result, teamName: options.teamName, groupId, model: bundle.document.model, sourceDatabaseReadOnly: true, modelCalls: 0, publicationPerformed: false, noSuccessfulModelObserved: bundle.audit.modelMetadata.noSuccessfulModelObserved }));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', code: error instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message) ? error.message : 'COMPETITION_EXPORT_VALIDATION_FAILED', privateValuesPrinted: false })); process.exitCode = 1;
}
