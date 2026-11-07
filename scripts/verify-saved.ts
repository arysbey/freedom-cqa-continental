import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { config } from '../server/config.js';
import { Store } from '../server/store.js';
import { validateEvidence } from '../server/evidence.js';
import { calculateScore } from '../src/scoring.js';
import { isApprovedSyntheticConversation, canonicalJson } from '../server/importer.js';

const store = new Store(config.dbPath);
try {
  const evaluations = store.listEvaluations();
  for (const evaluation of evaluations) {
    const conversation = store.getConversation(evaluation.conversationVersion);
    const checklist = store.getChecklist(evaluation.checklistVersion);
    assert(conversation && checklist);
    assert(isApprovedSyntheticConversation(conversation));
    validateEvidence(conversation, checklist, { results: evaluation.results });
    // JSON persistence intentionally removes the scorer's null object prototypes.
    assert.equal(canonicalJson(calculateScore(checklist, evaluation.results)), canonicalJson(evaluation.score));
  }
  const report = { status: 'PASS', actualSavedEvaluationsRevalidated: evaluations.length, quotesAndScoresUnchanged: true };
  writeFileSync('private/reports/saved-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { store.close(); }
