import type Database from 'better-sqlite3';

export const DEFAULT_RECORDS_LIMIT = 20 * 1024 * 1024;

// Keep the serialized record projection shared with the future recovery exporter.
export function projectRecords(db: Database.Database, projectId: string) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return null;
  return {
    project,
    projectRequests: db.prepare('SELECT * FROM requests WHERE project_id = ? ORDER BY request_id').all(projectId),
    repository: db.prepare('SELECT * FROM project_repositories WHERE project_id = ?').get(projectId) ?? null,
    workspaces: db.prepare('SELECT * FROM workspaces WHERE project_id = ? ORDER BY id').all(projectId),
    workspaceRequests: db.prepare('SELECT r.* FROM workspace_requests r JOIN workspaces w ON w.id = r.resource_id WHERE w.project_id = ? ORDER BY r.request_id').all(projectId),
    observations: db.prepare('SELECT * FROM workspace_observations WHERE project_id = ? ORDER BY id').all(projectId),
    observationRequests: db.prepare('SELECT r.* FROM observation_requests r JOIN workspace_observations o ON o.id = r.observation_id WHERE o.project_id = ? ORDER BY r.request_id').all(projectId),
    changes: db.prepare('SELECT * FROM changes WHERE project_id = ? ORDER BY id').all(projectId),
    changeRevisions: db.prepare('SELECT r.* FROM change_revisions r JOIN changes c ON c.id = r.change_id WHERE c.project_id = ? ORDER BY r.id').all(projectId),
    changeRequests: db.prepare('SELECT r.* FROM change_requests r JOIN changes c ON c.id = r.resource_id WHERE c.project_id = ? ORDER BY r.request_id').all(projectId),
    changeTransitions: db.prepare('SELECT t.* FROM change_transitions t JOIN changes c ON c.id = t.change_id WHERE c.project_id = ? ORDER BY t.id').all(projectId),
    baselines: db.prepare('SELECT b.* FROM baselines b JOIN changes c ON c.id = b.change_id WHERE c.project_id = ? ORDER BY b.id').all(projectId),
    baselineRequests: db.prepare('SELECT r.* FROM baseline_requests r JOIN baselines b ON b.id = r.baseline_id JOIN changes c ON c.id = b.change_id WHERE c.project_id = ? ORDER BY r.request_id').all(projectId),
    writerSessions: db.prepare('SELECT s.* FROM writer_sessions s JOIN changes c ON c.id = s.change_id WHERE c.project_id = ? ORDER BY s.id').all(projectId),
    writerSessionRequests: db.prepare('SELECT r.* FROM writer_session_requests r JOIN writer_sessions s ON s.id = r.session_id JOIN changes c ON c.id = s.change_id WHERE c.project_id = ? ORDER BY r.request_id').all(projectId),
    checkpoints: db.prepare('SELECT p.* FROM checkpoints p JOIN changes c ON c.id = p.change_id WHERE c.project_id = ? ORDER BY p.id').all(projectId),
    checkpointRequests: db.prepare('SELECT r.* FROM checkpoint_requests r JOIN checkpoints p ON p.id = r.checkpoint_id JOIN changes c ON c.id = p.change_id WHERE c.project_id = ? ORDER BY r.request_id').all(projectId),
    handoffSnapshots: db.prepare('SELECT s.* FROM handoff_snapshots s JOIN changes c ON c.id = s.change_id WHERE c.project_id = ? ORDER BY s.id').all(projectId),
    handoffRequests: db.prepare('SELECT r.* FROM handoff_requests r JOIN handoff_snapshots s ON s.id = r.snapshot_id JOIN changes c ON c.id = s.change_id WHERE c.project_id = ? ORDER BY r.request_id').all(projectId),
    executions: db.prepare('SELECT e.* FROM executions e JOIN changes c ON c.id = e.change_id WHERE c.project_id = ? ORDER BY e.id').all(projectId),
    executionRequests: db.prepare('SELECT r.* FROM execution_requests r JOIN executions e ON e.id = r.execution_id JOIN changes c ON c.id = e.change_id WHERE c.project_id = ? ORDER BY r.request_id').all(projectId),
    evidenceRecords: db.prepare('SELECT v.* FROM evidence_records v JOIN changes c ON c.id = v.change_id WHERE c.project_id = ? ORDER BY v.id').all(projectId),
    evidenceRequests: db.prepare('SELECT r.* FROM evidence_requests r JOIN evidence_records v ON v.id = r.evidence_id JOIN changes c ON c.id = v.change_id WHERE c.project_id = ? ORDER BY r.request_id').all(projectId),
    acceptanceTargets: db.prepare('SELECT t.* FROM acceptance_targets t JOIN changes c ON c.id = t.change_id WHERE c.project_id = ? ORDER BY t.id').all(projectId),
    acceptanceTargetRequests: db.prepare('SELECT r.* FROM acceptance_target_requests r JOIN acceptance_targets t ON t.id = r.target_id JOIN changes c ON c.id = t.change_id WHERE c.project_id = ? ORDER BY r.request_id').all(projectId),
    acceptanceProposals: db.prepare('SELECT p.* FROM acceptance_proposals p JOIN changes c ON c.id = p.change_id WHERE c.project_id = ? ORDER BY p.id').all(projectId),
    acceptanceProposalRequests: db.prepare('SELECT r.* FROM acceptance_proposal_requests r JOIN acceptance_proposals p ON p.id = r.proposal_id JOIN changes c ON c.id = p.change_id WHERE c.project_id = ? ORDER BY r.request_id').all(projectId),
    attachments: db.prepare('SELECT a.* FROM attachments a WHERE a.project_id = ? ORDER BY a.id').all(projectId),
    attachmentRequests: db.prepare('SELECT r.* FROM attachment_requests r JOIN attachments a ON a.id = r.attachment_id WHERE a.project_id = ? ORDER BY r.request_id').all(projectId),
    reviewPreviews: db.prepare('SELECT p.* FROM review_previews p WHERE p.project_id = ? ORDER BY p.id').all(projectId),
    decisions: db.prepare('SELECT d.* FROM decisions d WHERE d.project_id = ? ORDER BY d.id').all(projectId),
    failureDispositions: db.prepare('SELECT f.* FROM failure_dispositions f WHERE f.project_id = ? ORDER BY f.id').all(projectId),
    reviewRequests: db.prepare('SELECT r.* FROM review_requests r WHERE r.resource_id IN (SELECT id FROM review_previews WHERE project_id = ?) OR r.resource_id IN (SELECT id FROM decisions WHERE project_id = ?) OR r.resource_id IN (SELECT id FROM failure_dispositions WHERE project_id = ?) OR r.resource_id IN (SELECT id FROM changes WHERE project_id = ?)').all(projectId, projectId, projectId, projectId),
  };
}

