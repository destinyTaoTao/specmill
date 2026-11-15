import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { checkProjectCapacity, MAX_PROJECT_ATTACHMENTS, projectRecordBytes } from '../storage/project-capacity.js';
import { checkAttachmentHealth, attachmentPathFor } from '../storage/attachments.js';
import { requestIdUsedElsewhere, sameFingerprint } from '../storage/request-ids.js';
import { evidenceCriterionMatches } from '../storage/evidence-integrity.js';
import { containsCommits, identifyWorkspace, ObservationTempInsideWorkspace, observeWorkspace, pathKey } from '../workspace/git.js';
import type { WriterAuthorization } from './writer-sessions.js';
import { createWriterGuard, writerCommand, writerGrantMessage, type WriterGrant } from './writer-guard.js';

type Receipt = { requestId: string; resourceId: string; recordVersion: number; committedAt: string };
type RunInput = { method: string; result: 'passed' | 'failed' | 'unknown'; exitStatus?: string; claimedCommit?: string; claimedClean?: boolean; notes?: string };
type EvidenceInput = { executionId: string; criterion: { kind: 'baseline'; baselineId: string; criterionId: string } | { kind: 'draft'; revisionId: string }; criterionIndex: number; result: 'passed' | 'failed'; actualCommit?: string; notes?: string; attachmentIds?: string[] };
const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

type ChangeRow = { projectId: string; phase: string; cycle: number; version: number };

