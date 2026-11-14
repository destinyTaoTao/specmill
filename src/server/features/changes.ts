import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { checkProjectCapacity, projectRecordBytes } from '../storage/project-capacity.js';
import { requestIdUsedElsewhere, sameFingerprint } from '../storage/request-ids.js';

type Draft = { title: string; goal: string; scope: string; nonGoals: string; criteria: string[] };
type DraftCommand = { requestId: string; expectedVersion: null; payload: Draft };
type Receipt = { requestId: string; resourceId: string; recordVersion: number; committedAt: string };
type Previous = { fingerprint: string; resourceId: string; recordVersion: number; committedAt: string };
const draftSchema = { type: 'object', required: ['title', 'goal', 'scope', 'nonGoals', 'criteria'], additionalProperties: false, properties: {
  title: { type: 'string', minLength: 1, maxLength: 200 }, goal: { type: 'string', maxLength: 10000 }, scope: { type: 'string', maxLength: 10000 }, nonGoals: { type: 'string', maxLength: 10000 }, criteria: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 4000 } },
} } as const;

export function registerChanges(app: FastifyInstance, db: Database.Database, recordsLimit: number) {
  app.get<{ Params: { changeId: string } }>('/api/v1/changes/:changeId', async (request, reply) => {
    const row = db.prepare('SELECT c.id, c.project_id AS projectId, c.phase, c.cycle, c.version, c.current_revision_id AS revisionId, c.current_baseline_id AS baselineId, c.current_checkpoint_id AS checkpointId, r.title, r.goal, r.scope, r.non_goals AS nonGoals, r.criteria_json AS criteriaJson FROM changes c JOIN change_revisions r ON r.id = c.current_revision_id WHERE c.id = ?').get(request.params.changeId) as { revisionId: string; baselineId: string | null; goal: string; scope: string; nonGoals: string; criteriaJson: string } | undefined;
    if (!row) return reply.code(404).send({ code: 'NOT_FOUND', message: '变更不存在。', requestId: request.id });
    const { criteriaJson, goal, scope, nonGoals, ...change } = row;
    const draft = { revisionId: row.revisionId, goal, scope, nonGoals, criteria: JSON.parse(criteriaJson) };
    const baseline = row.baselineId ? db.prepare('SELECT id, draft_revision_id AS draftRevisionId, goal, scope, non_goals AS nonGoals, criteria_json AS criteriaJson, source_path AS path, source_sha256 AS sha256, selection, source_item_id AS sourceItemId, source_revision_id AS sourceRevisionId FROM baselines WHERE id = ? AND change_id = ?').get(row.baselineId, request.params.changeId) as { criteriaJson: string } | undefined : undefined;
    const basis = baseline ? (({ criteriaJson: baselineCriteria, ...snapshot }) => ({ kind: 'baseline', ...snapshot, criteria: JSON.parse(baselineCriteria) }))(baseline) : { kind: 'unconfirmedDraft', ...draft };
    const activeSession = db.prepare("SELECT id, workspace_id AS workspaceId, binding_version AS bindingVersion, tool_label AS toolLabel, actor, generation, created_at AS createdAt FROM writer_sessions WHERE change_id = ? AND status = 'active'").get(request.params.changeId) ?? null;
    return { ...change, draft, basis, activeSession };
  });
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/changes', async (request, reply) => {
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(request.params.projectId)) return reply.code(404).send({ code: 'NOT_FOUND', message: '项目不存在。', requestId: request.id });
    const rows = db.prepare('SELECT c.id, c.phase, c.cycle, c.version, c.current_revision_id AS revisionId, c.current_baseline_id AS baselineId, r.title, r.goal, r.scope, r.non_goals AS nonGoals, r.criteria_json AS criteriaJson FROM changes c JOIN change_revisions r ON r.id = c.current_revision_id WHERE c.project_id = ? ORDER BY c.created_at, c.id').all(request.params.projectId) as { criteriaJson: string }[];
    return { changes: rows.map(({ criteriaJson, ...row }) => ({ ...row, criteria: JSON.parse(criteriaJson) })) };
  });
  app.post<{ Params: { projectId: string }; Body: DraftCommand }>('/api/v1/projects/:projectId/changes', {
    schema: { body: { type: 'object', required: ['requestId', 'expectedVersion', 'payload'], additionalProperties: false, properties: {
      requestId: { type: 'string', minLength: 1, maxLength: 128 }, expectedVersion: { type: 'null' },
      payload: draftSchema,
    } } },
  }, async (request, reply) => {
    const { projectId } = request.params;
    const { requestId, payload } = request.body;
    if (!payload.title.trim()) return reply.code(400).send({ code: 'INVALID_TITLE', message: '变更标题不能为空。', requestId: request.id });
    const command = ['create', projectId, payload];
    const fingerprint = JSON.stringify(command);
    const result = db.transaction(() => {
      const previous = db.prepare('SELECT fingerprint, resource_id AS resourceId, record_version AS recordVersion, committed_at AS committedAt FROM change_requests WHERE request_id = ?').get(requestId) as Previous | undefined;
      if (previous) return sameFingerprint(previous.fingerprint, command) ? { requestId, resourceId: previous.resourceId, recordVersion: previous.recordVersion, committedAt: previous.committedAt } satisfies Receipt : 'REQUEST_ID_CONFLICT';
      if (requestIdUsedElsewhere(db, requestId, 'changes')) return 'REQUEST_ID_CONFLICT';
      if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) return 'NOT_FOUND';
      const before = projectRecordBytes(db, projectId);
      const receipt: Receipt = { requestId, resourceId: randomUUID(), recordVersion: 1, committedAt: new Date().toISOString() };
      const revisionId = randomUUID();
      db.prepare("INSERT INTO changes(id,project_id,phase,cycle,version,current_revision_id,created_at) VALUES (?,?,'Draft',1,1,?,?)").run(receipt.resourceId, projectId, revisionId, receipt.committedAt);
      db.prepare('INSERT INTO change_revisions(id,change_id,version,title,goal,scope,non_goals,criteria_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(revisionId, receipt.resourceId, 1, payload.title.trim(), payload.goal, payload.scope, payload.nonGoals, JSON.stringify(payload.criteria), receipt.committedAt);
      db.prepare('INSERT INTO change_requests(request_id,fingerprint,resource_id,record_version,committed_at) VALUES (?,?,?,?,?)').run(requestId, fingerprint, receipt.resourceId, 1, receipt.committedAt);
      checkProjectCapacity(db, projectId, before, recordsLimit);
      return receipt;
    })();
    if (typeof result === 'string') return reply.code(result === 'NOT_FOUND' ? 404 : 409).send({ code: result, message: result === 'NOT_FOUND' ? '项目不存在。' : '请求标识已用于不同的内容。', requestId: request.id });
    return reply.code(201).send(result);
  });
  app.get<{ Params: { changeId: string } }>('/api/v1/changes/:changeId/revisions', async (request, reply) => {
    if (!db.prepare('SELECT 1 FROM changes WHERE id = ?').get(request.params.changeId)) return reply.code(404).send({ code: 'NOT_FOUND', message: '变更不存在。', requestId: request.id });
    const rows = db.prepare('SELECT id, version, title, goal, scope, non_goals AS nonGoals, criteria_json AS criteriaJson, created_at AS createdAt FROM change_revisions WHERE change_id = ? ORDER BY version').all(request.params.changeId) as { criteriaJson: string }[];
    return { revisions: rows.map(({ criteriaJson, ...row }) => ({ ...row, criteria: JSON.parse(criteriaJson) })) };
  });
  app.patch<{ Params: { changeId: string }; Body: { requestId: string; expectedVersion: number; payload: Draft } }>('/api/v1/changes/:changeId', {
    schema: { body: { type: 'object', required: ['requestId', 'expectedVersion', 'payload'], additionalProperties: false, properties: {
      requestId: { type: 'string', minLength: 1, maxLength: 128 }, expectedVersion: { type: 'integer', minimum: 1 }, payload: draftSchema,
    } } },
  }, async (request, reply) => {
    const { changeId } = request.params;
    const { requestId, expectedVersion, payload } = request.body;
    if (!payload.title.trim()) return reply.code(400).send({ code: 'INVALID_TITLE', message: '变更标题不能为空。', requestId: request.id });
    const command = ['update', changeId, expectedVersion, payload];
    const fingerprint = JSON.stringify(command);
    const result = db.transaction(() => {
      const previous = db.prepare('SELECT fingerprint, resource_id AS resourceId, record_version AS recordVersion, committed_at AS committedAt FROM change_requests WHERE request_id = ?').get(requestId) as Previous | undefined;
      if (previous) return sameFingerprint(previous.fingerprint, command) ? { requestId, resourceId: previous.resourceId, recordVersion: previous.recordVersion, committedAt: previous.committedAt } satisfies Receipt : 'REQUEST_ID_CONFLICT';
      if (requestIdUsedElsewhere(db, requestId, 'changes')) return 'REQUEST_ID_CONFLICT';
      const change = db.prepare('SELECT project_id AS projectId, phase, version FROM changes WHERE id = ?').get(changeId) as { projectId: string; phase: string; version: number } | undefined;
      if (!change) return 'NOT_FOUND';
      if (change.version !== expectedVersion) return { currentVersion: change.version };
      if (change.phase !== 'Draft' && change.phase !== 'Working') return 'INVALID_STATE';
      const before = projectRecordBytes(db, change.projectId);
      const receipt: Receipt = { requestId, resourceId: changeId, recordVersion: change.version + 1, committedAt: new Date().toISOString() };
      const revisionId = randomUUID();
      db.prepare('INSERT INTO change_revisions(id,change_id,version,title,goal,scope,non_goals,criteria_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(revisionId, changeId, receipt.recordVersion, payload.title.trim(), payload.goal, payload.scope, payload.nonGoals, JSON.stringify(payload.criteria), receipt.committedAt);
      db.prepare('UPDATE changes SET version = ?, current_revision_id = ? WHERE id = ?').run(receipt.recordVersion, revisionId, changeId);
      db.prepare('INSERT INTO change_requests(request_id,fingerprint,resource_id,record_version,committed_at) VALUES (?,?,?,?,?)').run(requestId, fingerprint, changeId, receipt.recordVersion, receipt.committedAt);
      checkProjectCapacity(db, change.projectId, before, recordsLimit);
      return receipt;
    })();
    if (typeof result === 'string') return reply.code(result === 'NOT_FOUND' ? 404 : 409).send({ code: result, message: result === 'NOT_FOUND' ? '变更不存在。' : result === 'INVALID_STATE' ? '当前状态不能修改草案。' : '请求标识已用于不同的内容。', requestId: request.id });
    if ('currentVersion' in result) return reply.code(409).send({ code: 'VERSION_CONFLICT', message: '变更已更新，请刷新后重试。', requestId: request.id, currentVersion: result.currentVersion });
    return reply.code(200).send(result);
  });

  app.get<{ Params: { changeId: string } }>('/api/v1/changes/:changeId/transitions', async (request, reply) => {
    if (!db.prepare('SELECT 1 FROM changes WHERE id = ?').get(request.params.changeId)) return reply.code(404).send({ code: 'NOT_FOUND', message: '变更不存在。', requestId: request.id });
    return { transitions: db.prepare('SELECT id, from_phase AS "from", to_phase AS "to", cycle, record_version AS recordVersion, reason, created_at AS createdAt FROM change_transitions WHERE change_id = ? ORDER BY record_version').all(request.params.changeId) };
  });
  app.post<{ Params: { changeId: string; action: 'cancel' | 'reopen' }; Body: { requestId: string; expectedVersion: number; payload: { reason?: string; baselineId?: string } } }>('/api/v1/changes/:changeId/:action', {
    schema: {
      params: { type: 'object', required: ['changeId', 'action'], properties: { changeId: { type: 'string' }, action: { type: 'string', enum: ['cancel', 'reopen'] } } },
      body: { type: 'object', required: ['requestId', 'expectedVersion', 'payload'], additionalProperties: false, properties: {
        requestId: { type: 'string', minLength: 1, maxLength: 128 }, expectedVersion: { type: 'integer', minimum: 1 },
        payload: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string', maxLength: 10000 }, baselineId: { type: 'string', minLength: 1 } } },
      } },
    },
  }, async (request, reply) => {
    const { changeId, action } = request.params;
    const { requestId, expectedVersion, payload } = request.body;
    if (action === 'cancel' && !payload.reason?.trim()) return reply.code(400).send({ code: 'REASON_REQUIRED', message: '取消变更需要填写原因。', requestId: request.id });
    const command = [action, changeId, expectedVersion, payload];
    const fingerprint = JSON.stringify(command);
    const result = db.transaction(() => {
      const previous = db.prepare('SELECT fingerprint, resource_id AS resourceId, record_version AS recordVersion, committed_at AS committedAt FROM change_requests WHERE request_id = ?').get(requestId) as Previous | undefined;
      if (previous) return sameFingerprint(previous.fingerprint, command) ? { requestId, resourceId: previous.resourceId, recordVersion: previous.recordVersion, committedAt: previous.committedAt } satisfies Receipt : 'REQUEST_ID_CONFLICT';
      if (requestIdUsedElsewhere(db, requestId, 'changes')) return 'REQUEST_ID_CONFLICT';
      const change = db.prepare('SELECT project_id AS projectId, phase, cycle, version, current_baseline_id AS baselineId FROM changes WHERE id = ?').get(changeId) as { projectId: string; phase: string; cycle: number; version: number; baselineId: string | null } | undefined;
      if (!change) return 'NOT_FOUND';
      if (change.version !== expectedVersion) return { currentVersion: change.version };
      if ((action === 'cancel' && change.phase !== 'Draft' && change.phase !== 'Working' && change.phase !== 'Reviewing') || (action === 'reopen' && change.phase !== 'Canceled' && change.phase !== 'Accepted')) return 'INVALID_STATE';
      if (action === 'reopen' && change.baselineId !== null && payload.baselineId !== change.baselineId) return 'BASELINE_CONFIRMATION_REQUIRED';
      if (action === 'reopen' && change.baselineId === null && payload.baselineId !== undefined) return 'INVALID_STATE';
      if (action === 'reopen' && change.phase === 'Accepted' && !payload.reason?.trim()) return 'REASON_REQUIRED';
      const before = projectRecordBytes(db, change.projectId);
      const to = action === 'cancel' ? 'Canceled' : change.baselineId === null ? 'Draft' : 'Working';
      const cycle = action === 'reopen' ? change.cycle + 1 : change.cycle;
      const receipt: Receipt = { requestId, resourceId: changeId, recordVersion: change.version + 1, committedAt: new Date().toISOString() };
      if (action === 'cancel') db.prepare("UPDATE writer_sessions SET status = 'canceled', ended_at = ? WHERE change_id = ? AND status = 'active'").run(receipt.committedAt, changeId);
      db.prepare('INSERT INTO change_transitions(id,change_id,from_phase,to_phase,cycle,record_version,reason,created_at) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), changeId, change.phase, to, cycle, receipt.recordVersion, payload.reason?.trim() ?? '', receipt.committedAt);
      db.prepare('UPDATE changes SET phase = ?, cycle = ?, version = ? WHERE id = ?').run(to, cycle, receipt.recordVersion, changeId);
      db.prepare('INSERT INTO change_requests(request_id,fingerprint,resource_id,record_version,committed_at) VALUES (?,?,?,?,?)').run(requestId, fingerprint, changeId, receipt.recordVersion, receipt.committedAt);
      checkProjectCapacity(db, change.projectId, before, recordsLimit);
      return receipt;
    })();
    if (typeof result === 'string') return reply.code(result === 'NOT_FOUND' ? 404 : 409).send({ code: result, message: result === 'NOT_FOUND' ? '变更不存在。' : result === 'INVALID_STATE' ? '当前状态不能执行此操作。' : result === 'BASELINE_CONFIRMATION_REQUIRED' ? '请确认继续采用的规格基线。' : '请求标识已用于不同的内容。', requestId: request.id });
    if ('currentVersion' in result) return reply.code(409).send({ code: 'VERSION_CONFLICT', message: '变更已更新，请刷新后重试。', requestId: request.id, currentVersion: result.currentVersion });
    return reply.code(200).send(result);
  });
}
