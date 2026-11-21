import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { PILOT_SPEC, type PilotResult } from './sample.js';

type Status = 'draft' | 'queued' | 'running' | 'review' | 'archived' | 'blocked';
type Decision = 'freeze' | 'return' | 'accept';
type Spec = typeof PILOT_SPEC;
const maxCompletedRounds = 3;
const maxInterruptionRetries = 2;

export interface PilotSummary {
  id: string;
  version: number;
  status: Status;
  createdAt: string;
  updatedAt: string;
}
export interface PilotAttempt {
  id: string;
  generation: number;
  reason: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'finished' | 'interrupted';
  interruptionReason: string | null;
  result: PilotResult | null;
}
export interface PilotEvent {
  version: number;
  action: Decision | 'create' | 'claim' | 'finish' | 'interrupt';
  actor: 'owner' | 'worker' | 'service';
  reason: string;
  requestId: string | null;
  attemptId: string | null;
  at: string;
}
export interface PilotDetail extends PilotSummary {
  templateRevision: string;
  spec: Spec;
  frozenBaseline: { version: number; frozenAt: string; specSha256: string } | null;
  attempts: PilotAttempt[];
  events: PilotEvent[];
  canAccept: boolean;
  returnWillBlock: boolean;
}

export class PilotError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function isIds(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= 128 && value.every(Number.isSafeInteger);
}

// Worker IPC is a runtime boundary. Persist only these documented evidence fields.
function readResult(input: unknown): PilotResult | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  if (value.commit !== null && (typeof value.commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.commit))) return null;
  if (value.error !== null && (typeof value.error !== 'string' || value.error.length > 16384)) return null;
  if (typeof value.sql !== 'string' || value.sql.length > 16384 || !Array.isArray(value.checks) || value.checks.length > 32) return null;
  const checks: PilotResult['checks'] = [];
  for (const check of value.checks) {
    if (!check || typeof check.name !== 'string' || check.name.length > 256 || typeof check.passed !== 'boolean' ||
        !isIds(check.expected) || !isIds(check.actual)) return null;
    checks.push({ name: check.name, expected: check.expected, actual: check.actual, passed: check.passed });
  }
  return { commit: value.commit, sql: value.sql, checks, error: value.error };
}

function matchesIds(actual: readonly number[], expected: readonly number[]) {
  return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
}
function qualifies(spec: Spec, result: PilotResult | null | undefined) {
  if (!result || !result.commit || !result.sql.trim() || result.error !== null || result.checks.length !== spec.criteria.length) return false;
  return spec.criteria.every(criterion => result.checks.some(check => check.name === criterion.name && check.passed &&
    matchesIds(check.expected, criterion.expected) && matchesIds(check.actual, criterion.expected)));
}

const summaryFields = 'id, version, status, createdAt, updatedAt';
type RunRow = PilotSummary & { specJson: string };
type AttemptRow = Omit<PilotAttempt, 'result'> & { resultJson: string | null };

export class PilotLedger {
  private db: Database.Database;

