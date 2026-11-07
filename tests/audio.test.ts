import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { AudioService, isPublicAddress, parseAudioRange, sourceTimeSeconds } from '../server/audio.js';
import { Store } from '../server/store.js';
import { parseOrganizerResponse } from '../server/importer.js';

const organizer = 'https://ec88f21f1accecf38e20095a9fe175.a5.environment.api.powerplatform.com/path/Conversation/test?sig=TEST-ONLY';
const media = 'https://freedomholdingcorporation.crm11.dynamics.com/test.mp3?sig=TEST-ONLY';
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2045, 1)]);
function setup(url = organizer) {
  const store = new Store(':memory:');
  const data = parseOrganizerResponse({ error: '', isSuccess: true, data: { dataset_group_id: 'TEST', total_records: 1, records: [{ conversation_id: 'invented-call', channel: 'voice call', language: 'RU', audio_url: url, transcript: [] }] } });
  store.importDataset(data);
  mkdirSync('tmp/tests', { recursive: true });
  return { store, version: data.conversations[0].version, cacheDir: mkdtempSync(resolve('tmp/tests/cqa-audio-')) };
}
const publicDns = async () => ['8.8.8.8'];
function network(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input, init) => handler(String(input), init)) as typeof fetch;
}
test('audio ranges support normal, suffix and open-ended requests and reject invalid/multiple ranges', () => {
  assert.deepEqual(parseAudioRange('bytes=0-99', 200), { start: 0, end: 99 });
  assert.deepEqual(parseAudioRange('bytes=190-', 200), { start: 190, end: 199 });
  assert.deepEqual(parseAudioRange('bytes=-20', 200), { start: 180, end: 199 });
  assert.deepEqual(parseAudioRange('bytes=0-9999', 200), { start: 0, end: 199 });
  assert.equal(parseAudioRange(undefined, 200), null);
  for (const header of ['bytes=200-', 'bytes=4-1', 'bytes=-0', 'bytes=0-1,3-4', 'items=0-1']) assert.throws(() => parseAudioRange(header, 200), /INVALID_RANGE/);
});
test('rejects private, loopback, link-local, mapped and non-address DNS destinations', () => {
  for (const address of ['127.0.0.1', '10.2.3.4', '172.16.1.2', '192.168.1.2', '169.254.1.2', '0.0.0.0', '100.64.1.2', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'not-an-address']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true); assert.equal(isPublicAddress('2603:1030:20e:3::23c'), true);
});
test('source timeline offsets preserve original ISO timestamps and chat minute seconds', () => {
  assert.equal(sourceTimeSeconds('2026-11-01T12:00:10.500Z', '2026-11-01T12:00:00Z'), 10.5);
  assert.equal(sourceTimeSeconds('02:04', ''), 124); assert.equal(sourceTimeSeconds('00:99', ''), null);
  assert.equal(sourceTimeSeconds('bad', 'bad'), null);
});
test('resolves organizer HTML audio wrapper privately, caches media, and serves local byte ranges', async () => {
  const { store, version, cacheDir } = setup(); let calls = 0;
  const audio = new AudioService(store, { cacheDir, resolveHost: publicDns, fetch: network(url => { calls++; return url === organizer ? new Response(`<audio controls><source src="${media.replaceAll('&', '&amp;')}"/></audio>`, { headers: { 'Content-Type': 'text/html' } }) : new Response(mp3, { headers: { 'Content-Type': 'audio/mpeg' } }); }) });
  const status = await audio.status(version);
  assert.equal(status.state, 'available', JSON.stringify({ ...status, calls })); assert.equal(status.contentType, 'audio/mpeg'); assert.equal(status.byteLength, mp3.length);
  assert(!JSON.stringify(status).includes('sig=')); assert(!JSON.stringify(status).includes('https:'));
  const response = await audio.stream(version, 'bytes=0-99');
  assert.equal(response.statusCode, 206); assert.equal(response.headers['Content-Range'], `bytes 0-99/${mp3.length}`);
  const chunks = []; for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).length, 100); assert.equal(calls, 2);
  const reopened = new AudioService(store, { cacheDir, resolveHost: publicDns, fetch: network(() => { throw new Error('CACHE_MUST_AVOID_NETWORK'); }) });
  assert.equal((await reopened.status(version)).state, 'available'); store.close();
});
test('blocks arbitrary signed URLs, hostile wrapper media hosts, and private DNS without exposing credentials', async () => {
  const unsafe = setup('https://127.0.0.1/test?sig=SECRET');
  const blocked = await new AudioService(unsafe.store, { cacheDir: unsafe.cacheDir, resolveHost: publicDns, fetch: network(() => { throw new Error('NO_REQUEST'); }) }).status(unsafe.version);
  assert.equal(blocked.code, 'AUDIO_UNSAFE_SOURCE'); assert(!JSON.stringify(blocked).includes('SECRET')); unsafe.store.close();
  const { store, version, cacheDir } = setup();
  const privateDns = new AudioService(store, { cacheDir, resolveHost: async () => ['127.0.0.1'], fetch: network(() => { throw new Error('NO_REQUEST'); }) });
  assert.equal((await privateDns.status(version)).code, 'AUDIO_UNSAFE_ADDRESS');
  const hostile = new AudioService(store, { cacheDir, resolveHost: publicDns, fetch: network(() => new Response('<audio src="https://attacker.example/media.mp3?sig=SECRET">', { headers: { 'Content-Type': 'text/html' } })) });
  assert.equal((await hostile.status(version)).code, 'AUDIO_UNSAFE_SOURCE'); store.close();
});
test('reports real upstream errors, missing audio, invalid media and timeout as unavailable', async () => {
  const { store, version, cacheDir } = setup();
  const unavailable = new AudioService(store, { cacheDir, resolveHost: publicDns, fetch: network(() => new Response('private signed URL might be echoed here', { status: 403 })) });
  assert.deepEqual(await unavailable.status(version), { state: 'unavailable', code: 'AUDIO_HTTP_403', upstreamStatus: 403 });
  const notMedia = new AudioService(store, { cacheDir, resolveHost: publicDns, fetch: network(() => new Response('not media', { headers: { 'Content-Type': 'audio/mpeg' } })) });
  assert.equal((await notMedia.status(version)).code, 'AUDIO_RESPONSE_NOT_MEDIA');
  const timeout = new AudioService(store, { cacheDir, timeoutMs: 10, resolveHost: publicDns, fetch: network((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('SECRET_URL')), { once: true }))) });
  assert.equal((await timeout.status(version)).code, 'AUDIO_TIMEOUT');
  assert.equal((await unavailable.status('missing')).code, 'SOURCE_NOT_FOUND'); store.close();
});
