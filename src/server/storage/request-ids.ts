import type Database from 'better-sqlite3';

// JSON object member order is not part of a command's meaning. Existing
// receipts retain their original fingerprints and are compared canonically.
export function sameFingerprint(stored: string, requested: unknown) {
  const canonical = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
  try { return canonical(JSON.parse(stored)) === canonical(requested); }
  catch { return false; }
}

type RequestStore = 'projects' | 'workspaces' | 'observations' | 'changes' | 'baselines' | 'writerSessions' | 'checkpoints' | 'handoffs' | 'executions' | 'evidence' | 'targets' | 'proposals' | 'attachments' | 'review' | 'exports' | 'restores';
const tables: Record<RequestStore, string> = { projects: 'requests', workspaces: 'workspace_requests', observations: 'observation_requests', changes: 'change_requests', baselines: 'baseline_requests', writerSessions: 'writer_session_requests', checkpoints: 'checkpoint_requests', handoffs: 'handoff_requests', executions: 'execution_requests', evidence: 'evidence_requests', targets: 'acceptance_target_requests', proposals: 'acceptance_proposal_requests', attachments: 'attachment_requests', review: 'review_requests', exports: 'export_operations', restores: 'restore_receipts' };

export function requestIdUsedElsewhere(db: Database.Database, requestId: string, ownStore: RequestStore) {
  const selected = Object.entries(tables).filter(([name]) => name !== ownStore).map(([, table]) => `SELECT 1 FROM ${table} WHERE request_id = ?`);
  return Boolean(db.prepare(selected.join(' UNION ALL ')).get(...selected.map(() => requestId)));
}

export function requestIdIsAmbiguous(db: Database.Database, requestId: string) {
  const selected = Object.values(tables).map(table => `SELECT 1 FROM ${table} WHERE request_id = ?`);
  const result = db.prepare(`SELECT COUNT(*) AS count FROM (${selected.join(' UNION ALL ')})`).get(...selected.map(() => requestId)) as { count: number };
  return result.count > 1;
}
