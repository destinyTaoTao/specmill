import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { checkProjectCapacity, projectRecordBytes } from '../storage/project-capacity.js';
import { requestIdUsedElsewhere } from '../storage/request-ids.js';
import { identifyWorkspace, observeWorkspace, ObservationTempInsideWorkspace, pathKey } from '../workspace/git.js';
import { renderHandoffMarkdown, type HandoffContent, type HandoffAcceptance, type HandoffEvidence } from '../../shared/handoff.js';
import { blockingFailures, confirmedTarget } from '../storage/acceptance-context.js';
import type { WriterAuthorization } from './writer-sessions.js';
import { createWriterGuard, writerCommand, writerGrantMessage, type WriterGrant } from './writer-guard.js';

type Receipt = { requestId: string; resourceId: string; recordVersion: number; committedAt: string };

function captureAcceptance(db: Database.Database, changeId: string, cycle: number, basis: HandoffContent['basis']): HandoffAcceptance {
  const baselineId = basis.kind === 'baseline' ? basis.baselineId : null;
  const { target, targetOrderUncertain } = confirmedTarget(db, changeId);
  // Preserve the original context of evidence reused in a decision or a failure disposition.
  const rows = db.prepare(`WITH used_evidence AS (
      SELECT j.value AS id FROM decisions d, json_each(d.evidence_ids_json) j
      WHERE d.change_id = @changeId AND d.cycle = @cycle AND d.baseline_id = @baselineId
        AND d.target_id = @targetId AND d.superseded_by IS NULL
      UNION
      SELECT j.value FROM failure_dispositions f, json_each(f.supporting_evidence_ids_json) j
      WHERE f.change_id = @changeId AND f.cycle = @cycle AND f.baseline_id = @baselineId AND f.target_id = @targetId
    )
    SELECT e.id, e.execution_id AS executionId, e.cycle, e.baseline_id AS baselineId, e.revision_id AS revisionId,
      e.criterion_id AS criterionId, e.criterion_index AS criterionIndex, e.result, e.actual_commit AS actualCommit, e.formal, e.notes
    FROM evidence_records e WHERE e.change_id = @changeId AND (
      (e.cycle = @cycle AND e.baseline_id IS @baselineId AND e.revision_id = @revisionId) OR e.id IN (SELECT id FROM used_evidence))
    ORDER BY e.created_at, e.id`).all({ changeId, cycle, baselineId, revisionId: basis.revisionId, targetId: target?.id ?? null }) as
    (Omit<HandoffEvidence, 'formal'> & { formal: number; notes: string })[];
  const openFailureIds = baselineId
    ? blockingFailures(db, changeId, cycle, baselineId, null, target?.id ?? null).map(row => row.id)
    : rows.filter(row => row.result === 'failed').map(row => row.id);
  const open = new Set(openFailureIds);
  return { target: target ? { id: target.id, commitSha: target.commitSha } : null, targetOrderUncertain, openFailureIds,
    evidence: rows.map(({ formal, notes, ...ref }) => ({ ...ref, formal: formal === 1, ...(open.has(ref.id) && notes ? { notes } : {}) })) };
}

