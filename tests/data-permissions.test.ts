import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PermissionStore, conversationFingerprint } from '../server/data-permissions.js';
import type { Conversation } from '../src/domain.js';

// Isolated software fixture: these attestations are never written to production.
const source: Conversation = { version: 'new-group-fixture-v1', groupId: 'CONTROL_FIXTURE', conversationId: 'synthetic-fixture', channel: 'agent chat', language: 'EN', classification: 'unknown', audioAvailable: false, messages: [{ id: 'source:0', position: 0, timestamp: '00:00', speaker: 'client', text: 'A fabricated safe question.' }, { id: 'source:1', position: 1, timestamp: '00:00', speaker: 'operator', text: 'A fabricated safe answer.' }] };
const input = { reviewer: 'software-fixture', reason: 'Synthetic test data, isolated database; not an actual human approval.', syntheticAttestation: true, freeTierUseApproved: true, origin: 'human_declared', requestId: 'fixture-request' };
test('unknown chats stay restricted until an explicit bound approval; source/version unchanged', () => {
  const store = new PermissionStore(':memory:');
  try {
    assert.equal(store.resolve(source), source);
    const original = structuredClone(source); const permission = store.approve(source, input); const allowed = store.resolve(source);
    assert.equal(permission.sourceFingerprint, conversationFingerprint(source)); assert.equal(allowed.classification, 'synthetic_allowed');
    assert.notEqual(allowed, source); assert.deepEqual(source, original); assert.deepEqual(allowed, { ...original, classification: 'synthetic_allowed' });
    assert(!JSON.stringify(permission).includes(source.messages[0].text));
  } finally { store.close(); }
});
test('voice, audio, restricted calls and preclassified records cannot acquire new approvals', () => {
  const store = new PermissionStore(':memory:');
  try {
    for (const altered of [{ ...source, channel: 'voice call' }, { ...source, audioAvailable: true }, { ...source, classification: 'real_restricted' as const }, { ...source, classification: 'synthetic_allowed' as const }]) {
      assert.throws(() => store.approve(altered, input), /RESTRICTED/); assert.equal(store.resolve(altered), altered);
    }
    assert.equal(store.getPermission(source.version), undefined);
  } finally { store.close(); }
});
test('both actual-human declarations and explicit free-tier consent are mandatory', () => {
  const store = new PermissionStore(':memory:');
  try {
    for (const patch of [{ reviewer: '' }, { reason: ' ' }, { syntheticAttestation: false }, { freeTierUseApproved: false }, { origin: 'agent_demo' }, { extraField: 'rejected' }]) assert.throws(() => store.approve(source, { ...input, ...patch }));
    assert.equal(store.getPermission(source.version), undefined);
  } finally { store.close(); }
});
test('changing a source field, message order, timestamp, role, version or channel invalidates approval', () => {
  const store = new PermissionStore(':memory:');
  try {
    store.approve(source, input);
    const variants = [
      { ...source, version: 'other-version' }, { ...source, groupId: 'other-group' }, { ...source, conversationId: 'other-id' }, { ...source, language: 'KZ' },
      { ...source, messages: [...source.messages].reverse() },
      { ...source, messages: source.messages.map((m, i) => i ? m : { ...m, text: 'Changed text' }) },
      { ...source, messages: source.messages.map((m, i) => i ? m : { ...m, timestamp: '00:01' }) },
      { ...source, messages: source.messages.map((m, i) => i ? m : { ...m, speaker: 'system' as const }) },
      { ...source, messages: source.messages.map((m, i) => i ? m : { ...m, id: 'new-message-id', position: 5 }) },
    ];
    for (const altered of variants) assert.equal(store.resolve(altered), altered);
    assert.throws(() => store.approve(variants[5], { ...input, requestId: 'different' }), /IMMUTABLE_PERMISSION_SOURCE/);
  } finally { store.close(); }
});
test('exact retries are idempotent; changed requests conflict; canonical key order is stable', () => {
  const store = new PermissionStore(':memory:');
  try {
    const first = store.approve(source, input); assert.equal(store.approve(source, input).id, first.id);
    assert.throws(() => store.approve(source, { ...input, reason: 'different' }), /IDEMPOTENCY/);
    const reordered = Object.fromEntries(Object.entries(source).reverse()) as unknown as Conversation;
    assert.equal(conversationFingerprint(reordered), conversationFingerprint(source)); assert.equal(store.resolve(reordered).classification, 'synthetic_allowed');
  } finally { store.close(); }
});
test('approval and request history survive restart and SQL mutation is blocked', () => {
  mkdirSync(resolve('tmp'), { recursive: true }); const directory = mkdtempSync(join(resolve('tmp'), 'permissions-')); const dbPath = join(directory, 'test.sqlite');
  try {
    const firstStore = new PermissionStore(dbPath); const first = firstStore.approve(source, input); firstStore.close();
    const secondStore = new PermissionStore(dbPath); assert.equal(secondStore.getPermission(source.version)?.id, first.id); assert.equal(secondStore.approve(source, input).id, first.id); assert.equal(secondStore.resolve(source).classification, 'synthetic_allowed');
    const direct = new DatabaseSync(dbPath); assert.throws(() => direct.exec('DELETE FROM permission_approvals'), /append-only/); assert.throws(() => direct.exec("UPDATE permission_requests SET payload='changed'"), /append-only/); direct.close(); secondStore.close();
  } finally { const target = resolve(directory); assert(target.startsWith(resolve('tmp') + '\\') || target.startsWith(resolve('tmp') + '/')); rmSync(target, { recursive: true }); }
});

