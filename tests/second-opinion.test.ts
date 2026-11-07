import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { approvedSyntheticRecord } from './synthetic-fixture.js';
import { canonicalJson, parseOrganizerResponse } from '../server/importer.js';
import { initialChecklist } from '../src/checklist.js';
import { calculateScore } from '../src/scoring.js';
import { SecondOpinionStore, secondOpinionResponseSchema, validateSecondOpinionBundle, validateSecondOpinionJudgments } from '../server/second-opinion.js';

// Deliberately arbitrary software answers. These are neither human nor AI semantic gold.
const c = parseOrganizerResponse({ error: '', isSuccess: true, data: { dataset_group_id: 'DEV', total_records: 1, records: [approvedSyntheticRecord] } }).conversations[0];
const source = { conversationId: c.conversationId, conversationVersion: c.version, sourceHash: createHash('sha256').update(canonicalJson(c)).digest('hex'), originalHash: '0'.repeat(64), split: 'development', language: c.language, channel: 'agent chat', turns: c.messages.map((m, i) => ({ index: i + 1, messageId: m.id, timestamp: m.timestamp, speaker: m.speaker, text: m.text })) };
const results = () => initialChecklist.criteria.map(r => ({ criterionId: r.id, answer: r.answerType === 'numeric' ? '0' : 'NO', explanation: 'Software contract fixture only; no semantic judgment.', applicabilityRationale: '', evidence: [] as { turnIndex: number; quote: string }[], checkedRange: { startTurnIndex: 1, endTurnIndex: c.messages.length }, reviewRequired: false, uncertainty: '' }));
test('1-based evidence maps to original stable IDs; deterministic score is separate from gold', () => {
  const r = results(); r[0].answer = 'YES'; r[0].evidence = [{ turnIndex: 10, quote: c.messages[9].text }];
  const valid = validateSecondOpinionJudgments(source, r);
  assert.equal(valid[0].evidence[0].messageId, c.messages[9].id);
  assert.equal(calculateScore(initialChecklist, valid).total, 10);
});
test('rejects fabricated quote, missing/range/role errors, bad scales, N/A, order and extra fields', () => {
  const changes: Array<(r: ReturnType<typeof results>) => void> = [r => { r[0].evidence = [{ turnIndex: 10, quote: 'fabricated absent source text' }]; }, r => { r[0].evidence = [{ turnIndex: 9999, quote: 'absent' }]; }, r => { r[0].checkedRange.startTurnIndex = 0; }, r => { r[0].checkedRange.startTurnIndex = 12; r[0].checkedRange.endTurnIndex = 1; }, r => { r[3].answer = '19'; }, r => { r[0].answer = 'N/A'; }, r => { r[7].answer = 'YES'; r[7].evidence = [{ turnIndex: 1, quote: c.messages[0].text }]; }, r => { r[0].criterionId = 'C9'; }, r => { Object.assign(r[0], { human_verified: true }); }, r => { r[0].reviewRequired = true; }];
  for (const change of changes) { const r = results(); change(r); assert.throws(() => validateSecondOpinionJudgments(source, r)); }
});
test('rejects altered source, zero-based positions and fabricated approval', () => {
  const changed = structuredClone(source); changed.turns[0].text += ' altered'; assert.throws(() => validateSecondOpinionJudgments(changed, results()));
  const shifted = structuredClone(source); shifted.turns[0].index = 0; assert.throws(() => validateSecondOpinionJudgments(shifted, results()));
});
test('blank template answers, wrong provenance and human claims are rejected', () => {
  assert.equal(secondOpinionResponseSchema.safeParse({ origin: 'human_entered' }).success, false);
  assert.equal(secondOpinionResponseSchema.safeParse({ origin: 'ai_second_opinion', human_ground_truth: true }).success, false);
  const r = results(); Object.assign(r[0], { answer: null }); assert.throws(() => validateSecondOpinionJudgments(source, r));
});
test('bundle shape rejects missing sources, duplicate source versions and custom rubric', () => {
  const unsigned = { schemaVersion: 'second-opinion-bundle-v1', purpose: 'ai_second_opinion', humanGroundTruth: false, createdAt: '2026-11-08T00:00:00.000Z', manifestId: 'fixture', manifestHash: '0'.repeat(64), checklistHash: createHash('sha256').update(canonicalJson(initialChecklist)).digest('hex'), checklist: initialChecklist, cases: Array.from({ length: 4 }, () => source) };
  const bundle = { ...unsigned, bundleHash: createHash('sha256').update(canonicalJson(unsigned)).digest('hex') };
  assert.throws(() => validateSecondOpinionBundle(bundle), /DUPLICATE_SOURCE/);
  assert.throws(() => validateSecondOpinionBundle({ ...bundle, cases: [] }));
  const altered = structuredClone(bundle); altered.checklist.criteria[0].weight += 1; assert.throws(() => validateSecondOpinionBundle(altered), /OFFICIAL_CHECKLIST/);
});
test('separate append-only table cannot target source DB or overwrite/delete history', () => {
  const root = resolve('tmp'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'cqa-second-opinion-')), path = join(dir, 'sidecar.sqlite');
  assert.throws(() => new SecondOpinionStore(path, { sourceDatabasePath: path }), /SEPARATE_LEDGER/);
  const store = new SecondOpinionStore(path, { sourceDatabasePath: join(dir, 'source.sqlite') }); store.close();
  const db = new DatabaseSync(path);
  try { db.prepare('INSERT INTO ai_second_opinions VALUES(?,?,?,?)').run('software-only', 'req', 'hash', '{}'); assert.throws(() => db.exec("UPDATE ai_second_opinions SET json='changed'"), /APPEND_ONLY/); assert.throws(() => db.exec('DELETE FROM ai_second_opinions'), /APPEND_ONLY/); assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'quality_%' OR name='evaluations'").get()!.n, 0); } finally { db.close(); rmSync(path); rmdirSync(dir); }
});
