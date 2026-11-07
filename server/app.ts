import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { Store } from './store.js';
import { initialChecklist, validateChecklist } from '../src/checklist.js';
import { fetchOrganizerGroup, parseOrganizerResponse } from './importer.js';
import { evaluateAndSave } from './evaluation-service.js';
import { EvaluationRunError, publicErrorCode } from './errors.js';
import { ReviewStore } from './reviews.js';
import { QualityStore } from './quality.js';
import { saveManualEvaluation } from './manual.js';
import { AudioService, AudioError } from './audio.js';
import { PermissionStore } from './data-permissions.js';
import { publicAttempt } from './recovery.js';

export async function createApp(store = new Store(config.dbPath), reviews = new ReviewStore(':memory:'), quality = new QualityStore(':memory:'), permissions = new PermissionStore(store.path)) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const audio = new AudioService(store);
  store.saveChecklist(initialChecklist);
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const host = req.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return reply.code(403).send({ error: 'LOCAL_HOST_REQUIRED' });
    if (req.url.startsWith('/api/') && (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== `http://${host}`))) return reply.code(403).send({ error: 'CROSS_ORIGIN_BLOCKED' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}`) return reply.code(403).send({ error: 'CROSS_ORIGIN_BLOCKED' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: 'CROSS_ORIGIN_BLOCKED' });
      if (!req.headers['content-type']?.startsWith('application/json')) return reply.code(415).send({ error: 'JSON_REQUIRED' });
    }
  });
  app.setErrorHandler((error, req, reply) => {
    const code = publicErrorCode(error);
    const stored = error instanceof EvaluationRunError ? store.getEvaluationAttempt(error.attemptId) : undefined;
    const attempt = stored ? publicAttempt(store, stored) : undefined;
    const runConflict = code === 'IDEMPOTENCY_CONFLICT' && req.url.split('?')[0] === '/api/evaluations';
    reply.code(runConflict || ['EVALUATION_BUSY', 'RECOVERY_ALREADY_STARTED', 'RECOVERY_LIMIT_REACHED'].includes(code) ? 409 : 400).send({ error: code, ...(attempt ? { attempt, recovery: attempt.recovery } : {}) });
  });
  app.get('/api/status', async () => ({
    phase: 'next-implementation', provider: config.provider, model: config.model, mode: config.mode,
    apiKeyPresent: Boolean(config.apiKey), freeTierConfirmed: config.freeTierConfirmed,
    organizerConfigured: Boolean(config.organizerUrl),
    liveEvaluationCount: store.listEvaluations().filter(e => e.status === 'live_validated').length,
    manualEvaluationCount: store.listEvaluations().filter(e => e.status !== 'live_validated').length,
  }));
  app.get('/api/conversations', async () => store.listConversations().map(source => permissions.resolve(source)).map(c => ({
    version: c.version, groupId: c.groupId, conversationId: c.conversationId, language: c.language,
    channel: c.channel, classification: c.classification, messageCount: c.messages.length, audioAvailable: c.audioAvailable,
  })));
  app.get<{ Params: { version: string } }>('/api/conversations/:version', async (req, reply) => {
    const c = store.getConversation(req.params.version);
    return c ? permissions.resolve(c) : reply.code(404).send({ error: 'NOT_FOUND' });
  });
  app.get<{ Params: { version: string } }>('/api/conversations/:version/permission', async req => permissions.getPermission(req.params.version) || null);
  app.post<{ Params: { version: string } }>('/api/conversations/:version/permission', async req => {
    const conversation = store.getConversation(req.params.version);
    if (!conversation) throw new Error('SOURCE_NOT_FOUND');
    return permissions.approve(conversation, req.body);
  });
  app.get<{ Params: { version: string } }>('/api/conversations/:version/audio/status', async req => audio.status(req.params.version));
  app.get<{ Params: { version: string } }>('/api/conversations/:version/audio', async (req, reply) => {
    try {
      const result = await audio.stream(req.params.version, req.headers.range);
      reply.code(result.statusCode);
      for (const [header, value] of Object.entries(result.headers)) reply.header(header, value);
      return reply.send(result.body);
    } catch (error) {
      const code = error instanceof AudioError ? error.code : 'AUDIO_UNAVAILABLE';
      return reply.code(code === 'AUDIO_INVALID_RANGE' ? 416 : 502).send({ error: code });
    }
  });
  app.post('/api/import', async (req) => {
    const { groupId } = z.object({ groupId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }).strict().parse(req.body);
    const parsed = await fetchOrganizerGroup(config.organizerUrl || '', groupId);
    return store.importDataset(parsed);
  });
  app.post('/api/import-file', { bodyLimit: 16 * 1024 * 1024 }, async req => {
    const { payload } = z.object({ payload: z.unknown() }).strict().parse(req.body);
    const parsed = parseOrganizerResponse(payload);
    return { ...store.importDataset(parsed), groupId: parsed.groupId, source: 'local-json' };
  });
  app.get('/api/checklists', async () => store.listChecklists());
  app.post('/api/checklists', async req => {
    const checklist = validateChecklist(req.body);
    store.saveChecklist(checklist);
    return checklist;
  });
  app.get('/api/evaluations', async () => store.listEvaluations());
  app.get('/api/evaluation-attempts', async () => store.listEvaluationAttempts().map(a => publicAttempt(store, a)));
  app.get<{ Params: { id: string } }>('/api/evaluation-attempts/:id', async (req, reply) => {
    const attempt = store.getEvaluationAttempt(req.params.id);
    return attempt ? publicAttempt(store, attempt) : reply.code(404).send({ error: 'ATTEMPT_NOT_FOUND' });
  });
  app.get<{ Querystring: { manifestId?: string } }>('/api/quality', async req => quality.getDashboard(store, req.query.manifestId));
  app.get<{ Querystring: { manifestId?: string; cutoff?: string } }>('/api/quality/export', async req => quality.exportComparison(store, req.query.manifestId, req.query.cutoff));
  app.post('/api/quality/review-rounds', async req => quality.startFreshReviewRound(req.body));
  app.get<{ Params: { caseId: string }; Querystring: { manifestId?: string } }>('/api/quality/cases/:caseId', async req => {
    const manifestId = req.query.manifestId || quality.getManifest()?.id;
    if (!manifestId) throw new Error('VALIDATION_MANIFEST_NOT_FOUND');
    return quality.getCase(manifestId, req.params.caseId, store);
  });
  app.post('/api/quality/references', async req => {
    const target = z.object({ manifestId: z.string().min(1), caseId: z.string().min(1) }).passthrough().parse(req.body);
    const context = quality.getCase(target.manifestId, target.caseId, store);
    return quality.saveReference(context.conversation, context.checklist, req.body);
  });
  app.post('/api/quality/evidence-reviews', async req => quality.saveEvidenceReview(req.body, store));
  app.post('/api/manual-evaluations', async req => saveManualEvaluation(store, req.body));
  app.get<{ Params: { id: string } }>('/api/evaluations/:id', async (req, reply) => store.getEvaluation(req.params.id) || reply.code(404).send({ error: 'NOT_FOUND' }));
  const reviewContext = (id: string) => {
    const evaluation = store.getEvaluation(id);
    if (!evaluation) throw new Error('SOURCE_NOT_FOUND');
    const checklist = store.getChecklist(evaluation.checklistVersion);
    if (!checklist) throw new Error('SOURCE_NOT_FOUND');
    return { evaluation, checklist };
  };
  app.get<{ Params: { id: string } }>('/api/evaluations/:id/history', async req => {
    const { evaluation, checklist } = reviewContext(req.params.id);
    return reviews.getHistory(evaluation, checklist);
  });
  app.post<{ Params: { id: string } }>('/api/evaluations/:id/appeals', async req => {
    const body = z.object({ criterionId: z.string().min(1), comment: z.string().trim().min(1).max(5000), requestId: z.string().trim().min(1).max(128) }).strict().parse(req.body);
    const { evaluation, checklist } = reviewContext(req.params.id);
    return reviews.createAppeal(evaluation, checklist, body);
  });
  app.post<{ Params: { id: string } }>('/api/evaluations/:id/decisions', async req => {
    const body = z.object({ appealId: z.string().min(1), action: z.enum(['uphold', 'change']), answer: z.string().optional(), reason: z.string().trim().min(1).max(5000), requestId: z.string().trim().min(1).max(128) }).strict().parse(req.body);
    const { evaluation, checklist } = reviewContext(req.params.id);
    return reviews.decide(evaluation, checklist, body);
  });
  app.post('/api/evaluations', async req => {
    const { conversationVersion, checklistVersion, requestId, retryOf } = z.object({ conversationVersion: z.string().min(1), checklistVersion: z.string().min(1), requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(), retryOf: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional() }).strict().parse(req.body);
    return evaluateAndSave(store, conversationVersion, checklistVersion, { permissions, attemptId: requestId, retryOf });
  });
  if (existsSync(resolve('dist/index.html'))) {
    await app.register(fastifyStatic, { root: resolve('dist') });
    app.setNotFoundHandler((req, reply) => req.url.startsWith('/api/') ? reply.code(404).send({ error: 'NOT_FOUND' }) : reply.sendFile('index.html'));
  }
  app.addHook('onClose', async () => { permissions.close(); quality.close(); reviews.close(); store.close(); });
  return app;
}