function batchSources() {
  return [source, { ...structuredClone(source), version: 'new-group-fixture-v2', conversationId: 'synthetic-fixture-two', messages: source.messages.map((message, index) => ({ ...message, id: `second:${index}` })) }];
}
function batchInput(store: PermissionStore, sources = batchSources(), requestId = 'batch-fixture-request') {
  const { eligibleCount: _eligibleCount, ...binding } = store.previewBatch(sources); void _eligibleCount;
  return { ...binding, ...input, requestId };
}

test('batch preview is deterministic, source bound and never grants permission', () => {
  const store = new PermissionStore(':memory:');
  try {
    const sources = batchSources(), original = structuredClone(sources);
    const preview = store.previewBatch(sources);
    assert.deepEqual(store.previewBatch([...sources].reverse()), preview);
    assert.equal(preview.groupId, source.groupId); assert.equal(preview.eligibleCount, 2);
    assert.deepEqual(preview.conversationVersions, sources.map(item => item.version));
    assert.match(preview.sourceFingerprint, /^[a-f0-9]{64}$/);
    assert.notEqual(store.previewBatch([{ ...sources[0], language: 'KZ' }, sources[1]]).sourceFingerprint, preview.sourceFingerprint);
    assert(!JSON.stringify(preview).includes(source.messages[0].text));
    assert.deepEqual(sources, original); for (const item of sources) assert.equal(store.resolve(item), item);
  } finally { store.close(); }
});

test('batch approval binds all versions atomically and exact replay is idempotent', () => {
  const store = new PermissionStore(':memory:');
  try {
    const sources = batchSources(), original = structuredClone(sources), request = batchInput(store, sources);
    const approved = store.approveBatch(sources, request);
    assert.equal(approved.scope, 'one-immutable-synthetic-chat-batch'); assert.equal(approved.eligibleCount, 2);
    assert.equal(new Set(approved.approvalIds).size, 2);
    assert.deepEqual(store.approveBatch([...sources].reverse(), request), approved);
    for (const [index, item] of sources.entries()) {
      const saved = store.getPermission(item.version)!;
      assert.equal(saved.id, approved.approvalIds[index]); assert.match(saved.requestId, /^batch_permission_[a-f0-9]{64}_\d+$/);
      assert.equal(saved.sourceFingerprint, conversationFingerprint(item)); assert.equal(saved.reviewer, input.reviewer);
      assert.equal(store.resolve(item).classification, 'synthetic_allowed');
    }
    assert.deepEqual(sources, original);
    for (const patch of [{ reason: 'changed purpose' }, { reviewer: 'different software fixture' }]) assert.throws(() => store.approveBatch(sources, { ...request, ...patch }), /IDEMPOTENCY_CONFLICT/);
    const otherGroup = sources.map(item => ({ ...item, groupId: 'OTHER_LOCAL_FIXTURE' }));
    assert.throws(() => store.approveBatch(otherGroup, batchInput(store, otherGroup, request.requestId)), /IDEMPOTENCY_CONFLICT/);
  } finally { store.close(); }
});

test('any restricted, duplicate or mixed-group member rejects the whole batch before a grant', () => {
  const store = new PermissionStore(':memory:');
  try {
    const sources = batchSources(); const request = batchInput(store, sources);
    const invalid = [[], [source, source], [source, { ...sources[1], conversationId: source.conversationId }], [source, { ...sources[1], groupId: 'OTHER' }],
      [source, { ...sources[1], channel: 'voice call' }], [source, { ...sources[1], audioAvailable: true }],
      [source, { ...sources[1], classification: 'real_restricted' as const }], [source, { ...sources[1], classification: 'synthetic_allowed' as const }]];
    for (const list of invalid) {
      assert.throws(() => store.previewBatch(list), /DATA_PERMISSION/);
      assert.throws(() => store.approveBatch(list, request), /DATA_PERMISSION/);
      for (const item of sources) assert.equal(store.getPermission(item.version), undefined);
    }
  } finally { store.close(); }
});

