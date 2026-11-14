import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { containsCommits, identifyWorkspace, ObservationTempInsideWorkspace, observeWorkspace, pathKey } from '../workspace/git.js';
import { checkProjectCapacity, projectRecordBytes } from '../storage/project-capacity.js';
import { requestIdUsedElsewhere } from '../storage/request-ids.js';
import type { WriterAuthorization } from './writer-sessions.js';

type BindInput = { requestId: string; expectedVersion: number | null; payload: { workspaceId: string | null; path: string; confirmUnverified?: boolean } };
type Receipt = { requestId: string; resourceId: string; recordVersion: number; committedAt: string };
type Previous = { fingerprint: string; resourceId: string; recordVersion: number; committedAt: string };

export function registerWorkspaces(app: FastifyInstance, db: Database.Database, recordsLimit: number, isOwner: (request: FastifyRequest) => boolean, authorizeWriter: WriterAuthorization) {
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/workspaces', async request => ({
    workspaces: db.prepare('SELECT id, path, version FROM workspaces WHERE project_id = ? ORDER BY created_at, id').all(request.params.projectId),
  }));
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/capacity', async (request, reply) => {
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(request.params.projectId)) return reply.code(404).send({ code: 'NOT_FOUND', message: '项目不存在。', requestId: request.id });
    const used = projectRecordBytes(db, request.params.projectId);
    return { records: { used, limit: recordsLimit, warning: used >= recordsLimit * 0.8 } };
  });
  app.post<{ Params: { projectId: string }; Body: BindInput }>('/api/v1/projects/:projectId/workspaces', {
    schema: { body: { type: 'object', required: ['requestId', 'expectedVersion', 'payload'], additionalProperties: false, properties: {
      requestId: { type: 'string', minLength: 1, maxLength: 128 },
      expectedVersion: { type: ['integer', 'null'], minimum: 1 },
      payload: { type: 'object', required: ['workspaceId', 'path'], additionalProperties: false, properties: { workspaceId: { type: ['string', 'null'] }, path: { type: 'string', minLength: 1, maxLength: 4096 }, confirmUnverified: { type: 'boolean' } } },
    } } },
  }, async (request, reply) => {
    const { projectId } = request.params;
    const { requestId, expectedVersion, payload } = request.body;
    const fingerprint = JSON.stringify([projectId, expectedVersion, payload.workspaceId, payload.path, payload.confirmUnverified ?? false]);
    const legacyFingerprint = JSON.stringify([projectId, expectedVersion, payload.workspaceId, payload.path]);
    const matches = (value: string) => value === fingerprint || (!payload.confirmUnverified && value === legacyFingerprint);
    const previous = db.prepare('SELECT fingerprint, resource_id AS resourceId, record_version AS recordVersion, committed_at AS committedAt FROM workspace_requests WHERE request_id = ?').get(requestId) as Previous | undefined;
    if (previous) {
      if (!matches(previous.fingerprint)) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
      return reply.code(payload.workspaceId === null ? 201 : 200).send({ requestId, resourceId: previous.resourceId, recordVersion: previous.recordVersion, committedAt: previous.committedAt } satisfies Receipt);
    }
    if (requestIdUsedElsewhere(db, requestId, 'workspaces')) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) return reply.code(404).send({ code: 'NOT_FOUND', message: '项目不存在。', requestId: request.id });
    if ((payload.workspaceId === null) !== (expectedVersion === null)) return reply.code(400).send({ code: 'INVALID_REQUEST', message: '工作区标识和预期版本必须同时提供。', requestId: request.id });
    let workspace: Awaited<ReturnType<typeof identifyWorkspace>>;
    try { workspace = await identifyWorkspace(payload.path); } catch { return reply.code(400).send({ code: 'INVALID_WORKSPACE', message: '无法读取所选 Git 工作目录。', requestId: request.id }); }
    type Binding = { id: string; path: string; version: number };
    const bindings = () => db.prepare('SELECT id, path, version FROM workspaces WHERE project_id = ? ORDER BY id').all(projectId) as Binding[];
    const projectRepository = db.prepare('SELECT common_key AS commonKey FROM project_repositories WHERE project_id = ?').get(projectId) as { commonKey: string } | undefined;
    const priorBindings = bindings();
    const relocating = projectRepository !== undefined && projectRepository.commonKey !== workspace.commonKey && payload.workspaceId !== null;
    if (relocating) {
      for (const binding of priorBindings) {
        try { await access(binding.path); return reply.code(409).send({ code: 'REPOSITORY_MISMATCH', message: '原仓库目录仍存在，不能绑定到另一仓库。', requestId: request.id }); }
        catch (error) { if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') return reply.code(503).send({ code: 'WORKSPACE_UNAVAILABLE', message: '无法核对原工作区状态。', requestId: request.id }); }
      }
      const rows = db.prepare('SELECT data_json AS dataJson FROM workspace_observations WHERE project_id = ?').all(projectId) as { dataJson: string }[];
      const commits = [...new Set(rows.map(row => (JSON.parse(row.dataJson) as { head?: string | null }).head).filter((head): head is string => typeof head === 'string'))];
      if (commits.length === 0 && !payload.confirmUnverified) return reply.code(409).send({ code: 'REPOSITORY_UNVERIFIED', message: '没有可核对的历史提交；请确认所选目录是原仓库。', requestId: request.id });
      if (!(await containsCommits(workspace.path, workspace.commonDir, commits))) return reply.code(409).send({ code: 'REPOSITORY_MISMATCH', message: '所选仓库缺少历史观察引用的提交。', requestId: request.id });
    }
    const result = db.transaction(() => {
      const concurrent = db.prepare('SELECT fingerprint, resource_id AS resourceId, record_version AS recordVersion, committed_at AS committedAt FROM workspace_requests WHERE request_id = ?').get(requestId) as Previous | undefined;
      if (concurrent) {
        if (!matches(concurrent.fingerprint)) return 'REQUEST_ID_CONFLICT';
        return { requestId, resourceId: concurrent.resourceId, recordVersion: concurrent.recordVersion, committedAt: concurrent.committedAt } satisfies Receipt;
      }
      if (requestIdUsedElsewhere(db, requestId, 'workspaces')) return 'REQUEST_ID_CONFLICT';
      const existing = payload.workspaceId === null ? undefined : db.prepare('SELECT id, version FROM workspaces WHERE id = ? AND project_id = ?').get(payload.workspaceId, projectId) as { id: string; version: number } | undefined;
      if (payload.workspaceId !== null && !existing) return 'WORKSPACE_NOT_FOUND';
      if (existing && existing.version !== expectedVersion) return { currentVersion: existing.version };
      if (existing && db.prepare("SELECT 1 FROM writer_sessions WHERE workspace_id = ? AND status = 'active'").get(existing.id)) return 'WORKSPACE_IN_USE';
      if (relocating && db.prepare("SELECT 1 FROM writer_sessions s JOIN changes c ON c.id = s.change_id WHERE c.project_id = ? AND s.status = 'active'").get(projectId)) return 'WORKSPACE_IN_USE';
      const sameProject = db.prepare('SELECT common_key AS commonKey FROM project_repositories WHERE project_id = ?').get(projectId) as { commonKey: string } | undefined;
      if (relocating && JSON.stringify(bindings()) !== JSON.stringify(priorBindings)) return 'BINDINGS_CHANGED';
      if (sameProject && sameProject.commonKey !== workspace.commonKey && !relocating) return 'REPOSITORY_MISMATCH';
      if (relocating && sameProject?.commonKey !== projectRepository?.commonKey) return 'BINDINGS_CHANGED';
      if (db.prepare('SELECT 1 FROM workspaces WHERE path_key = ? AND id != ?').get(workspace.pathKey, existing?.id ?? '')) return 'WORKSPACE_EXISTS';
      const before = projectRecordBytes(db, projectId);
      if (!sameProject) db.prepare('INSERT INTO project_repositories(project_id,common_dir,common_key) VALUES (?,?,?)').run(projectId, workspace.commonDir, workspace.commonKey);
      else if (relocating) db.prepare('UPDATE project_repositories SET common_dir = ?, common_key = ? WHERE project_id = ?').run(workspace.commonDir, workspace.commonKey, projectId);
      const receipt: Receipt = { requestId, resourceId: existing?.id ?? randomUUID(), recordVersion: existing ? existing.version + 1 : 1, committedAt: new Date().toISOString() };
      if (existing) db.prepare('UPDATE workspaces SET path = ?, path_key = ?, common_dir = ?, common_key = ?, version = ? WHERE id = ?').run(workspace.path, workspace.pathKey, workspace.commonDir, workspace.commonKey, receipt.recordVersion, existing.id);
      else db.prepare('INSERT INTO workspaces(id,project_id,path,path_key,common_dir,common_key,version,created_at) VALUES (?,?,?,?,?,?,?,?)').run(receipt.resourceId, projectId, workspace.path, workspace.pathKey, workspace.commonDir, workspace.commonKey, 1, receipt.committedAt);
      db.prepare('INSERT INTO workspace_requests(request_id,fingerprint,resource_id,record_version,committed_at) VALUES (?,?,?,?,?)').run(requestId, fingerprint, receipt.resourceId, receipt.recordVersion, receipt.committedAt);
      checkProjectCapacity(db, projectId, before, recordsLimit);
      return receipt;
    })();
    if (typeof result === 'string') return reply.code(result === 'WORKSPACE_NOT_FOUND' ? 404 : 409).send({ code: result, message: result === 'WORKSPACE_NOT_FOUND' ? '工作区不存在。' : result === 'WORKSPACE_IN_USE' ? '工作区有活跃写会话，请先结束会话。' : result === 'WORKSPACE_EXISTS' ? '该工作目录已登记。' : result === 'REQUEST_ID_CONFLICT' ? '请求标识已用于不同的内容。' : result === 'BINDINGS_CHANGED' ? '工作区绑定已变化，请刷新后重试。' : '所选目录不属于此项目的 Git 仓库。', requestId: request.id });
    if ('currentVersion' in result) return reply.code(409).send({ code: 'VERSION_CONFLICT', message: '工作区绑定已变化，请刷新后重试。', requestId: request.id, currentVersion: result.currentVersion });
    return reply.code(payload.workspaceId === null ? 201 : 200).send(result);
  });

  app.get<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId/observations', async (request, reply) => {
    if (!db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(request.params.workspaceId)) return reply.code(404).send({ code: 'NOT_FOUND', message: '工作区不存在。', requestId: request.id });
    const records = db.prepare('SELECT id, workspace_id AS workspaceId, binding_version AS bindingVersion, path, data_json AS dataJson, created_at AS createdAt FROM workspace_observations WHERE workspace_id = ? ORDER BY rowid DESC').all(request.params.workspaceId) as { dataJson: string }[];
    return { observations: records.map(({ dataJson, ...metadata }) => ({ ...metadata, ...JSON.parse(dataJson) })) };
  });
  app.get<{ Params: { workspaceId: string; observationId: string } }>('/api/v1/workspaces/:workspaceId/observations/:observationId', async (request, reply) => {
    const record = db.prepare('SELECT id, workspace_id AS workspaceId, binding_version AS bindingVersion, path, data_json AS dataJson, created_at AS createdAt FROM workspace_observations WHERE id = ? AND workspace_id = ?').get(request.params.observationId, request.params.workspaceId) as { id: string; workspaceId: string; bindingVersion: number; path: string; dataJson: string; createdAt: string } | undefined;
    if (!record) return reply.code(404).send({ code: 'NOT_FOUND', message: '工作区观察记录不存在。', requestId: request.id });
    const { dataJson, ...metadata } = record;
    return { ...metadata, ...JSON.parse(dataJson) };
  });

  app.post<{ Params: { workspaceId: string }; Body: { requestId: string; expectedBindingVersion: number; selectedUntracked: string[]; writerSessionId?: string; generation?: number } }>('/api/v1/workspaces/:workspaceId/observations', {
    schema: { body: { type: 'object', required: ['requestId', 'expectedBindingVersion', 'selectedUntracked'], additionalProperties: false, properties: {
      requestId: { type: 'string', minLength: 1, maxLength: 128 }, expectedBindingVersion: { type: 'integer', minimum: 1 },
      selectedUntracked: { type: 'array', maxItems: 10000, items: { type: 'string', minLength: 1, maxLength: 4096 } },
      writerSessionId: { type: 'string', minLength: 1 }, generation: { type: 'integer', minimum: 1 },
    } } },
  }, async (request, reply) => {
    const { workspaceId } = request.params;
    const { requestId, expectedBindingVersion, selectedUntracked, writerSessionId, generation } = request.body;
    const owner = isOwner(request);
    const validateAgent = () => {
      if (owner) return null;
      const session = authorizeWriter(request, writerSessionId ?? '', generation ?? 0);
      if (typeof session === 'string') return session;
      return session.workspaceId === workspaceId && session.bindingVersion === expectedBindingVersion ? null : 'WORKSPACE_CHANGED';
    };
    const invalid = validateAgent();
    if (invalid) return reply.code(invalid === 'FORBIDDEN' ? 403 : 409).send({ code: invalid, message: invalid === 'FORBIDDEN' ? '没有此写会话的授权。' : '写会话或工作区绑定已失效。', requestId: request.id });
    const fingerprint = JSON.stringify(owner ? [workspaceId, expectedBindingVersion, selectedUntracked] : [workspaceId, expectedBindingVersion, selectedUntracked, 'agent', writerSessionId, generation]);
    type PriorObservation = { fingerprint: string; observationId: string; committedAt: string };
    const findPrior = () => db.prepare('SELECT fingerprint, observation_id AS observationId, committed_at AS committedAt FROM observation_requests WHERE request_id = ?').get(requestId) as PriorObservation | undefined;
    const receipt = (prior: PriorObservation) => ({ requestId, resourceId: prior.observationId, recordVersion: 1, committedAt: prior.committedAt });
    const previous = findPrior();
    if (previous) {
      if (previous.fingerprint !== fingerprint) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
      return reply.code(201).send(receipt(previous));
    }
    if (requestIdUsedElsewhere(db, requestId, 'observations')) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    type Workspace = { id: string; projectId: string; path: string; commonKey: string; version: number };
    const current = () => db.prepare('SELECT id, project_id AS projectId, path, common_key AS commonKey, version FROM workspaces WHERE id = ?').get(workspaceId) as Workspace | undefined;
    const workspace = current();
    if (!workspace) return reply.code(404).send({ code: 'NOT_FOUND', message: '工作区不存在。', requestId: request.id });
    if (workspace.version !== expectedBindingVersion) return reply.code(409).send({ code: 'VERSION_CONFLICT', message: '工作区绑定已变化，请刷新后重试。', requestId: request.id, currentVersion: workspace.version });
    const projectRepo = db.prepare('SELECT common_key AS commonKey FROM project_repositories WHERE project_id = ?').get(workspace.projectId) as { commonKey: string } | undefined;
    if (!projectRepo || projectRepo.commonKey !== workspace.commonKey) return reply.code(409).send({ code: 'WORKSPACE_CHANGED', message: '工作区需要重新绑定当前项目仓库。', requestId: request.id });
    let observation: Awaited<ReturnType<typeof observeWorkspace>>;
    try {
      const identity = await identifyWorkspace(workspace.path);
      if (identity.pathKey !== pathKey(workspace.path) || identity.commonKey !== workspace.commonKey) return reply.code(409).send({ code: 'WORKSPACE_CHANGED', message: '工作目录或仓库身份已变化，请重新绑定。', requestId: request.id });
      observation = await observeWorkspace(workspace.path, identity.commonDir, selectedUntracked);
    } catch (error) {
      if (error instanceof ObservationTempInsideWorkspace) return reply.code(503).send({ code: 'OBSERVATION_TEMP_INSIDE_WORKSPACE', message: '临时目录位于工作区内，请改用工作区外的临时目录。', requestId: request.id });
      return reply.code(503).send({ code: 'OBSERVATION_FAILED', message: '无法观察工作区，请检查目录和 Git 状态。', requestId: request.id });
    }
    const result = db.transaction(() => {
      const concurrent = findPrior();
      if (concurrent) return concurrent.fingerprint === fingerprint ? receipt(concurrent) : 'REQUEST_ID_CONFLICT';
      if (requestIdUsedElsewhere(db, requestId, 'observations')) return 'REQUEST_ID_CONFLICT';
      const authorization = validateAgent();
      if (authorization) return authorization;
      const latest = current();
      if (!latest) return 'NOT_FOUND';
      if (latest.version !== expectedBindingVersion) return { currentVersion: latest.version };
      const currentRepo = db.prepare('SELECT common_key AS commonKey FROM project_repositories WHERE project_id = ?').get(latest.projectId) as { commonKey: string } | undefined;
      if (!currentRepo || currentRepo.commonKey !== latest.commonKey) return 'WORKSPACE_CHANGED';
      const before = projectRecordBytes(db, latest.projectId);
      const result: Receipt = { requestId, resourceId: randomUUID(), recordVersion: 1, committedAt: new Date().toISOString() };
      db.prepare('INSERT INTO workspace_observations(id,workspace_id,project_id,binding_version,path,data_json,created_at) VALUES (?,?,?,?,?,?,?)').run(result.resourceId, workspaceId, latest.projectId, latest.version, latest.path, JSON.stringify(observation), result.committedAt);
      db.prepare('INSERT INTO observation_requests(request_id,fingerprint,observation_id,committed_at) VALUES (?,?,?,?)').run(requestId, fingerprint, result.resourceId, result.committedAt);
      checkProjectCapacity(db, latest.projectId, before, recordsLimit);
      return result;
    })();
    if (typeof result === 'string') return reply.code(result === 'NOT_FOUND' ? 404 : result === 'FORBIDDEN' ? 403 : 409).send({ code: result, message: result === 'NOT_FOUND' ? '工作区不存在。' : result === 'WORKSPACE_CHANGED' || result === 'SESSION_EXPIRED' ? '工作区或写会话已变化，请重新核对。' : result === 'FORBIDDEN' ? '没有此写会话的授权。' : '请求标识已用于不同的内容。', requestId: request.id });
    if ('currentVersion' in result) return reply.code(409).send({ code: 'VERSION_CONFLICT', message: '工作区绑定已变化，请刷新后重试。', requestId: request.id, currentVersion: result.currentVersion });
    return reply.code(201).send(result);
  });
}
