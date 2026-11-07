import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from '../server/store.js';
import { parseOrganizerResponse } from '../server/importer.js';
import type { Checklist, Evaluation } from '../src/domain.js';

function dataset(text = 'Invented test conversation') {
  return parseOrganizerResponse({ error: '', isSuccess: true, data: { dataset_group_id: 'DEV', total_records: 1, records: [{
    conversation_id: 'fixture-1', channel: 'agent chat', language: 'EN', transcript: [{ timestamp: '00:00', speaker: 'operator', text }], audio_url: null,
  }] } });
}
const checklist: Checklist = { id: 'test', version: 'test-v1', title: 'Test fixture', criteria: [{
  id: 'test-c1', title: 'Test', instructions: 'Test fixture', weight: 10, answerType: 'boolean', allowedValues: ['YES', 'NO'], scaleMax: 1,
  naAllowed: false, naCondition: '', section: 'Test', evidenceRequirement: 'Test fixture', flag: false,
}] };
function evaluation(conversationVersion: string): Evaluation {
  // Software persistence test fixture; never exposed as a live provider run.
  return { id: 'test-eval-1', createdAt: '2026-01-01T00:00:00Z', conversationVersion, checklistVersion: checklist.version,
    provider: 'automated-test-double', model: 'test-fixture', mode: 'free', status: 'live_validated', results: [],
    score: { total: 100, applicableWeight: 10, rawPoints: 10, rows: [], sections: {}, flags: {} }, usage: {}, latencyMs: 1, providerCallCount: 0, configuration: { testOnly: true },
  };
}

test('idempotent imports preserve original records and exclude signed audio URLs from views', () => {
  const store = new Store(':memory:');
  try {
    const source = dataset();
    assert.deepEqual(store.importDataset(source), { inserted: 1, unchanged: 0, total: 1 });
    assert.deepEqual(store.importDataset(source), { inserted: 0, unchanged: 1, total: 1 });
    assert.equal(store.listConversations().length, 1);
    assert.equal(store.listConversations('OTHER').length, 0);
    assert.deepEqual(store.getOriginal(source.conversations[0].version), source.originals[0]);
    assert.equal('audio_url' in store.listConversations()[0], false);
    const withAudio = parseOrganizerResponse({ error: '', isSuccess: true, data: { dataset_group_id: 'DEV', total_records: 1, records: [{
      conversation_id: 'voice-fixture-1', channel: 'voice call', language: 'EN', transcript: [], audio_url: 'https://audio.example.invalid/recording?signature=test-fixture',
    }] } });
    store.importDataset(withAudio);
    assert.equal(JSON.stringify(store.listConversations()).includes('signature='), false);
    assert.equal(store.getConversation(withAudio.conversations[0].version)?.audioAvailable, true);
    assert.equal(store.getConversation('missing'), undefined);
  } finally { store.close(); }
});

test('changed transcripts create new immutable versions, leaving existing evaluation unchanged', () => {
  const store = new Store(':memory:');
  try {
    const first = dataset(); store.importDataset(first); store.saveChecklist(checklist);
    const original = evaluation(first.conversations[0].version); store.saveEvaluation(original);
    const updated = dataset('Changed fixture'); store.importDataset(updated);
    assert.equal(store.listConversations().length, 1);
    assert.equal(store.listConversations()[0].messages[0].text, 'Changed fixture');
    assert.equal(store.getConversation(first.conversations[0].version)?.messages[0].text, 'Invented test conversation');
    assert.deepEqual(store.getEvaluation(original.id), original);
    assert.deepEqual(store.listEvaluations(), [original]);
    store.saveChecklist(checklist); store.saveEvaluation(original);
    assert.throws(() => store.saveChecklist({ ...checklist, title: 'Changed same version' }), /immutable checklist/);
    assert.throws(() => store.saveEvaluation({ ...original, model: 'Changed model' }), /immutable evaluation/);
    store.saveChecklist({ ...checklist, version: 'test-v2', title: 'New version' });
    assert.equal(store.listChecklists().length, 2);
    assert.deepEqual(store.getChecklist(checklist.version), checklist);
  } finally { store.close(); }
});

test('import is transactional when a conflicting immutable version is detected', () => {
  const store = new Store(':memory:');
  try {
    const first = dataset(); store.importDataset(first);
    const second = dataset('Second');
    const corrupt = structuredClone(first.conversations[0]); corrupt.messages[0].text = 'Spoofed unchanged version';
    const combined = { groupId: 'DEV', conversations: [...second.conversations, corrupt], originals: [...second.originals, first.originals[0]] };
    assert.throws(() => store.importDataset(combined), /immutable conversation/);
    assert.equal(store.getConversation(second.conversations[0].version), undefined);
    assert.equal(store.listConversations().length, 1);
  } finally { store.close(); }
});

test('SQLite data and immutable evaluation links survive close and reopen', () => {
  const tempRoot = resolve('tmp'); mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(join(tempRoot, 'store-test-'));
  const path = join(dir, 'nested', 'cqa.sqlite');
  let store = new Store(path);
  try {
    const imported = dataset(); store.importDataset(imported); store.saveChecklist(checklist);
    const original = evaluation(imported.conversations[0].version); store.saveEvaluation(original);
    store.close(); store = new Store(path);
    assert.deepEqual(store.getEvaluation(original.id), original);
    assert.deepEqual(store.getChecklist(checklist.version), checklist);
    assert.deepEqual(store.getConversation(imported.conversations[0].version), imported.conversations[0]);
    assert.deepEqual(store.importDataset(imported), { inserted: 0, unchanged: 1, total: 1 });
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
