import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { checkProjectCapacity, projectRecordBytes } from '../storage/project-capacity.js';
import { requestIdUsedElsewhere, sameFingerprint } from '../storage/request-ids.js';
import { identifyWorkspace, pathKey } from '../workspace/git.js';
import { readSpecification } from '../workspace/spec.js';

type Workspace = { id: string; projectId: string; path: string; commonKey: string; version: number };
type Criterion = { id: string; revisionId: string; text: string };
type Prior = { fingerprint: string; baselineId: string; recordVersion: number; committedAt: string };
type Input = { requestId: string; expectedVersion: number; payload: { workspaceId: string; expectedBindingVersion: number; path: string; expectedSha256: string; selection?: string; selectionRange?: { start: number; end: number }; criterionLinks: (string | null)[]; previousSourceItemId: string | null; previousSourceRevisionId?: string | null } };

// Textareas expose LF line endings; retain the matching original source bytes.
function selectedSource(content: string, payload: Input['payload']) {
  const normalize = (text: string) => text.replace(/\r\n?/g, '\n');
  const normalized = normalize(content);
  const selected = payload.selection === undefined ? undefined : normalize(payload.selection);
  const start = payload.selectionRange?.start ?? (selected === undefined ? -1 : normalized.indexOf(selected));
  const end = payload.selectionRange?.end ?? (selected === undefined ? -1 : start + selected.length);
  const splitsSurrogate = (index: number) => index > 0 && index < normalized.length && normalized.charCodeAt(index - 1) >= 0xd800 && normalized.charCodeAt(index - 1) <= 0xdbff && normalized.charCodeAt(index) >= 0xdc00 && normalized.charCodeAt(index) <= 0xdfff;
  if (start < 0 || end <= start || end > normalized.length || splitsSurrogate(start) || splitsSurrogate(end) || !normalized.slice(start, end).trim()) return null;
  const offset = (index: number) => {
    let raw = 0;
    for (let i = 0; i < index; i++, raw++) if (content[raw] === '\r' && content[raw + 1] === '\n') raw++;
    return raw;
  };
  return content.slice(offset(start), offset(end));
}

function error(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string, currentVersion?: number) {
  return reply.code(status).send({ code, message, requestId: request.id, ...(currentVersion === undefined ? {} : { currentVersion }) });
}