export function projectRecordBytes(db: Database.Database, projectId: string) {
  const records = projectRecords(db, projectId);
  if (records === null) return 0;
  // 每个唯一附件按其内容字节数计一次；预留活跃会话的释放/中断回执开销。
  const attachmentTotal = (db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM attachments WHERE project_id = ?').get(projectId) as { total: number }).total;
  const active = (db.prepare("SELECT COUNT(*) AS count FROM writer_sessions s JOIN changes c ON c.id = s.change_id WHERE c.project_id = ? AND s.status = 'active'").get(projectId) as { count: number }).count;
  return Buffer.byteLength(JSON.stringify(records), 'utf8') + active * 2048 + attachmentTotal;
}

export class ProjectCapacityExceeded extends Error {
  readonly statusCode = 413;
  readonly code = 'PROJECT_CAPACITY_EXCEEDED';
  readonly dimension = 'records';
  constructor(readonly used: number, readonly requestedIncrement: number, readonly limit: number) {
    super('项目容量不足，未保存本次操作。');
  }
}

export function checkProjectCapacity(db: Database.Database, projectId: string, before: number, limit: number) {
  const after = projectRecordBytes(db, projectId);
  if (after > limit) throw new ProjectCapacityExceeded(before, Math.max(0, after - before), limit);
}
