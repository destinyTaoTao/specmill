import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { checkProjectCapacity, projectRecordBytes } from '../storage/project-capacity.js';
import { confirmedTarget, blockingFailures } from '../storage/acceptance-context.js';
import { checkAttachmentHealth } from '../storage/attachments.js';
import { evidenceCriterionMatches } from '../storage/evidence-integrity.js';
import { createHandoffSnapshotRow } from './handoffs.js';
import { requestIdUsedElsewhere, sameFingerprint } from '../storage/request-ids.js';
import type { WriterAuthorization } from './writer-sessions.js';
import { createWriterGuard, writerCommand, writerGrantMessage, type WriterGrant, type WriterGuardError } from './writer-guard.js';

type Receipt = { requestId: string; resourceId: string; recordVersion: number; committedAt: string };
type ChangeRow = { projectId: string; phase: string; cycle: number; version: number; baselineId: string | null };
type Criterion = { id: string; text: string };
type Selection = { criterionId: string; mode: 'new' | 'reuse'; evidenceIds: string[]; reuseReason?: string };
type DispositionRow = { criterionId: string; failureEvidenceId: string; outcome: 'resolved' | 'not_applicable'; supportingEvidenceIds?: string[]; reason: string };
type ReviewSnapshot = { version: number; cycle: number; baselineId: string; criterionRevisionId: string; targetId: string | null; observationId: string | null; evidenceCount: number; decisionCount: number; dispositionCount: number };

