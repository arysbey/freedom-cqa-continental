import { readFileSync } from 'node:fs';
import { config } from '../server/config.js';
import { fetchOrganizerGroup, parseOrganizerResponse } from '../server/importer.js';
import { Store } from '../server/store.js';
import { initialChecklist } from '../src/checklist.js';

const store = new Store(config.dbPath);
try {
  const fileIndex = process.argv.indexOf('--file');
  const groupIndex = process.argv.indexOf('--group');
  const group = groupIndex >= 0 ? process.argv[groupIndex + 1] : 'DEV';
  const source = fileIndex >= 0
    ? parseOrganizerResponse(JSON.parse(readFileSync(process.argv[fileIndex + 1], 'utf8').replace(/^\uFEFF/, '')), group)
    : await fetchOrganizerGroup(config.organizerUrl || '', group);
  store.saveChecklist(initialChecklist);
  const result = store.importDataset(source);
  const records = store.listConversations(group);
  const counts = records.reduce<Record<string, number>>((acc, item) => { acc[item.classification] = (acc[item.classification] || 0) + 1; return acc; }, {});
  console.log(JSON.stringify({ source: fileIndex >= 0 ? 'local-file' : 'live-organizer-get', group, ...result, classifications: counts }, null, 2));
} catch {
  console.error('Import failed. No source URL or response content has been logged. Check connectivity and organizer configuration.');
  process.exitCode = 1;
} finally { store.close(); }
