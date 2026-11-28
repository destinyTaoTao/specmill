import type Database from 'better-sqlite3';

export function confirmedTarget(db: Database.Database, changeId: string) {
  const target = db.prepare(`SELECT id, commit_sha AS commitSha, workspace_id AS workspaceId, status, confirmed_at AS confirmedAt
    FROM acceptance_targets WHERE change_id = ? AND status = 'confirmed' AND confirmation_order IS NOT NULL
    ORDER BY confirmation_order DESC LIMIT 1`).get(changeId) as
    { id: string; commitSha: string; workspaceId: string; status: string; confirmedAt: string } | undefined;
  const targetOrderUncertain = !target && Boolean(db.prepare("SELECT 1 FROM acceptance_targets WHERE change_id = ? AND status = 'confirmed' LIMIT 1").get(changeId));
  return { target: target ?? null, targetOrderUncertain };
}

export function blockingFailures(db: Database.Database, changeId: string, cycle: number, baselineId: string, criterionId: string | null, targetId: string | null) {
  return db.prepare(`SELECT e.id, e.actual_commit AS actualCommit, e.notes FROM evidence_records e
    WHERE e.change_id = @changeId AND e.cycle = @cycle AND e.baseline_id = @baselineId
      AND (@criterionId IS NULL OR e.criterion_id = @criterionId) AND e.result = 'failed'
      AND NOT EXISTS (SELECT 1 FROM failure_dispositions d WHERE d.failure_evidence_id = e.id AND d.cycle = e.cycle AND d.target_id = @targetId)
      AND NOT EXISTS (SELECT 1 FROM decisions w WHERE w.change_id = e.change_id AND w.cycle = e.cycle AND w.baseline_id = e.baseline_id
        AND w.criterion_id = e.criterion_id AND w.target_id = @targetId AND w.result = 'waived' AND w.superseded_by IS NULL
        AND EXISTS (SELECT 1 FROM json_each(w.evidence_ids_json) WHERE value = e.id))
    ORDER BY e.created_at, e.id`).all({ changeId, cycle, baselineId, criterionId, targetId }) as { id: string; actualCommit: string | null; notes: string }[];
}
