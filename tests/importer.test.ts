import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson, fetchOrganizerGroup, isApprovedSyntheticConversation, parseOrganizerResponse } from '../server/importer.js';

const endpoint = 'https://ec88f21f1accecf38e20095a9fe175.a5.environment.api.powerplatform.com/powerautomate/automations/direct/cu/11/workflows/b3d2a68006a24662be2b721454cb4e00/triggers/manual/paths/invoke?sig=test-only';
function fixture(group = 'DEV') {
  return {
    error: '', isSuccess: true,
    data: { dataset_group_id: group, total_records: 1, records: [{
      conversation_id: 'p1-ru-001', channel: 'agent chat', language: 'RU', audio_url: null,
      transcript: [
        { timestamp: '00:00', speaker: 'client', text: 'Invented fixture', additional_field: 'keep original' },
        { timestamp: '00:00', speaker: 'operator', text: 'Invented reply' },
      ], extra_source_field: 'preserved',
    }] },
  };
}

test('import preserves duplicate timestamps, original order, roles and text with positional IDs', () => {
  const source = fixture();
  const parsed = parseOrganizerResponse(source, 'DEV');
  assert.equal(parsed.conversations.length, 1);
  assert.equal(parsed.conversations[0].messages.length, 2);
  assert.deepEqual(parsed.conversations[0].messages.map(message => message.timestamp), ['00:00', '00:00']);
  assert.deepEqual(parsed.conversations[0].messages.map(message => message.speaker), ['client', 'operator']);
  assert.deepEqual(parsed.conversations[0].messages.map(message => message.text), ['Invented fixture', 'Invented reply']);
  assert.notEqual(parsed.conversations[0].messages[0].id, parsed.conversations[0].messages[1].id);
  assert.deepEqual(parsed.originals[0], source.data.records[0]);
  source.data.records[0].transcript[0].text = 'changed after import';
  assert.equal(parsed.conversations[0].messages[0].text, 'Invented fixture');
  assert.equal((parsed.originals[0] as typeof source.data.records[0]).transcript[0].text, 'Invented fixture');
});

test('classification fails closed for spoofed DEV IDs and new groups', () => {
  assert.equal(parseOrganizerResponse(fixture()).conversations[0].classification, 'unknown');
  assert.equal(parseOrganizerResponse(fixture('CONTROL')).conversations[0].classification, 'unknown');
  const spoof = parseOrganizerResponse(fixture()).conversations[0];
  spoof.classification = 'synthetic_allowed';
  assert.equal(isApprovedSyntheticConversation(spoof), false);
  const voice = fixture();
  voice.data.records[0].channel = 'voice call';
  assert.equal(parseOrganizerResponse(voice).conversations[0].classification, 'real_restricted');
});

test('unknown new language/channel is retained and never grants permission', () => {
  const source = fixture('CONTROL-42');
  source.data.records[0].language = 'NEW';
  source.data.records[0].channel = 'new channel';
  const record = parseOrganizerResponse(source, 'CONTROL-42').conversations[0];
  assert.equal(record.language, 'NEW');
  assert.equal(record.channel, 'new channel');
  assert.equal(record.classification, 'unknown');
});

test('canonical versions are stable for object key order but change for transcript content/order', () => {
  const source = fixture();
  const first = parseOrganizerResponse(source).conversations[0];
  const same = { data: source.data, isSuccess: true, error: '' };
  assert.equal(first.version, parseOrganizerResponse(same).conversations[0].version);
  assert.equal(canonicalJson({ b: 1, a: ['x', 'y'] }), canonicalJson({ a: ['x', 'y'], b: 1 }));
  source.data.records[0].transcript.reverse();
  assert.notEqual(first.version, parseOrganizerResponse(source).conversations[0].version);
  assert.notEqual(first.messages[0].id, parseOrganizerResponse(source).conversations[0].messages[0].id);
});

