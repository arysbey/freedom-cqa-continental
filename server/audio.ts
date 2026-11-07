import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import type { Store } from './store.js';

const ORGANIZER_HOST = 'ec88f21f1accecf38e20095a9fe175.a5.environment.api.powerplatform.com';
const MEDIA_HOST = 'freedomholdingcorporation.crm11.dynamics.com';
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const MAX_HTML_BYTES = 64 * 1024;

export class AudioError extends Error {
  constructor(readonly code: string, readonly upstreamStatus?: number) { super(code); }
}
export interface AudioStatus {
  state: 'available' | 'unavailable';
  code: string;
  upstreamStatus?: number;
  byteLength?: number;
  contentType?: string;
  cached?: boolean;
}
interface CachedAudio { file: string; contentType: string; byteLength: number; sha256: string }
export interface AudioOptions {
  cacheDir?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  resolveHost?: (host: string) => Promise<string[]>;
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    const c = Number(address.split('.')[2]);
    return !(a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99) || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19].includes(b));
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    if (value === '::' || value === '::1' || /^(fc|fd|fe[89ab])/.test(value) || value.startsWith('ff')) return false;
    if (value.startsWith('::ffff:') || value.startsWith('2001:db8:')) return false;
    return /^[23][0-9a-f]{0,3}:/.test(value);
  }
  return false;
}
export function parseAudioRange(header: string | undefined, length: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !match[1] && !match[2]) throw new AudioError('AUDIO_INVALID_RANGE');
  let start: number; let end: number;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new AudioError('AUDIO_INVALID_RANGE'); start = Math.max(0, length - suffix); end = length - 1; }
  else { start = Number(match[1]); end = match[2] ? Number(match[2]) : length - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= length) throw new AudioError('AUDIO_INVALID_RANGE');
  return { start, end: Math.min(end, length - 1) };
}
export function sourceTimeSeconds(timestamp: string, firstTimestamp: string): number | null {
  if (/^\d+:\d{2}(?:\.\d+)?$/.test(timestamp)) { const [minutes, seconds] = timestamp.split(':').map(Number); return seconds < 60 ? minutes * 60 + seconds : null; }
  const time = Date.parse(timestamp); const first = Date.parse(firstTimestamp);
  return Number.isFinite(time) && Number.isFinite(first) ? Math.max(0, (time - first) / 1000) : null;
}
function sniffAudio(bytes: Buffer): string | null {
  if (bytes.subarray(0, 3).toString() === 'ID3' || bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE') return 'audio/wav';
  if (bytes.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
  if (bytes.subarray(0, 4).toString() === 'fLaC') return 'audio/flac';
  if (bytes.subarray(4, 8).toString() === 'ftyp') return 'audio/mp4';
  if (bytes.subarray(0, 4).toString('hex') === '1a45dfa3') return 'audio/webm';
  if (bytes.subarray(0, 5).toString() === '#!AMR') return 'audio/amr';
  return null;
}

/** Restricted server-side resolver/cache. Signed source URLs never cross the local API. */
export class AudioService {
  private readonly cacheDir: string;
  private readonly timeoutMs: number;
  private readonly network: typeof fetch;
  private readonly resolveHost: (host: string) => Promise<string[]>;
  private readonly pending = new Map<string, Promise<CachedAudio>>();
  constructor(private readonly store: Store, options: AudioOptions = {}) {
    this.cacheDir = resolve(options.cacheDir || 'private/audio-cache');
    this.timeoutMs = options.timeoutMs || 45000;
    this.network = options.fetch || globalThis.fetch;
    this.resolveHost = options.resolveHost || (async host => (await lookup(host, { all: true })).map(result => result.address));
  }
  private async checkedUrl(value: string, kind: 'organizer' | 'media'): Promise<URL> {
    let url: URL;
    try { url = new URL(value); } catch { throw new AudioError('AUDIO_UNSAFE_SOURCE'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') throw new AudioError('AUDIO_UNSAFE_SOURCE');
    const allowed = kind === 'organizer' ? url.hostname === ORGANIZER_HOST && url.pathname.includes('/Conversation/') : url.hostname === MEDIA_HOST || /^[a-z0-9-]+\.blob\.core\.windows\.net$/.test(url.hostname);
    if (!allowed) throw new AudioError('AUDIO_UNSAFE_SOURCE');
    let addresses: string[];
    try { addresses = await this.resolveHost(url.hostname); } catch { throw new AudioError('AUDIO_DNS_FAILED'); }
    if (!addresses.length || addresses.some(address => !isPublicAddress(address))) throw new AudioError('AUDIO_UNSAFE_ADDRESS');
    return url;
  }
  private async bytes(url: URL, maxBytes: number, signal: AbortSignal, kind: 'organizer' | 'media', redirects = 0): Promise<{ bytes: Buffer; contentType: string }> {
    const response = await this.network(url, { method: 'GET', redirect: 'manual', signal, headers: { Accept: kind === 'organizer' ? 'audio/*, text/html;q=0.8' : 'audio/*,application/octet-stream;q=0.8' } });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      if (redirects >= 2) throw new AudioError('AUDIO_TOO_MANY_REDIRECTS', response.status);
      const location = response.headers.get('location');
      if (!location) throw new AudioError('AUDIO_REDIRECT_MISSING', response.status);
      const target = await this.checkedUrl(new URL(location, url).href, kind);
      return this.bytes(target, maxBytes, signal, kind, redirects + 1);
    }
    if (!response.ok) { await response.body?.cancel(); throw new AudioError(`AUDIO_HTTP_${response.status}`, response.status); }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) { await response.body?.cancel(); throw new AudioError('AUDIO_TOO_LARGE'); }
    const chunks: Buffer[] = []; let length = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new AudioError('AUDIO_EMPTY_RESPONSE');
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) throw new AudioError('AUDIO_TOO_LARGE');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => undefined); }
    if (!length) throw new AudioError('AUDIO_EMPTY_RESPONSE');
    return { bytes: Buffer.concat(chunks), contentType: response.headers.get('content-type') || '' };
  }
  private async load(version: string): Promise<CachedAudio> {
    const conversation = this.store.getConversation(version);
    if (!conversation) throw new AudioError('SOURCE_NOT_FOUND');
    if (conversation.channel !== 'voice call' || !conversation.audioAvailable) throw new AudioError('AUDIO_NOT_PROVIDED');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(version)) throw new AudioError('AUDIO_UNSAFE_SOURCE');
    const file = resolve(this.cacheDir, `${version}.audio`); const metadataFile = `${file}.json`;
    if (existsSync(file) && existsSync(metadataFile)) {
      try {
        const metadata = JSON.parse(readFileSync(metadataFile, 'utf8')) as CachedAudio;
        if (metadata.byteLength === statSync(file).size && metadata.byteLength > 0 && metadata.byteLength <= MAX_AUDIO_BYTES) {
          const bytes = readFileSync(file); const contentType = sniffAudio(bytes);
          if (contentType && metadata.sha256 === createHash('sha256').update(bytes).digest('hex')) return { ...metadata, file, contentType };
        }
      } catch { /* Re-fetch an invalid/incomplete local cache. */ }
    }
    const original = this.store.getOriginal(version) as { audio_url?: unknown } | undefined;
    if (typeof original?.audio_url !== 'string') throw new AudioError('AUDIO_NOT_PROVIDED');
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const source = await this.checkedUrl(original.audio_url, 'organizer');
      let result = await this.bytes(source, MAX_AUDIO_BYTES, signal, 'organizer');
      let contentType = sniffAudio(result.bytes);
      if (!contentType && /text\/html/i.test(result.contentType)) {
        if (result.bytes.length > MAX_HTML_BYTES) throw new AudioError('AUDIO_INVALID_WRAPPER');
        const html = result.bytes.toString('utf8');
        const match = /<(?:source|audio)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(html);
        if (!match) throw new AudioError('AUDIO_SOURCE_MISSING');
        const target = await this.checkedUrl(new URL(match[1].replaceAll('&amp;', '&').replaceAll('&#38;', '&'), source).href, 'media');
        result = await this.bytes(target, MAX_AUDIO_BYTES, signal, 'media');
        contentType = sniffAudio(result.bytes);
      }
      if (!contentType) throw new AudioError('AUDIO_RESPONSE_NOT_MEDIA');
      const metadata = { file, contentType, byteLength: result.bytes.length, sha256: createHash('sha256').update(result.bytes).digest('hex') };
      try {
        mkdirSync(this.cacheDir, { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        writeFileSync(temporary, result.bytes); renameSync(temporary, file);
        writeFileSync(metadataFile, JSON.stringify({ ...metadata, file: undefined }));
      } catch { throw new AudioError('AUDIO_CACHE_WRITE_FAILED'); }
      return metadata;
    } catch (error) {
      if (error instanceof AudioError) throw error;
      throw new AudioError(signal.aborted ? 'AUDIO_TIMEOUT' : 'AUDIO_NETWORK_FAILED');
    }
  }
  private get(version: string): Promise<CachedAudio> {
    const previous = this.pending.get(version);
    if (previous) return previous;
    const request = this.load(version).finally(() => { this.pending.delete(version); });
    this.pending.set(version, request); return request;
  }
  async status(version: string): Promise<AudioStatus> {
    try { const audio = await this.get(version); return { state: 'available', code: 'AUDIO_READY', contentType: audio.contentType, byteLength: audio.byteLength, cached: true }; }
    catch (error) { return { state: 'unavailable', code: error instanceof AudioError ? error.code : 'AUDIO_NETWORK_FAILED', ...(error instanceof AudioError && error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}) }; }
  }
  async stream(version: string, rangeHeader?: string) {
    const audio = await this.get(version); const range = parseAudioRange(rangeHeader, audio.byteLength);
    const headers: Record<string, string> = { 'Content-Type': audio.contentType, 'Accept-Ranges': 'bytes', 'Content-Length': String(range ? range.end - range.start + 1 : audio.byteLength), 'Content-Disposition': 'inline; filename="conversation-audio"' };
    if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${audio.byteLength}`;
    return { statusCode: range ? 206 : 200, headers, body: createReadStream(audio.file, range || undefined) };
  }
}