// 捕获当前状态并写入固定交接快照（不含请求登记与容量校验，由调用方在同一事务内完成）。
export function createHandoffSnapshotRow(db: Database.Database, changeId: string): { snapshotId: string; committedAt: string } | null {
  const change = db.prepare('SELECT c.project_id AS projectId, c.phase, c.cycle, c.version, c.current_revision_id AS revisionId, c.current_baseline_id AS baselineId, p.name AS projectName FROM changes c JOIN projects p ON p.id = c.project_id WHERE c.id = ?').get(changeId) as { projectId: string; phase: string; cycle: number; version: number; revisionId: string; baselineId: string | null; projectName: string } | undefined;
  if (!change) return null;
  const revision = db.prepare('SELECT title, goal, scope, non_goals AS nonGoals, criteria_json AS criteriaJson FROM change_revisions WHERE id = ? AND change_id = ?').get(change.revisionId, changeId) as { title: string; goal: string; scope: string; nonGoals: string; criteriaJson: string } | undefined;
  if (!revision) return null;
  let goal = revision.goal;
  let scope = revision.scope;
  let nonGoals = revision.nonGoals;
  let criteria: HandoffContent['criteria'] = JSON.parse(revision.criteriaJson);
  let basis: HandoffContent['basis'] = { kind: 'unconfirmedDraft', revisionId: change.revisionId };
  if (change.baselineId) {
    const baseline = db.prepare('SELECT id, draft_revision_id AS draftRevisionId, goal, scope, non_goals AS nonGoals, criteria_json AS criteriaJson, source_path AS sourcePath, source_sha256 AS sourceSha256, source_head AS sourceHead FROM baselines WHERE id = ? AND change_id = ?').get(change.baselineId, changeId) as { id: string; draftRevisionId: string; goal: string; scope: string; nonGoals: string; criteriaJson: string; sourcePath: string; sourceSha256: string; sourceHead: string | null } | undefined;
    if (!baseline) return null;
    goal = baseline.goal;
    scope = baseline.scope;
    nonGoals = baseline.nonGoals;
    criteria = JSON.parse(baseline.criteriaJson);
    basis = { kind: 'baseline', baselineId: baseline.id, revisionId: baseline.draftRevisionId, sourcePath: baseline.sourcePath, sourceSha256: baseline.sourceSha256, sourceHead: baseline.sourceHead };
  }
  const checkpointRow = db.prepare('SELECT p.id, p.record_version AS recordVersion, p.actor, p.goal, p.done, p.failures, p.unverified, p.blockers, p.next_steps AS nextSteps, p.created_at AS createdAt, o.id AS observationId, o.workspace_id AS observationWorkspaceId, o.binding_version AS bindingVersion, o.path AS observationPath, o.created_at AS observationCreatedAt, o.data_json AS observationJson FROM checkpoints p JOIN workspace_observations o ON o.id = p.observation_id WHERE p.change_id = ? ORDER BY p.record_version DESC LIMIT 1').get(changeId) as { id: string; recordVersion: number; actor: string; goal: string; done: string; failures: string; unverified: string; nextSteps: string; blockers: string; createdAt: string; observationId: string; observationWorkspaceId: string; bindingVersion: number; observationPath: string; observationCreatedAt: string; observationJson: string } | undefined;
  const checkpoint = checkpointRow ? (() => {
    const observation = JSON.parse(checkpointRow.observationJson) as { head: string | null; branch: string | null; stable: boolean; limitations: string[]; files: { path: string; status: string; sha256?: string }[]; trackedDiffSha256: string | null };
    return {
      id: checkpointRow.id, recordVersion: checkpointRow.recordVersion, actor: checkpointRow.actor as 'user' | 'agent', createdAt: checkpointRow.createdAt,
      goal: checkpointRow.goal, done: checkpointRow.done, failures: checkpointRow.failures, unverified: checkpointRow.unverified, blockers: checkpointRow.blockers, nextSteps: checkpointRow.nextSteps,
      observation: { id: checkpointRow.observationId, workspaceId: checkpointRow.observationWorkspaceId, path: checkpointRow.observationPath, bindingVersion: checkpointRow.bindingVersion, createdAt: checkpointRow.observationCreatedAt, ...observation },
    };
  })() : null;
  const snapshotId = randomUUID();
  const committedAt = new Date().toISOString();
  const content: HandoffContent = {
    projectId: change.projectId, projectName: change.projectName, changeId, changeTitle: revision.title,
    snapshotId, createdAt: committedAt, phase: change.phase, cycle: change.cycle, capturedVersion: change.version,
    goal, scope, nonGoals, criteria, basis, checkpoint, acceptance: captureAcceptance(db, changeId, change.cycle, basis),
  };
  db.prepare('INSERT INTO handoff_snapshots(id,change_id,project_id,cycle,version,phase,content_json,created_at) VALUES (?,?,?,?,?,?,?,?)').run(snapshotId, changeId, change.projectId, change.cycle, change.version, change.phase, JSON.stringify(content), committedAt);
  return { snapshotId, committedAt };
}

