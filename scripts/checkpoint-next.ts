/** Capture immutable hashes before restart; never exports transcripts into public artifacts. */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { config } from '../server/config.js';
import { Store } from '../server/store.js';
import { ReviewStore } from '../server/reviews.js';
import { QualityStore } from '../server/quality.js';
import { canonicalJson } from '../server/importer.js';

const store = new Store(config.dbPath), reviews = new ReviewStore(config.dbPath), quality = new QualityStore(config.dbPath);
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
try {
  const evaluations = store.listEvaluations();
  const manifest = quality.getManifest();
  const report = {
    capturedAt: new Date().toISOString(),
    evaluations: evaluations.map(e => ({ id: e.id, status: e.status, hash: digest(e), historyHash: digest(reviews.getHistory(e, store.getChecklist(e.checklistVersion)!)) })),
    checklists: store.listChecklists().map(c => ({ version: c.version, hash: digest(c) })),
    qualityManifestId: manifest?.id ?? null,
    references: manifest ? quality.listReferences(manifest.id).map(r => ({ id: r.id, hash: digest(r) })) : [],
    liveCount: evaluations.filter(e => e.status === 'live_validated').length,
    manualDemoCount: evaluations.filter(e => e.status === 'manual_demo').length,
    humanEnteredCount: evaluations.filter(e => e.status === 'human_entered').length,
  };
  writeFileSync('private/reports/next-before-restart.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: 'PASS', liveCount: report.liveCount, manualDemoCount: report.manualDemoCount, humanEnteredCount: report.humanEnteredCount, humanReferences: report.references.length }));
} finally { quality.close(); reviews.close(); store.close(); }
