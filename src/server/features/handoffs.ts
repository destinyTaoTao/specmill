import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { checkProjectCapacity, projectRecordBytes } from '../storage/project-capacity.js';
import { requestIdUsedElsewhere } from '../storage/request-ids.js';
import { identifyWorkspace, observeWorkspace, ObservationTempInsideWorkspace, pathKey } from '../workspace/git.js';
import { renderHandoffMarkdown, type HandoffContent } from '../../shared/handoff.js';

type Receipt = { requestId: string; resourceId: string; recordVersion: number; committedAt: string };

export function registerHandoffs(app: FastifyInstance, db: Database.Database, recordsLimit: number) {
  app.get<{ Params: { changeId: string } }>('/api/v1/changes/:changeId/handoffs', async (request, reply) => {
    if (!db.prepare('SELECT 1 FROM changes WHERE id = ?').get(request.params.changeId)) return reply.code(404).send({ code: 'NOT_FOUND', message: '变更不存在。', requestId: request.id });
    const rows = db.prepare('SELECT id, cycle, version, phase, content_json AS contentJson, created_at AS createdAt FROM handoff_snapshots WHERE change_id = ? ORDER BY created_at, id').all(request.params.changeId) as { contentJson: string }[];
    return { snapshots: rows.map(({ contentJson, ...row }) => ({ ...row, changeTitle: (JSON.parse(contentJson) as HandoffContent).changeTitle })) };
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

  app.post<{ Params: { changeId: string }; Body: { requestId: string } }>('/api/v1/changes/:changeId/handoffs', {
    schema: { body: { type: 'object', required: ['requestId'], additionalProperties: false, properties: { requestId: { type: 'string', minLength: 1, maxLength: 128 } } } },
  }, async (request, reply) => {
    const { changeId } = request.params;
    const { requestId } = request.body;
    const fingerprint = JSON.stringify(['create', changeId]);
    const findPrior = () => db.prepare('SELECT fingerprint, snapshot_id AS snapshotId, committed_at AS committedAt FROM handoff_requests WHERE request_id = ?').get(requestId) as { fingerprint: string; snapshotId: string; committedAt: string } | undefined;
    const previous = findPrior();
    if (previous) {
      if (previous.fingerprint !== fingerprint) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
      return reply.code(201).send({ requestId, resourceId: previous.snapshotId, recordVersion: 1, committedAt: previous.committedAt } satisfies Receipt);
    }
    if (requestIdUsedElsewhere(db, requestId, 'handoffs')) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    const result = db.transaction((): Receipt | string => {
      const concurrent = findPrior();
      if (concurrent) {
        if (concurrent.fingerprint !== fingerprint) return 'REQUEST_ID_CONFLICT';
        return { requestId, resourceId: concurrent.snapshotId, recordVersion: 1, committedAt: concurrent.committedAt };
      }
      if (requestIdUsedElsewhere(db, requestId, 'handoffs')) return 'REQUEST_ID_CONFLICT';
      const change = db.prepare('SELECT c.project_id AS projectId, c.phase, c.cycle, c.version, c.current_revision_id AS revisionId, c.current_baseline_id AS baselineId, p.name AS projectName FROM changes c JOIN projects p ON p.id = c.project_id WHERE c.id = ?').get(changeId) as { projectId: string; phase: string; cycle: number; version: number; revisionId: string; baselineId: string | null; projectName: string } | undefined;
      if (!change) return 'NOT_FOUND';
      const revision = db.prepare('SELECT title, goal, scope, non_goals AS nonGoals, criteria_json AS criteriaJson FROM change_revisions WHERE id = ? AND change_id = ?').get(change.revisionId, changeId) as { title: string; goal: string; scope: string; nonGoals: string; criteriaJson: string } | undefined;
      if (!revision) return 'NOT_FOUND';
      let goal = revision.goal;
      let scope = revision.scope;
      let nonGoals = revision.nonGoals;
      let criteria: string[] = JSON.parse(revision.criteriaJson);
      let basis: HandoffContent['basis'] = { kind: 'unconfirmedDraft', revisionId: change.revisionId };
      if (change.baselineId) {
        const baseline = db.prepare('SELECT id, draft_revision_id AS draftRevisionId, goal, scope, non_goals AS nonGoals, criteria_json AS criteriaJson, source_path AS sourcePath, source_sha256 AS sourceSha256, source_head AS sourceHead FROM baselines WHERE id = ? AND change_id = ?').get(change.baselineId, changeId) as { id: string; draftRevisionId: string; goal: string; scope: string; nonGoals: string; criteriaJson: string; sourcePath: string; sourceSha256: string; sourceHead: string | null } | undefined;
        if (!baseline) return 'NOT_FOUND';
        goal = baseline.goal;
        scope = baseline.scope;
        nonGoals = baseline.nonGoals;
        criteria = JSON.parse(baseline.criteriaJson);
        basis = { kind: 'baseline', baselineId: baseline.id, revisionId: baseline.draftRevisionId, sourcePath: baseline.sourcePath, sourceSha256: baseline.sourceSha256, sourceHead: baseline.sourceHead };
      }
      const checkpointRow = db.prepare('SELECT p.id, p.record_version AS recordVersion, p.actor, p.goal, p.done, p.failures, p.unverified, p.blockers, p.next_steps AS nextSteps, p.created_at AS createdAt, o.id AS observationId, o.binding_version AS bindingVersion, o.path AS observationPath, o.created_at AS observationCreatedAt, o.data_json AS observationJson FROM checkpoints p JOIN workspace_observations o ON o.id = p.observation_id WHERE p.change_id = ? ORDER BY p.record_version DESC LIMIT 1').get(changeId) as { id: string; recordVersion: number; actor: string; goal: string; done: string; failures: string; unverified: string; nextSteps: string; blockers: string; createdAt: string; observationId: string; bindingVersion: number; observationPath: string; observationCreatedAt: string; observationJson: string } | undefined;
      const checkpoint = checkpointRow ? (() => {
        const observation = JSON.parse(checkpointRow.observationJson) as { head: string | null; branch: string | null; stable: boolean; limitations: string[]; files: { path: string; status: string; sha256?: string }[]; trackedDiffSha256: string | null };
        return {
          id: checkpointRow.id, recordVersion: checkpointRow.recordVersion, actor: checkpointRow.actor as 'user' | 'agent', createdAt: checkpointRow.createdAt,
          goal: checkpointRow.goal, done: checkpointRow.done, failures: checkpointRow.failures, unverified: checkpointRow.unverified, blockers: checkpointRow.blockers, nextSteps: checkpointRow.nextSteps,
          observation: { id: checkpointRow.observationId, path: checkpointRow.observationPath, bindingVersion: checkpointRow.bindingVersion, createdAt: checkpointRow.observationCreatedAt, ...observation },
        };
      })() : null;
      const snapshotId = randomUUID();
      const committedAt = new Date().toISOString();
      const content: HandoffContent = {
        projectId: change.projectId, projectName: change.projectName, changeId, changeTitle: revision.title,
        snapshotId, createdAt: committedAt, phase: change.phase, cycle: change.cycle, capturedVersion: change.version,
        goal, scope, nonGoals, criteria, basis, checkpoint,
      };
      const before = projectRecordBytes(db, change.projectId);
      db.prepare('INSERT INTO handoff_snapshots(id,change_id,project_id,cycle,version,phase,content_json,created_at) VALUES (?,?,?,?,?,?,?,?)').run(snapshotId, changeId, change.projectId, change.cycle, change.version, change.phase, JSON.stringify(content), committedAt);
      db.prepare('INSERT INTO handoff_requests(request_id,fingerprint,snapshot_id,committed_at) VALUES (?,?,?,?)').run(requestId, fingerprint, snapshotId, committedAt);
      checkProjectCapacity(db, change.projectId, before, recordsLimit);
      return { requestId, resourceId: snapshotId, recordVersion: 1, committedAt };
    })();
    if (typeof result === 'string') return reply.code(result === 'NOT_FOUND' ? 404 : 409).send({ code: result, message: result === 'NOT_FOUND' ? '变更不存在。' : '请求标识已用于不同的内容。', requestId: request.id });
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
    const savedObservation = db.prepare('SELECT o.id, o.binding_version AS bindingVersion, o.data_json AS dataJson, o.created_at AS createdAt FROM checkpoints p JOIN workspace_observations o ON o.id = p.observation_id WHERE p.change_id = ? ORDER BY p.record_version DESC LIMIT 1').get(request.params.changeId) as { id: string; bindingVersion: number; dataJson: string; createdAt: string } | undefined
      ?? db.prepare('SELECT o.id, o.binding_version AS bindingVersion, o.data_json AS dataJson, o.created_at AS createdAt FROM workspace_observations o WHERE o.workspace_id = ? ORDER BY o.rowid DESC LIMIT 1').get(request.params.workspaceId) as { id: string; bindingVersion: number; dataJson: string; createdAt: string } | undefined;
    if (!savedObservation) return reply.code(409).send({ code: 'NO_CONTINUATION_BASE', message: '没有可对比的观察记录；请先在工作区执行观察。', requestId: request.id });
    const saved = JSON.parse(savedObservation.dataJson) as { head: string | null; branch: string | null; trackedDiffSha256: string | null; files: { path: string; status: string; sha256?: string }[] };
    let fresh: Awaited<ReturnType<typeof observeWorkspace>>;
    try {
      const identity = await identifyWorkspace(workspace.path);
      if (identity.pathKey !== pathKey(workspace.path) || identity.commonKey !== workspace.commonKey) return reply.code(409).send({ code: 'WORKSPACE_CHANGED', message: '工作目录或仓库身份已变化，请重新绑定。', requestId: request.id });
      fresh = await observeWorkspace(workspace.path, identity.commonDir, []);
    } catch (error) {
      if (error instanceof ObservationTempInsideWorkspace) return reply.code(503).send({ code: 'OBSERVATION_TEMP_INSIDE_WORKSPACE', message: '临时目录位于工作区内，请改用工作区外的临时目录。', requestId: request.id });
      return reply.code(503).send({ code: 'OBSERVATION_FAILED', message: '无法观察工作区，请检查目录和 Git 状态。', requestId: request.id });
    }
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
    const hasUnsavedChanges = headChanged || trackedDiffChanged === true || added.length > 0 || removed.length > 0 || changed.length > 0;
    return {
      savedObservation: { id: savedObservation.id, bindingVersion: savedObservation.bindingVersion, createdAt: savedObservation.createdAt, head: saved.head, branch: saved.branch, trackedDiffSha256: saved.trackedDiffSha256 },
      fresh: { head: fresh.head, branch: fresh.branch, dirty: fresh.dirty, stable: fresh.stable, trackedDiffSha256: fresh.trackedDiffSha256, fileCount: fresh.files.length },
      diff: { headChanged, trackedDiffChanged, added, removed, changed },
      hasUnsavedChanges,
      notice: hasUnsavedChanges ? '检测到比最近保存点更新的文件状态：可能是未保存的新工作。请核对来源，不要自动回滚或覆盖；无法解释的并发改动先停止受影响的写操作。' : '未检测到比最近保存点更新的文件状态。',
    };
  });
}
