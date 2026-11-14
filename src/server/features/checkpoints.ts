import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { checkProjectCapacity, projectRecordBytes } from '../storage/project-capacity.js';
import { requestIdUsedElsewhere, sameFingerprint } from '../storage/request-ids.js';
import type { WriterAuthorization } from './writer-sessions.js';

type Input = { requestId: string; expectedVersion: number; writerSessionId: string; generation: number; payload: { observationId: string; done: string; failures: string; unverified: string; blockers: string; nextSteps: string } };
type Prior = { fingerprint: string; checkpointId: string; recordVersion: number; committedAt: string };
function error(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string, currentVersion?: number) {
  return reply.code(status).send({ code, message, requestId: request.id, ...(currentVersion === undefined ? {} : { currentVersion }) });
}

export function registerCheckpoints(app: FastifyInstance, db: Database.Database, recordsLimit: number, isOwner: (request: FastifyRequest) => boolean, authorizeWriter: WriterAuthorization) {
  app.get<{ Params: { requestId: string } }>('/api/v1/receipts/:requestId', async (request, reply) => {
    const sql = [
      'SELECT r.project_id AS resourceId, 1 AS recordVersion, p.created_at AS committedAt FROM requests r JOIN projects p ON p.id = r.project_id WHERE r.request_id = ?',
      'SELECT resource_id AS resourceId, record_version AS recordVersion, committed_at AS committedAt FROM workspace_requests WHERE request_id = ?',
      'SELECT observation_id AS resourceId, 1 AS recordVersion, committed_at AS committedAt FROM observation_requests WHERE request_id = ?',
      'SELECT resource_id AS resourceId, record_version AS recordVersion, committed_at AS committedAt FROM change_requests WHERE request_id = ?',
      'SELECT baseline_id AS resourceId, record_version AS recordVersion, committed_at AS committedAt FROM baseline_requests WHERE request_id = ?',
      'SELECT session_id AS resourceId, record_version AS recordVersion, committed_at AS committedAt FROM writer_session_requests WHERE request_id = ?',
      'SELECT checkpoint_id AS resourceId, record_version AS recordVersion, committed_at AS committedAt FROM checkpoint_requests WHERE request_id = ?',
    ];
    for (const query of sql) {
      const found = db.prepare(query).get(request.params.requestId) as { resourceId: string; recordVersion: number; committedAt: string } | undefined;
      if (found) return { requestId: request.params.requestId, ...found };
    }
    return error(request, reply, 404, 'NOT_FOUND', '没有找到该请求的已保存回执。');
  });

  app.get<{ Params: { changeId: string } }>('/api/v1/changes/:changeId/checkpoints', async (request, reply) => {
    if (!db.prepare('SELECT 1 FROM changes WHERE id = ?').get(request.params.changeId)) return error(request, reply, 404, 'NOT_FOUND', '变更不存在。');
    const rows = db.prepare('SELECT p.id, p.cycle, p.record_version AS recordVersion, p.draft_revision_id AS draftRevisionId, p.baseline_id AS baselineId, p.writer_session_id AS writerSessionId, p.observation_id AS observationId, p.actor, p.goal, p.done, p.failures, p.unverified, p.blockers, p.next_steps AS nextSteps, p.created_at AS createdAt, o.path AS observationPath, o.binding_version AS observationBindingVersion, o.created_at AS observationCreatedAt, o.data_json AS observationJson FROM checkpoints p JOIN workspace_observations o ON o.id = p.observation_id WHERE p.change_id = ? ORDER BY p.record_version DESC').all(request.params.changeId) as { observationJson: string }[];
    return { checkpoints: rows.map(({ observationJson, ...row }) => { const observation = JSON.parse(observationJson) as { stable: boolean; limitations: string[] }; return { ...row, observationStable: observation.stable, observationLimitations: observation.limitations }; }) };
  });

  app.post<{ Params: { changeId: string }; Body: Input }>('/api/v1/changes/:changeId/checkpoints', {
    schema: { body: { type: 'object', required: ['requestId', 'expectedVersion', 'writerSessionId', 'generation', 'payload'], additionalProperties: false, properties: {
      requestId: { type: 'string', minLength: 1, maxLength: 128 }, expectedVersion: { type: 'integer', minimum: 1 }, writerSessionId: { type: 'string', minLength: 1 }, generation: { type: 'integer', minimum: 1 },
      payload: { type: 'object', required: ['observationId', 'done', 'failures', 'unverified', 'blockers', 'nextSteps'], additionalProperties: false, properties: {
        observationId: { type: 'string', minLength: 1 }, done: { type: 'string', minLength: 1, maxLength: 200000 }, failures: { type: 'string', minLength: 1, maxLength: 200000 }, unverified: { type: 'string', minLength: 1, maxLength: 200000 }, blockers: { type: 'string', minLength: 1, maxLength: 200000 }, nextSteps: { type: 'string', minLength: 1, maxLength: 200000 },
      } },
    } } },
  }, async (request, reply) => {
    const { changeId } = request.params;
    const { requestId, expectedVersion, writerSessionId, generation, payload } = request.body;
    if ([payload.done, payload.failures, payload.unverified, payload.blockers, payload.nextSteps].some(value => !value.trim())) return error(request, reply, 400, 'INCOMPLETE_CHECKPOINT', '请填写各项进度；没有内容时填写“无”或“未知”。');
    const actor = isOwner(request) ? 'user' : 'agent';
    const command = [changeId, expectedVersion, writerSessionId, generation, actor, payload];
    const fingerprint = JSON.stringify(command);
    const findPrior = () => db.prepare('SELECT fingerprint, checkpoint_id AS checkpointId, record_version AS recordVersion, committed_at AS committedAt FROM checkpoint_requests WHERE request_id = ?').get(requestId) as Prior | undefined;
    const toReceipt = (prior: Prior) => ({ requestId, resourceId: prior.checkpointId, recordVersion: prior.recordVersion, committedAt: prior.committedAt });
    const result = db.transaction(() => {
      const previous = findPrior();
      if (previous) return sameFingerprint(previous.fingerprint, command) ? toReceipt(previous) : 'REQUEST_ID_CONFLICT';
      if (requestIdUsedElsewhere(db, requestId, 'checkpoints')) return 'REQUEST_ID_CONFLICT';
      const session = authorizeWriter(request, writerSessionId, generation, changeId);
      if (typeof session === 'string') return session;
      const change = db.prepare('SELECT c.project_id AS projectId, c.phase, c.cycle, c.version, c.current_revision_id AS revisionId, c.current_baseline_id AS baselineId, r.goal, b.goal AS baselineGoal, b.draft_revision_id AS baselineRevisionId FROM changes c JOIN change_revisions r ON r.id = c.current_revision_id LEFT JOIN baselines b ON b.id = c.current_baseline_id WHERE c.id = ?').get(changeId) as { projectId: string; phase: string; cycle: number; version: number; revisionId: string; baselineId: string | null; goal: string; baselineGoal: string | null; baselineRevisionId: string | null } | undefined;
      if (!change) return 'NOT_FOUND';
      if (change.version !== expectedVersion) return { currentVersion: change.version };
      if (change.phase !== 'Draft' && change.phase !== 'Working') return 'CHANGE_NOT_WRITABLE';
      const workspace = db.prepare('SELECT w.version, w.common_key AS commonKey, p.common_key AS projectCommonKey FROM workspaces w JOIN project_repositories p ON p.project_id = w.project_id WHERE w.id = ? AND w.project_id = ?').get(session.workspaceId, change.projectId) as { version: number; commonKey: string; projectCommonKey: string } | undefined;
      if (!workspace || workspace.version !== session.bindingVersion || workspace.commonKey !== workspace.projectCommonKey) return 'WORKSPACE_CHANGED';
      const observation = db.prepare('SELECT 1 FROM workspace_observations WHERE id = ? AND workspace_id = ? AND binding_version = ?').get(payload.observationId, session.workspaceId, session.bindingVersion);
      if (!observation) return 'OBSERVATION_MISMATCH';
      const before = projectRecordBytes(db, change.projectId);
      const result = { requestId, resourceId: randomUUID(), recordVersion: change.version + 1, committedAt: new Date().toISOString() };
      db.prepare('INSERT INTO checkpoints(id,change_id,cycle,record_version,draft_revision_id,baseline_id,writer_session_id,observation_id,actor,goal,done,failures,unverified,blockers,next_steps,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(result.resourceId, changeId, change.cycle, result.recordVersion, change.baselineRevisionId ?? change.revisionId, change.baselineId, writerSessionId, payload.observationId, actor, change.baselineGoal ?? change.goal, payload.done, payload.failures, payload.unverified, payload.blockers, payload.nextSteps, result.committedAt);
      db.prepare('UPDATE changes SET version = ?, current_checkpoint_id = ? WHERE id = ?').run(result.recordVersion, result.resourceId, changeId);
      db.prepare('INSERT INTO checkpoint_requests(request_id,fingerprint,checkpoint_id,record_version,committed_at) VALUES (?,?,?,?,?)').run(requestId, fingerprint, result.resourceId, result.recordVersion, result.committedAt);
      checkProjectCapacity(db, change.projectId, before, recordsLimit);
      return result;
    })();
    if (typeof result === 'string') return error(request, reply, result === 'NOT_FOUND' ? 404 : result === 'FORBIDDEN' ? 403 : 409, result, result === 'SESSION_EXPIRED' ? '写会话已失效，请重新开始。' : result === 'CHANGE_NOT_WRITABLE' ? '变更正在审阅或已完成验收，当前不能保存进度。' : result === 'FORBIDDEN' ? '没有此写会话的写入授权。' : result === 'OBSERVATION_MISMATCH' ? '工作区观察不属于当前会话的绑定。' : result === 'WORKSPACE_CHANGED' ? '工作区绑定已变化，请重新核对。' : result === 'NOT_FOUND' ? '变更不存在。' : '请求标识已用于不同的内容。');
    if ('currentVersion' in result) return error(request, reply, 409, 'VERSION_CONFLICT', '变更已更新，请刷新后重试。', result.currentVersion);
    return reply.code(201).send(result);
  });
}