export function registerHandoffs(app: FastifyInstance, db: Database.Database, recordsLimit: number, isOwner: (request: FastifyRequest) => boolean, authorizeWriter: WriterAuthorization) {
  const checkWriter = createWriterGuard(db, isOwner, authorizeWriter);
  app.get<{ Params: { changeId: string } }>('/api/v1/changes/:changeId/handoffs', async (request, reply) => {
    if (!db.prepare('SELECT 1 FROM changes WHERE id = ?').get(request.params.changeId)) return reply.code(404).send({ code: 'NOT_FOUND', message: '变更不存在。', requestId: request.id });
    const rows = db.prepare('SELECT id, cycle, version, phase, content_json AS contentJson, created_at AS createdAt FROM handoff_snapshots WHERE change_id = ? ORDER BY created_at, id').all(request.params.changeId) as { id: string; cycle: number; version: number; phase: string; contentJson: string; createdAt: string }[];
    return { snapshots: rows.map(({ contentJson, ...row }) => ({ ...row, capturedVersion: row.version, changeTitle: (JSON.parse(contentJson) as HandoffContent).changeTitle })) };
  });

  app.get<{ Params: { snapshotId: string } }>('/api/v1/handoffs/:snapshotId', async (request, reply) => {
    const row = db.prepare('SELECT s.id, s.change_id AS changeId, s.cycle, s.version, s.phase, s.content_json AS contentJson, s.created_at AS createdAt FROM handoff_snapshots s WHERE s.id = ?').get(request.params.snapshotId) as { contentJson: string } | undefined;
    if (!row) return reply.code(404).send({ code: 'NOT_FOUND', message: '交接快照不存在。', requestId: request.id });
    return { ...JSON.parse(row.contentJson) as HandoffContent };
  });

  app.get<{ Params: { snapshotId: string } }>('/api/v1/handoffs/:snapshotId/render', async (request, reply) => {
    const row = db.prepare('SELECT id, content_json AS contentJson FROM handoff_snapshots WHERE id = ?').get(request.params.snapshotId) as { id: string; contentJson: string } | undefined;
    if (!row) return reply.code(404).send({ code: 'NOT_FOUND', message: '交接快照不存在。', requestId: request.id });
    const content = JSON.parse(row.contentJson) as HandoffContent;
    const markdown = renderHandoffMarkdown(content);
    return { snapshotId: row.id, markdown, sha256: createHash('sha256').update(markdown, 'utf8').digest('hex') };
  });

  app.post<{ Params: { changeId: string }; Body: { requestId: string } & WriterGrant }>('/api/v1/changes/:changeId/handoffs', {
    schema: { body: { type: 'object', required: ['requestId'], additionalProperties: false, properties: { requestId: { type: 'string', minLength: 1, maxLength: 128 }, writerSessionId: { type: 'string', minLength: 1 }, generation: { type: 'integer', minimum: 1 } } } },
  }, async (request, reply) => {
    const { changeId } = request.params;
    const { requestId } = request.body;
    const guard = () => checkWriter(request, request.body, { changeId });
    const denied = guard();
    if (denied) return reply.code(denied === 'FORBIDDEN' ? 403 : 409).send({ code: denied, message: writerGrantMessage(denied), requestId: request.id });
    const fingerprint = JSON.stringify(writerCommand(isOwner(request), request.body, ['create', changeId]));
    const findPrior = () => db.prepare('SELECT fingerprint, snapshot_id AS snapshotId, committed_at AS committedAt FROM handoff_requests WHERE request_id = ?').get(requestId) as { fingerprint: string; snapshotId: string; committedAt: string } | undefined;
    const previous = findPrior();
    if (previous) {
      if (previous.fingerprint !== fingerprint) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
      return reply.code(201).send({ requestId, resourceId: previous.snapshotId, recordVersion: 1, committedAt: previous.committedAt } satisfies Receipt);
    }
    if (requestIdUsedElsewhere(db, requestId, 'handoffs')) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    const result = db.transaction((): Receipt | string => {
      const denied = guard();
      if (denied) return denied;
      const concurrent = findPrior();
      if (concurrent) {
        if (concurrent.fingerprint !== fingerprint) return 'REQUEST_ID_CONFLICT';
        return { requestId, resourceId: concurrent.snapshotId, recordVersion: 1, committedAt: concurrent.committedAt };
      }
      if (requestIdUsedElsewhere(db, requestId, 'handoffs')) return 'REQUEST_ID_CONFLICT';
      if (!db.prepare('SELECT 1 FROM changes WHERE id = ?').get(changeId)) return 'NOT_FOUND';
      const before = projectRecordBytes(db, (db.prepare('SELECT project_id FROM changes WHERE id = ?').get(changeId) as { project_id: string }).project_id);
      const committedAt = new Date().toISOString();
      const created = createHandoffSnapshotRow(db, changeId);
      if (!created) return 'NOT_FOUND';
      db.prepare('INSERT INTO handoff_requests(request_id,fingerprint,snapshot_id,committed_at) VALUES (?,?,?,?)').run(requestId, fingerprint, created.snapshotId, committedAt);
      checkProjectCapacity(db, (db.prepare('SELECT project_id FROM changes WHERE id = ?').get(changeId) as { project_id: string }).project_id, before, recordsLimit);
      return { requestId, resourceId: created.snapshotId, recordVersion: 1, committedAt };
    })();
    if (typeof result === 'string') return reply.code(result === 'NOT_FOUND' ? 404 : result === 'FORBIDDEN' ? 403 : 409).send({ code: result, message: result === 'NOT_FOUND' ? '变更不存在。' : result === 'REQUEST_ID_CONFLICT' ? '请求标识已用于不同的内容。' : writerGrantMessage(result as 'FORBIDDEN' | 'SESSION_EXPIRED' | 'WORKSPACE_CHANGED'), requestId: request.id });
    return reply.code(201).send(result);
  });

  // 续做核对：把最近保存点（或最近观察）与当前真实文件对比；只读，不写记录。
  app.get<{ Params: { changeId: string; workspaceId: string } }>('/api/v1/changes/:changeId/continuation/:workspaceId', async (request, reply) => {
    const change = db.prepare('SELECT id, project_id AS projectId FROM changes WHERE id = ?').get(request.params.changeId) as { projectId: string } | undefined;
    if (!change) return reply.code(404).send({ code: 'NOT_FOUND', message: '变更不存在。', requestId: request.id });
    const workspace = db.prepare('SELECT id, path, common_key AS commonKey, version FROM workspaces WHERE id = ? AND project_id = ?').get(request.params.workspaceId, change.projectId) as { id: string; path: string; commonKey: string; version: number } | undefined;
    if (!workspace) return reply.code(404).send({ code: 'NOT_FOUND', message: '工作区不存在或不属于此项目。', requestId: request.id });
    const projectRepo = db.prepare('SELECT common_key AS commonKey FROM project_repositories WHERE project_id = ?').get(change.projectId) as { commonKey: string } | undefined;
    if (!projectRepo || projectRepo.commonKey !== workspace.commonKey) return reply.code(409).send({ code: 'WORKSPACE_CHANGED', message: '工作区需要重新绑定当前项目仓库。', requestId: request.id });
    type SavedObservation = { id: string; workspaceId: string; path: string; bindingVersion: number; dataJson: string; createdAt: string };
    const columns = 'o.id, o.workspace_id AS workspaceId, o.path, o.binding_version AS bindingVersion, o.data_json AS dataJson, o.created_at AS createdAt';
    const checkpoint = db.prepare(`SELECT ${columns} FROM checkpoints p JOIN workspace_observations o ON o.id = p.observation_id WHERE p.change_id = ? ORDER BY p.record_version DESC LIMIT 1`).get(request.params.changeId) as SavedObservation | undefined;
    const savedObservation = checkpoint ?? db.prepare(`SELECT ${columns} FROM workspace_observations o WHERE o.workspace_id = ? ORDER BY o.rowid DESC LIMIT 1`).get(workspace.id) as SavedObservation | undefined;
    if (!savedObservation) return reply.code(409).send({ code: 'NO_CONTINUATION_BASE', message: '没有可对比的观察记录；请先在工作区执行观察。', requestId: request.id });
    const saved = JSON.parse(savedObservation.dataJson) as Awaited<ReturnType<typeof observeWorkspace>>;
    let fresh: Awaited<ReturnType<typeof observeWorkspace>>;
    try {
      const identity = await identifyWorkspace(workspace.path);
      if (identity.pathKey !== pathKey(workspace.path) || identity.commonKey !== workspace.commonKey) return reply.code(409).send({ code: 'WORKSPACE_CHANGED', message: '工作目录或仓库身份已变化，请重新绑定。', requestId: request.id });
      fresh = await observeWorkspace(workspace.path, identity.commonDir, saved.files.filter(file => file.status === '??' && file.sha256).map(file => file.path));
    } catch (error) {
      if (error instanceof ObservationTempInsideWorkspace) return reply.code(503).send({ code: 'OBSERVATION_TEMP_INSIDE_WORKSPACE', message: '临时目录位于工作区内，请改用工作区外的临时目录。', requestId: request.id });
      return reply.code(503).send({ code: 'OBSERVATION_FAILED', message: '无法观察工作区，请检查目录和 Git 状态。', requestId: request.id });
    }
    const bindingStillCurrent = db.prepare('SELECT 1 FROM workspaces w JOIN project_repositories p ON p.project_id = w.project_id AND p.common_key = w.common_key WHERE w.id = ? AND w.version = ?').get(workspace.id, workspace.version);
    if (!bindingStillCurrent) return reply.code(409).send({ code: 'WORKSPACE_CHANGED', message: '核对期间工作区绑定发生变化，请重新核对。', requestId: request.id });
    const comparison = savedObservation.workspaceId !== workspace.id ? 'differentWorkspace'
      : savedObservation.bindingVersion !== workspace.version || pathKey(savedObservation.path) !== pathKey(workspace.path) ? 'bindingChanged' : 'sameBinding';
    const savedKeys = new Map(saved.files.map(file => [`${file.status} ${file.path}`, file]));
    const freshKeys = new Map(fresh.files.map(file => [`${file.status} ${file.path}`, file]));
    const added = fresh.files.filter(file => !savedKeys.has(`${file.status} ${file.path}`)).map(({ path, status }) => ({ path, status }));
    const removed = saved.files.filter(file => !freshKeys.has(`${file.status} ${file.path}`)).map(({ path, status }) => ({ path, status }));
    const changed = fresh.files.filter(file => {
      const prior = savedKeys.get(`${file.status} ${file.path}`);
      return prior && file.sha256 && prior.sha256 && prior.sha256 !== file.sha256;
    }).map(({ path, status }) => ({ path, status }));
    const headChanged = saved.head !== fresh.head;
    const trackedDiffChanged = saved.trackedDiffSha256 !== null && fresh.trackedDiffSha256 !== null ? saved.trackedDiffSha256 !== fresh.trackedDiffSha256 : null;
    const differences = headChanged || trackedDiffChanged === true || added.length > 0 || removed.length > 0 || changed.length > 0;
    const incomplete = !saved.stable || !fresh.stable || trackedDiffChanged === null || saved.files.length >= 10000 || fresh.files.length >= 10000 || saved.files.some(file => file.status === '??' && (!file.sha256 || (freshKeys.has(`${file.status} ${file.path}`) && !freshKeys.get(`${file.status} ${file.path}`)?.sha256)));
    const baseLabel = checkpoint ? '最近保存点' : '最近工作区观察';
    let notice: string;
    if (comparison === 'differentWorkspace') notice = '跨工作区对比：当前目录与原观察来自不同的工作区。下列差异仅供参考，请选择原工作区核对未保存的工作。';
    else if (comparison === 'bindingChanged') notice = '工作区绑定已变化。下列差异仅供参考，请核对原观察的路径和绑定版本。';
    else if (differences) notice = `检测到比${baseLabel}更新的文件状态：可能是未保存的新工作。请核对来源，不要自动回滚或覆盖；无法解释的并发改动先停止受影响的写操作。`;
    else if (incomplete) notice = '未发现可确认的差异，但部分文件或差异未能核对；请手动检查工作区。';
    else notice = `未检测到比${baseLabel}更新的文件状态。`;
    return {
      comparison, baseSource: checkpoint ? 'checkpoint' : 'observation',
      savedObservation: { id: savedObservation.id, workspaceId: savedObservation.workspaceId, path: savedObservation.path, bindingVersion: savedObservation.bindingVersion, createdAt: savedObservation.createdAt, head: saved.head, branch: saved.branch, trackedDiffSha256: saved.trackedDiffSha256 },
      fresh: { workspaceId: workspace.id, path: workspace.path, bindingVersion: workspace.version, head: fresh.head, branch: fresh.branch, dirty: fresh.dirty, stable: fresh.stable, trackedDiffSha256: fresh.trackedDiffSha256, fileCount: fresh.files.length },
      diff: { headChanged, trackedDiffChanged, added, removed, changed },
      hasUnsavedChanges: comparison === 'sameBinding' && (differences || !incomplete) ? differences : null,
      notice,
    };
  });
}
