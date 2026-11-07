import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Classification, Conversation } from '../src/domain.js';

const MAX_RESPONSE_BYTES = 15 * 1024 * 1024;
const ORGANIZER_HOST = 'ec88f21f1accecf38e20095a9fe175.a5.environment.api.powerplatform.com';
const ORGANIZER_PATH = '/powerautomate/automations/direct/cu/11/workflows/b3d2a68006a24662be2b721454cb4e00/triggers/manual/paths/invoke';

// Hashes of the 60 explicitly permitted, organizer-provided synthetic DEV chats.
// Matching an ID or channel alone is not permission to transmit the content.
const APPROVED_SYNTHETIC_HASHES = new Set<string>([
  '6090935d4084c4d27d5f3829811c8bc86c2111a5c2e3606be33e045cf6f25c31',
  'acbf5bdd26648cd56c917911c4fceaf33b19ac9a7f19aaaf73ec697412eb380c',
  '0c882478ddad44ba8fe09b81f65effb59eb4444e05bd9ca13d7efdbfcb9eb998',
  'ba241e28a296c13b925a25467902210c7a6a382c969e4595a4717267aed8e0e6',
  '4370fe18cfae3c101d10eae61e47e067fa8a7a8b38f8574ccf351973e2c07c16',
  'ca3bae79669f5612b401a81f7a526fbe0dbed474b292430e1a33ae08343b7553',
  '4f27df74a249556a5b0ade55550bc1646aa2f4945dc797059d71262dc6f11c47',
  'f97a7753df0fdf3ba65133633c502dd754d1d93483dac8b6c8f6a7497efcfe57',
  '4339ecd8f79ffe406405376de9b5e89a06d8a8e63b986d9d218cb9ab283c1554',
  '5657836ddc5fbac3adb14046ad7c5aa3358813a43536a4fff0dc25d896c23b9e',
  'f0b46ab829e7d97d13ccc107bd14c896238f9489a315b4a7f3b7675ef462bb3c',
  '03c0f60e051f984c2c5b49736a3ef670c7b9945a2178bd8bb49a54fcd0b6bb23',
  'e47dfaa925440d0997eb188b5828245f0a269d0a183d1cd115e2a2a4c16ffcc7',
  'f35e8325c4f92cca07d1a0679e7fa4818a9c9347d9eba8df16fbe9776218e5e8',
  'f8cdc745900a5607b8a201175ce5c3b3db74e2950b78da8c4c0026074e24a22a',
  '4ee8872277ef0c5233f466041c4c740407e482bf2a93c4320ab32dfa2b4da03a',
  '30e8fd7de2b82ea10ec6f854ac30c39e60a0af30f40abd63a93ec3c55297efc2',
  '39637d40ac04a62f901710667a13ced0509280075187f79976661dc84abd3fa4',
  'f7b264cb677bafb5f2a3dac7943e0d1f6e33164399e56acd1ef09ca317f53604',
  '02b3d9cc054b518af2b97ebee34021f1636d3054a81f9f1129d648bcaed0edd8',
  'a7737c374d28d577e620a8384d2217e0fcce58ab8321e0144f93551c9ecf5e3c',
  '4d4f750fef6cb323cc93cdbd27c22417050be067f430a28018dc450e5d89e767',
  'a3789c8b9657a2a3f3449fdde18cd36dc8105c4e111c6a9d1888ca5fe1466e58',
  'a9454672c21eb295194d2344acd8a9d964da8921df5c5b4556246e9bde82bc71',
  'c48b76434d8523614a6fb30dae8154ece56955afaffbef1c15ee497180b8d736',
  '18448805020b7bd4d67de7e66b07b281d8c5dcff62ff5fa8a5aa0d35f73b9d35',
  'd630d02869a9035cd64a3debb8a48eb003e11094b57b34f8ba20d50258c3d1aa',
  'a46c01dc6f61dd9dddcd3a2dfa9d57ede84837ec08effcd83bcedd62b93699a8',
  '89f415056b845da03088d878dceb3c81770070dc38be2b2a252418128134c593',
  'e1f4e44a862da4326705af74471174687fba7ccff8cae78955a2493692632f03',
  'a517a68d074d07d00b2c0dd3fd7a384dce93eb856e6e17b81fb6e707031c0735',
  '4557e192d49c1c2e80da9283c860e348cdfe46d66b1bc99f59f67d4daca5618a',
  '22142d89ad19d0726655fb0fafcbbbfe2556ce5b4616897f645dad908a4743b0',
  '669dfc72ebefa6e9e8824aa0a2ac52d65a216e14bc8c941d538eaf91b01befa8',
  'c4c947090ee5d329511ad690d2620bc7cb930926d7bd10d90c0fb2018177479e',
  '72c4e95655bee89cfa5bd25a7c501538903b91887f30a9ebad86ff185688520c',
  '824bc3f415c3fa40a212bb56e31ee6295d6efc1ad0480630dae9b4e4a3578d65',
  '7af5dcffb0cf41a9016a98c98e68c1f99779071dc2cf7e7478a0298890452299',
  'df89f7f67b623012d0d967957a3b091c4417a9042951ec1c6b53c8fc443fabf9',
  '9753773445c7e6ed330c7658128030ea4aa2f62eaa58881c366e32ca04837919',
  'bc14b209d8143b7a87150a664318b89ec584281043ee094abd77c27f1cd7468b',
  '4902a64675e84b4b670b1a5696f97e9c926727e54be60ce985123e29a67c366b',
  '9adb30d5ca5d1961c8df53acc07695cce23feee061bd667f6778652c5b338917',
  '00db76bf32f05233a8b803b9d4a5346d6c3b7f026b0d33689d77dfc449ab836a',
  'b0e7fb18fd22f2bc45296a6247990bdef4db24b369ba34ad660a61d6f905fd53',
  '96e415b3a4b76383ea397a0e78250efdf8a0c102bd3de4a66df64496c9717be8',
  '9abd01733610affeb8650dcd1693cada9b17a01d98fcf3e4837915f1d67c8fd4',
  '615e288e14f12d6313056931c38c3defc8f39a2fb7ed066b3d153d02c0cf4d64',
  '3f8d80c4674e7eed6505d689305b7574091c903492b73e1c1e8096514041b874',
  '211333d4502bffc7c6389411d44f9bf71061312651eb12746b43f4010b4eae29',
  'cd6153dd378311a9dcba10b96cedb4f566fa47dbb828fd98199ea0e48798ac81',
  '5af6c4fdb0ef5e4c3402e9381dbb2b9f5c1fc3798a1ea76b1eb81e855355db5b',
  '11c66f0ecf9627645c06844dc528a141242b17377f82fd88a9f1937eea077e81',
  'f94d49eee3332d76f565ee772297e63aca1050d6b0ef8c4d76d12e03a557447f',
  'bf189dc4cae80235538f656af77132c382c646753c5e0629714e702bac051e56',
  '305e56b6444d7fd2c6d7834d268fff0e9285c0f1d7e2986045a0429bde96b57b',
  '7c96c621ace05a25d71f3235bd788390aa3d228a2b2ca2558834392885683566',
  '7227c0417529ac052cbb93d684b945ed12ee253775679dd5f9f51889f3019dbb',
  'e9dc9c616fa4d935b0b7ceada3ffb9ad7b3835b885e148caf0ed6f045d080284',
  '1ea19e38a96f7d741c1906b3cebd8f03555caef8392889382dcbcc01565c29a3',
]);

