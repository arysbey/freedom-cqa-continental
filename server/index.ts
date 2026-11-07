import { createApp } from './app.js';
import { config } from './config.js';
import { Store } from './store.js';
import { ReviewStore } from './reviews.js';
import { QualityStore } from './quality.js';
import { interruptRecordedAttempts } from './interrupted-attempts.js';

const store = new Store(config.dbPath);
const interruptedIds = store.listEvaluationAttempts().filter(attempt => attempt.status === 'running').map(attempt => attempt.id);
const app = await createApp(store, new ReviewStore(config.dbPath), new QualityStore(config.dbPath));
try {
  await app.listen({ port: config.port, host: '127.0.0.1' });
  interruptRecordedAttempts(store, interruptedIds);
  console.log(`CQA local workspace: http://127.0.0.1:${config.port}`);
} catch { console.error('SERVER_START_FAILED'); process.exitCode = 1; }
process.on('SIGINT', async () => { await app.close(); });
process.on('SIGTERM', async () => { await app.close(); });