export function registerEvidence(app: FastifyInstance, db: Database.Database, recordsLimit: number, attachmentsDir: string, isOwner: (request: FastifyRequest) => boolean, authorizeWriter: WriterAuthorization) {
  type Grant = WriterGrant;
  const checkWriter = createWriterGuard(db, isOwner, authorizeWriter);
  const agentGrant = (request: FastifyRequest, changeId: string, grant: Grant, workspaceId?: string) => checkWriter(request, grant, { changeId, workspaceId });
  const grantCommand = (request: FastifyRequest, grant: Grant, command: unknown[]) => writerCommand(isOwner(request), grant, command);
  const grantError = (code: string) => code === 'FORBIDDEN' ? '没有此写会话的授权。' : code === 'WORKSPACE_CHANGED' ? '写会话的工作区绑定已变化。' : '写会话已失效，请重新获取授权。';
  const attachmentQueues = new Map<string, Promise<void>>();
  async function withAttachmentLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = attachmentQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    attachmentQueues.set(key, current);
    await previous;
    try { return await work(); }
    finally { if (attachmentQueues.get(key) === current) attachmentQueues.delete(key); release(); }
  }
  const getChange = (changeId: string) => db.prepare('SELECT id, project_id AS projectId, phase, cycle, version FROM changes WHERE id = ?').get(changeId) as ChangeRow | undefined;
  const attachmentPath = (projectId: string, sha256: string) => attachmentPathFor(attachmentsDir, projectId, sha256);
  // 附件健康：文件存在且摘要与记录一致；损坏与缺失都明确暴露，不伪报成功。
  const attachmentHealth = (attachment: { projectId: string; sha256: string; size: number }) => checkAttachmentHealth(attachmentsDir, attachment.projectId, attachment.sha256, attachment.size);
  const boundWorkspace = (projectId: string) => db.prepare('SELECT w.id, w.path, w.version, w.common_key AS commonKey FROM workspaces w JOIN project_repositories p ON p.project_id = w.project_id WHERE w.project_id = ? AND w.common_key = p.common_key ORDER BY w.rowid DESC LIMIT 1').get(projectId) as { id: string; path: string; version: number; commonKey: string } | undefined;
  const bindingUnchanged = (projectId: string, workspaceId: string, observed: { path: string; version: number; commonKey: string }) => {
    const current = db.prepare('SELECT w.path, w.version, w.common_key AS commonKey FROM workspaces w JOIN project_repositories p ON p.project_id = w.project_id AND p.common_key = w.common_key WHERE w.id = ? AND w.project_id = ?').get(workspaceId, projectId) as { path: string; version: number; commonKey: string } | undefined;
    return !!current && current.path === observed.path && current.version === observed.version && current.commonKey === observed.commonKey;
  };
  const freshObservation = async (workspace: { id: string; path: string; commonKey: string }) => {
    try {
      const identity = await identifyWorkspace(workspace.path);
      if (identity.pathKey !== pathKey(workspace.path) || identity.commonKey !== workspace.commonKey) return { context: null, limitation: '上传时无法核对工作目录或仓库身份（身份已变化）。' };
      const observed = await observeWorkspace(workspace.path, identity.commonDir, []);
      return {
        context: { head: observed.head, branch: observed.branch, dirty: observed.dirty, stable: observed.stable, trackedDiffSha256: observed.trackedDiffSha256, fileCount: observed.files.length, limitations: observed.limitations, observedAt: new Date().toISOString() },
        limitation: '',
      };
    } catch (error) {
      if (error instanceof ObservationTempInsideWorkspace) return { context: null, limitation: '上传时无法观察工作区：临时目录位于工作区内。' };
      return { context: null, limitation: '上传时无法观察工作区，请检查目录和 Git 状态。' };
    }
  };

  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/attachments', async (request, reply) => {
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(request.params.projectId)) return reply.code(404).send({ code: 'NOT_FOUND', message: '项目不存在。', requestId: request.id });
    const rows = db.prepare('SELECT id, sha256, size, filename, content_type AS contentType, created_at AS createdAt FROM attachments WHERE project_id = ? ORDER BY created_at, id').all(request.params.projectId);
    return { attachments: rows };
  });

  app.get<{ Params: { attachmentId: string } }>('/api/v1/attachments/:attachmentId', async (request, reply) => {
    const row = db.prepare('SELECT a.id, a.project_id AS projectId, a.sha256, a.size, a.filename, a.content_type AS contentType FROM attachments a WHERE a.id = ?').get(request.params.attachmentId) as { id: string; projectId: string; sha256: string; size: number; filename: string; contentType: string } | undefined;
    if (!row) return reply.code(404).send({ code: 'NOT_FOUND', message: '附件不存在。', requestId: request.id });
    const path = attachmentPath(row.projectId, row.sha256);
    try {
      const content = await readFile(path);
      if (createHash('sha256').update(content).digest('hex') !== row.sha256) return reply.code(503).send({ code: 'ATTACHMENT_CORRUPTED', message: '附件内容摘要与记录不一致，已损坏。', requestId: request.id });
      const asciiName = row.filename.replace(/[^\x20-\x7e]/g, '_');
      return reply.header('Content-Type', 'application/octet-stream').header('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`).header('Content-Length', content.length).send(content);
    } catch { return reply.code(503).send({ code: 'ATTACHMENT_MISSING', message: '附件文件缺失，无法下载。', requestId: request.id }); }
  });

  app.post<{ Params: { projectId: string }; Querystring: { requestId: string; filename: string; contentType?: string; writerSessionId?: string; generation?: string }; Body: Buffer }>('/api/v1/projects/:projectId/attachments', {
    bodyLimit: 6 * 1024 * 1024,
    schema: { querystring: { type: 'object', required: ['requestId', 'filename'], additionalProperties: false, properties: { requestId: { type: 'string', minLength: 1, maxLength: 128 }, filename: { type: 'string', minLength: 1, maxLength: 200 }, contentType: { type: 'string', minLength: 1, maxLength: 100 }, writerSessionId: { type: 'string', minLength: 1 }, generation: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' } } } },
  }, async (request, reply) => {
    const { projectId } = request.params;
    const { requestId, filename, contentType } = request.query;
    const grant = { writerSessionId: request.query.writerSessionId, generation: request.query.generation === undefined ? undefined : Number(request.query.generation) };
    const guard = () => checkWriter(request, grant, { projectId });
    const denied = guard();
    if (denied) return reply.code(denied === 'FORBIDDEN' ? 403 : 409).send({ code: denied, message: writerGrantMessage(denied), requestId: request.id });
    const content = request.body as Buffer;
    if (!Buffer.isBuffer(content) || content.length === 0) return reply.code(400).send({ code: 'INVALID_ATTACHMENT', message: '附件内容为空。', requestId: request.id });
    if (content.length > 5 * 1024 * 1024) return reply.code(413).send({ code: 'PAYLOAD_TOO_LARGE', message: '单个附件不能超过 5 MiB。', requestId: request.id });
    const safeFilename = filename.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim() || 'attachment';
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) return reply.code(404).send({ code: 'NOT_FOUND', message: '项目不存在。', requestId: request.id });
    const declaredType = contentType ?? 'application/octet-stream';
    const sha256 = createHash('sha256').update(content).digest('hex');
    return withAttachmentLock(`${projectId}:${sha256}`, async () => {
      const lockedDenied = guard();
      if (lockedDenied) return reply.code(lockedDenied === 'FORBIDDEN' ? 403 : 409).send({ code: lockedDenied, message: writerGrantMessage(lockedDenied), requestId: request.id });
      const fingerprint = JSON.stringify(writerCommand(isOwner(request), grant, ['attach', projectId, sha256, safeFilename, declaredType]));
      const findPrior = () => db.prepare('SELECT fingerprint, attachment_id AS attachmentId, committed_at AS committedAt FROM attachment_requests WHERE request_id = ?').get(requestId) as { fingerprint: string; attachmentId: string; committedAt: string } | undefined;
      const receiptOf = (prior: { attachmentId: string; committedAt: string }, deduplicated = false) => ({ requestId, resourceId: prior.attachmentId, recordVersion: 1, committedAt: prior.committedAt, sha256, size: content.length, filename: safeFilename, deduplicated } satisfies Receipt & { sha256: string; size: number; filename: string; deduplicated: boolean });
      const previous = findPrior();
      if (previous) {
        if (previous.fingerprint !== fingerprint) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
        return reply.code(201).send(receiptOf(previous));
      }
      if (requestIdUsedElsewhere(db, requestId, 'attachments')) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
      const existing = db.prepare('SELECT id FROM attachments WHERE project_id = ? AND sha256 = ?').get(projectId, sha256) as { id: string } | undefined;
      if (existing) {
        // 重复内容按项目唯一附件计量：只登记引用关系，不复制文件、不重复占用预算。
        const health = await attachmentHealth({ projectId, sha256, size: content.length });
        if (health !== 'ok') return reply.code(503).send({ code: health === 'missing' ? 'ATTACHMENT_MISSING' : 'ATTACHMENT_CORRUPTED', message: health === 'missing' ? '已有附件文件缺失，请核对存储完整性。' : '已有附件内容摘要不符，请核对存储完整性。', requestId: request.id });
        const committedAt = new Date().toISOString();
        const dedupeResult = db.transaction((): Receipt | string => {
          const denied = guard();
          if (denied) return denied;
          const concurrent = findPrior();
          if (concurrent) return concurrent.fingerprint === fingerprint ? receiptOf(concurrent, true) : 'REQUEST_ID_CONFLICT';
          if (requestIdUsedElsewhere(db, requestId, 'attachments')) return 'REQUEST_ID_CONFLICT';
          const before = projectRecordBytes(db, projectId);
          db.prepare('INSERT INTO attachment_requests(request_id,fingerprint,attachment_id,committed_at) VALUES (?,?,?,?)').run(requestId, fingerprint, existing.id, committedAt);
          checkProjectCapacity(db, projectId, before, recordsLimit);
          return { requestId, resourceId: existing.id, recordVersion: 1, committedAt };
        })();
        if (typeof dedupeResult === 'string') return reply.code(dedupeResult === 'FORBIDDEN' ? 403 : 409).send({ code: dedupeResult, message: dedupeResult === 'REQUEST_ID_CONFLICT' ? '请求标识已用于不同的内容。' : grantError(dedupeResult), requestId: request.id });
        return reply.code(201).send({ ...dedupeResult, sha256, size: content.length, filename: safeFilename, deduplicated: true });
      }
      const attachmentCount = () => (db.prepare('SELECT COUNT(*) AS count FROM attachments WHERE project_id = ?').get(projectId) as { count: number }).count;
      if (attachmentCount() >= MAX_PROJECT_ATTACHMENTS) return reply.code(413).send({ code: 'ATTACHMENT_COUNT_EXCEEDED', message: `项目的不同附件已达到上限 ${MAX_PROJECT_ATTACHMENTS}，不能新增附件。`, limit: MAX_PROJECT_ATTACHMENTS, requestId: request.id });
      // 先落盘内容寻址文件，再在事务中登记引用；任何失败都不留下有效引用。
      const path = attachmentPath(projectId, sha256);
      let created = false;
      let registered = false;
      try {
        try {
          await mkdir(join(attachmentsDir, projectId), { recursive: true });
          const file = await open(path, 'wx');
          created = true;
          try { await file.writeFile(content); } finally { await file.close(); }
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST' && !created) {
            const onDisk = await readFile(path).then((data: Buffer) => createHash('sha256').update(data).digest('hex')).catch(() => '');
            if (onDisk !== sha256) { reply.code(503); return { code: 'ATTACHMENT_CORRUPTED', message: '存储中已有同地址内容且摘要不符，请核对存储完整性。', requestId: request.id }; }
          } else {
            reply.code(503); return { code: 'STORAGE_WRITE_FAILED', message: '附件写入存储失败；未登记引用。', requestId: request.id };
          }
        }
        const result = db.transaction((): Receipt | string => {
          const denied = guard();
          if (denied) return denied;
          const concurrent = findPrior();
          if (concurrent) return concurrent.fingerprint === fingerprint ? receiptOf(concurrent) : 'REQUEST_ID_CONFLICT';
          if (requestIdUsedElsewhere(db, requestId, 'attachments')) return 'REQUEST_ID_CONFLICT';
          if (attachmentCount() >= MAX_PROJECT_ATTACHMENTS) return 'ATTACHMENT_COUNT_EXCEEDED';
          const before = projectRecordBytes(db, projectId);
          const committedAt = new Date().toISOString();
          const attachmentId = randomUUID();
          db.prepare('INSERT INTO attachments(id,project_id,sha256,size,filename,content_type,created_at) VALUES (?,?,?,?,?,?,?)').run(attachmentId, projectId, sha256, content.length, safeFilename, declaredType, committedAt);
          db.prepare('INSERT INTO attachment_requests(request_id,fingerprint,attachment_id,committed_at) VALUES (?,?,?,?)').run(requestId, fingerprint, attachmentId, committedAt);
          checkProjectCapacity(db, projectId, before, recordsLimit);
          return { requestId, resourceId: attachmentId, recordVersion: 1, committedAt };
        })();
        if (result === 'ATTACHMENT_COUNT_EXCEEDED') { reply.code(413); return { code: result, message: `项目的不同附件已达到上限 ${MAX_PROJECT_ATTACHMENTS}，不能新增附件。`, limit: MAX_PROJECT_ATTACHMENTS, requestId: request.id }; }
        if (typeof result === 'string') { reply.code(result === 'FORBIDDEN' ? 403 : 409); return { code: result, message: result === 'REQUEST_ID_CONFLICT' ? '请求标识已用于不同的内容。' : grantError(result), requestId: request.id }; }
        registered = true;
        reply.code(201); return { ...result, sha256, size: content.length, filename: safeFilename, deduplicated: false };
      } finally {
        if (created && !registered) await unlink(path).catch(error => { if (error?.code !== 'ENOENT') throw error; });
      }
    });
  });

  app.get<{ Params: { changeId: string } }>('/api/v1/changes/:changeId/executions', async (request, reply) => {
    if (!getChange(request.params.changeId)) return reply.code(404).send({ code: 'NOT_FOUND', message: '变更不存在。', requestId: request.id });
    const rows = db.prepare('SELECT id, actor, method, result, exit_status AS exitStatus, claimed_commit AS claimedCommit, claimed_clean AS claimedClean, notes, upload_workspace_id AS uploadWorkspaceId, upload_context_json AS uploadContextJson, upload_limitation AS uploadLimitation, commit_verified AS commitVerified, record_version AS recordVersion, created_at AS createdAt FROM executions WHERE change_id = ? ORDER BY created_at, id').all(request.params.changeId) as { uploadContextJson: string | null; claimedClean: number | null; commitVerified: number | null }[];
    return { executions: rows.map(({ uploadContextJson, claimedClean, commitVerified, ...row }) => ({ ...row, claimedClean: claimedClean === null ? null : claimedClean === 1, commitVerified: commitVerified === null ? null : commitVerified === 1, uploadContext: uploadContextJson ? JSON.parse(uploadContextJson) : null })) };
  });

  app.post<{ Params: { changeId: string }; Body: { requestId: string; workspaceId: string; payload: RunInput } & Grant }>('/api/v1/changes/:changeId/executions', {
    schema: { body: { type: 'object', required: ['requestId', 'workspaceId', 'payload'], additionalProperties: false, properties: {
      requestId: { type: 'string', minLength: 1, maxLength: 128 }, workspaceId: { type: 'string', minLength: 1 },
      writerSessionId: { type: 'string', minLength: 1 }, generation: { type: 'integer', minimum: 1 },
      payload: { type: 'object', required: ['method', 'result'], additionalProperties: false, properties: {
        method: { type: 'string', minLength: 1, maxLength: 2000 }, result: { type: 'string', enum: ['passed', 'failed', 'unknown'] },
        exitStatus: { type: 'string', maxLength: 200 }, claimedCommit: { type: 'string', maxLength: 64 }, claimedClean: { type: 'boolean' }, notes: { type: 'string', maxLength: 4000 },
      } },
    } } },
  }, async (request, reply) => {
    const { changeId } = request.params;
    const { requestId, workspaceId, payload } = request.body;
    const authorization = agentGrant(request, changeId, request.body, workspaceId);
    if (authorization) return reply.code(authorization === 'FORBIDDEN' ? 403 : 409).send({ code: authorization, message: grantError(authorization), requestId: request.id });
    if (payload.claimedCommit !== undefined && !COMMIT_PATTERN.test(payload.claimedCommit)) return reply.code(400).send({ code: 'INVALID_COMMIT', message: '声明的测试版本必须是完整 commit 哈希。', requestId: request.id });
    const command = grantCommand(request, request.body, ['run', changeId, payload]);
    const fingerprint = JSON.stringify(command);
    const findPrior = () => db.prepare('SELECT r.fingerprint, r.execution_id AS executionId, r.record_version AS recordVersion, r.committed_at AS committedAt, e.upload_workspace_id AS workspaceId FROM execution_requests r JOIN executions e ON e.id = r.execution_id WHERE r.request_id = ?').get(requestId) as { fingerprint: string; executionId: string; recordVersion: number; committedAt: string; workspaceId: string | null } | undefined;
    const receiptOf = (prior: { executionId: string; recordVersion: number; committedAt: string }) => ({ requestId, resourceId: prior.executionId, recordVersion: prior.recordVersion, committedAt: prior.committedAt } satisfies Receipt);
    const previous = findPrior();
    if (previous) {
      if (previous.workspaceId !== workspaceId || !sameFingerprint(previous.fingerprint, command)) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
      return reply.code(201).send(receiptOf(previous));
    }
    if (requestIdUsedElsewhere(db, requestId, 'executions')) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    const change = getChange(changeId);
    if (!change) return reply.code(404).send({ code: 'NOT_FOUND', message: '变更不存在。', requestId: request.id });
    if (change.phase !== 'Draft' && change.phase !== 'Working' && change.phase !== 'Reviewing') return reply.code(409).send({ code: 'INVALID_STATE', message: '当前变更状态不能记录执行。', requestId: request.id });
    const workspace = db.prepare('SELECT w.id, w.path, w.version, w.common_key AS commonKey FROM workspaces w JOIN project_repositories p ON p.project_id = w.project_id WHERE w.id = ? AND w.project_id = ? AND w.common_key = p.common_key').get(workspaceId, change.projectId) as { id: string; path: string; version: number; commonKey: string } | undefined;
    if (!workspace) return reply.code(404).send({ code: 'NOT_FOUND', message: '工作区不存在或不属于此项目的当前仓库。', requestId: request.id });
    const upload = await freshObservation(workspace);
    const commitVerified = payload.claimedCommit === undefined ? null : (await containsCommits(workspace.path, workspace.commonKey, [payload.claimedCommit])) ? 1 : 0;
    const result = db.transaction((): Receipt | string => {
      const currentAuthorization = agentGrant(request, changeId, request.body, workspaceId);
      if (currentAuthorization) return currentAuthorization;
      const concurrent = findPrior();
      if (concurrent) return concurrent.workspaceId === workspaceId && sameFingerprint(concurrent.fingerprint, command) ? receiptOf(concurrent) : 'REQUEST_ID_CONFLICT';
      if (requestIdUsedElsewhere(db, requestId, 'executions')) return 'REQUEST_ID_CONFLICT';
      const current = getChange(changeId);
      if (!current) return 'NOT_FOUND';
      if (current.phase !== 'Draft' && current.phase !== 'Working' && current.phase !== 'Reviewing') return 'INVALID_STATE';
      if (current.version !== change.version || current.cycle !== change.cycle) return 'VERSION_CONFLICT';
      if (!bindingUnchanged(current.projectId, workspace.id, workspace)) return 'WORKSPACE_CHANGED';
      const before = projectRecordBytes(db, current.projectId);
      const committedAt = new Date().toISOString();
      const executionId = randomUUID();
      db.prepare('INSERT INTO executions(id,change_id,project_id,cycle,record_version,actor,method,result,exit_status,claimed_commit,claimed_clean,notes,upload_workspace_id,upload_context_json,upload_limitation,commit_verified,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(executionId, changeId, current.projectId, current.cycle, current.version, isOwner(request) ? 'user' : 'agent', payload.method, payload.result, payload.exitStatus ?? '', payload.claimedCommit ?? null, payload.claimedClean === undefined ? null : payload.claimedClean ? 1 : 0, payload.notes ?? '', workspace.id, upload.context ? JSON.stringify(upload.context) : null, upload.limitation, commitVerified, committedAt);
      db.prepare('INSERT INTO execution_requests(request_id,fingerprint,execution_id,record_version,committed_at) VALUES (?,?,?,?,?)').run(requestId, fingerprint, executionId, current.version, committedAt);
      checkProjectCapacity(db, current.projectId, before, recordsLimit);
      return { requestId, resourceId: executionId, recordVersion: current.version, committedAt };
    })();
    if (typeof result === 'string') return reply.code(result === 'NOT_FOUND' ? 404 : result === 'FORBIDDEN' ? 403 : 409).send({ code: result, message: result === 'FORBIDDEN' || result === 'SESSION_EXPIRED' || result === 'WORKSPACE_CHANGED' ? grantError(result) : result === 'NOT_FOUND' ? '变更不存在。' : result === 'INVALID_STATE' ? '当前变更状态不能记录执行。' : result === 'VERSION_CONFLICT' ? '变更在核对期间已更新，请重新提交执行记录。' : '请求标识已用于不同的内容。', requestId: request.id });
    return reply.code(201).send(result);
  });

  app.get<{ Params: { changeId: string } }>('/api/v1/changes/:changeId/evidence', async (request, reply) => {
    const change = getChange(request.params.changeId);
    if (!change) return reply.code(404).send({ code: 'NOT_FOUND', message: '变更不存在。', requestId: request.id });
    const rows = db.prepare('SELECT id, actor, execution_id AS executionId, criterion_source AS criterionSource, baseline_id AS baselineId, revision_id AS revisionId, criterion_id AS criterionId, criterion_index AS criterionIndex, result, actual_commit AS actualCommit, notes, formal, record_version AS recordVersion, created_at AS createdAt, attachment_ids_json AS attachmentIdsJson FROM evidence_records WHERE change_id = ? ORDER BY created_at, id').all(request.params.changeId) as { criterionSource: string; baselineId: string | null; revisionId: string; criterionId: string | null; criterionIndex: number; formal: number; attachmentIdsJson: string }[];
    const evidence = await Promise.all(rows.map(async ({ formal, attachmentIdsJson, ...row }) => {
      let criterionText: string | null = null;
      if (row.criterionSource === 'baseline' && row.baselineId && row.criterionId) {
        const baseline = db.prepare('SELECT criteria_json AS criteriaJson FROM baselines WHERE id = ? AND change_id = ?').get(row.baselineId, request.params.changeId) as { criteriaJson: string } | undefined;
        const criteria = baseline ? JSON.parse(baseline.criteriaJson) as { id: string; text: string }[] : [];
        criterionText = criteria.find(item => item.id === row.criterionId)?.text ?? null;
      } else {
        const revision = db.prepare('SELECT criteria_json AS criteriaJson FROM change_revisions WHERE id = ? AND change_id = ?').get(row.revisionId, request.params.changeId) as { criteriaJson: string } | undefined;
        const criteria = revision ? JSON.parse(revision.criteriaJson) as string[] : [];
        criterionText = row.criterionIndex >= 1 && row.criterionIndex <= criteria.length ? criteria[row.criterionIndex - 1] : null;
      }
      const attachmentIds = JSON.parse(attachmentIdsJson) as string[];
      const attachments = await Promise.all(attachmentIds.map(async id => {
        const found = db.prepare('SELECT id, filename, sha256, size FROM attachments WHERE id = ? AND project_id = ?').get(id, change!.projectId) as { id: string; filename: string; sha256: string; size: number } | undefined;
        if (!found) return { id, filename: '（附件记录缺失）', sha256: '', size: 0, health: 'missing' as const };
        return { ...found, health: await attachmentHealth({ projectId: change!.projectId, sha256: found.sha256, size: found.size }) };
      }));
      const attachmentsHealthy = attachments.length === 0 || attachments.every(item => item.health === 'ok');
      const criterionConsistent = formal !== 1 || evidenceCriterionMatches(db, { changeId: request.params.changeId, baselineId: row.baselineId, criterionId: row.criterionId, criterionIndex: row.criterionIndex });
      return { ...row, formal: formal === 1, formalEffective: formal === 1 && attachmentsHealthy && criterionConsistent, criterionConsistent, attachments, criterionText };
    }));
    return { evidence };
  });

  app.post<{ Params: { changeId: string }; Body: { requestId: string; payload: EvidenceInput } & Grant }>('/api/v1/changes/:changeId/evidence', {
    schema: { body: { type: 'object', required: ['requestId', 'payload'], additionalProperties: false, properties: {
      requestId: { type: 'string', minLength: 1, maxLength: 128 },
      writerSessionId: { type: 'string', minLength: 1 }, generation: { type: 'integer', minimum: 1 },
      payload: { type: 'object', required: ['executionId', 'criterion', 'criterionIndex', 'result'], additionalProperties: false, properties: {
        executionId: { type: 'string', minLength: 1 },
        criterion: { type: 'object', required: ['kind'], additionalProperties: false, properties: { kind: { type: 'string', enum: ['baseline', 'draft'] }, baselineId: { type: 'string' }, criterionId: { type: 'string' }, revisionId: { type: 'string' } } },
        criterionIndex: { type: 'integer', minimum: 1, maximum: 100 }, result: { type: 'string', enum: ['passed', 'failed'] },
        actualCommit: { type: 'string', maxLength: 64 }, notes: { type: 'string', maxLength: 4000 },
        attachmentIds: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1 } },
      } },
    } } },
  }, async (request, reply) => {
    const { changeId } = request.params;
    const { requestId, payload } = request.body;
    const authorization = agentGrant(request, changeId, request.body);
    if (authorization) return reply.code(authorization === 'FORBIDDEN' ? 403 : 409).send({ code: authorization, message: grantError(authorization), requestId: request.id });
    if (payload.actualCommit !== undefined && !COMMIT_PATTERN.test(payload.actualCommit)) return reply.code(400).send({ code: 'INVALID_COMMIT', message: '实际验证版本必须是完整 commit 哈希。', requestId: request.id });
    if ((payload.criterion.kind === 'baseline' && (!payload.criterion.baselineId || !payload.criterion.criterionId)) || (payload.criterion.kind === 'draft' && !payload.criterion.revisionId)) return reply.code(400).send({ code: 'INVALID_REQUEST', message: '条件来源缺少对应标识。', requestId: request.id });
    const baselineCriterion = payload.criterion.kind === 'baseline' ? { baselineId: payload.criterion.baselineId, criterionId: payload.criterion.criterionId } : null;
    const draftCriterion = payload.criterion.kind === 'draft' ? { revisionId: payload.criterion.revisionId } : null;
    const command = grantCommand(request, request.body, ['evidence', changeId, payload]);
    const fingerprint = JSON.stringify(command);
    const findPrior = () => db.prepare('SELECT fingerprint, evidence_id AS evidenceId, record_version AS recordVersion, committed_at AS committedAt FROM evidence_requests WHERE request_id = ?').get(requestId) as { fingerprint: string; evidenceId: string; recordVersion: number; committedAt: string } | undefined;
    const receiptOf = (prior: { evidenceId: string; recordVersion: number; committedAt: string }) => ({ requestId, resourceId: prior.evidenceId, recordVersion: prior.recordVersion, committedAt: prior.committedAt } satisfies Receipt);
    const previous = findPrior();
    if (previous) {
      if (!sameFingerprint(previous.fingerprint, command)) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
      return reply.code(201).send(receiptOf(previous));
    }
    if (requestIdUsedElsewhere(db, requestId, 'evidence')) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    const result = db.transaction((): Receipt | string => {
      const currentAuthorization = agentGrant(request, changeId, request.body);
      if (currentAuthorization) return currentAuthorization;
      const concurrent = findPrior();
      if (concurrent) return sameFingerprint(concurrent.fingerprint, command) ? receiptOf(concurrent) : 'REQUEST_ID_CONFLICT';
      if (requestIdUsedElsewhere(db, requestId, 'evidence')) return 'REQUEST_ID_CONFLICT';
      const change = getChange(changeId);
      if (!change) return 'NOT_FOUND';
      if (change.phase !== 'Draft' && change.phase !== 'Working' && change.phase !== 'Reviewing') return 'INVALID_STATE';
      const execution = db.prepare('SELECT id, claimed_commit AS claimedCommit, claimed_clean AS claimedClean, commit_verified AS commitVerified FROM executions WHERE id = ? AND change_id = ?').get(payload.executionId, changeId) as { claimedCommit: string | null; claimedClean: number | null; commitVerified: number | null } | undefined;
      if (!execution) return 'EXECUTION_NOT_FOUND';
      let criteriaCount = 0;
      let revisionId = '';
      let baselineId: string | null = null;
      let criterionId: string | null = null;
      if (baselineCriterion) {
        const baseline = db.prepare('SELECT id, draft_revision_id AS draftRevisionId, criteria_json AS criteriaJson FROM baselines WHERE id = ? AND change_id = ?').get(baselineCriterion.baselineId, changeId) as { id: string; draftRevisionId: string; criteriaJson: string } | undefined;
        if (!baseline) return 'CRITERION_NOT_FOUND';
        const criteria = JSON.parse(baseline.criteriaJson) as { id: string; text: string }[];
        criteriaCount = criteria.length;
        const matched = criteria.find(item => item.id === baselineCriterion.criterionId);
        if (!matched) return 'CRITERION_NOT_FOUND';
        if (payload.criterionIndex <= criteriaCount && criteria[payload.criterionIndex - 1]?.id !== matched.id) return 'CRITERION_INDEX_MISMATCH';
        baselineId = baseline.id;
        revisionId = baseline.draftRevisionId;
        criterionId = matched.id;
      } else {
        const revision = db.prepare('SELECT id, criteria_json AS criteriaJson FROM change_revisions WHERE id = ? AND change_id = ?').get(draftCriterion!.revisionId, changeId) as { id: string; criteriaJson: string } | undefined;
        if (!revision) return 'CRITERION_NOT_FOUND';
        criteriaCount = (JSON.parse(revision.criteriaJson) as string[]).length;
        revisionId = revision.id;
      }
      if (payload.criterionIndex > criteriaCount) return 'CRITERION_OUT_OF_RANGE';
      const attachmentIds = payload.attachmentIds ?? [];
      for (const attachmentId of attachmentIds) {
        if (!db.prepare('SELECT 1 FROM attachments WHERE id = ? AND project_id = ?').get(attachmentId, change.projectId)) return 'ATTACHMENT_NOT_FOUND';
      }
      const formal = payload.criterion.kind === 'baseline'
        && execution.claimedClean === 1 && execution.commitVerified === 1
        && payload.actualCommit !== undefined && execution.claimedCommit !== null && payload.actualCommit === execution.claimedCommit;
      const before = projectRecordBytes(db, change.projectId);
      const committedAt = new Date().toISOString();
      const evidenceId = randomUUID();
      db.prepare('INSERT INTO evidence_records(id,change_id,project_id,cycle,record_version,actor,execution_id,criterion_source,baseline_id,revision_id,criterion_id,criterion_index,result,actual_commit,notes,formal,created_at,attachment_ids_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(evidenceId, changeId, change.projectId, change.cycle, change.version, isOwner(request) ? 'user' : 'agent', payload.executionId, payload.criterion.kind, baselineId, revisionId, criterionId, payload.criterionIndex, payload.result, payload.actualCommit ?? null, payload.notes ?? '', formal ? 1 : 0, committedAt, JSON.stringify(attachmentIds));
      db.prepare('INSERT INTO evidence_requests(request_id,fingerprint,evidence_id,record_version,committed_at) VALUES (?,?,?,?,?)').run(requestId, fingerprint, evidenceId, change.version, committedAt);
      checkProjectCapacity(db, change.projectId, before, recordsLimit);
      return { requestId, resourceId: evidenceId, recordVersion: change.version, committedAt };
    })();
    if (typeof result === 'string') {
      if (result === 'FORBIDDEN' || result === 'SESSION_EXPIRED' || result === 'WORKSPACE_CHANGED') return reply.code(result === 'FORBIDDEN' ? 403 : 409).send({ code: result, message: grantError(result), requestId: request.id });
      if (result === 'EXECUTION_NOT_FOUND' || result === 'CRITERION_NOT_FOUND') return reply.code(404).send({ code: result, message: result === 'EXECUTION_NOT_FOUND' ? '引用的执行记录不存在。' : '条件来源不存在或不属于此变更。', requestId: request.id });
      if (result === 'CRITERION_OUT_OF_RANGE') return reply.code(400).send({ code: result, message: '条件编号超出该来源的范围。', requestId: request.id });
      if (result === 'CRITERION_INDEX_MISMATCH') return reply.code(400).send({ code: result, message: '条件编号与指定的基线条件不一致。', requestId: request.id });
      if (result === 'ATTACHMENT_NOT_FOUND') return reply.code(404).send({ code: result, message: '引用的附件不存在或不属于此项目。', requestId: request.id });
      return reply.code(result === 'NOT_FOUND' ? 404 : result === 'INVALID_STATE' ? 409 : 409).send({ code: result, message: result === 'NOT_FOUND' ? '变更不存在。' : result === 'INVALID_STATE' ? '当前变更状态不能记录证据。' : '请求标识已用于不同的内容。', requestId: request.id });
    }
    return reply.code(201).send(result);
  });

  app.get<{ Params: { changeId: string } }>('/api/v1/changes/:changeId/acceptance-targets', async (request, reply) => {
    if (!getChange(request.params.changeId)) return reply.code(404).send({ code: 'NOT_FOUND', message: '变更不存在。', requestId: request.id });
    const rows = db.prepare('SELECT t.id, t.actor, t.commit_sha AS commitSha, t.repository_key AS repositoryKey, t.workspace_id AS workspaceId, w.path AS workspacePath, w.version AS workspaceVersion, t.commit_verified AS commitVerified, t.status, t.confirmed_at AS confirmedAt, t.confirmation_order AS confirmationOrder, t.notes, t.record_version AS recordVersion, t.created_at AS createdAt FROM acceptance_targets t JOIN workspaces w ON w.id = t.workspace_id WHERE t.change_id = ? ORDER BY t.created_at, t.id').all(request.params.changeId) as { commitVerified: number; status: string; confirmationOrder: number | null }[];
    const orderUncertain = rows.some(row => row.status === 'confirmed') && !rows.some(row => row.status === 'confirmed' && row.confirmationOrder !== null);
    return { targets: rows.map(({ commitVerified, ...row }) => ({ ...row, commitVerified: commitVerified === 1 })), orderUncertain };
  });

  app.post<{ Params: { changeId: string }; Body: { requestId: string; payload: { commit: string; workspaceId?: string; notes?: string } } & Grant }>('/api/v1/changes/:changeId/acceptance-targets', {
    schema: { body: { type: 'object', required: ['requestId', 'payload'], additionalProperties: false, properties: {
      requestId: { type: 'string', minLength: 1, maxLength: 128 },
      writerSessionId: { type: 'string', minLength: 1 }, generation: { type: 'integer', minimum: 1 },
      payload: { type: 'object', required: ['commit'], additionalProperties: false, properties: { commit: { type: 'string', minLength: 40, maxLength: 64 }, workspaceId: { type: 'string', minLength: 1 }, notes: { type: 'string', maxLength: 2000 } } },
    } } },
  }, async (request, reply) => {
    const { changeId } = request.params;
    const { requestId, payload } = request.body;
    const authorization = agentGrant(request, changeId, request.body, payload.workspaceId);
    if (authorization) return reply.code(authorization === 'FORBIDDEN' ? 403 : 409).send({ code: authorization, message: grantError(authorization), requestId: request.id });
    if (!COMMIT_PATTERN.test(payload.commit)) return reply.code(400).send({ code: 'INVALID_COMMIT', message: '实现目标必须是完整 commit 哈希。', requestId: request.id });
    const command = grantCommand(request, request.body, ['target', changeId, payload]);
    const fingerprint = JSON.stringify(command);
    const findPrior = () => db.prepare('SELECT fingerprint, target_id AS targetId, committed_at AS committedAt FROM acceptance_target_requests WHERE request_id = ? AND action = ?').get(requestId, 'create') as { fingerprint: string; targetId: string; committedAt: string } | undefined;
    const receiptOf = (prior: { targetId: string; committedAt: string }) => ({ requestId, resourceId: prior.targetId, recordVersion: 1, committedAt: prior.committedAt } satisfies Receipt);
    const previous = findPrior();
    if (previous) {
      if (!sameFingerprint(previous.fingerprint, command)) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
      return reply.code(201).send(receiptOf(previous));
    }
    if (db.prepare('SELECT 1 FROM acceptance_target_requests WHERE request_id = ?').get(requestId) || requestIdUsedElsewhere(db, requestId, 'targets')) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    const change = getChange(changeId);
    if (!change) return reply.code(404).send({ code: 'NOT_FOUND', message: '变更不存在。', requestId: request.id });
    if (change.phase !== 'Draft' && change.phase !== 'Working' && change.phase !== 'Reviewing') return reply.code(409).send({ code: 'INVALID_STATE', message: '当前变更状态不能提交实现目标候选。', requestId: request.id });
    const session = isOwner(request) ? null : authorizeWriter(request, request.body.writerSessionId ?? '', request.body.generation ?? 0, changeId);
    const selectedWorkspace = payload.workspaceId ?? (session && typeof session !== 'string' ? session.workspaceId : undefined);
    const workspace = selectedWorkspace === undefined ? boundWorkspace(change.projectId) : db.prepare('SELECT w.id, w.path, w.version, w.common_key AS commonKey FROM workspaces w JOIN project_repositories p ON p.project_id = w.project_id AND p.common_key = w.common_key WHERE w.project_id = ? AND w.id = ?').get(change.projectId, selectedWorkspace) as ReturnType<typeof boundWorkspace>;
    if (!workspace) return reply.code(409).send({ code: 'WORKSPACE_UNAVAILABLE', message: payload.workspaceId === undefined ? '没有可核对 commit 的已绑定工作区。' : '指定的工作区不可用或不属于此项目的已绑定仓库。', requestId: request.id });
    let identity: Awaited<ReturnType<typeof identifyWorkspace>>;
    try {
      identity = await identifyWorkspace(workspace.path);
      if (identity.pathKey !== pathKey(workspace.path) || identity.commonKey !== workspace.commonKey) return reply.code(409).send({ code: 'WORKSPACE_CHANGED', message: '工作目录或仓库身份已变化，请重新绑定后再提交目标。', requestId: request.id });
    } catch {
      return reply.code(503).send({ code: 'WORKSPACE_UNAVAILABLE', message: '无法读取工作区，请检查目录。', requestId: request.id });
    }
    const commitVerified = (await containsCommits(workspace.path, workspace.commonKey, [payload.commit])) ? 1 : 0;
    const result = db.transaction((): Receipt | string => {
      const currentAuthorization = agentGrant(request, changeId, request.body, workspace.id);
      if (currentAuthorization) return currentAuthorization;
      const concurrent = findPrior();
      if (concurrent) return sameFingerprint(concurrent.fingerprint, command) ? receiptOf(concurrent) : 'REQUEST_ID_CONFLICT';
      if (db.prepare('SELECT 1 FROM acceptance_target_requests WHERE request_id = ?').get(requestId) || requestIdUsedElsewhere(db, requestId, 'targets')) return 'REQUEST_ID_CONFLICT';
      const current = getChange(changeId);
      if (!current) return 'NOT_FOUND';
      if (current.phase !== 'Draft' && current.phase !== 'Working' && current.phase !== 'Reviewing') return 'INVALID_STATE';
      if (current.version !== change.version || current.cycle !== change.cycle) return 'VERSION_CONFLICT';
      if (!bindingUnchanged(current.projectId, workspace.id, workspace)) return 'WORKSPACE_CHANGED';
      const before = projectRecordBytes(db, current.projectId);
      const committedAt = new Date().toISOString();
      const targetId = randomUUID();
      db.prepare('INSERT INTO acceptance_targets(id,change_id,project_id,cycle,record_version,commit_sha,repository_key,workspace_id,actor,commit_verified,status,confirmed_at,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)')
        .run(targetId, changeId, current.projectId, current.cycle, current.version, payload.commit, workspace.commonKey, workspace.id, isOwner(request) ? 'user' : 'agent', commitVerified, 'proposed', payload.notes ?? '', committedAt);
      db.prepare('INSERT INTO acceptance_target_requests(request_id,fingerprint,target_id,action,committed_at) VALUES (?,?,?,?,?)').run(requestId, fingerprint, targetId, 'create', committedAt);
      checkProjectCapacity(db, current.projectId, before, recordsLimit);
      return { requestId, resourceId: targetId, recordVersion: 1, committedAt: committedAt };
    })();
    if (typeof result === 'string') return reply.code(result === 'NOT_FOUND' ? 404 : result === 'FORBIDDEN' ? 403 : 409).send({ code: result, message: result === 'FORBIDDEN' || result === 'SESSION_EXPIRED' || result === 'WORKSPACE_CHANGED' ? grantError(result) : result === 'NOT_FOUND' ? '变更不存在。' : result === 'INVALID_STATE' ? '当前变更状态不能提交实现目标候选。' : result === 'VERSION_CONFLICT' ? '变更在核对期间已更新，请重新提交目标。' : '请求标识已用于不同的内容。', requestId: request.id });
    return reply.code(201).send(result);
  });

  app.post<{ Params: { changeId: string; targetId: string }; Body: { requestId: string; expectedBindingVersion?: number } }>('/api/v1/changes/:changeId/acceptance-targets/:targetId/confirm', {
    schema: { body: { type: 'object', required: ['requestId'], additionalProperties: false, properties: { requestId: { type: 'string', minLength: 1, maxLength: 128 }, expectedBindingVersion: { type: 'integer', minimum: 1 } } } },
  }, async (request, reply) => {
    const { changeId, targetId } = request.params;
    const { requestId, expectedBindingVersion } = request.body;
    const fingerprint = JSON.stringify(expectedBindingVersion === undefined ? ['target-confirm', targetId] : ['target-confirm', targetId, expectedBindingVersion]);
    const findPrior = () => db.prepare('SELECT fingerprint, target_id AS tid, committed_at AS committedAt FROM acceptance_target_requests WHERE request_id = ? AND action = ?').get(requestId, 'confirm') as { fingerprint: string; tid: string; committedAt: string } | undefined;
    const previous = findPrior();
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.tid !== targetId) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
      const confirmed = db.prepare('SELECT status, confirmed_at AS confirmedAt FROM acceptance_targets WHERE id = ? AND change_id = ?').get(targetId, changeId) as { status: string; confirmedAt: string | null } | undefined;
      if (!confirmed) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
      return reply.code(200).send({ requestId, resourceId: targetId, status: confirmed?.status ?? 'confirmed', confirmedAt: confirmed?.confirmedAt ?? previous.committedAt });
    }
    if (db.prepare('SELECT 1 FROM acceptance_target_requests WHERE request_id = ?').get(requestId) || requestIdUsedElsewhere(db, requestId, 'targets')) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    const change = getChange(changeId);
    if (!change) return reply.code(404).send({ code: 'NOT_FOUND', message: '变更不存在。', requestId: request.id });
    if (change.phase !== 'Reviewing') return reply.code(409).send({ code: 'INVALID_STATE', message: '进入审阅阶段后才能确认实现目标。', requestId: request.id });
    const target = db.prepare('SELECT id, commit_sha AS commitSha, repository_key AS repositoryKey, workspace_id AS workspaceId, status, notes FROM acceptance_targets WHERE id = ? AND change_id = ?').get(targetId, changeId) as { id: string; commitSha: string; repositoryKey: string; workspaceId: string; status: string; notes: string } | undefined;
    if (!target) return reply.code(404).send({ code: 'NOT_FOUND', message: '实现目标候选不存在。', requestId: request.id });
    if (target.status !== 'proposed') return reply.code(409).send({ code: 'TARGET_ALREADY_CONFIRMED', message: '该实现目标已确认。', requestId: request.id });
    const confirmedCount = () => (db.prepare("SELECT COUNT(*) AS count FROM acceptance_targets WHERE change_id = ? AND status = 'confirmed'").get(changeId) as { count: number }).count;
    const previousConfirmedCount = confirmedCount();
    const workspace = db.prepare('SELECT w.path, w.common_key AS commonKey, w.version FROM workspaces w JOIN project_repositories p ON p.project_id = w.project_id AND p.common_key = w.common_key WHERE w.id = ? AND w.project_id = ? AND w.common_key = ?').get(target.workspaceId, change.projectId, target.repositoryKey) as { path: string; commonKey: string; version: number } | undefined;
    if (!workspace) return reply.code(409).send({ code: 'WORKSPACE_CHANGED', message: '候选目标引用的工作区或仓库身份已变化，请重新核对。', requestId: request.id });
    if (expectedBindingVersion !== undefined && workspace.version !== expectedBindingVersion) return reply.code(409).send({ code: 'WORKSPACE_CHANGED', message: '工作区绑定已变化，请重新读取目标后核对。', requestId: request.id });
    let commitVerified: boolean;
    try {
      const identity = await identifyWorkspace(workspace.path);
      if (identity.commonKey !== workspace.commonKey) return reply.code(409).send({ code: 'WORKSPACE_CHANGED', message: '仓库身份已变化，请重新绑定后再确认目标。', requestId: request.id });
      commitVerified = await containsCommits(workspace.path, workspace.commonKey, [target.commitSha]);
    } catch {
      return reply.code(503).send({ code: 'WORKSPACE_UNAVAILABLE', message: '无法读取工作区，请检查目录。', requestId: request.id });
    }
    if (!commitVerified) return reply.code(409).send({ code: 'COMMIT_UNVERIFIABLE', message: 'commit 无法在已绑定仓库中核对，不能确认为实现目标。', requestId: request.id });
    const result = db.transaction((): { requestId: string; resourceId: string; status: string; confirmedAt: string } | string => {
      const concurrent = findPrior();
      if (concurrent) return concurrent.fingerprint === fingerprint && db.prepare('SELECT 1 FROM acceptance_targets WHERE id = ? AND change_id = ?').get(targetId, changeId) ? { requestId, resourceId: targetId, status: 'confirmed', confirmedAt: concurrent.committedAt } : 'REQUEST_ID_CONFLICT';
      if (db.prepare('SELECT 1 FROM acceptance_target_requests WHERE request_id = ?').get(requestId) || requestIdUsedElsewhere(db, requestId, 'targets')) return 'REQUEST_ID_CONFLICT';
      const currentChange = getChange(changeId);
      if (!currentChange || currentChange.phase !== 'Reviewing') return 'INVALID_STATE';
      if (currentChange.version !== change.version || currentChange.cycle !== change.cycle) return 'VERSION_CONFLICT';
      if (confirmedCount() !== previousConfirmedCount) return 'VERSION_CONFLICT';
      if (!bindingUnchanged(currentChange.projectId, target.workspaceId, workspace)) return 'WORKSPACE_CHANGED';
      const latest = db.prepare('SELECT status FROM acceptance_targets WHERE id = ? AND change_id = ?').get(targetId, changeId) as { status: string } | undefined;
      if (!latest) return 'NOT_FOUND';
      if (latest.status !== 'proposed') return 'TARGET_ALREADY_CONFIRMED';
      const before = projectRecordBytes(db, currentChange.projectId);
      const confirmedAt = new Date().toISOString();
      const previousOrder = (db.prepare('SELECT COALESCE(MAX(confirmation_order), 0) AS value FROM acceptance_targets WHERE change_id = ?').get(changeId) as { value: number }).value;
      db.prepare('UPDATE acceptance_targets SET status = ?, confirmed_at = ?, confirmation_order = ? WHERE id = ?').run('confirmed', confirmedAt, previousOrder + 1, targetId);
      db.prepare('INSERT INTO acceptance_target_requests(request_id,fingerprint,target_id,action,committed_at) VALUES (?,?,?,?,?)').run(requestId, fingerprint, targetId, 'confirm', confirmedAt);
      checkProjectCapacity(db, currentChange.projectId, before, recordsLimit);
      return { requestId, resourceId: targetId, status: 'confirmed', confirmedAt };
    })();
    if (typeof result === 'string') return reply.code(result === 'NOT_FOUND' ? 404 : 409).send({ code: result, message: result === 'NOT_FOUND' ? '实现目标候选不存在。' : result === 'TARGET_ALREADY_CONFIRMED' ? '该实现目标已确认。' : result === 'INVALID_STATE' ? '变更已不在审阅阶段，不能确认目标。' : result === 'VERSION_CONFLICT' ? '变更在核对期间已更新，请重新审阅。' : result === 'WORKSPACE_CHANGED' ? '工作区绑定在核对期间已变化，请重新核对。' : '请求标识已用于不同的内容。', requestId: request.id });
    return reply.code(200).send(result);
  });

  app.get<{ Params: { changeId: string } }>('/api/v1/changes/:changeId/acceptance-proposals', async (request, reply) => {
    if (!getChange(request.params.changeId)) return reply.code(404).send({ code: 'NOT_FOUND', message: '变更不存在。', requestId: request.id });
    const rows = db.prepare('SELECT id, actor, target_id AS targetId, reason, evidence_ids_json AS evidenceIdsJson, record_version AS recordVersion, created_at AS createdAt FROM acceptance_proposals WHERE change_id = ? ORDER BY created_at, id').all(request.params.changeId) as { evidenceIdsJson: string }[];
    return { proposals: rows.map(({ evidenceIdsJson, ...row }) => ({ ...row, evidenceIds: JSON.parse(evidenceIdsJson) as string[] })) };
  });

  app.post<{ Params: { changeId: string }; Body: { requestId: string; expectedVersion: number; payload: { targetId?: string; reason: string; evidenceIds?: string[] } } & Grant }>('/api/v1/changes/:changeId/acceptance-proposals', {
    schema: { body: { type: 'object', required: ['requestId', 'expectedVersion', 'payload'], additionalProperties: false, properties: {
      requestId: { type: 'string', minLength: 1, maxLength: 128 }, expectedVersion: { type: 'integer', minimum: 1 },
      writerSessionId: { type: 'string', minLength: 1 }, generation: { type: 'integer', minimum: 1 },
      payload: { type: 'object', required: ['reason'], additionalProperties: false, properties: { targetId: { type: 'string' }, reason: { type: 'string', minLength: 1, maxLength: 4000 }, evidenceIds: { type: 'array', maxItems: 500, items: { type: 'string', minLength: 1 } } } },
    } } },
  }, async (request, reply) => {
    const { changeId } = request.params;
    const { requestId, expectedVersion, payload } = request.body;
    const authorization = agentGrant(request, changeId, request.body);
    if (authorization) return reply.code(authorization === 'FORBIDDEN' ? 403 : 409).send({ code: authorization, message: grantError(authorization), requestId: request.id });
    if (!payload.reason.trim()) return reply.code(400).send({ code: 'INVALID_REQUEST', message: '验收建议需要说明理由或缺口。', requestId: request.id });
    const command = grantCommand(request, request.body, ['proposal', changeId, expectedVersion, payload]);
    const fingerprint = JSON.stringify(command);
    const findPrior = () => db.prepare('SELECT fingerprint, proposal_id AS proposalId, record_version AS recordVersion, committed_at AS committedAt FROM acceptance_proposal_requests WHERE request_id = ?').get(requestId) as { fingerprint: string; proposalId: string; recordVersion: number; committedAt: string } | undefined;
    const receiptOf = (prior: { proposalId: string; recordVersion: number; committedAt: string }) => ({ requestId, resourceId: prior.proposalId, recordVersion: prior.recordVersion, committedAt: prior.committedAt } satisfies Receipt);
    const previous = findPrior();
    if (previous) {
      if (!sameFingerprint(previous.fingerprint, command)) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
      return reply.code(201).send(receiptOf(previous));
    }
    if (requestIdUsedElsewhere(db, requestId, 'proposals')) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    const evidenceIds = payload.evidenceIds ?? [];
  const result = db.transaction((): Receipt | { currentVersion: number } | string => {
    const currentAuthorization = agentGrant(request, changeId, request.body);
    if (currentAuthorization) return currentAuthorization;
    const concurrent = findPrior();
    if (concurrent) return sameFingerprint(concurrent.fingerprint, command) ? receiptOf(concurrent) : 'REQUEST_ID_CONFLICT';
    if (requestIdUsedElsewhere(db, requestId, 'proposals')) return 'REQUEST_ID_CONFLICT';
    const change = getChange(changeId);
    if (!change) return 'NOT_FOUND';
    if (change.version !== expectedVersion) return { currentVersion: change.version };
      if (change.phase !== 'Working') return 'INVALID_STATE';
      if (payload.targetId !== undefined) {
        const target = db.prepare('SELECT 1 FROM acceptance_targets WHERE id = ? AND change_id = ?').get(payload.targetId, changeId);
        if (!target) return 'TARGET_NOT_FOUND';
      }
      for (const evidenceId of evidenceIds) {
        if (!db.prepare('SELECT 1 FROM evidence_records WHERE id = ? AND change_id = ?').get(evidenceId, changeId)) return 'EVIDENCE_NOT_FOUND';
      }
      const before = projectRecordBytes(db, change.projectId);
      const committedAt = new Date().toISOString();
      const recordVersion = change.version + 1;
      const proposalId = randomUUID();
      db.prepare('INSERT INTO acceptance_proposals(id,change_id,project_id,cycle,record_version,actor,target_id,reason,evidence_ids_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(proposalId, changeId, change.projectId, change.cycle, recordVersion, isOwner(request) ? 'user' : 'agent', payload.targetId ?? null, payload.reason.trim(), JSON.stringify(evidenceIds), committedAt);
      db.prepare('INSERT INTO acceptance_proposal_requests(request_id,fingerprint,proposal_id,record_version,committed_at) VALUES (?,?,?,?,?)').run(requestId, fingerprint, proposalId, recordVersion, committedAt);
      db.prepare("INSERT INTO change_transitions(id,change_id,from_phase,to_phase,cycle,record_version,reason,created_at) VALUES (?,?,?,?,?,?,?,?)").run(randomUUID(), changeId, change.phase, 'Reviewing', change.cycle, recordVersion, payload.reason.trim(), committedAt);
      db.prepare('UPDATE changes SET phase = ?, version = ? WHERE id = ?').run('Reviewing', recordVersion, changeId);
      checkProjectCapacity(db, change.projectId, before, recordsLimit);
      return { requestId, resourceId: proposalId, recordVersion, committedAt: committedAt };
    })();
    if (typeof result === 'string') return reply.code(result === 'NOT_FOUND' || result === 'TARGET_NOT_FOUND' || result === 'EVIDENCE_NOT_FOUND' ? 404 : result === 'FORBIDDEN' ? 403 : 409).send({ code: result, message: result === 'FORBIDDEN' || result === 'SESSION_EXPIRED' || result === 'WORKSPACE_CHANGED' ? grantError(result) : result === 'NOT_FOUND' ? '变更不存在。' : result === 'TARGET_NOT_FOUND' ? '引用的实现目标不存在。' : result === 'EVIDENCE_NOT_FOUND' ? '引用的证据不存在。' : result === 'INVALID_STATE' ? '只有开发中的变更可以提交验收建议。' : '请求标识已用于不同的内容。', requestId: request.id });
    if ('currentVersion' in result) return reply.code(409).send({ code: 'VERSION_CONFLICT', message: '变更已更新，请刷新后重试。', requestId: request.id, currentVersion: result.currentVersion });
    return reply.code(201).send(result);
  });
}