const messageSchema = z.object({
  timestamp: z.string().min(1).max(128),
  speaker: z.enum(['client', 'operator', 'bot', 'system']),
  text: z.string().max(1_000_000),
}).passthrough();
const recordSchema = z.object({
  conversation_id: z.string().min(1).max(256),
  channel: z.string().min(1).max(128),
  language: z.string().min(1).max(128),
  transcript: z.array(messageSchema).max(50_000),
  audio_url: z.string().url().nullable().optional(),
}).passthrough();
const responseSchema = z.object({
  error: z.string(),
  isSuccess: z.boolean(),
  data: z.object({
    dataset_group_id: z.string().min(1).max(128),
    total_records: z.number().int().min(0).max(100_000),
    records: z.array(recordSchema).max(100_000),
  }).passthrough(),
}).passthrough();

export interface ParsedDataset {
  groupId: string;
  conversations: Conversation[];
  originals: unknown[];
}

/** Canonical JSON: key order is irrelevant, original array order remains significant. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return '{' + Object.keys(object).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(object[key])).join(',') + '}';
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Unsupported JSON value.');
  return serialized;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** Rechecks content permission at the external-provider boundary, without trusting a flag. */
export function isApprovedSyntheticConversation(conversation: Conversation): boolean {
  if (conversation.classification !== 'synthetic_allowed' || conversation.groupId !== 'DEV' || conversation.channel !== 'agent chat' || conversation.audioAvailable) return false;
  const record = {
    conversation_id: conversation.conversationId,
    channel: conversation.channel,
    language: conversation.language,
    transcript: conversation.messages.map(message => ({ timestamp: message.timestamp, speaker: message.speaker, text: message.text })),
    audio_url: null,
  };
  const version = 'cv_' + digest({ groupId: conversation.groupId, record });
  return APPROVED_SYNTHETIC_HASHES.has(digest(record))
    && version === conversation.version
    && conversation.messages.every((message, position) => message.position === position && message.id === `msg_${version.slice(3)}_${position}`);
}

