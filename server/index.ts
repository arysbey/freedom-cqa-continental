import { createApp } from './app.js';
import { config } from './config.js';
import { Store } from './store.js';
import { ReviewStore } from './reviews.js';

const app = await createApp(new Store(config.dbPath), new ReviewStore(config.dbPath));
try {
  await app.listen({ port: config.port, host: '127.0.0.1' });
  console.log(`CQA local workspace: http://127.0.0.1:${config.port}`);
} catch { console.error('SERVER_START_FAILED'); process.exitCode = 1; }
process.on('SIGINT', async () => { await app.close(); });
process.on('SIGTERM', async () => { await app.close(); });
