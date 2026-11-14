import type Database from 'better-sqlite3';

export const DEFAULT_RECORDS_LIMIT = 20 * 1024 * 1024;

// Keep the serialized record projection shared with the future recovery exporter.
export function projectRecords(db: Database.Database, projectId: string) {
  const project = db.prepare('SELECT id, name, created_at AS createdAt FROM projects WHERE id = ?').get(projectId);
  if (!project) return null;
  return {
    project,
    projectRequests: db.prepare('SELECT request_id AS requestId, name, project_id AS projectId FROM requests WHERE project_id = ? ORDER BY request_id').all(projectId),
    repository: db.prepare('SELECT common_dir AS commonDir FROM project_repositories WHERE project_id = ?').get(projectId) ?? null,
    workspaces: db.prepare('SELECT id, project_id AS projectId, path, common_dir AS commonDir, version, created_at AS createdAt FROM workspaces WHERE project_id = ? ORDER BY id').all(projectId),
    workspaceRequests: db.prepare('SELECT r.request_id AS requestId, r.fingerprint, r.resource_id AS resourceId, r.record_version AS recordVersion, r.committed_at AS committedAt FROM workspace_requests r JOIN workspaces w ON w.id = r.resource_id WHERE w.project_id = ? ORDER BY r.request_id').all(projectId),
    observations: db.prepare('SELECT id, workspace_id AS workspaceId, binding_version AS bindingVersion, path, data_json AS dataJson, created_at AS createdAt FROM workspace_observations WHERE project_id = ? ORDER BY id').all(projectId),
    observationRequests: db.prepare('SELECT r.request_id AS requestId, r.fingerprint, r.observation_id AS observationId, r.committed_at AS committedAt FROM observation_requests r JOIN workspace_observations o ON o.id = r.observation_id WHERE o.project_id = ? ORDER BY r.request_id').all(projectId),
    changes: db.prepare('SELECT id, phase, cycle, version, current_revision_id AS currentRevisionId, current_baseline_id AS currentBaselineId, current_checkpoint_id AS currentCheckpointId, created_at AS createdAt FROM changes WHERE project_id = ? ORDER BY id').all(projectId),
    changeRevisions: db.prepare('SELECT r.id, r.change_id AS changeId, r.version, r.title, r.goal, r.scope, r.non_goals AS nonGoals, r.criteria_json AS criteriaJson, r.created_at AS createdAt FROM change_revisions r JOIN changes c ON c.id = r.change_id WHERE c.project_id = ? ORDER BY r.id').all(projectId),
    changeRequests: db.prepare('SELECT r.request_id AS requestId, r.fingerprint, r.resource_id AS resourceId, r.record_version AS recordVersion, r.committed_at AS committedAt FROM change_requests r JOIN changes c ON c.id = r.resource_id WHERE c.project_id = ? ORDER BY r.request_id').all(projectId),
    changeTransitions: db.prepare('SELECT t.id, t.change_id AS changeId, t.from_phase AS fromPhase, t.to_phase AS toPhase, t.cycle, t.record_version AS recordVersion, t.reason, t.created_at AS createdAt FROM change_transitions t JOIN changes c ON c.id = t.change_id WHERE c.project_id = ? ORDER BY t.id').all(projectId),
    baselines: db.prepare('SELECT b.* FROM baselines b JOIN changes c ON c.id = b.change_id WHERE c.project_id = ? ORDER BY b.id').all(projectId),
    baselineRequests: db.prepare('SELECT r.* FROM baseline_requests r JOIN baselines b ON b.id = r.baseline_id JOIN changes c ON c.id = b.change_id WHERE c.project_id = ? ORDER BY r.request_id').all(projectId),
    writerSessions: db.prepare('SELECT s.id, s.change_id, s.workspace_id, s.binding_version, s.tool_label, s.actor, s.generation, s.status, s.created_at, s.ended_at FROM writer_sessions s JOIN changes c ON c.id = s.change_id WHERE c.project_id = ? ORDER BY s.id').all(projectId),
    writerSessionRequests: db.prepare('SELECT r.* FROM writer_session_requests r JOIN writer_sessions s ON s.id = r.session_id JOIN changes c ON c.id = s.change_id WHERE c.project_id = ? ORDER BY r.request_id').all(projectId),
    checkpoints: db.prepare('SELECT p.* FROM checkpoints p JOIN changes c ON c.id = p.change_id WHERE c.project_id = ? ORDER BY p.id').all(projectId),
    checkpointRequests: db.prepare('SELECT r.* FROM checkpoint_requests r JOIN checkpoints p ON p.id = r.checkpoint_id JOIN changes c ON c.id = p.change_id WHERE c.project_id = ? ORDER BY r.request_id').all(projectId),
  };
}

export function projectRecordBytes(db: Database.Database, projectId: string) {
  const records = projectRecords(db, projectId);
  if (records === null) return 0;
  // Reserve enough for interruption or normal release, including the maximum
  // request-id encoding and receipt, so a full project can free a workspace.
  const active = (db.prepare("SELECT COUNT(*) AS count FROM writer_sessions s JOIN changes c ON c.id = s.change_id WHERE c.project_id = ? AND s.status = 'active'").get(projectId) as { count: number }).count;
  return Buffer.byteLength(JSON.stringify(records), 'utf8') + active * 2048;
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