export function parseOrganizerResponse(input: unknown, expectedGroup?: string): ParsedDataset {
  // Never include Zod issue values, endpoint responses, or signed URLs in errors.
  const parsed = responseSchema.safeParse(input);
  if (!parsed.success) throw new Error('Organizer response does not match the expected schema.');
  const envelope = parsed.data;
  if (!envelope.isSuccess || envelope.error.trim()) throw new Error('Organizer reported an unsuccessful import.');
  const data = envelope.data;
  if (expectedGroup !== undefined && data.dataset_group_id !== expectedGroup) throw new Error('Organizer returned a different dataset group.');
  if (data.total_records !== data.records.length) throw new Error('Organizer record count does not match the response.');
  if (new Set(data.records.map(record => record.conversation_id)).size !== data.records.length) throw new Error('Duplicate conversation IDs in one import.');
  const groupId = data.dataset_group_id;
  const originals = structuredClone(data.records);
  const conversations: Conversation[] = data.records.map(record => {
    const sourceHash = digest(record);
    let classification: Classification = 'unknown';
    if (record.channel === 'voice call') classification = 'real_restricted';
    else if (groupId === 'DEV' && record.channel === 'agent chat' && !record.audio_url && APPROVED_SYNTHETIC_HASHES.has(sourceHash)) classification = 'synthetic_allowed';
    const version = 'cv_' + digest({ groupId, record });
    return {
      version, groupId,
      conversationId: record.conversation_id,
      channel: record.channel,
      language: record.language,
      classification,
      messages: record.transcript.map((message, position) => ({
        id: `msg_${version.slice(3)}_${position}`,
        position,
        timestamp: message.timestamp,
        speaker: message.speaker,
        text: message.text,
      })),
      audioAvailable: Boolean(record.audio_url),
    };
  });
  return { groupId, conversations, originals };
}

export async function fetchOrganizerGroup(endpoint: string, groupId: string, timeoutMs = 30_000): Promise<ParsedDataset> {
  if (!groupId.trim() || groupId.length > 128) throw new Error('Invalid dataset group.');
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('Organizer endpoint is not configured correctly.'); }
  if (url.protocol !== 'https:' || url.hostname !== ORGANIZER_HOST || url.pathname !== ORGANIZER_PATH || url.username || url.password || url.port) {
    throw new Error('Organizer endpoint must use the approved HTTPS host and path.');
  }
  url.searchParams.set('group_id', groupId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, Math.min(timeoutMs, 60_000)));
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`Organizer HTTP status ${response.status}.`);
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('Organizer response exceeds the size limit.');
    if (!response.body) throw new Error('Organizer response has no body.');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          controller.abort();
          await reader.cancel();
          throw new Error('Organizer response exceeds the size limit.');
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Organizer returned invalid JSON.'); }
    return parseOrganizerResponse(input, groupId);
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Organizer import timed out or exceeded its size limit.');
    // Keep our own safe errors; networking exceptions may contain the signed URL.
    if (error instanceof Error && /^(Organizer|Duplicate)/.test(error.message)) throw error;
    throw new Error('Organizer request failed; endpoint details are hidden.');
  } finally {
    clearTimeout(timer);
  }
}
