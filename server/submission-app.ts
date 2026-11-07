import type { FastifyInstance } from 'fastify';
import { relative, resolve } from 'node:path';
import { z } from 'zod';
import type { Store } from './store.js';
import type { PermissionStore } from './data-permissions.js';
import { BatchStore, batchExecutorState, createGroupBatch, runGroupBatch } from './batches.js';
import { buildCompetitionExport, competitionTeamName, readCompetitionDataset, writeCompetitionExport } from './competition.js';
import { config } from './config.js';
import { publicErrorCode } from './errors.js';

const groupId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const exportInput = z.object({ groupId, target: z.enum(['dev', 'prod']), teamName: z.string().trim().min(2).max(100) });
export function registerSubmissionRoutes(app: FastifyInstance, store: Store, permissions: PermissionStore, options: { workspaceRoot?: string } = {}) {
  const batches = new BatchStore(store.path);
  const active = new Map<string, { controller: AbortController; promise: Promise<unknown> }>();
  const localPath = (path: string) => relative(resolve(options.workspaceRoot || '.'), path).replaceAll('\\', '/');
  const snapshot = (group: string) => readCompetitionDataset(store.path, group);
  const exportBundle = (input: z.infer<typeof exportInput>) => {
    const dataset = snapshot(input.groupId);
    const settings = { target: input.target, teamName: input.teamName, configuredModel: config.model };
    return { dataset, settings, bundle: buildCompetitionExport(dataset, settings) };
  };
  app.get('/api/competition/groups', async () => {
    const sources = store.listConversations();
    return { teamName: competitionTeamName, model: config.model, groups: [...new Set(sources.map(c => c.groupId))].sort().map(id => ({ groupId: id, records: sources.filter(c => c.groupId === id).length, fixture: /REHEARSAL|CQA_ACCEPTANCE|SOFTWARE|FIXTURE/i.test(id) })) };
  });
  app.get<{ Querystring: unknown }>('/api/competition/coverage', async req => {
    const input = exportInput.parse(req.query);
    const { bundle } = exportBundle(input);
    return { groupId: input.groupId, target: input.target, records: bundle.document.results.length, success: bundle.audit.success, error: bundle.audit.error,
      model: bundle.document.model, teamName: bundle.document.team_name, documentHash: bundle.audit.documentHash,
      recordsSummary: bundle.document.results.map(record => ({ conversationId: record.conversation_id, status: record.status, ...(record.status === 'error' ? { error: record.error } : {}) })) };
  });
  app.post('/api/competition/export', async req => {
    const input = exportInput.extend({ dryRun: z.boolean() }).strict().parse(req.body);
    if (!input.dryRun && /LOCAL_REHEARSAL|CQA_ACCEPTANCE/.test(input.groupId) && !options.workspaceRoot) throw new Error('FIXTURE_OFFICIAL_EXPORT_FORBIDDEN');
    const { dataset, settings, bundle } = exportBundle(input);
    const result = writeCompetitionExport(bundle, dataset, { ...settings, dryRun: input.dryRun, workspaceRoot: options.workspaceRoot });
    return { ...result, outputPath: localPath(result.outputPath), auditPath: localPath(result.auditPath), published: false };
  });
  app.get<{ Querystring: unknown }>('/api/competition/download', async (req, reply) => {
    const input = exportInput.parse(req.query);
    const { bundle } = exportBundle(input);
    return reply.header('Content-Type', 'application/json; charset=utf-8').header('Content-Disposition', `attachment; filename="${input.target}-results.json"`).send(`${JSON.stringify(bundle.document, null, 2)}\n`);
  });
  app.get('/api/competition/batches', async () => batches.list());
  app.get<{ Params: { id: string } }>('/api/competition/batches/:id', async req => batches.required(req.params.id));
  app.post('/api/competition/batches', async req => {
    const input = z.object({ groupId, id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional(), minSpacingMs: z.number().int().min(1000).max(600000).optional(), runBudgetMs: z.number().int().min(1000).max(2700000).optional() }).strict().parse(req.body);
    return createGroupBatch(store, batches, input);
  });
  app.post<{ Params: { id: string } }>('/api/competition/batches/:id/run', async req => {
    const input = z.object({ resume: z.boolean().optional(), recoverInterrupted: z.boolean().optional(), retryQuota: z.boolean().optional() }).strict().parse(req.body);
    let batch = batches.required(req.params.id);
    if (active.size || store.listEvaluationAttempts().some(attempt => attempt.status === 'running') || batches.list().some(other => other.id !== batch.id && other.status === 'running')) throw new Error('BATCH_ALREADY_RUNNING');
    if (batch.status === 'running' && (!input.resume || batchExecutorState(batch) !== 'dead')) throw new Error('BATCH_ALREADY_RUNNING');
    if (input.resume) batch = batches.resume(batch.id, { allowInterruptedRecovery: input.recoverInterrupted, retryQuota: input.retryQuota });
    const controller = new AbortController();
    const promise = runGroupBatch(store, batches, batch.id, { signal: controller.signal, permissions }).catch(error => {
      const code = publicErrorCode(error);
      const latest = batches.required(batch.id);
      if (latest.status === 'running') batches.save({ ...latest, status: 'paused', reason: code });
      return { error: code };
    }).finally(() => active.delete(batch.id));
    active.set(batch.id, { controller, promise });
    return batches.required(batch.id);
  });
  app.post<{ Params: { id: string } }>('/api/competition/batches/:id/pause', async req => batches.pause(req.params.id));
  app.post<{ Params: { id: string } }>('/api/competition/batches/:id/cancel', async req => batches.cancel(req.params.id));
  app.get<{ Querystring: { groupId: string } }>('/api/competition/permissions', async req => {
    const group = groupId.parse(req.query.groupId);
    const eligible = store.listConversations(group).filter(c => c.classification === 'unknown' && c.channel === 'agent chat' && !c.audioAvailable && !permissions.getPermission(c.version));
    return { groupId: group, preview: eligible.length ? permissions.previewBatch(eligible) : null,
      sources: eligible.map(c => ({ conversationId: c.conversationId, conversationVersion: c.version, language: c.language })) };
  });
  app.post('/api/competition/permissions', async req => {
    const input = z.object({ groupId, conversationVersions: z.array(z.string()).min(1).max(1000) }).passthrough().parse(req.body);
    const current = store.listConversations(input.groupId);
    const selected = input.conversationVersions.map(version => current.find(c => c.version === version));
    if (selected.some(c => !c)) throw new Error('DATA_PERMISSION_BATCH_SOURCE_MISMATCH');
    return permissions.approveBatch(selected.filter((c): c is NonNullable<typeof c> => Boolean(c)), req.body);
  });
  app.addHook('preClose', async () => {
    for (const job of active.values()) job.controller.abort();
    await Promise.allSettled([...active.values()].map(job => job.promise));
  });
  app.addHook('onClose', async () => { batches.close(); });
}