export function registerReview(app: FastifyInstance, db: Database.Database, recordsLimit: number, attachmentsDir: string, isOwner: (request: FastifyRequest) => boolean, authorizeWriter: WriterAuthorization) {
  const checkWriter = createWriterGuard(db, isOwner, authorizeWriter);
  const isActor = (request: FastifyRequest) => isOwner(request) ? 'user' : 'agent';
  const getChange = (changeId: string) => db.prepare('SELECT id, project_id AS projectId, phase, cycle, version, current_baseline_id AS baselineId FROM changes WHERE id = ?').get(changeId) as (ChangeRow & { id: string }) | undefined;
  const evidenceHealthy = async (evidence: { id: string; attachmentIdsJson: string; projectId: string }, checks?: Map<string, Promise<boolean>>) => {
    const ids = JSON.parse(evidence.attachmentIdsJson) as string[];
    for (const id of ids) {
      const key = `${evidence.projectId}:${id}`;
      let check = checks?.get(key);
      if (!check) {
        const row = db.prepare('SELECT sha256, size FROM attachments WHERE id = ? AND project_id = ?').get(id, evidence.projectId) as { sha256: string; size: number } | undefined;
        check = row ? checkAttachmentHealth(attachmentsDir, evidence.projectId, row.sha256, row.size).then(result => result === 'ok') : Promise.resolve(false);
        checks?.set(key, check);
      }
      if (!await check) return false;
    }
    return true;
  };
  const contextOf = (change: ChangeRow & { id: string }) => {
    if (!change.baselineId) return null;
    const baseline = db.prepare('SELECT id, draft_revision_id AS criterionRevisionId, criteria_json AS criteriaJson FROM baselines WHERE id = ? AND change_id = ?').get(change.baselineId, change.id) as { id: string; criterionRevisionId: string; criteriaJson: string } | undefined;
    if (!baseline) return null;
    return { baselineId: baseline.id, criterionRevisionId: baseline.criterionRevisionId, criteria: JSON.parse(baseline.criteriaJson) as Criterion[], ...confirmedTarget(db, change.id) };
  };
  const snapshotOf = (change: ChangeRow & { id: string }, context: NonNullable<ReturnType<typeof contextOf>>): ReviewSnapshot => ({
    version: change.version, cycle: change.cycle, baselineId: context.baselineId, criterionRevisionId: context.criterionRevisionId, targetId: context.target?.id ?? null,
    observationId: context.target ? (db.prepare('SELECT id FROM workspace_observations WHERE workspace_id = ? ORDER BY rowid DESC LIMIT 1').get(context.target.workspaceId) as { id: string } | undefined)?.id ?? null : null,
    evidenceCount: (db.prepare('SELECT COUNT(*) AS count FROM evidence_records WHERE change_id = ?').get(change.id) as { count: number }).count,
    decisionCount: (db.prepare('SELECT COUNT(*) AS count FROM decisions WHERE change_id = ?').get(change.id) as { count: number }).count,
    dispositionCount: (db.prepare('SELECT COUNT(*) AS count FROM failure_dispositions WHERE change_id = ?').get(change.id) as { count: number }).count,
  });
  const sameSnapshot = (left: ReviewSnapshot, right: ReviewSnapshot) => sameFingerprint(JSON.stringify(left), right);
  const effectiveDecision = (changeId: string, cycle: number, baselineId: string, criterionId: string, targetId: string | null) => db.prepare('SELECT id, result, evidence_ids_json AS evidenceIdsJson, reason, actor, created_at AS createdAt FROM decisions WHERE change_id = ? AND cycle = ? AND baseline_id = ? AND criterion_id = ? AND (target_id = ? OR ? IS NULL) AND superseded_by IS NULL ORDER BY created_at DESC, id DESC LIMIT 1').get(changeId, cycle, baselineId, criterionId, targetId, targetId) as { id: string; result: string; evidenceIdsJson: string; reason: string; actor: string; createdAt: string } | undefined;

  const dispositionHistory = (changeId: string, currentCriteria: Criterion[]) => {
    const dispositionRows = db.prepare(`SELECT d.id, d.criterion_id AS criterionId, d.cycle, d.baseline_id AS baselineId, d.failure_evidence_id AS failureEvidenceId,
      e.actual_commit AS failureCommit, e.notes AS failureNotes, d.target_id AS targetId, t.commit_sha AS targetCommit, d.outcome, d.supporting_evidence_ids_json AS supportingEvidenceIdsJson,
      d.reason, d.actor, d.created_at AS createdAt FROM failure_dispositions d
      JOIN evidence_records e ON e.id = d.failure_evidence_id LEFT JOIN acceptance_targets t ON t.id = d.target_id
      WHERE d.change_id = ? ORDER BY d.created_at DESC, d.id DESC`).all(changeId) as { id: string; criterionId: string; cycle: number; baselineId: string; failureEvidenceId: string; failureCommit: string | null; failureNotes: string; targetId: string | null; targetCommit: string | null; outcome: string; supportingEvidenceIdsJson: string; reason: string; actor: string; createdAt: string }[];
    const dispositionsByCriterion = new Map<string, typeof dispositionRows>();
    for (const row of dispositionRows) {
      const rows = dispositionsByCriterion.get(row.criterionId) ?? [];
      rows.push(row);
      dispositionsByCriterion.set(row.criterionId, rows);
    }
    const historicalCriteria = new Map<string, Criterion[]>();
    const historyBaseline = db.prepare('SELECT criteria_json AS criteriaJson FROM baselines WHERE id = ? AND change_id = ?');
    for (const baselineId of new Set(dispositionRows.map(row => row.baselineId))) {
      const baseline = historyBaseline.get(baselineId, changeId) as { criteriaJson: string } | undefined;
      if (!baseline) continue;
      try { const parsed: unknown = JSON.parse(baseline.criteriaJson); if (Array.isArray(parsed)) historicalCriteria.set(baselineId, parsed as Criterion[]); } catch { /* 显示无法核对，保留历史记录。 */ }
    }
    const dispositionView = ({ supportingEvidenceIdsJson, ...row }: typeof dispositionRows[number]) => ({ ...row, criterionText: historicalCriteria.get(row.baselineId)?.find(item => item?.id === row.criterionId)?.text ?? null, supportingEvidenceIds: JSON.parse(supportingEvidenceIdsJson) as string[] });
    const currentCriterionIds = new Set(currentCriteria.map(item => item.id));
    const retiredDispositions = dispositionRows.filter(row => !currentCriterionIds.has(row.criterionId)).map(dispositionView);
    return { criteria: currentCriteria.map(item => ({ criterionId: item.id, text: item.text, dispositions: (dispositionsByCriterion.get(item.id) ?? []).map(dispositionView) })), retiredDispositions };
  };

  app.get<{ Params: { changeId: string } }>('/api/v1/changes/:changeId/review/failure-dispositions', async (request, reply) => {
    const change = getChange(request.params.changeId);
    if (!change) return reply.code(404).send({ code: 'NOT_FOUND', message: '变更不存在。', requestId: request.id });
    const context = contextOf(change);
    if (!context) return reply.code(409).send({ code: 'NO_REVIEW_CONTEXT', message: '尚无冻结基线，不能读取失败处置历史。', requestId: request.id });
    return dispositionHistory(change.id, context.criteria);
  });

  app.get<{ Params: { changeId: string } }>('/api/v1/changes/:changeId/review', async (request, reply) => {
    const change = getChange(request.params.changeId);
    if (!change) return reply.code(404).send({ code: 'NOT_FOUND', message: '变更不存在。', requestId: request.id });
    const context = contextOf(change);
    if (!context) return reply.code(409).send({ code: 'NO_REVIEW_CONTEXT', message: '尚无冻结基线，不能进入验收审阅。', requestId: request.id });
    const snapshot = snapshotOf(change, context);
    const history = dispositionHistory(change.id, context.criteria);
    const historyByCriterion = new Map(history.criteria.map(item => [item.criterionId, item.dispositions]));
    // 缓存仅存活于本次 GET；预览、确认和后续读取始终重新核对附件。
    const attachmentChecks = new Map<string, Promise<boolean>>();
    const criteria = await Promise.all(context.criteria.map(async (criterion, index) => {
      const decision = effectiveDecision(change.id, change.cycle, context.baselineId, criterion.id, context.target?.id ?? null);
      const failures = blockingFailures(db, change.id, change.cycle, context.baselineId, criterion.id, context.target?.id ?? null);
      const dispositions = historyByCriterion.get(criterion.id) ?? [];
      const rows = db.prepare("SELECT id, baseline_id AS baselineId, criterion_index AS criterionIndex, actual_commit AS actualCommit, formal, created_at AS createdAt, attachment_ids_json AS attachmentIdsJson FROM evidence_records WHERE change_id = ? AND cycle = ? AND criterion_id = ? AND result = 'passed' ORDER BY created_at DESC, id DESC").all(change.id, change.cycle, criterion.id) as { id: string; baselineId: string | null; criterionIndex: number; actualCommit: string | null; formal: number; createdAt: string; attachmentIdsJson: string }[];
      const candidates = [];
      for (const row of rows) {
        const healthy = await evidenceHealthy({ id: row.id, attachmentIdsJson: row.attachmentIdsJson, projectId: change.projectId }, attachmentChecks);
        candidates.push({ id: row.id, actualCommit: row.actualCommit, formal: row.formal === 1 && evidenceCriterionMatches(db, { changeId: change.id, baselineId: row.baselineId, criterionId: criterion.id, criterionIndex: row.criterionIndex }), healthy, createdAt: row.createdAt, matchesTarget: row.actualCommit !== null && context.target !== null && row.actualCommit === context.target.commitSha });
      }
      const decisionEvidenceIds = decision ? JSON.parse(decision.evidenceIdsJson) as string[] : [];
      let decisionValid = true;
      if (decision?.result === 'passed') {
        if (decisionEvidenceIds.length === 0) decisionValid = false;
        for (const id of decisionEvidenceIds) {
          const row = db.prepare('SELECT id, project_id AS projectId, baseline_id AS baselineId, criterion_id AS criterionId, criterion_index AS criterionIndex, result, formal, attachment_ids_json AS attachmentIdsJson FROM evidence_records WHERE id = ? AND change_id = ?').get(id, change.id) as { id: string; projectId: string; baselineId: string | null; criterionId: string | null; criterionIndex: number; result: string; formal: number; attachmentIdsJson: string } | undefined;
          if (!row || row.result !== 'passed' || row.formal !== 1 || row.criterionId !== criterion.id || !evidenceCriterionMatches(db, { changeId: change.id, baselineId: row.baselineId, criterionId: row.criterionId, criterionIndex: row.criterionIndex }) || !(await evidenceHealthy(row, attachmentChecks))) { decisionValid = false; break; }
        }
      }
      return { criterionId: criterion.id, index: index + 1, text: criterion.text, decision: decision ? { ...decision, evidenceIds: decisionEvidenceIds, valid: decisionValid } : null, blockingFailures: failures, dispositions, evidence: candidates };
    }));
    const observation = context.target ? db.prepare('SELECT path, binding_version AS bindingVersion, created_at AS createdAt, data_json AS dataJson FROM workspace_observations WHERE workspace_id = ? ORDER BY rowid DESC LIMIT 1').get(context.target.workspaceId) as { path: string; bindingVersion: number; createdAt: string; dataJson: string } | undefined : undefined;
    const observationData = observation ? JSON.parse(observation.dataJson) as { head: string | null; dirty: boolean; stable: boolean } : null;
    const latest = getChange(change.id);
    const latestContext = latest && contextOf(latest);
    if (!latest || !latestContext || !sameSnapshot(snapshot, snapshotOf(latest, latestContext))) return reply.code(409).send({ code: 'REVIEW_CHANGED', message: '审阅状态在读取期间发生变化，请重试。', requestId: request.id });
    return { context: { cycle: change.cycle, baselineId: context.baselineId, criterionRevisionId: context.criterionRevisionId, target: context.target, targetOrderUncertain: context.targetOrderUncertain, phase: change.phase }, snapshot, observation: observation && observationData ? { path: observation.path, bindingVersion: observation.bindingVersion, createdAt: observation.createdAt, head: observationData.head, dirty: observationData.dirty, stable: observationData.stable } : null, criteria, retiredDispositions: history.retiredDispositions, accepted: change.phase === 'Accepted' };
  });

  app.post<{ Params: { changeId: string }; Body: { requestId: string; expectedSnapshot?: ReviewSnapshot; payload: { selections: Selection[] } } & WriterGrant }>('/api/v1/changes/:changeId/review/preview', {
    schema: { body: { type: 'object', required: ['requestId', 'payload'], additionalProperties: false, properties: {
      requestId: { type: 'string', minLength: 1, maxLength: 128 },
      writerSessionId: { type: 'string', minLength: 1 }, generation: { type: 'integer', minimum: 1 },
      expectedSnapshot: { type: 'object', required: ['version', 'cycle', 'baselineId', 'criterionRevisionId', 'targetId', 'observationId', 'evidenceCount', 'decisionCount', 'dispositionCount'], additionalProperties: false, properties: { version: { type: 'integer', minimum: 1 }, cycle: { type: 'integer', minimum: 1 }, baselineId: { type: 'string', minLength: 1 }, criterionRevisionId: { type: 'string', minLength: 1 }, targetId: { type: ['string', 'null'] }, observationId: { type: ['string', 'null'] }, evidenceCount: { type: 'integer', minimum: 0 }, decisionCount: { type: 'integer', minimum: 0 }, dispositionCount: { type: 'integer', minimum: 0 } } },
      payload: { type: 'object', required: ['selections'], additionalProperties: false, properties: { selections: { type: 'array', maxItems: 100, items: { type: 'object', required: ['criterionId', 'mode', 'evidenceIds'], additionalProperties: false, properties: {
        criterionId: { type: 'string', minLength: 1 }, mode: { type: 'string', enum: ['new', 'reuse'] }, evidenceIds: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1 } }, reuseReason: { type: 'string', maxLength: 4000 },
      } } } } },
    } } },
  }, async (request, reply) => {
    const { changeId } = request.params;
    const { requestId, payload, expectedSnapshot } = request.body;
    const guard = () => checkWriter(request, request.body, { changeId });
    const denied = guard();
    if (denied) return reply.code(denied === 'FORBIDDEN' ? 403 : 409).send({ code: denied, message: writerGrantMessage(denied), requestId: request.id });
    const fingerprint = JSON.stringify(writerCommand(isOwner(request), request.body, expectedSnapshot ? ['review-preview', changeId, payload, expectedSnapshot] : ['review-preview', changeId, payload]));
    const findPrior = () => db.prepare("SELECT fingerprint, resource_id AS resourceId FROM review_requests WHERE request_id = ? AND action = 'preview'").get(requestId) as { fingerprint: string; resourceId: string } | undefined;
    const previous = findPrior();
    if (previous && !sameFingerprint(previous.fingerprint, JSON.parse(fingerprint))) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    if (previous) return reply.code(201).send({ requestId, resourceId: previous.resourceId });
    if (db.prepare('SELECT 1 FROM review_requests WHERE request_id = ?').get(requestId) || requestIdUsedElsewhere(db, requestId, 'review')) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    const change = getChange(changeId);
    if (!change) return reply.code(404).send({ code: 'NOT_FOUND', message: '变更不存在。', requestId: request.id });
    if (change.phase !== 'Reviewing') return reply.code(409).send({ code: 'INVALID_STATE', message: '只有审阅中的变更可以生成确认预览。', requestId: request.id });
    const context = contextOf(change);
    if (!context || !context.target) return reply.code(409).send({ code: 'TARGET_REQUIRED', message: '需要用户确认实现目标后才能生成有效确认预览。', requestId: request.id });
    const snapshot = snapshotOf(change, context);
    if (expectedSnapshot && !sameSnapshot(snapshot, expectedSnapshot)) return reply.code(409).send({ code: 'REVIEW_CHANGED', message: '审阅状态已变化，请重新读取后生成预览。', requestId: request.id });
    const confirmedTarget = context.target;
    const seen = new Set<string>();
    for (const selection of payload.selections) {
      if (seen.has(selection.criterionId)) return reply.code(400).send({ code: 'DUPLICATE_CRITERION', message: '同一条件在一次预览中只能出现一项。', requestId: request.id });
      seen.add(selection.criterionId);
      const check = await qualifies(change, context, selection);
      if (!check.ok) return reply.code(check.status).send({ code: check.code, message: check.message, requestId: request.id });
    }
    const result = db.transaction((): Receipt | string => {
      const denied = guard();
      if (denied) return denied;
      const concurrent = findPrior();
      if (concurrent && !sameFingerprint(concurrent.fingerprint, JSON.parse(fingerprint))) return 'REQUEST_ID_CONFLICT';
      if (concurrent) return { requestId, resourceId: concurrent.resourceId, recordVersion: change.version, committedAt: new Date().toISOString() };
      if (db.prepare('SELECT 1 FROM review_requests WHERE request_id = ?').get(requestId) || requestIdUsedElsewhere(db, requestId, 'review')) return 'REQUEST_ID_CONFLICT';
      const latest = getChange(changeId);
      const latestContext = latest && contextOf(latest);
      if (!latest || !latestContext || !sameSnapshot(snapshot, snapshotOf(latest, latestContext))) return 'REVIEW_CHANGED';
      const before = projectRecordBytes(db, change.projectId);
      const committedAt = new Date().toISOString();
      const previewId = randomUUID();
      const counts = {
        evidence: (db.prepare('SELECT COUNT(*) AS count FROM evidence_records WHERE change_id = ?').get(change.id) as { count: number }).count,
        decisions: (db.prepare('SELECT COUNT(*) AS count FROM decisions WHERE change_id = ?').get(change.id) as { count: number }).count,
        dispositions: (db.prepare('SELECT COUNT(*) AS count FROM failure_dispositions WHERE change_id = ?').get(change.id) as { count: number }).count,
      };
      db.prepare('INSERT INTO review_previews(id,change_id,project_id,cycle,baseline_id,criterion_revision_id,target_id,record_version,evidence_count,decision_count,disposition_count,selections_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(previewId, change.id, change.projectId, change.cycle, context.baselineId, context.criterionRevisionId, confirmedTarget.id, change.version, counts.evidence, counts.decisions, counts.dispositions, JSON.stringify(payload.selections), committedAt);
      db.prepare("INSERT INTO review_requests(request_id,fingerprint,resource_id,action,record_version,committed_at) VALUES (?,?,?,?,?,?)").run(requestId, fingerprint, previewId, 'preview', change.version, committedAt);
      checkProjectCapacity(db, change.projectId, before, recordsLimit);
      return { requestId, resourceId: previewId, recordVersion: change.version, committedAt };
    })();
    if (typeof result === 'string') return reply.code(result === 'FORBIDDEN' ? 403 : 409).send({ code: result, message: result === 'REVIEW_CHANGED' ? '审阅状态已变化，请重新读取后生成预览。' : result === 'REQUEST_ID_CONFLICT' ? '请求标识已用于不同的内容。' : writerGrantMessage(result as WriterGuardError), requestId: request.id });
    return reply.code(201).send(result);

    async function qualifies(change: ChangeRow & { id: string }, context: NonNullable<ReturnType<typeof contextOf>>, selection: Selection): Promise<{ ok: true } | { ok: false; status: number; code: string; message: string }> {
      const criterion = context.criteria.find(item => item.id === selection.criterionId);
      if (!criterion) return { ok: false, status: 404, code: 'CRITERION_NOT_FOUND', message: '条件不属于当前冻结基线。' };
      const failures = blockingFailures(db, change.id, change.cycle, context.baselineId, selection.criterionId, context.target?.id ?? null);
      if (failures.length > 0) return { ok: false, status: 409, code: 'BLOCKED_BY_FAILURE', message: `条件存在尚未处置的失败证据（${failures.length} 项），请先处置或豁免。` };
      if (selection.evidenceIds.length === 0) return { ok: false, status: 400, code: 'EVIDENCE_REQUIRED', message: '确认通过至少需要引用一项证据。' };
      for (const evidenceId of selection.evidenceIds) {
        const row = db.prepare('SELECT id, change_id, project_id, result, formal, baseline_id, criterion_id, criterion_index, actual_commit, attachment_ids_json FROM evidence_records WHERE id = ?').get(evidenceId) as { id: string; change_id: string; project_id: string; result: string; formal: number; baseline_id: string | null; criterion_id: string | null; criterion_index: number; actual_commit: string | null; attachment_ids_json: string } | undefined;
        if (!row || row.change_id !== change.id) return { ok: false, status: 404, code: 'EVIDENCE_NOT_FOUND', message: '引用的证据不存在。' };
        if (row.result !== 'passed') return { ok: false, status: 409, code: 'EVIDENCE_NOT_PASSING', message: '只有结果为通过的证据可以支持确认。' };
        if (row.formal !== 1 || !evidenceCriterionMatches(db, { changeId: change.id, baselineId: row.baseline_id, criterionId: row.criterion_id, criterionIndex: row.criterion_index }) || !(await evidenceHealthy({ id: row.id, attachmentIdsJson: row.attachment_ids_json, projectId: row.project_id }))) return { ok: false, status: 409, code: 'EVIDENCE_NOT_QUALIFIED', message: '证据不具备正式通过资格（版本、干净状态、条件来源或附件不满足）。' };
        if (selection.mode === 'new') {
          if (row.baseline_id !== context.baselineId || row.criterion_id !== selection.criterionId) return { ok: false, status: 409, code: 'EVIDENCE_VERSION_MISMATCH', message: '证据不属于当前冻结基线的该条件；请改用复用模式并说明适用理由。' };
          if (row.actual_commit !== confirmedTarget.commitSha) return { ok: false, status: 409, code: 'EVIDENCE_VERSION_MISMATCH', message: '证据的验证版本与已确认实现目标不一致；请改用复用模式并说明理由。' };
        } else {
          if (row.criterion_id !== selection.criterionId) return { ok: false, status: 409, code: 'EVIDENCE_CRITERION_MISMATCH', message: '复用证据不属于同一条件。' };
          if (!selection.reuseReason?.trim()) return { ok: false, status: 400, code: 'REUSE_REASON_REQUIRED', message: '复用历史证据必须说明适用理由。' };
        }
      }
      return { ok: true };
    }
  });

  app.post<{ Params: { changeId: string }; Body: { requestId: string; payload: { previewId: string; complete: boolean } } }>('/api/v1/changes/:changeId/review/confirm', {
    schema: { body: { type: 'object', required: ['requestId', 'payload'], additionalProperties: false, properties: {
      requestId: { type: 'string', minLength: 1, maxLength: 128 },
      payload: { type: 'object', required: ['previewId', 'complete'], additionalProperties: false, properties: { previewId: { type: 'string', minLength: 1 }, complete: { type: 'boolean' } } },
    } } },
  }, async (request, reply) => {
    const { changeId } = request.params;
    const { requestId, payload } = request.body;
    if (!db.prepare('SELECT 1 FROM changes WHERE id = ?').get(changeId)) return reply.code(404).send({ code: 'NOT_FOUND', message: '变更不存在。', requestId: request.id });
    const preview = db.prepare('SELECT id, cycle, baseline_id, criterion_revision_id, target_id, record_version, evidence_count, decision_count, disposition_count, selections_json FROM review_previews WHERE id = ? AND change_id = ?').get(payload.previewId, changeId) as { id: string; cycle: number; baseline_id: string; criterion_revision_id: string; target_id: string | null; record_version: number; evidence_count: number; decision_count: number; disposition_count: number; selections_json: string } | undefined;
    if (!preview) return reply.code(404).send({ code: 'PREVIEW_NOT_FOUND', message: '确认预览不存在。', requestId: request.id });
    const fingerprint = JSON.stringify(['review-confirm', changeId, payload.previewId, payload.complete]);
    const findPrior = () => db.prepare("SELECT fingerprint, resource_id AS resourceId, record_version AS recordVersion, committed_at AS committedAt FROM review_requests WHERE request_id = ? AND action = 'confirm'").get(requestId) as { fingerprint: string; resourceId: string; recordVersion: number | null; committedAt: string } | undefined;
    const previous = findPrior();
    if (previous && !sameFingerprint(previous.fingerprint, JSON.parse(fingerprint))) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    if (previous) return reply.code(200).send({ requestId, resourceId: previous.resourceId, recordVersion: previous.recordVersion ?? preview.record_version, committedAt: previous.committedAt, complete: payload.complete } satisfies Receipt & { complete: boolean });
    if (db.prepare('SELECT 1 FROM review_requests WHERE request_id = ?').get(requestId) || requestIdUsedElsewhere(db, requestId, 'review')) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    const parsedSelections: unknown = JSON.parse(preview.selections_json);
    if (!Array.isArray(parsedSelections)) return reply.code(400).send({ code: 'PREVIEW_KIND_MISMATCH', message: '该预览不是验收确认预览。', requestId: request.id });
    const selections = parsedSelections as Selection[];
    const evidenceToCheck = new Map<string, Set<string>>();
    const addEvidence = (id: string, criterionId: string) => {
      const criteria = evidenceToCheck.get(id) ?? new Set<string>();
      criteria.add(criterionId);
      evidenceToCheck.set(id, criteria);
    };
    for (const selection of selections) for (const id of selection.evidenceIds) addEvidence(id, selection.criterionId);
    if (payload.complete) {
      const current = getChange(changeId);
      const context = current && contextOf(current);
      if (current && context?.target) {
        const selected = new Set(selections.map(selection => selection.criterionId));
        for (const criterion of context.criteria) {
          if (selected.has(criterion.id)) continue;
          const decision = effectiveDecision(changeId, current.cycle, context.baselineId, criterion.id, context.target.id);
          if (decision?.result === 'passed') {
            const ids = JSON.parse(decision.evidenceIdsJson) as string[];
            if (ids.length === 0) return reply.code(409).send({ code: 'EVIDENCE_NOT_QUALIFIED', message: '已有通过决定缺少证据，请重新核对。', requestId: request.id });
            for (const id of ids) addEvidence(id, criterion.id);
          }
        }
      }
    }
    for (const [evidenceId, criteria] of evidenceToCheck) {
      const row = db.prepare('SELECT id, project_id AS projectId, baseline_id AS baselineId, criterion_id AS criterionId, criterion_index AS criterionIndex, formal, result, attachment_ids_json AS attachmentIdsJson FROM evidence_records WHERE id = ? AND change_id = ?').get(evidenceId, changeId) as { id: string; projectId: string; baselineId: string | null; criterionId: string | null; criterionIndex: number; formal: number; result: string; attachmentIdsJson: string } | undefined;
      if (!row || row.formal !== 1 || row.result !== 'passed' || criteria.size !== 1 || !row.criterionId || !criteria.has(row.criterionId) || !evidenceCriterionMatches(db, { changeId, baselineId: row.baselineId, criterionId: row.criterionId, criterionIndex: row.criterionIndex }) || !(await evidenceHealthy(row))) return reply.code(409).send({ code: 'EVIDENCE_NOT_QUALIFIED', message: '证据的条件关联或附件不完整，请重新核对。', requestId: request.id });
    }
    const result = db.transaction((): Receipt & { complete: boolean } | string => {
      const concurrent = findPrior();
      if (concurrent && !sameFingerprint(concurrent.fingerprint, JSON.parse(fingerprint))) return 'REQUEST_ID_CONFLICT';
      if (concurrent) return { requestId, resourceId: concurrent.resourceId, recordVersion: concurrent.recordVersion ?? preview.record_version, committedAt: concurrent.committedAt, complete: payload.complete };
      if (db.prepare('SELECT 1 FROM review_requests WHERE request_id = ?').get(requestId) || requestIdUsedElsewhere(db, requestId, 'review')) return 'REQUEST_ID_CONFLICT';
      const change = getChange(changeId);
      if (!change) return 'NOT_FOUND';
      if (change.phase !== 'Reviewing') return 'INVALID_STATE';
      if (change.version !== preview.record_version) return 'PREVIEW_STALE';
      const counts = {
        evidence: (db.prepare('SELECT COUNT(*) AS count FROM evidence_records WHERE change_id = ?').get(change.id) as { count: number }).count,
        decisions: (db.prepare('SELECT COUNT(*) AS count FROM decisions WHERE change_id = ?').get(change.id) as { count: number }).count,
        dispositions: (db.prepare('SELECT COUNT(*) AS count FROM failure_dispositions WHERE change_id = ?').get(change.id) as { count: number }).count,
      };
      if (counts.evidence !== preview.evidence_count || counts.decisions !== preview.decision_count || counts.dispositions !== preview.disposition_count) return 'PREVIEW_STALE';
      const context = contextOf(change);
      if (!context || !context.target || context.baselineId !== preview.baseline_id || context.criterionRevisionId !== preview.criterion_revision_id || context.target.id !== preview.target_id) return 'PREVIEW_STALE';
      for (const selection of selections) {
        const failures = blockingFailures(db, change.id, change.cycle, context.baselineId, selection.criterionId, context.target?.id ?? null);
        if (failures.length > 0) return 'PREVIEW_STALE';
        for (const evidenceId of selection.evidenceIds) {
          const row = db.prepare('SELECT result, formal, baseline_id, criterion_id, criterion_index, actual_commit, attachment_ids_json, change_id, project_id FROM evidence_records WHERE id = ?').get(evidenceId) as { result: string; formal: number; baseline_id: string | null; criterion_id: string | null; criterion_index: number; actual_commit: string | null; attachment_ids_json: string; change_id: string } | undefined;
          if (!row || row.change_id !== change.id || row.result !== 'passed' || row.formal !== 1 || !evidenceCriterionMatches(db, { changeId: change.id, baselineId: row.baseline_id, criterionId: row.criterion_id, criterionIndex: row.criterion_index })) return 'PREVIEW_STALE';
          if (selection.mode === 'new' && (row.baseline_id !== context.baselineId || row.criterion_id !== selection.criterionId || row.actual_commit !== context.target!.commitSha)) return 'PREVIEW_STALE';
        }
      }
      // A rejected final acceptance must not persist any decisions or receipt.
      if (payload.complete) {
        const selected = new Set(selections.map(selection => selection.criterionId));
        for (const criterion of context.criteria) {
          const decision = effectiveDecision(change.id, change.cycle, context.baselineId, criterion.id, context.target.id);
          if (!selected.has(criterion.id) && (!decision || decision.result === 'failed')) return 'GATE_INCOMPLETE';
          if (blockingFailures(db, change.id, change.cycle, context.baselineId, criterion.id, context.target?.id ?? null).length > 0) return 'GATE_INCOMPLETE';
        }
      }
      const before = projectRecordBytes(db, change.projectId);
      const committedAt = new Date().toISOString();
      const recordVersion = change.version + 1;
      const decisionIds: string[] = [];
      for (const selection of selections) {
        const prior = effectiveDecision(change.id, change.cycle, context.baselineId, selection.criterionId, context.target!.id);
        const decisionId = randomUUID();
        db.prepare('INSERT INTO decisions(id,change_id,project_id,cycle,baseline_id,criterion_revision_id,criterion_id,target_id,result,evidence_ids_json,reason,actor,preview_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(decisionId, change.id, change.projectId, change.cycle, context.baselineId, context.criterionRevisionId, selection.criterionId, context.target!.id, 'passed', JSON.stringify(selection.evidenceIds), selection.mode === 'reuse' ? `复用历史证据：${selection.reuseReason ?? ''}` : '当前版本核对通过', isActor(request), preview.id, committedAt);
        if (prior) db.prepare('UPDATE decisions SET superseded_by = ? WHERE id = ?').run(decisionId, prior.id);
        decisionIds.push(decisionId);
      }
      db.prepare("INSERT INTO review_requests(request_id,fingerprint,resource_id,action,record_version,committed_at) VALUES (?,?,?,?,?,?)").run(requestId, fingerprint, decisionIds[0] ?? preview.id, 'confirm', recordVersion, committedAt);
      let accepted = false;
      if (payload.complete) {
        db.prepare("UPDATE writer_sessions SET status = 'completed', ended_at = ? WHERE change_id = ? AND status = 'active'").run(committedAt, change.id);
        db.prepare('UPDATE changes SET phase = ?, version = ? WHERE id = ?').run('Accepted', recordVersion, change.id);
        // 最终固定快照：验收完成时在同一事务捕获全部记录，失败回滚不留快照。
        const snapshot = createHandoffSnapshotRow(db, change.id);
        db.prepare("INSERT INTO change_transitions(id,change_id,from_phase,to_phase,cycle,record_version,reason,created_at) VALUES (?,?,?,?,?,?,?,?)").run(randomUUID(), change.id, change.phase, 'Accepted', change.cycle, recordVersion, snapshot ? `用户完成冻结版本验收；完成快照 ${snapshot.snapshotId}` : '用户完成冻结版本验收', committedAt);
        accepted = true;
      } else {
        db.prepare('UPDATE changes SET version = ? WHERE id = ?').run(recordVersion, change.id);
      }
      checkProjectCapacity(db, change.projectId, before, recordsLimit);
      return { requestId, resourceId: decisionIds[0] ?? preview.id, recordVersion, committedAt, complete: accepted };
    })();
    if (typeof result === 'string') {
      if (result === 'NOT_FOUND') return reply.code(404).send({ code: result, message: '变更不存在。', requestId: request.id });
      if (result === 'INVALID_STATE') return reply.code(409).send({ code: result, message: '只有审阅中的变更可以确认。', requestId: request.id });
      if (result === 'PREVIEW_STALE') return reply.code(409).send({ code: result, message: '确认预览已过期：相关数据在预览后发生变化，请重新生成预览。', requestId: request.id });
      if (result === 'GATE_INCOMPLETE') return reply.code(409).send({ code: result, message: '尚有条件缺少有效决定或存在未处置失败，不能完成最终验收。', requestId: request.id });
      return reply.code(409).send({ code: result, message: '请求标识已用于不同的内容。', requestId: request.id });
    }
    return reply.code(200).send(result);
  });

  app.post<{ Params: { changeId: string }; Body: { requestId: string; expectedVersion: number; payload: { criterionId: string; reason: string; failureEvidenceIds?: string[] } } }>('/api/v1/changes/:changeId/review/waive', {
    schema: { body: { type: 'object', required: ['requestId', 'expectedVersion', 'payload'], additionalProperties: false, properties: {
      requestId: { type: 'string', minLength: 1, maxLength: 128 }, expectedVersion: { type: 'integer', minimum: 1 },
      payload: { type: 'object', required: ['criterionId', 'reason'], additionalProperties: false, properties: { criterionId: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1, maxLength: 4000 }, failureEvidenceIds: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1 } } } },
    } } },
  }, async (request, reply) => {
    const { changeId } = request.params;
    const { requestId, expectedVersion, payload } = request.body;
    if (!payload.reason.trim()) return reply.code(400).send({ code: 'INVALID_REQUEST', message: '风险豁免必须说明理由与影响。', requestId: request.id });
    const fingerprint = JSON.stringify(['waive', changeId, expectedVersion, payload]);
    const findPrior = () => db.prepare("SELECT fingerprint, resource_id AS resourceId, record_version AS recordVersion, committed_at AS committedAt FROM review_requests WHERE request_id = ? AND action = 'waive'").get(requestId) as { fingerprint: string; resourceId: string; recordVersion: number | null; committedAt: string } | undefined;
    const previous = findPrior();
    if (previous && !sameFingerprint(previous.fingerprint, JSON.parse(fingerprint))) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    if (previous) return reply.code(200).send({ requestId, resourceId: previous.resourceId, recordVersion: previous.recordVersion, committedAt: previous.committedAt });
    if (db.prepare('SELECT 1 FROM review_requests WHERE request_id = ?').get(requestId) || requestIdUsedElsewhere(db, requestId, 'review')) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    const result = db.transaction((): Receipt | { currentVersion: number } | string => {
      const concurrent = findPrior();
      if (concurrent && !sameFingerprint(concurrent.fingerprint, JSON.parse(fingerprint))) return 'REQUEST_ID_CONFLICT';
      if (concurrent) return { requestId, resourceId: concurrent.resourceId, recordVersion: concurrent.recordVersion ?? expectedVersion, committedAt: concurrent.committedAt };
      if (db.prepare('SELECT 1 FROM review_requests WHERE request_id = ?').get(requestId) || requestIdUsedElsewhere(db, requestId, 'review')) return 'REQUEST_ID_CONFLICT';
      const change = getChange(changeId);
      if (!change) return 'NOT_FOUND';
      if (change.version !== expectedVersion) return { currentVersion: change.version };
      if (change.phase !== 'Reviewing') return 'INVALID_STATE';
      const context = contextOf(change);
      if (!context) return 'INVALID_STATE';
      if (!context.criteria.some(item => item.id === payload.criterionId)) return 'CRITERION_NOT_FOUND';
      for (const failureId of payload.failureEvidenceIds ?? []) {
        const row = db.prepare("SELECT 1 FROM evidence_records WHERE id = ? AND change_id = ? AND criterion_id = ? AND result = 'failed'").get(failureId, change.id, payload.criterionId);
        if (!row) return 'EVIDENCE_NOT_FOUND';
      }
      const before = projectRecordBytes(db, change.projectId);
      const committedAt = new Date().toISOString();
      const recordVersion = change.version + 1;
      const decisionId = randomUUID();
      const prior = effectiveDecision(change.id, change.cycle, context.baselineId, payload.criterionId, context.target?.id ?? null);
      db.prepare('INSERT INTO decisions(id,change_id,project_id,cycle,baseline_id,criterion_revision_id,criterion_id,target_id,result,evidence_ids_json,reason,actor,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(decisionId, change.id, change.projectId, change.cycle, context.baselineId, context.criterionRevisionId, payload.criterionId, context.target?.id ?? null, 'waived', JSON.stringify(payload.failureEvidenceIds ?? []), payload.reason.trim(), isActor(request), committedAt);
      if (prior) db.prepare('UPDATE decisions SET superseded_by = ? WHERE id = ?').run(decisionId, prior.id);
      db.prepare("INSERT INTO review_requests(request_id,fingerprint,resource_id,action,record_version,committed_at) VALUES (?,?,?,?,?,?)").run(requestId, fingerprint, decisionId, 'waive', recordVersion, committedAt);
      db.prepare('UPDATE changes SET version = ? WHERE id = ?').run(recordVersion, change.id);
      checkProjectCapacity(db, change.projectId, before, recordsLimit);
      return { requestId, resourceId: decisionId, recordVersion, committedAt };
    })();
    if (typeof result === 'string') {
      if (result === 'NOT_FOUND') return reply.code(404).send({ code: result, message: '变更不存在。', requestId: request.id });
      if (result === 'CRITERION_NOT_FOUND' || result === 'EVIDENCE_NOT_FOUND') return reply.code(404).send({ code: result, message: result === 'CRITERION_NOT_FOUND' ? '条件不属于当前冻结基线。' : '引用的失败证据不存在或不属于该条件。', requestId: request.id });
      if (result === 'INVALID_STATE') return reply.code(409).send({ code: result, message: '只有审阅中的变更可以进行风险豁免。', requestId: request.id });
      return reply.code(409).send({ code: result, message: '请求标识已用于不同的内容。', requestId: request.id });
    }
    if ('currentVersion' in result) return reply.code(409).send({ code: 'VERSION_CONFLICT', message: '变更已更新，请刷新后重试。', requestId: request.id, currentVersion: result.currentVersion });
    return reply.code(200).send(result);
  });

  app.post<{ Params: { changeId: string }; Body: { requestId: string; expectedVersion: number; payload: { rows: DispositionRow[] } } & WriterGrant }>('/api/v1/changes/:changeId/review/failure-dispositions/preview', {
    schema: { body: { type: 'object', required: ['requestId', 'expectedVersion', 'payload'], additionalProperties: false, properties: {
      requestId: { type: 'string', minLength: 1, maxLength: 128 }, expectedVersion: { type: 'integer', minimum: 1 },
      writerSessionId: { type: 'string', minLength: 1 }, generation: { type: 'integer', minimum: 1 },
      payload: { type: 'object', required: ['rows'], additionalProperties: false, properties: { rows: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', required: ['criterionId', 'failureEvidenceId', 'outcome', 'reason'], additionalProperties: false, properties: {
        criterionId: { type: 'string', minLength: 1 }, failureEvidenceId: { type: 'string', minLength: 1 }, outcome: { type: 'string', enum: ['resolved', 'not_applicable'] }, supportingEvidenceIds: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1 } }, reason: { type: 'string', minLength: 1, maxLength: 4000 },
      } } } } },
    } } },
  }, async (request, reply) => {
    const { changeId } = request.params;
    const { requestId, expectedVersion, payload } = request.body;
    const guard = () => checkWriter(request, request.body, { changeId });
    const denied = guard();
    if (denied) return reply.code(denied === 'FORBIDDEN' ? 403 : 409).send({ code: denied, message: writerGrantMessage(denied), requestId: request.id });
    const fingerprint = JSON.stringify(writerCommand(isOwner(request), request.body, ['disposition-preview', changeId, expectedVersion, payload]));
    const findPrior = () => db.prepare("SELECT fingerprint, resource_id AS resourceId FROM review_requests WHERE request_id = ? AND action = 'disposition-preview'").get(requestId) as { fingerprint: string; resourceId: string } | undefined;
    const previous = findPrior();
    if (previous && !sameFingerprint(previous.fingerprint, JSON.parse(fingerprint))) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    if (previous) return reply.code(201).send({ requestId, resourceId: previous.resourceId });
    if (db.prepare('SELECT 1 FROM review_requests WHERE request_id = ?').get(requestId) || requestIdUsedElsewhere(db, requestId, 'review')) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    const change = getChange(changeId);
    if (!change) return reply.code(404).send({ code: 'NOT_FOUND', message: '变更不存在。', requestId: request.id });
    if (change.version !== expectedVersion) return reply.code(409).send({ code: 'VERSION_CONFLICT', message: '变更已更新，请刷新后重试。', requestId: request.id, currentVersion: change.version });
    if (change.phase !== 'Reviewing') return reply.code(409).send({ code: 'INVALID_STATE', message: '只有审阅中的变更可以处置失败。', requestId: request.id });
    const context = contextOf(change);
    if (!context) return reply.code(409).send({ code: 'NO_REVIEW_CONTEXT', message: '尚无冻结基线。', requestId: request.id });
    if (!context.target) return reply.code(409).send({ code: 'TARGET_REQUIRED', message: '确认实现目标后才能处置失败。', requestId: request.id });
    const snapshot = snapshotOf(change, context);
    for (const row of payload.rows) {
      const failure = db.prepare("SELECT id, baseline_id, criterion_id FROM evidence_records WHERE id = ? AND change_id = ? AND result = 'failed'").get(row.failureEvidenceId, change.id) as { baseline_id: string | null; criterion_id: string | null } | undefined;
      if (!failure || failure.baseline_id !== context.baselineId || failure.criterion_id !== row.criterionId) return reply.code(404).send({ code: 'FAILURE_NOT_FOUND', message: '失败证据不存在或不属于当前上下文的该条件。', requestId: request.id });
      if (!row.reason.trim()) return reply.code(400).send({ code: 'REASON_REQUIRED', message: '失败处置必须说明理由或依据。', requestId: request.id });
      if (row.outcome === 'resolved') {
        const target = context.target;
        if (!target) return reply.code(409).send({ code: 'TARGET_REQUIRED', message: '补测解决需要已确认的实现目标。', requestId: request.id });
        const support = row.supportingEvidenceIds ?? [];
        if (support.length === 0) return reply.code(400).send({ code: 'SUPPORT_REQUIRED', message: '判定已解决必须引用可核对的补测证据。', requestId: request.id });
        for (const evidenceId of support) {
          const item = db.prepare('SELECT change_id, result, formal, baseline_id, criterion_id, criterion_index, actual_commit FROM evidence_records WHERE id = ?').get(evidenceId) as { change_id: string; result: string; formal: number; baseline_id: string | null; criterion_id: string | null; criterion_index: number; actual_commit: string | null } | undefined;
          if (!item || item.change_id !== change.id || item.result !== 'passed' || item.formal !== 1 || item.baseline_id !== context.baselineId || item.criterion_id !== row.criterionId || item.actual_commit !== target.commitSha || !evidenceCriterionMatches(db, { changeId: change.id, baselineId: item.baseline_id, criterionId: item.criterion_id, criterionIndex: item.criterion_index })) return reply.code(409).send({ code: 'SUPPORT_NOT_QUALIFIED', message: '补测证据必须是通过的正式证据，且验证版本与已确认实现目标一致。', requestId: request.id });
          const evidence = db.prepare('SELECT id, project_id AS projectId, attachment_ids_json AS attachmentIdsJson FROM evidence_records WHERE id = ?').get(evidenceId) as { id: string; projectId: string; attachmentIdsJson: string };
          if (!(await evidenceHealthy(evidence))) return reply.code(409).send({ code: 'SUPPORT_NOT_QUALIFIED', message: '补测证据的附件缺失或损坏。', requestId: request.id });
        }
      }
    }
    const result = db.transaction((): Receipt | string => {
      const denied = guard();
      if (denied) return denied;
      const concurrent = findPrior();
      if (concurrent && !sameFingerprint(concurrent.fingerprint, JSON.parse(fingerprint))) return 'REQUEST_ID_CONFLICT';
      if (concurrent) return { requestId, resourceId: concurrent.resourceId, recordVersion: change.version, committedAt: new Date().toISOString() };
      if (db.prepare('SELECT 1 FROM review_requests WHERE request_id = ?').get(requestId) || requestIdUsedElsewhere(db, requestId, 'review')) return 'REQUEST_ID_CONFLICT';
      const current = getChange(changeId);
      const currentContext = current && contextOf(current);
      if (!current || current.phase !== 'Reviewing' || !currentContext || !sameSnapshot(snapshot, snapshotOf(current, currentContext))) return 'PREVIEW_STALE';
      const before = projectRecordBytes(db, change.projectId);
      const committedAt = new Date().toISOString();
      const previewId = randomUUID();
      const counts = {
        evidence: (db.prepare('SELECT COUNT(*) AS count FROM evidence_records WHERE change_id = ?').get(change.id) as { count: number }).count,
        decisions: (db.prepare('SELECT COUNT(*) AS count FROM decisions WHERE change_id = ?').get(change.id) as { count: number }).count,
        dispositions: (db.prepare('SELECT COUNT(*) AS count FROM failure_dispositions WHERE change_id = ?').get(change.id) as { count: number }).count,
      };
      db.prepare('INSERT INTO review_previews(id,change_id,project_id,cycle,baseline_id,criterion_revision_id,target_id,record_version,evidence_count,decision_count,disposition_count,selections_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(previewId, change.id, change.projectId, change.cycle, context.baselineId, context.criterionRevisionId, context.target?.id ?? null, change.version, counts.evidence, counts.decisions, counts.dispositions, JSON.stringify({ kind: 'dispositions', rows: payload.rows }), committedAt);
      db.prepare("INSERT INTO review_requests(request_id,fingerprint,resource_id,action,record_version,committed_at) VALUES (?,?,?,?,?,?)").run(requestId, fingerprint, previewId, 'disposition-preview', change.version, committedAt);
      checkProjectCapacity(db, change.projectId, before, recordsLimit);
      return { requestId, resourceId: previewId, recordVersion: change.version, committedAt };
    })();
    if (typeof result === 'string') return reply.code(result === 'FORBIDDEN' ? 403 : 409).send({ code: result, message: result === 'PREVIEW_STALE' ? '处置上下文在核对期间变化，请重新生成预览。' : result === 'REQUEST_ID_CONFLICT' ? '请求标识已用于不同的内容。' : writerGrantMessage(result as WriterGuardError), requestId: request.id });
    return reply.code(201).send(result);
  });

  app.post<{ Params: { changeId: string }; Body: { requestId: string; payload: { previewId: string } } }>('/api/v1/changes/:changeId/review/failure-dispositions/confirm', {
    schema: { body: { type: 'object', required: ['requestId', 'payload'], additionalProperties: false, properties: { requestId: { type: 'string', minLength: 1, maxLength: 128 }, payload: { type: 'object', required: ['previewId'], additionalProperties: false, properties: { previewId: { type: 'string', minLength: 1 } } } } } },
  }, async (request, reply) => {
    const { changeId } = request.params;
    const { requestId, payload } = request.body;
    const preview = db.prepare("SELECT * FROM review_previews WHERE id = ? AND change_id = ?").get(payload.previewId, changeId) as { cycle: number; baseline_id: string; criterion_revision_id: string; target_id: string | null; record_version: number; evidence_count: number; decision_count: number; disposition_count: number; selections_json: string } | undefined;
    if (!preview) return reply.code(404).send({ code: 'PREVIEW_NOT_FOUND', message: '处置预览不存在。', requestId: request.id });
    const parsed = JSON.parse(preview.selections_json) as { kind?: string; rows?: DispositionRow[] };
    if (parsed.kind !== 'dispositions' || !Array.isArray(parsed.rows) || parsed.rows.length === 0) return reply.code(400).send({ code: 'PREVIEW_KIND_MISMATCH', message: '该预览不是有效的失败处置预览。', requestId: request.id });
    const fingerprint = JSON.stringify(['disposition-confirm', changeId, payload.previewId]);
    const findPrior = () => db.prepare("SELECT fingerprint, resource_id AS resourceId, record_version AS recordVersion, committed_at AS committedAt FROM review_requests WHERE request_id = ? AND action = 'disposition-confirm'").get(requestId) as { fingerprint: string; resourceId: string; recordVersion: number | null; committedAt: string } | undefined;
    const previous = findPrior();
    if (previous && !sameFingerprint(previous.fingerprint, JSON.parse(fingerprint))) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    if (previous) return reply.code(200).send({ requestId, resourceId: previous.resourceId, recordVersion: previous.recordVersion, committedAt: previous.committedAt });
    if (db.prepare('SELECT 1 FROM review_requests WHERE request_id = ?').get(requestId) || requestIdUsedElsewhere(db, requestId, 'review')) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    for (const row of parsed.rows) {
      for (const evidenceId of row.supportingEvidenceIds ?? []) {
        const evidence = db.prepare('SELECT id, project_id AS projectId, attachment_ids_json AS attachmentIdsJson FROM evidence_records WHERE id = ? AND change_id = ?').get(evidenceId, changeId) as { id: string; projectId: string; attachmentIdsJson: string } | undefined;
        if (!evidence || !(await evidenceHealthy(evidence))) return reply.code(409).send({ code: 'SUPPORT_NOT_QUALIFIED', message: '补测证据的附件缺失或损坏，请重新核对。', requestId: request.id });
      }
    }
    const result = db.transaction((): Receipt | string => {
      const concurrent = findPrior();
      if (concurrent && !sameFingerprint(concurrent.fingerprint, JSON.parse(fingerprint))) return 'REQUEST_ID_CONFLICT';
      if (concurrent) return { requestId, resourceId: concurrent.resourceId, recordVersion: concurrent.recordVersion ?? preview.record_version, committedAt: concurrent.committedAt };
      if (db.prepare('SELECT 1 FROM review_requests WHERE request_id = ?').get(requestId) || requestIdUsedElsewhere(db, requestId, 'review')) return 'REQUEST_ID_CONFLICT';
      const change = getChange(changeId);
      if (!change) return 'NOT_FOUND';
      if (change.phase !== 'Reviewing') return 'INVALID_STATE';
      if (change.version !== preview.record_version) return 'PREVIEW_STALE';
      const counts = {
        evidence: (db.prepare('SELECT COUNT(*) AS count FROM evidence_records WHERE change_id = ?').get(change.id) as { count: number }).count,
        decisions: (db.prepare('SELECT COUNT(*) AS count FROM decisions WHERE change_id = ?').get(change.id) as { count: number }).count,
        dispositions: (db.prepare('SELECT COUNT(*) AS count FROM failure_dispositions WHERE change_id = ?').get(change.id) as { count: number }).count,
      };
      if (counts.evidence !== preview.evidence_count || counts.decisions !== preview.decision_count || counts.dispositions !== preview.disposition_count) return 'PREVIEW_STALE';
      const context = contextOf(change);
      if (!context || context.baselineId !== preview.baseline_id || context.target?.id !== preview.target_id) return 'PREVIEW_STALE';
      const before = projectRecordBytes(db, change.projectId);
      const committedAt = new Date().toISOString();
      const recordVersion = change.version + 1;
      const firstId = randomUUID();
      for (const [index, row] of parsed.rows!.entries()) {
        const dispositionId = index === 0 ? firstId : randomUUID();
        db.prepare('INSERT INTO failure_dispositions(id,change_id,project_id,cycle,baseline_id,criterion_id,failure_evidence_id,outcome,supporting_evidence_ids_json,reason,actor,created_at,target_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(dispositionId, change.id, change.projectId, change.cycle, context.baselineId, row.criterionId, row.failureEvidenceId, row.outcome, JSON.stringify(row.supportingEvidenceIds ?? []), row.reason.trim(), isActor(request), committedAt, context.target!.id);
      }
      db.prepare("INSERT INTO review_requests(request_id,fingerprint,resource_id,action,record_version,committed_at) VALUES (?,?,?,?,?,?)").run(requestId, fingerprint, firstId, 'disposition-confirm', recordVersion, committedAt);
      db.prepare('UPDATE changes SET version = ? WHERE id = ?').run(recordVersion, change.id);
      checkProjectCapacity(db, change.projectId, before, recordsLimit);
      return { requestId, resourceId: firstId, recordVersion, committedAt };
    })();
    if (typeof result === 'string') {
      if (result === 'NOT_FOUND') return reply.code(404).send({ code: result, message: '变更不存在。', requestId: request.id });
      if (result === 'INVALID_STATE') return reply.code(409).send({ code: result, message: '只有审阅中的变更可以处置失败。', requestId: request.id });
      if (result === 'PREVIEW_STALE') return reply.code(409).send({ code: result, message: '处置预览已过期：相关数据在预览后发生变化，请重新生成预览。', requestId: request.id });
      return reply.code(409).send({ code: result, message: '请求标识已用于不同的内容。', requestId: request.id });
    }
    return reply.code(200).send(result);
  });

  app.post<{ Params: { changeId: string }; Body: { requestId: string; expectedVersion: number } }>('/api/v1/changes/:changeId/review/continue', {
    schema: { body: { type: 'object', required: ['requestId', 'expectedVersion'], additionalProperties: false, properties: { requestId: { type: 'string', minLength: 1, maxLength: 128 }, expectedVersion: { type: 'integer', minimum: 1 } } } },
  }, async (request, reply) => {
    const { changeId } = request.params;
    const { requestId, expectedVersion } = request.body;
    const fingerprint = JSON.stringify(['review-continue', changeId, expectedVersion]);
    const findPrior = () => db.prepare("SELECT fingerprint, resource_id AS resourceId, record_version AS recordVersion, committed_at AS committedAt FROM review_requests WHERE request_id = ? AND action = 'continue'").get(requestId) as { fingerprint: string; resourceId: string; recordVersion: number | null; committedAt: string } | undefined;
    const previous = findPrior();
    if (previous && !sameFingerprint(previous.fingerprint, JSON.parse(fingerprint))) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    if (previous) return reply.code(200).send({ requestId, resourceId: previous.resourceId, recordVersion: previous.recordVersion, committedAt: previous.committedAt });
    if (db.prepare('SELECT 1 FROM review_requests WHERE request_id = ?').get(requestId) || requestIdUsedElsewhere(db, requestId, 'review')) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    const result = db.transaction((): Receipt | { currentVersion: number } | string => {
      const concurrent = findPrior();
      if (concurrent && !sameFingerprint(concurrent.fingerprint, JSON.parse(fingerprint))) return 'REQUEST_ID_CONFLICT';
      if (concurrent) return { requestId, resourceId: concurrent.resourceId, recordVersion: concurrent.recordVersion ?? expectedVersion, committedAt: concurrent.committedAt };
      if (db.prepare('SELECT 1 FROM review_requests WHERE request_id = ?').get(requestId) || requestIdUsedElsewhere(db, requestId, 'review')) return 'REQUEST_ID_CONFLICT';
      const change = getChange(changeId);
      if (!change) return 'NOT_FOUND';
      if (change.version !== expectedVersion) return { currentVersion: change.version };
      if (change.phase !== 'Reviewing') return 'INVALID_STATE';
      const before = projectRecordBytes(db, change.projectId);
      const committedAt = new Date().toISOString();
      const recordVersion = change.version + 1;
      db.prepare("INSERT INTO change_transitions(id,change_id,from_phase,to_phase,cycle,record_version,reason,created_at) VALUES (?,?,?,?,?,?,?,?)").run(randomUUID(), change.id, 'Reviewing', 'Working', change.cycle, recordVersion, '继续实现', committedAt);
      db.prepare('UPDATE changes SET phase = ?, version = ? WHERE id = ?').run('Working', recordVersion, change.id);
      db.prepare("INSERT INTO review_requests(request_id,fingerprint,resource_id,action,record_version,committed_at) VALUES (?,?,?,?,?,?)").run(requestId, fingerprint, change.id, 'continue', recordVersion, committedAt);
      checkProjectCapacity(db, change.projectId, before, recordsLimit);
      return { requestId, resourceId: change.id, recordVersion, committedAt };
    })();
    if (typeof result === 'string') {
      if (result === 'NOT_FOUND') return reply.code(404).send({ code: result, message: '变更不存在。', requestId: request.id });
      if (result === 'INVALID_STATE') return reply.code(409).send({ code: result, message: '只有审阅中的变更可以继续实现。', requestId: request.id });
      return reply.code(409).send({ code: result, message: '请求标识已用于不同的内容。', requestId: request.id });
    }
    if ('currentVersion' in result) return reply.code(409).send({ code: 'VERSION_CONFLICT', message: '变更已更新，请刷新后重试。', requestId: request.id, currentVersion: result.currentVersion });
    return reply.code(200).send(result);
  });
}
