import type Database from 'better-sqlite3';

/** 检查历史证据的条件序号仍指向其记录的冻结条件 ID。 */
export function evidenceCriterionMatches(db: Database.Database, evidence: { changeId: string; baselineId: string | null; criterionId: string | null; criterionIndex: number }): boolean {
  if (!evidence.baselineId || !evidence.criterionId || !Number.isInteger(evidence.criterionIndex) || evidence.criterionIndex < 1) return false;
  const baseline = db.prepare('SELECT criteria_json AS criteriaJson FROM baselines WHERE id = ? AND change_id = ?').get(evidence.baselineId, evidence.changeId) as { criteriaJson: string } | undefined;
  if (!baseline) return false;
  try {
    const criteria: unknown = JSON.parse(baseline.criteriaJson);
    const criterion = Array.isArray(criteria) ? criteria[evidence.criterionIndex - 1] as { id?: unknown } | undefined : undefined;
    return criterion?.id === evidence.criterionId;
  } catch { return false; }
}
