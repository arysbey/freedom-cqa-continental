import { writeFileSync } from 'node:fs';
import { config } from '../server/config.js';
import { Store } from '../server/store.js';
import { AudioService } from '../server/audio.js';
const store = new Store(config.dbPath);
try {
  const audio = new AudioService(store);
  const results = [];
  for (const conversation of store.listConversations().filter(c => c.channel === 'voice call')) {
    const started = Date.now();
    const status = await audio.status(conversation.version);
    results.push({ conversationId: conversation.conversationId, version: conversation.version, ...status, latencyMs: Date.now() - started });
  }
  writeFileSync('private/reports/audio-status.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally { store.close(); }