  constructor(filename: string) {
    this.db = new Database(filename);
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('synchronous = FULL');
      this.db.pragma('busy_timeout = 5000');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pilot_runs (
          id TEXT PRIMARY KEY, specJson TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
          createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pilot_attempts (
          id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES pilot_runs(id),
          generation INTEGER NOT NULL, reason TEXT NOT NULL, startedAt TEXT NOT NULL, UNIQUE(runId, generation)
        );
        CREATE TABLE IF NOT EXISTS pilot_endings (
          attemptId TEXT PRIMARY KEY REFERENCES pilot_attempts(id),
          status TEXT NOT NULL CHECK (status IN ('finished','interrupted')),
          finishedAt TEXT NOT NULL, interruptionReason TEXT, resultJson TEXT
        );
        CREATE TABLE IF NOT EXISTS pilot_events (
          runId TEXT NOT NULL REFERENCES pilot_runs(id), version INTEGER NOT NULL,
          action TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL,
          requestId TEXT, attemptId TEXT REFERENCES pilot_attempts(id), PRIMARY KEY(runId, version)
        );
        CREATE TABLE IF NOT EXISTS pilot_receipts (
          requestId TEXT PRIMARY KEY, input TEXT NOT NULL, runId TEXT NOT NULL REFERENCES pilot_runs(id)
        );
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() { this.db.close(); }

  list(): PilotSummary[] {
    return this.db.prepare(`SELECT ${summaryFields} FROM pilot_runs ORDER BY createdAt DESC, rowid DESC`).all() as PilotSummary[];
  }
  get(id: string): PilotDetail | null {
    return this.db.transaction(() => this.detail(id))();
  }
  private detail(id: string): PilotDetail | null {
    const row = this.db.prepare(`SELECT ${summaryFields},specJson FROM pilot_runs WHERE id=?`).get(id) as RunRow | undefined;
    if (!row) return null;
    const { specJson, ...summary } = row;
    const spec: Spec = JSON.parse(specJson);
    const rows = this.db.prepare(`
      SELECT a.id,a.generation,a.reason,a.startedAt,e.finishedAt,e.interruptionReason,e.resultJson,
        COALESCE(e.status,'running') AS status
      FROM pilot_attempts a LEFT JOIN pilot_endings e ON e.attemptId=a.id
      WHERE a.runId=? ORDER BY a.generation
    `).all(id) as AttemptRow[];
    const attempts: PilotAttempt[] = rows.map(({ resultJson, ...attempt }) => ({
      ...attempt, result: resultJson === null ? null : JSON.parse(resultJson),
    }));
    const events = this.db.prepare(`
      SELECT version,action,actor,reason,requestId,attemptId,at FROM pilot_events WHERE runId=? ORDER BY version
    `).all(id) as PilotEvent[];
    const freeze = events.find(event => event.action === 'freeze');
    const frozenBaseline = freeze ? {
      version: freeze.version, frozenAt: freeze.at, specSha256: createHash('sha256').update(specJson).digest('hex'),
    } : null;
    return { ...summary, templateRevision: spec.templateRevision, spec, frozenBaseline, attempts, events,
      returnWillBlock: summary.status === 'review' && attempts.filter(a => a.status === 'finished').length >= maxCompletedRounds,
      canAccept: summary.status === 'review' && qualifies(spec, attempts.at(-1)?.result) };
  }

  private transition(id: string, status: Status, action: PilotEvent['action'], actor: PilotEvent['actor'],
    reason: string, requestId: string | null = null, attemptId: string | null = null) {
    const at = new Date().toISOString();
    this.db.prepare('UPDATE pilot_runs SET status=?,version=version+1,updatedAt=? WHERE id=?').run(status, at, id);
    this.db.prepare(`INSERT INTO pilot_events(runId,version,action,actor,reason,at,requestId,attemptId)
      SELECT id,version,?,?,?,?,?,? FROM pilot_runs WHERE id=?`).run(action, actor, reason, at, requestId, attemptId, id);
  }
  private command(requestId: string, input: string, execute: () => string): { id: string } {
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128) throw new PilotError(400, '请求标识无效');
    const fingerprint = createHash('sha256').update(input).digest('hex');
    return this.db.transaction(() => {
      const receipt = this.db.prepare('SELECT input,runId FROM pilot_receipts WHERE requestId=?').get(requestId) as
        { input: string; runId: string } | undefined;
      if (receipt) {
        if (receipt.input !== fingerprint) throw new PilotError(409, '此请求标识已用于不同操作');
        return { id: receipt.runId };
      }
      const id = execute();
      this.db.prepare('INSERT INTO pilot_receipts(requestId,input,runId) VALUES(?,?,?)').run(requestId, fingerprint, id);
      return { id };
    }).immediate();
  }
  create(requestId: string) {
    return this.command(requestId, 'create', () => {
      const id = randomUUID();
      const at = new Date().toISOString();
      this.db.prepare(`INSERT INTO pilot_runs(id,specJson,status,version,createdAt,updatedAt)
        VALUES(?,?,'draft',0,?,?)`).run(id, JSON.stringify(PILOT_SPEC), at, at);
      this.transition(id, 'draft', 'create', 'owner', '', requestId);
      return id;
    });
  }
  decide(id: string, action: Decision, version: number, reason: string, requestId: string) {
    if (!['freeze','return','accept'].includes(action) || !Number.isSafeInteger(version) || version < 1 ||
        typeof reason !== 'string' || reason.length > 1000 || (action !== 'freeze' && !reason.trim())) {
      throw new PilotError(400, '决定、版本或理由无效');
    }
    return this.command(requestId, JSON.stringify([id, action, version, reason]), () => {
      const run = this.detail(id);
      if (!run) throw new PilotError(404, '找不到试点运行');
      if (run.version !== version) throw new PilotError(409, '审阅版本已过期，请重新核对');
      if (run.status !== (action === 'freeze' ? 'draft' : 'review')) throw new PilotError(409, '当前状态不接受此决定');
      if (action === 'accept' && !run.canAccept) throw new PilotError(422, '当前尝试缺少对应冻结条件的通过证据');
      let status: Status = 'queued';
      if (action === 'accept') status = 'archived';
      if (action === 'return' && run.returnWillBlock) status = 'blocked';
      this.transition(id, status, action, 'owner', reason, requestId, run.attempts.at(-1)?.id);
      return id;
    });
  }
  claim() {
    return this.db.transaction(() => {
      const queued = this.db.prepare("SELECT id FROM pilot_runs WHERE status='queued' ORDER BY updatedAt,rowid LIMIT 1").get() as
        { id: string } | undefined;
      if (!queued) return null;
      const run = this.detail(queued.id)!;
      const reason = [...run.events].reverse().find(event => event.action === 'return')?.reason ?? '';
      const previous = [...run.attempts].reverse().find(a => a.status === 'finished');
      const attemptId = randomUUID();
      this.db.prepare('INSERT INTO pilot_attempts(id,runId,generation,reason,startedAt) VALUES(?,?,?,?,?)')
        .run(attemptId, run.id, run.attempts.length + 1, reason, new Date().toISOString());
      this.transition(run.id, 'running', 'claim', 'service', reason, null, attemptId);
      return { runId: run.id, attemptId, spec: run.spec, reason, previousSql: previous?.result?.sql || null };
    }).immediate();
  }
  private activeRun(attemptId: string) {
    const row = this.db.prepare(`SELECT r.id FROM pilot_attempts a JOIN pilot_runs r ON r.id=a.runId
      LEFT JOIN pilot_endings e ON e.attemptId=a.id WHERE a.id=? AND e.attemptId IS NULL AND r.status='running'`).get(attemptId) as
      { id: string } | undefined;
    return row?.id;
  }
  finish(attemptId: string, result: PilotResult): boolean {
    return this.db.transaction(() => {
      const id = this.activeRun(attemptId);
      if (!id) return false;
      const evidence = readResult(result);
      if (!evidence) return false;
      this.db.prepare(`INSERT INTO pilot_endings(attemptId,status,finishedAt,resultJson) VALUES(?,'finished',?,?)`)
        .run(attemptId, new Date().toISOString(), JSON.stringify(evidence));
      this.transition(id, 'review', 'finish', 'worker', evidence.error ?? '', null, attemptId);
      return true;
    }).immediate();
  }
  interrupt(attemptId: string, reason: string): boolean {
    return this.db.transaction(() => this.endInterrupted(attemptId, reason)).immediate();
  }
  private endInterrupted(attemptId: string, reason: string) {
    const id = this.activeRun(attemptId);
    if (!id) return false;
    this.db.prepare(`INSERT INTO pilot_endings(attemptId,status,finishedAt,interruptionReason) VALUES(?,'interrupted',?,?)`)
      .run(attemptId, new Date().toISOString(), reason);
    const { count } = this.db.prepare(`SELECT count(*) AS count FROM pilot_attempts a JOIN pilot_endings e ON e.attemptId=a.id
      WHERE a.runId=? AND e.status='interrupted'`).get(id) as { count: number };
    this.transition(id, count > maxInterruptionRetries ? 'blocked' : 'queued', 'interrupt', 'service', reason, null, attemptId);
    return true;
  }
  recover() {
    this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT a.id FROM pilot_attempts a LEFT JOIN pilot_endings e ON e.attemptId=a.id
        WHERE e.attemptId IS NULL`).all() as { id: string }[];
      for (const { id } of rows) this.endInterrupted(id, '服务重启，原执行尝试已中断');
    }).immediate();
  }
  archive(id: string) {
    const run = this.get(id);
    if (!run) throw new PilotError(404, '找不到试点运行');
    if (run.status !== 'archived') throw new PilotError(409, '运行尚未验收归档');
    return { formatVersion: 1, ...run };
  }
}