test('stale source sets, source contents or preview bindings never grant batch permission', () => {
  const store = new PermissionStore(':memory:');
  try {
    const sources = batchSources(); const request = batchInput(store, sources);
    for (const patch of [{ groupId: 'OTHER' }, { conversationVersions: [source.version] }, { conversationVersions: [...request.conversationVersions, 'extra-version'] }, { conversationVersions: [...request.conversationVersions].reverse() }, { sourceFingerprint: '0'.repeat(64) }]) {
      assert.throws(() => store.approveBatch(sources, { ...request, ...patch }), /BATCH_SOURCE_MISMATCH/);
    }
    const changed = [sources[0], { ...sources[1], messages: [...sources[1].messages].reverse() }];
    assert.throws(() => store.approveBatch(changed, request), /BATCH_SOURCE_MISMATCH/);
    for (const patch of [{ syntheticAttestation: false }, { freeTierUseApproved: false }, { origin: 'agent_demo' }, { reviewer: ' ' }, { reason: '' }, { extraField: 'must reject' }]) assert.throws(() => store.approveBatch(sources, { ...request, ...patch }));
    for (const item of sources) assert.equal(store.getPermission(item.version), undefined);
  } finally { store.close(); }
});

test('an existing conflicting per-source binding is detected before any batch insert', () => {
  const store = new PermissionStore(':memory:');
  try {
    const sources = batchSources(); const previous = store.approve(sources[1], input);
    const changed = [sources[0], { ...sources[1], messages: sources[1].messages.map((message, index) => index ? message : { ...message, text: 'A changed but still purely fabricated source.' }) }];
    assert.throws(() => store.approveBatch(changed, batchInput(store, changed)), /IMMUTABLE_PERMISSION_SOURCE/);
    assert.equal(store.getPermission(sources[0].version), undefined); assert.deepEqual(store.getPermission(sources[1].version), previous);
  } finally { store.close(); }
});

test('a mid-batch SQLite failure rolls back every child approval and request', () => {
  mkdirSync(resolve('tmp'), { recursive: true }); const directory = mkdtempSync(join(resolve('tmp'), 'batch-permission-rollback-')); const path = join(directory, 'isolated.sqlite');
  const store = new PermissionStore(path); const direct = new DatabaseSync(path);
  try {
    const sources = batchSources(); const request = batchInput(store, sources);
    direct.exec("CREATE TRIGGER fixture_insert_failure BEFORE INSERT ON permission_approvals WHEN NEW.conversation_version='new-group-fixture-v2' BEGIN SELECT RAISE(ABORT,'INJECTED_SOFTWARE_STORAGE_FAILURE'); END;");
    assert.throws(() => store.approveBatch(sources, request), /INJECTED_SOFTWARE_STORAGE_FAILURE/);
    assert.equal(direct.prepare('SELECT COUNT(*) AS count FROM permission_approvals').get()?.count, 0);
    assert.equal(direct.prepare('SELECT COUNT(*) AS count FROM permission_requests').get()?.count, 0);
    for (const item of sources) assert.equal(store.resolve(item), item);
  } finally { direct.close(); store.close(); const target = resolve(directory); assert(target.startsWith(resolve('tmp') + '\\') || target.startsWith(resolve('tmp') + '/')); rmSync(target, { recursive: true }); }
});

test('batch grant audit and replay survive restart without duplicate child rows', () => {
  mkdirSync(resolve('tmp'), { recursive: true }); const directory = mkdtempSync(join(resolve('tmp'), 'batch-permission-restart-')); const path = join(directory, 'isolated.sqlite');
  try {
    const sources = batchSources(); const firstStore = new PermissionStore(path); const request = batchInput(firstStore, sources);
    const first = firstStore.approveBatch(sources, request); firstStore.close();
    const secondStore = new PermissionStore(path);
    try {
      assert.deepEqual(secondStore.approveBatch(sources, request), first);
      for (const item of sources) assert.equal(secondStore.resolve(item).classification, 'synthetic_allowed');
      const direct = new DatabaseSync(path, { readOnly: true });
      try { assert.equal(direct.prepare('SELECT COUNT(*) AS count FROM permission_approvals').get()?.count, 2); assert.equal(direct.prepare('SELECT COUNT(*) AS count FROM permission_requests').get()?.count, 3); }
      finally { direct.close(); }
    } finally { secondStore.close(); }
  } finally { const target = resolve(directory); assert(target.startsWith(resolve('tmp') + '\\') || target.startsWith(resolve('tmp') + '/')); rmSync(target, { recursive: true }); }
});
