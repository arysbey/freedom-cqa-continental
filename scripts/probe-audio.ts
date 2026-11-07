import { config } from '../server/config.js';
import { Store } from '../server/store.js';
import { writeFileSync } from 'node:fs';

const store = new Store(config.dbPath);
const results: unknown[] = [];
try {
  for (const conversation of store.listConversations().filter(c => c.channel === 'voice call')) {
    const original = store.getOriginal(conversation.version) as { audio_url?: string };
    const started = Date.now();
    try {
      if (!original.audio_url) throw new Error('MISSING_AUDIO');
      const response = await fetch(original.audio_url, { headers: { Range: 'bytes=0-8191' }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
      const reader = response.body?.getReader();
      const pieces: Uint8Array[] = [];
      let count = 0;
      while (reader && count < 8192) {
        const { value, done } = await reader.read();
        if (done) break;
        pieces.push(value.slice(0, 8192 - count));
        count += Math.min(value.length, 8192 - count);
      }
      await reader?.cancel();
      const bytes = Buffer.concat(pieces.map(p => Buffer.from(p)));
      const contentType = response.headers.get('content-type');
      if (contentType?.includes('html') && process.argv.includes('--inspect-page')) {
        const html = bytes.toString('utf8');
        writeFileSync('private/reports/audio-page.html', html);
        const sources = [...html.matchAll(/<(audio|source|script|a)[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/gi)].map(match => {
          try {
            const url = new URL(match[2].replaceAll('&amp;', '&'), original.audio_url);
            return { tag: match[1], protocol: url.protocol, host: url.host, queryKeys: [...url.searchParams.keys()] };
          } catch { return { tag: match[1], invalid: true }; }
        });
        console.log(JSON.stringify({ hasAudio: /<audio/i.test(html), hasBase64: /base64/i.test(html), sources, inlineScriptLengths: [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1].length) }));
      }
      let shape: unknown = null;
      if (contentType?.includes('json')) {
        try {
          const parsed = JSON.parse(bytes.toString('utf8'));
          shape = { keys: Object.keys(parsed), dataType: typeof parsed.data, dataKeys: parsed.data && typeof parsed.data === 'object' ? Object.keys(parsed.data) : null };
        } catch { shape = 'JSON_BODY_EXCEEDS_PROBE_OR_INVALID'; }
      }
      results.push({ conversationId: conversation.conversationId, version: conversation.version, status: response.status, contentType, contentLength: response.headers.get('content-length'), contentRange: response.headers.get('content-range'), acceptRanges: response.headers.get('accept-ranges'), bytesInspected: bytes.length, magicHex: bytes.subarray(0, 12).toString('hex'), shape, latencyMs: Date.now() - started });
      if (process.argv.includes('--inspect-page')) break;
    } catch (error) {
      results.push({ conversationId: conversation.conversationId, version: conversation.version, error: error instanceof Error && ['TimeoutError','AbortError'].includes(error.name) ? 'AUDIO_TIMEOUT' : 'AUDIO_NETWORK_FAILED', latencyMs: Date.now() - started });
    }
  }
  writeFileSync('private/reports/audio-probe.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally { store.close(); }