export function registerBaselines(app: FastifyInstance, db: Database.Database, recordsLimit: number) {
  const workspaceById = (id: string) => db.prepare('SELECT id, project_id AS projectId, path, common_key AS commonKey, version FROM workspaces WHERE id = ?').get(id) as Workspace | undefined;
  async function source(workspace: Workspace, path: string) {
    const projectRepository = db.prepare('SELECT common_key AS commonKey FROM project_repositories WHERE project_id = ?').get(workspace.projectId) as { commonKey: string } | undefined;
    if (!projectRepository || projectRepository.commonKey !== workspace.commonKey) throw new Error('Workspace requires rebinding');
    const identity = await identifyWorkspace(workspace.path);
    if (identity.pathKey !== pathKey(workspace.path) || identity.commonKey !== workspace.commonKey) throw new Error('Workspace identity changed');
    return readSpecification(workspace.path, identity.commonDir, path);
  }
  app.post<{ Params: { workspaceId: string }; Body: { expectedBindingVersion: number; path: string } }>('/api/v1/workspaces/:workspaceId/spec-preview', {
    schema: { body: { type: 'object', required: ['expectedBindingVersion', 'path'], additionalProperties: false, properties: { expectedBindingVersion: { type: 'integer', minimum: 1 }, path: { type: 'string', minLength: 1, maxLength: 4096 } } } },
  }, async (request, reply) => {
    const workspace = workspaceById(request.params.workspaceId);
    if (!workspace) return error(request, reply, 404, 'NOT_FOUND', '工作区不存在。');
    if (workspace.version !== request.body.expectedBindingVersion) return error(request, reply, 409, 'VERSION_CONFLICT', '工作区绑定已变化，请刷新后重试。', workspace.version);
    try { return { ...await source(workspace, request.body.path), bindingVersion: workspace.version }; }
    catch { return error(request, reply, 400, 'INVALID_SPEC_SOURCE', '无法读取工作区内的 Markdown 规格文件，或文件超过大小限制。'); }
  });
  app.get<{ Params: { changeId: string; baselineId: string } }>('/api/v1/changes/:changeId/baselines/:baselineId', async (request, reply) => {
    const row = db.prepare('SELECT id, change_id AS changeId, draft_revision_id AS draftRevisionId, workspace_id AS workspaceId, binding_version AS bindingVersion, source_path AS path, source_sha256 AS sha256, source_head AS sourceHead, source_committed AS sourceCommitted, selection, source_item_id AS sourceItemId, source_revision_id AS sourceRevisionId, criteria_json AS criteriaJson, goal, scope, non_goals AS nonGoals, record_version AS recordVersion, created_at AS createdAt FROM baselines WHERE id = ? AND change_id = ?').get(request.params.baselineId, request.params.changeId) as { sourceCommitted: number | null; criteriaJson: string } | undefined;
    if (!row) return error(request, reply, 404, 'NOT_FOUND', '规格基线不存在。');
    const { criteriaJson, sourceCommitted, ...rest } = row;
    return { ...rest, sourceCommitted: sourceCommitted === null ? null : sourceCommitted === 1, criteria: JSON.parse(criteriaJson) };
  });
  app.get<{ Params: { changeId: string } }>('/api/v1/changes/:changeId/baselines', async (request, reply) => {
    if (!db.prepare('SELECT 1 FROM changes WHERE id = ?').get(request.params.changeId)) return error(request, reply, 404, 'NOT_FOUND', '变更不存在。');
    const rows = db.prepare('SELECT id, change_id AS changeId, draft_revision_id AS draftRevisionId, workspace_id AS workspaceId, binding_version AS bindingVersion, source_path AS path, source_sha256 AS sha256, source_head AS sourceHead, source_committed AS sourceCommitted, selection, source_item_id AS sourceItemId, source_revision_id AS sourceRevisionId, criteria_json AS criteriaJson, goal, scope, non_goals AS nonGoals, record_version AS recordVersion, created_at AS createdAt FROM baselines WHERE change_id = ? ORDER BY record_version DESC').all(request.params.changeId) as { sourceCommitted: number | null; criteriaJson: string }[];
    return { baselines: rows.map(({ criteriaJson, sourceCommitted, ...rest }) => ({ ...rest, sourceCommitted: sourceCommitted === null ? null : sourceCommitted === 1, criteria: JSON.parse(criteriaJson) })) };
  });
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/spec-items', async (request, reply) => {
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(request.params.projectId)) return error(request, reply, 404, 'NOT_FOUND', '项目不存在。');
    return { revisions: db.prepare('SELECT b.source_item_id AS sourceItemId, b.source_revision_id AS sourceRevisionId, b.selection, b.source_path AS path FROM baselines b JOIN changes c ON c.id = b.change_id WHERE c.project_id = ? GROUP BY b.source_item_id, b.source_revision_id ORDER BY MAX(b.created_at) DESC').all(request.params.projectId) };
  });
  app.get<{ Params: { changeId: string; baselineId: string } }>('/api/v1/changes/:changeId/baselines/:baselineId/source-status', async (request, reply) => {
    const baseline = db.prepare('SELECT workspace_id AS workspaceId, binding_version AS bindingVersion, source_path AS path, source_sha256 AS sha256 FROM baselines WHERE id = ? AND change_id = ?').get(request.params.baselineId, request.params.changeId) as { workspaceId: string; bindingVersion: number; path: string; sha256: string } | undefined;
    if (!baseline) return error(request, reply, 404, 'NOT_FOUND', '规格基线不存在。');
    const workspace = workspaceById(baseline.workspaceId);
    if (!workspace || workspace.version !== baseline.bindingVersion) return { status: 'unavailable' };
    try { return { status: (await source(workspace, baseline.path)).sha256 === baseline.sha256 ? 'unchanged' : 'changed' }; }
    catch { return { status: 'unavailable' }; }
  });
  app.post<{ Params: { changeId: string }; Body: Input }>('/api/v1/changes/:changeId/baselines', {
    schema: { body: { type: 'object', required: ['requestId', 'expectedVersion', 'payload'], additionalProperties: false, properties: {
      requestId: { type: 'string', minLength: 1, maxLength: 128 }, expectedVersion: { type: 'integer', minimum: 1 },
      payload: { type: 'object', required: ['workspaceId', 'expectedBindingVersion', 'path', 'expectedSha256', 'criterionLinks', 'previousSourceItemId'], oneOf: [{ required: ['selection'] }, { required: ['selectionRange'] }], additionalProperties: false, properties: {
        workspaceId: { type: 'string', minLength: 1 }, expectedBindingVersion: { type: 'integer', minimum: 1 }, path: { type: 'string', minLength: 1, maxLength: 4096 }, expectedSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, selection: { type: 'string', minLength: 1 }, selectionRange: { type: 'object', required: ['start', 'end'], additionalProperties: false, properties: { start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 } } }, criterionLinks: { type: 'array', maxItems: 100, items: { type: ['string', 'null'] } }, previousSourceItemId: { type: ['string', 'null'] }, previousSourceRevisionId: { type: ['string', 'null'] },
      } },
    } } },
  }, async (request, reply) => {
    const { changeId } = request.params;
    const { requestId, expectedVersion, payload } = request.body;
    const command = [changeId, expectedVersion, payload];
    const fingerprint = JSON.stringify(command);
    const findPrior = () => db.prepare('SELECT fingerprint, baseline_id AS baselineId, record_version AS recordVersion, committed_at AS committedAt FROM baseline_requests WHERE request_id = ?').get(requestId) as Prior | undefined;
    const receipt = (prior: Prior) => ({ requestId, resourceId: prior.baselineId, recordVersion: prior.recordVersion, committedAt: prior.committedAt });
    const previous = findPrior();
    if (previous) return sameFingerprint(previous.fingerprint, command) ? reply.code(201).send(receipt(previous)) : error(request, reply, 409, 'REQUEST_ID_CONFLICT', '请求标识已用于不同的内容。');
    if (requestIdUsedElsewhere(db, requestId, 'baselines')) return error(request, reply, 409, 'REQUEST_ID_CONFLICT', '请求标识已用于不同的内容。');
    const workspace = workspaceById(payload.workspaceId);
    if (!workspace) return error(request, reply, 404, 'NOT_FOUND', '工作区不存在。');
    if (workspace.version !== payload.expectedBindingVersion) return error(request, reply, 409, 'VERSION_CONFLICT', '工作区绑定已变化，请刷新后重试。', workspace.version);
    const initial = db.prepare('SELECT project_id AS projectId, version FROM changes WHERE id = ?').get(changeId) as { projectId: string; version: number } | undefined;
    if (!initial) return error(request, reply, 404, 'NOT_FOUND', '变更不存在。');
    if (initial.projectId !== workspace.projectId) return error(request, reply, 409, 'WORKSPACE_MISMATCH', '工作区不属于该变更的项目。');
    if (initial.version !== expectedVersion) return error(request, reply, 409, 'VERSION_CONFLICT', '变更已更新，请刷新后重试。', initial.version);
    let captured: Awaited<ReturnType<typeof readSpecification>>;
    try { captured = await source(workspace, payload.path); }
    catch { return error(request, reply, 400, 'INVALID_SPEC_SOURCE', '无法读取工作区内的 Markdown 规格文件，或文件超过大小限制。'); }
    if (captured.sha256 !== payload.expectedSha256) return error(request, reply, 409, 'SOURCE_CHANGED', '规格来源已变化，请重新预览。');
    const selection = selectedSource(captured.content, payload);
    if (selection === null) return error(request, reply, 400, 'INVALID_SELECTION', '所选内容为空或不属于当前规格来源。');
    const result = db.transaction(() => {
      const concurrent = findPrior();
      if (concurrent) return sameFingerprint(concurrent.fingerprint, command) ? receipt(concurrent) : 'REQUEST_ID_CONFLICT';
      if (requestIdUsedElsewhere(db, requestId, 'baselines')) return 'REQUEST_ID_CONFLICT';
      const change = db.prepare('SELECT c.project_id AS projectId, c.phase, c.cycle, c.version, c.current_revision_id AS revisionId, c.current_baseline_id AS baselineId, r.goal, r.scope, r.non_goals AS nonGoals, r.criteria_json AS criteriaJson FROM changes c JOIN change_revisions r ON r.id = c.current_revision_id WHERE c.id = ?').get(changeId) as { projectId: string; phase: string; cycle: number; version: number; revisionId: string; baselineId: string | null; goal: string; scope: string; nonGoals: string; criteriaJson: string } | undefined;
      if (!change) return 'NOT_FOUND';
      if (change.version !== expectedVersion) return { currentVersion: change.version };
      if (change.phase !== 'Draft' && change.phase !== 'Working') return 'INVALID_STATE';
      const latestWorkspace = workspaceById(payload.workspaceId);
      const currentRepo = db.prepare('SELECT common_key AS commonKey FROM project_repositories WHERE project_id = ?').get(change.projectId) as { commonKey: string } | undefined;
      if (!latestWorkspace || latestWorkspace.projectId !== change.projectId || latestWorkspace.version !== payload.expectedBindingVersion || !currentRepo || currentRepo.commonKey !== latestWorkspace.commonKey) return 'WORKSPACE_CHANGED';
      const texts = JSON.parse(change.criteriaJson) as string[];
      if (texts.length === 0 || texts.some(text => !text.trim()) || texts.length !== payload.criterionLinks.length) return 'INVALID_CRITERIA';
      const old = change.baselineId ? db.prepare('SELECT source_item_id AS sourceItemId, source_revision_id AS sourceRevisionId, selection, criteria_json AS criteriaJson FROM baselines WHERE id = ?').get(change.baselineId) as { sourceItemId: string; sourceRevisionId: string; selection: string; criteriaJson: string } | undefined : undefined;
      const linkedRevision = payload.previousSourceItemId === null ? undefined : payload.previousSourceRevisionId
        ? db.prepare('SELECT b.selection, b.source_revision_id AS sourceRevisionId FROM baselines b JOIN changes c ON c.id = b.change_id WHERE c.project_id = ? AND b.source_item_id = ? AND b.source_revision_id = ? LIMIT 1').get(change.projectId, payload.previousSourceItemId, payload.previousSourceRevisionId) as { selection: string; sourceRevisionId: string } | undefined
        : old?.sourceItemId === payload.previousSourceItemId ? old : undefined;
      if ((payload.previousSourceItemId !== null && !linkedRevision) || (payload.previousSourceItemId === null && payload.previousSourceRevisionId)) return 'INVALID_SOURCE_ITEM';
      const history = db.prepare('SELECT criteria_json AS criteriaJson FROM baselines WHERE change_id = ? ORDER BY record_version DESC').all(changeId) as { criteriaJson: string }[];
      const knownCriteria = new Map<string, Criterion>();
      for (const row of history) for (const criterion of JSON.parse(row.criteriaJson) as Criterion[]) if (!knownCriteria.has(criterion.id)) knownCriteria.set(criterion.id, criterion);
      const linked = payload.criterionLinks.filter((id): id is string => id !== null);
      if (new Set(linked).size !== linked.length || linked.some(id => !knownCriteria.has(id))) return 'INVALID_CRITERION_LINK';
      const criteria = texts.map((text, index) => {
        const prior = knownCriteria.get(payload.criterionLinks[index] ?? '');
        return { id: prior?.id ?? randomUUID(), revisionId: prior?.text === text ? prior.revisionId : randomUUID(), text };
      });
      const before = projectRecordBytes(db, change.projectId);
      const result = { requestId, resourceId: randomUUID(), recordVersion: change.version + 1, committedAt: new Date().toISOString() };
      const sourceRevisionId = linkedRevision?.selection === selection ? linkedRevision.sourceRevisionId : randomUUID();
      db.prepare('INSERT INTO baselines(id,change_id,draft_revision_id,workspace_id,binding_version,source_path,source_sha256,source_head,source_committed,selection,source_item_id,source_revision_id,criteria_json,goal,scope,non_goals,record_version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(result.resourceId, changeId, change.revisionId, workspace.id, workspace.version, captured.path, captured.sha256, captured.head, captured.committed === null ? null : Number(captured.committed), selection, payload.previousSourceItemId ?? randomUUID(), sourceRevisionId, JSON.stringify(criteria), change.goal, change.scope, change.nonGoals, result.recordVersion, result.committedAt);
      if (change.phase === 'Draft') db.prepare('INSERT INTO change_transitions(id,change_id,from_phase,to_phase,cycle,record_version,reason,created_at) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), changeId, 'Draft', 'Working', change.cycle, result.recordVersion, '确认规格基线', result.committedAt);
      db.prepare("UPDATE changes SET current_baseline_id = ?, phase = 'Working', version = ? WHERE id = ?").run(result.resourceId, result.recordVersion, changeId);
      db.prepare('INSERT INTO baseline_requests(request_id,fingerprint,baseline_id,record_version,committed_at) VALUES (?,?,?,?,?)').run(requestId, fingerprint, result.resourceId, result.recordVersion, result.committedAt);
      checkProjectCapacity(db, change.projectId, before, recordsLimit);
      return result;
    })();
    if (typeof result === 'string') return error(request, reply, result === 'NOT_FOUND' ? 404 : 409, result, result === 'INVALID_CRITERIA' ? '至少需要一项非空验收条件。' : result === 'INVALID_CRITERION_LINK' || result === 'INVALID_SOURCE_ITEM' ? '所选规格或验收条件不能关联当前基线。' : result === 'WORKSPACE_CHANGED' ? '工作区绑定已变化，请重新预览。' : result === 'INVALID_STATE' ? '当前状态不能采用基线。' : result === 'NOT_FOUND' ? '变更不存在。' : '请求标识已用于不同的内容。');
    if ('currentVersion' in result) return error(request, reply, 409, 'VERSION_CONFLICT', '变更已更新，请刷新后重试。', result.currentVersion);
    return reply.code(201).send(result);
  });
}
