import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

loadEnv({ quiet: true });
loadEnv({ path: '.env.local', quiet: true });
const boundedNumber = (name: string, fallback: number, min: number, max: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid configuration: ${name}`);
  return value;
};
if (process.env.CQA_MODE && process.env.CQA_MODE !== 'free') throw new Error('Only explicitly confirmed free mode is enabled.');
if (process.env.CQA_PROVIDER && process.env.CQA_PROVIDER !== 'gemini') throw new Error('Unsupported provider.');
export const config = {
  apiKey: process.env.GEMINI_API_KEY,
  freeTierConfirmed: process.env.GEMINI_FREE_TIER_CONFIRMED === 'true',
  provider: 'gemini' as const,
  model: process.env.CQA_MODEL || 'gemini-3.1-flash-lite',
  mode: 'free' as const,
  timeoutMs: boundedNumber('CQA_TIMEOUT_MS', 120000, 1000, 120000),
  retryLimit: boundedNumber('CQA_RETRY_LIMIT', 1, 0, 1),
  organizerUrl: process.env.CQA_ORGANIZER_URL,
  dbPath: resolve(process.env.CQA_DB_PATH || 'private/cqa.sqlite'),
  port: boundedNumber('PORT', 3001, 1024, 65535),
};
