import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { identifyWorkspace, pathKey } from '../workspace/git.js';
import { checkProjectCapacity, projectRecordBytes } from '../storage/project-capacity.js';
import { requestIdUsedElsewhere, sameFingerprint } from '../storage/request-ids.js';

export type Session = { id: string; changeId: string; workspaceId: string; bindingVersion: number; actor: 'user' | 'agent'; generation: number; status: string; claimHash: string | null };
export type WriterAuthorization = (request: FastifyRequest, sessionId: string, generation: number, changeId?: string) => Session | 'SESSION_EXPIRED' | 'FORBIDDEN';
type Prior = { fingerprint: string; sessionId: string; recordVersion: number; committedAt: string };
type Start = { requestId: string; expectedVersion: number; payload: { workspaceId: string; expectedBindingVersion: number; toolLabel: string } };
type Release = { requestId: string; expectedVersion: number; generation: number };
type Takeover = { requestId: string; expectedVersion: number; payload: { writerSessionId: string; expectedGeneration: number; expectedCheckpointId: string | null; toolLabel: string } };

function error(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string, currentVersion?: number) {
  return reply.code(status).send({ code, message, requestId: request.id, ...(currentVersion === undefined ? {} : { currentVersion }) });
}

export function registerWriterSessions(app: FastifyInstance, db: Database.Database, recordsLimit: number, isOwner: (request: FastifyRequest) => boolean) {
  // The tool supplies its own random grant. Only its verifier is stored, and
  // neither verifier nor grant is included in project records or exports.
  const validToken = (session: Session, supplied: string | undefined) => {
    if (!supplied || !session.claimHash) return false;
    const a = Buffer.from(session.claimHash, 'hex'), b = createHash('sha256').update(supplied).digest();
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const getSession = (id: string) => db.prepare('SELECT id, change_id AS changeId, workspace_id AS workspaceId, binding_version AS bindingVersion, actor, generation, status, claim_hash AS claimHash FROM writer_sessions WHERE id = ?').get(id) as Session | undefined;
  const getPrior = (requestId: string) => db.prepare('SELECT fingerprint, session_id AS sessionId, record_version AS recordVersion, committed_at AS committedAt FROM writer_session_requests WHERE request_id = ?').get(requestId) as Prior | undefined;
  const receipt = (requestId: string, prior: Prior) => ({ requestId, resourceId: prior.sessionId, recordVersion: prior.recordVersion, committedAt: prior.committedAt });

  app.get<{ Params: { changeId: string } }>('/api/v1/changes/:changeId/writer-sessions', async (request, reply) => {
    if (!db.prepare('SELECT 1 FROM changes WHERE id = ?').get(request.params.changeId)) return error(request, reply, 404, 'NOT_FOUND', '变更不存在。');
    return { sessions: db.prepare('SELECT id, workspace_id AS workspaceId, binding_version AS bindingVersion, tool_label AS toolLabel, actor, generation, status, created_at AS createdAt, ended_at AS endedAt FROM writer_sessions WHERE change_id = ? ORDER BY generation DESC').all(request.params.changeId) };
  });

  app.post<{ Params: { changeId: string }; Body: Start }>('/api/v1/changes/:changeId/writer-sessions', {
    schema: { body: { type: 'object', required: ['requestId', 'expectedVersion', 'payload'], additionalProperties: false, properties: {
      requestId: { type: 'string', minLength: 1, maxLength: 128 }, expectedVersion: { type: 'integer', minimum: 1 },
      payload: { type: 'object', required: ['workspaceId', 'expectedBindingVersion', 'toolLabel'], additionalProperties: false, properties: {
        workspaceId: { type: 'string', minLength: 1 }, expectedBindingVersion: { type: 'integer', minimum: 1 }, toolLabel: { type: 'string', minLength: 1, maxLength: 200 },
      } },
    } } },
  }, async (request, reply) => {
    const { changeId } = request.params;
    const { requestId, expectedVersion, payload } = request.body;
    if (!payload.toolLabel.trim()) return error(request, reply, 400, 'INVALID_REQUEST', '工具名称不能为空。');
    const actor = isOwner(request) ? 'user' : 'agent';
    const claim = request.headers['x-specmill-writer-token'];
    if (actor === 'agent' && (typeof claim !== 'string' || !/^[0-9a-f]{64}$/.test(claim))) return error(request, reply, 403, 'FORBIDDEN', '需要有效的写会话授权。');
    const command = ['start', changeId, expectedVersion, actor, payload];
    const fingerprint = JSON.stringify(command);
    const replay = (prior: Prior) => {
      if (!sameFingerprint(prior.fingerprint, command)) return error(request, reply, 409, 'REQUEST_ID_CONFLICT', '请求标识已用于不同的内容。');
      const session = getSession(prior.sessionId)!;
      if (actor === 'agent' && !validToken(session, claim as string)) return error(request, reply, 403, 'FORBIDDEN', '没有此写会话的授权。');
      return reply.code(201).send({ ...receipt(requestId, prior), generation: session.generation, active: session.status === 'active' });
    };
    const previous = getPrior(requestId);
    if (previous) return replay(previous);
    if (requestIdUsedElsewhere(db, requestId, 'writerSessions')) return error(request, reply, 409, 'REQUEST_ID_CONFLICT', '请求标识已用于不同的内容。');
    const workspace = db.prepare('SELECT id, project_id AS projectId, path, common_key AS commonKey, version FROM workspaces WHERE id = ?').get(payload.workspaceId) as { id: string; projectId: string; path: string; commonKey: string; version: number } | undefined;
    if (!workspace) return error(request, reply, 404, 'NOT_FOUND', '工作区不存在。');
    if (workspace.version !== payload.expectedBindingVersion) return error(request, reply, 409, 'VERSION_CONFLICT', '工作区绑定已变化。', workspace.version);
    const projectRepo = db.prepare('SELECT common_key AS commonKey FROM project_repositories WHERE project_id = ?').get(workspace.projectId) as { commonKey: string } | undefined;
    if (!projectRepo || projectRepo.commonKey !== workspace.commonKey) return error(request, reply, 409, 'WORKSPACE_CHANGED', '工作区需要重新绑定当前项目仓库。');
    try {
      const identity = await identifyWorkspace(workspace.path);
      if (identity.pathKey !== pathKey(workspace.path) || identity.commonKey !== workspace.commonKey) return error(request, reply, 409, 'WORKSPACE_CHANGED', '工作区身份已变化，请重新绑定。');
    } catch { return error(request, reply, 409, 'WORKSPACE_UNAVAILABLE', '无法读取工作区，请检查目录。'); }
    const result = db.transaction(() => {
      const concurrent = getPrior(requestId);
      if (concurrent) return sameFingerprint(concurrent.fingerprint, command) ? { prior: concurrent } : 'REQUEST_ID_CONFLICT';
      if (requestIdUsedElsewhere(db, requestId, 'writerSessions')) return 'REQUEST_ID_CONFLICT';
      const change = db.prepare('SELECT project_id AS projectId, version, phase FROM changes WHERE id = ?').get(changeId) as { projectId: string; version: number; phase: string } | undefined;
      if (!change) return 'NOT_FOUND';
      if (change.version !== expectedVersion) return { currentVersion: change.version };
      if (change.phase !== 'Draft' && change.phase !== 'Working') return 'INVALID_STATE';
      const current = db.prepare('SELECT w.project_id AS projectId, w.version, w.common_key AS commonKey, p.common_key AS projectCommonKey FROM workspaces w JOIN project_repositories p ON p.project_id = w.project_id WHERE w.id = ?').get(workspace.id) as { projectId: string; version: number; commonKey: string; projectCommonKey: string } | undefined;
      if (!current || current.projectId !== change.projectId || current.version !== payload.expectedBindingVersion || current.commonKey !== current.projectCommonKey) return 'WORKSPACE_CHANGED';
      if (db.prepare("SELECT 1 FROM writer_sessions WHERE status = 'active' AND (change_id = ? OR workspace_id = ?)").get(changeId, workspace.id)) return 'WRITER_IN_USE';
      const before = projectRecordBytes(db, change.projectId);
      const generation = (db.prepare('SELECT COALESCE(MAX(generation), 0) AS generation FROM writer_sessions WHERE change_id = ?').get(changeId) as { generation: number }).generation + 1;
      const result = { requestId, resourceId: randomUUID(), recordVersion: change.version + 1, committedAt: new Date().toISOString() };
      const claimHash = actor === 'agent' ? createHash('sha256').update(claim as string).digest('hex') : null;
      db.prepare("INSERT INTO writer_sessions(id,change_id,workspace_id,binding_version,tool_label,actor,generation,status,created_at,claim_hash) VALUES (?,?,?,?,?,?,?,'active',?,?)").run(result.resourceId, changeId, workspace.id, workspace.version, payload.toolLabel.trim(), actor, generation, result.committedAt, claimHash);
      db.prepare('UPDATE changes SET version = ? WHERE id = ?').run(result.recordVersion, changeId);
      db.prepare('INSERT INTO writer_session_requests(request_id,fingerprint,session_id,record_version,committed_at) VALUES (?,?,?,?,?)').run(requestId, fingerprint, result.resourceId, result.recordVersion, result.committedAt);
      checkProjectCapacity(db, change.projectId, before, recordsLimit);
      return { prior: { fingerprint, sessionId: result.resourceId, recordVersion: result.recordVersion, committedAt: result.committedAt } };
    })();
    if (typeof result === 'string') return error(request, reply, result === 'NOT_FOUND' ? 404 : 409, result, result === 'WRITER_IN_USE' ? '变更或工作区已有活跃写会话。' : result === 'WORKSPACE_CHANGED' ? '工作区绑定已变化或不属于该项目。' : result === 'INVALID_STATE' ? '当前变更状态不能开始写会话。' : result === 'NOT_FOUND' ? '变更不存在。' : '请求标识已用于不同的内容。');
    if ('currentVersion' in result) return error(request, reply, 409, 'VERSION_CONFLICT', '变更已更新，请刷新后重试。', result.currentVersion);
    return replay(result.prior);
  });

  app.post<{ Params: { sessionId: string }; Body: Release }>('/api/v1/writer-sessions/:sessionId/release', {
    schema: { body: { type: 'object', required: ['requestId', 'expectedVersion', 'generation'], additionalProperties: false, properties: {
      requestId: { type: 'string', minLength: 1, maxLength: 128 }, expectedVersion: { type: 'integer', minimum: 1 }, generation: { type: 'integer', minimum: 1 },
    } } },
  }, async (request, reply) => {
    const { sessionId } = request.params;
    const { requestId, expectedVersion, generation } = request.body;
    const session = getSession(sessionId);
    if (!session) return error(request, reply, 404, 'NOT_FOUND', '写会话不存在。');
    if (session.status === 'interrupted' || session.status === 'canceled') return error(request, reply, 409, 'SESSION_EXPIRED', '写会话已失效，请重新开始。');
    if (session.generation !== generation) return error(request, reply, 409, 'SESSION_EXPIRED', '写会话代次已失效。');
    const owner = isOwner(request);
    if (owner ? session.actor !== 'user' : session.actor !== 'agent' || !validToken(session, request.headers['x-specmill-writer-token'] as string | undefined)) return error(request, reply, 403, 'FORBIDDEN', '没有释放此写会话的权限。');
    const command = ['release', sessionId, expectedVersion, generation, owner ? 'user' : 'agent'];
    const fingerprint = JSON.stringify(command);
    const result = db.transaction(() => {
      const previous = getPrior(requestId);
      if (previous) return sameFingerprint(previous.fingerprint, command) ? receipt(requestId, previous) : 'REQUEST_ID_CONFLICT';
      if (requestIdUsedElsewhere(db, requestId, 'writerSessions')) return 'REQUEST_ID_CONFLICT';
      const latest = getSession(sessionId);
      if (!latest || latest.status !== 'active' || latest.generation !== generation) return 'SESSION_EXPIRED';
      const change = db.prepare('SELECT project_id AS projectId, version FROM changes WHERE id = ?').get(latest.changeId) as { projectId: string; version: number };
      if (change.version !== expectedVersion) return { currentVersion: change.version };
      const before = projectRecordBytes(db, change.projectId);
      const result = { requestId, resourceId: sessionId, recordVersion: change.version + 1, committedAt: new Date().toISOString() };
      db.prepare("UPDATE writer_sessions SET status = 'released', ended_at = ? WHERE id = ?").run(result.committedAt, sessionId);
      db.prepare('UPDATE changes SET version = ? WHERE id = ?').run(result.recordVersion, latest.changeId);
      db.prepare('INSERT INTO writer_session_requests(request_id,fingerprint,session_id,record_version,committed_at) VALUES (?,?,?,?,?)').run(requestId, fingerprint, sessionId, result.recordVersion, result.committedAt);
      checkProjectCapacity(db, change.projectId, before, recordsLimit);
      return result;
    })();
    if (typeof result === 'string') return error(request, reply, 409, result, result === 'SESSION_EXPIRED' ? '写会话已失效，请重新开始。' : '请求标识已用于不同的内容。');
    if ('currentVersion' in result) return error(request, reply, 409, 'VERSION_CONFLICT', '变更已更新，请刷新后重试。', result.currentVersion);
    return reply.code(200).send(result);
  });

  app.post<{ Params: { changeId: string }; Body: Takeover }>('/api/v1/changes/:changeId/writer-sessions/takeover', {
    schema: { body: { type: 'object', required: ['requestId', 'expectedVersion', 'payload'], additionalProperties: false, properties: {
      requestId: { type: 'string', minLength: 1, maxLength: 128 }, expectedVersion: { type: 'integer', minimum: 1 },
      payload: { type: 'object', required: ['writerSessionId', 'expectedGeneration', 'expectedCheckpointId', 'toolLabel'], additionalProperties: false, properties: {
        writerSessionId: { type: 'string', minLength: 1 }, expectedGeneration: { type: 'integer', minimum: 1 }, expectedCheckpointId: { type: ['string', 'null'] }, toolLabel: { type: 'string', minLength: 1, maxLength: 200 },
      } },
    } } },
  }, async (request, reply) => {
    if (!isOwner(request)) return error(request, reply, 403, 'FORBIDDEN', '只有用户可以接管写会话。');
    const { changeId } = request.params;
    const { requestId, expectedVersion, payload } = request.body;
    if (!payload.toolLabel.trim()) return error(request, reply, 400, 'INVALID_REQUEST', '工具名称不能为空。');
    const command = ['takeover', changeId, expectedVersion, payload];
    const fingerprint = JSON.stringify(command);
    const result = db.transaction(() => {
      const previous = getPrior(requestId);
      if (previous) return sameFingerprint(previous.fingerprint, command) ? { prior: previous } : 'REQUEST_ID_CONFLICT';
      if (requestIdUsedElsewhere(db, requestId, 'writerSessions')) return 'REQUEST_ID_CONFLICT';
      const change = db.prepare('SELECT project_id AS projectId, version, phase, current_checkpoint_id AS checkpointId FROM changes WHERE id = ?').get(changeId) as { projectId: string; version: number; phase: string; checkpointId: string | null } | undefined;
      if (!change) return 'NOT_FOUND';
      if (change.version !== expectedVersion) return { currentVersion: change.version };
      if (change.phase !== 'Draft' && change.phase !== 'Working') return 'SESSION_EXPIRED';
      if (change.checkpointId !== payload.expectedCheckpointId) return 'CHECKPOINT_CHANGED';
      const old = getSession(payload.writerSessionId);
      if (!old || old.changeId !== changeId || old.status !== 'active' || old.generation !== payload.expectedGeneration) return 'SESSION_EXPIRED';
      const before = projectRecordBytes(db, change.projectId);
      const result = { requestId, resourceId: randomUUID(), recordVersion: change.version + 1, committedAt: new Date().toISOString() };
      const generation = old.generation + 1;
      db.prepare("UPDATE writer_sessions SET status = 'taken_over', ended_at = ? WHERE id = ?").run(result.committedAt, old.id);
      db.prepare("INSERT INTO writer_sessions(id,change_id,workspace_id,binding_version,tool_label,actor,generation,status,created_at,claim_hash) VALUES (?,?,?,?,?,'user',?,'active',?,NULL)").run(result.resourceId, changeId, old.workspaceId, old.bindingVersion, payload.toolLabel.trim(), generation, result.committedAt);
      db.prepare('UPDATE changes SET version = ? WHERE id = ?').run(result.recordVersion, changeId);
      db.prepare('INSERT INTO writer_session_requests(request_id,fingerprint,session_id,record_version,committed_at) VALUES (?,?,?,?,?)').run(requestId, fingerprint, result.resourceId, result.recordVersion, result.committedAt);
      checkProjectCapacity(db, change.projectId, before, recordsLimit);
      return { prior: { fingerprint, sessionId: result.resourceId, recordVersion: result.recordVersion, committedAt: result.committedAt } };
    })();
    if (typeof result === 'string') return error(request, reply, result === 'NOT_FOUND' ? 404 : 409, result, result === 'CHECKPOINT_CHANGED' ? '最新保存点已变化，请重新核对。' : result === 'SESSION_EXPIRED' ? '写会话已变化，请刷新后重新核对。' : result === 'NOT_FOUND' ? '变更不存在。' : '请求标识已用于不同的内容。');
    if ('currentVersion' in result) return error(request, reply, 409, 'VERSION_CONFLICT', '变更已更新，请刷新后重试。', result.currentVersion);
    const session = getSession(result.prior.sessionId)!;
    return reply.code(201).send({ ...receipt(requestId, result.prior), generation: session.generation, active: session.status === 'active' });
  });
  const authorize: WriterAuthorization = (request, sessionId, generation, changeId) => {
    const session = getSession(sessionId);
    if (!session || session.status !== 'active' || (changeId !== undefined && session.changeId !== changeId) || session.generation !== generation) return 'SESSION_EXPIRED';
    if (!isOwner(request) && (session.actor !== 'agent' || !validToken(session, request.headers['x-specmill-writer-token'] as string | undefined))) return 'FORBIDDEN';
    return session;
  };
  return authorize;
}