test('empty transcripts and long transcripts are imported without truncation', () => {
  const empty = fixture();
  empty.data.records[0].transcript = [];
  assert.equal(parseOrganizerResponse(empty).conversations[0].messages.length, 0);
  const long = fixture('CONTROL');
  long.data.records[0].transcript = Array.from({ length: 5000 }, (_, index) => ({ timestamp: '00:00', speaker: 'operator', text: `message ${index}`, additional_field: '' }));
  const parsed = parseOrganizerResponse(long);
  assert.equal(parsed.conversations[0].messages.length, 5000);
  assert.equal(parsed.conversations[0].messages[4999].text, 'message 4999');
});

test('schema failures are explicit and never echo confidential input', () => {
  const invalidCases: unknown[] = [null, [], {}, { ...fixture(), isSuccess: false }, { ...fixture(), error: 'secret endpoint value' }];
  const count = fixture(); count.data.total_records = 9; invalidCases.push(count);
  const speaker = fixture(); speaker.data.records[0].transcript[0].speaker = 'other'; invalidCases.push(speaker);
  const duplicate = fixture(); duplicate.data.records.push(structuredClone(duplicate.data.records[0])); duplicate.data.total_records = 2; invalidCases.push(duplicate);
  for (const source of invalidCases) assert.throws(() => parseOrganizerResponse(source), error => error instanceof Error && !error.message.includes('secret endpoint value'));
  assert.throws(() => parseOrganizerResponse(fixture(), 'OTHER'), /different dataset group/);
});

test('organizer adapter rejects unsafe URLs before making a request', async () => {
  for (const url of ['http://localhost/', 'https://localhost/', 'https://evil.example/', endpoint.replace('/paths/invoke', '/paths/elsewhere'), 'invalid']) {
    await assert.rejects(fetchOrganizerGroup(url, 'DEV'), /endpoint/);
  }
  await assert.rejects(fetchOrganizerGroup(endpoint, ''), /Invalid dataset group/);
});

test('organizer adapter updates group_id server-side, does not follow redirects, parses response', async context => {
  const mock = context.mock.method(globalThis, 'fetch', async (url: URL | RequestInfo, options?: RequestInit) => {
    assert.equal(new URL(String(url)).searchParams.get('group_id'), 'CONTROL');
    assert.equal(new URL(String(url)).searchParams.get('sig'), 'test-only');
    assert.equal(options?.redirect, 'error');
    return new Response(JSON.stringify(fixture('CONTROL')), { headers: { 'content-type': 'application/json' } });
  });
  const parsed = await fetchOrganizerGroup(endpoint, 'CONTROL');
  assert.equal(parsed.groupId, 'CONTROL');
  assert.equal(mock.mock.callCount(), 1);
});

test('HTTP, malformed JSON, oversize, and network errors are bounded and safe', async context => {
  const mock = context.mock.method(globalThis, 'fetch');
  mock.mock.mockImplementation(async () => new Response('unavailable', { status: 503 }));
  await assert.rejects(fetchOrganizerGroup(endpoint, 'DEV'), /HTTP status 503/);
  mock.mock.mockImplementation(async () => new Response('not json'));
  await assert.rejects(fetchOrganizerGroup(endpoint, 'DEV'), /invalid JSON/);
  mock.mock.mockImplementation(async () => new Response('{}', { headers: { 'content-length': '999999999' } }));
  await assert.rejects(fetchOrganizerGroup(endpoint, 'DEV'), /size limit/);
  mock.mock.mockImplementation(async () => { throw new Error('secret signed URL'); });
  await assert.rejects(fetchOrganizerGroup(endpoint, 'DEV'), error => error instanceof Error && error.message === 'Organizer request failed; endpoint details are hidden.');
});

test('organizer request timeout aborts', async context => {
  context.mock.method(globalThis, 'fetch', (_url: unknown, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('AbortError')), { once: true });
  }));
  await assert.rejects(fetchOrganizerGroup(endpoint, 'DEV', 100), /timed out/);
});
