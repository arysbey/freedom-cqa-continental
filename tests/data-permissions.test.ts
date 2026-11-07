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
