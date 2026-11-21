import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { checkPilotSql, PILOT_SPEC } from '../pilot/sample.js';
import { readAgentEvidence } from '../workflow/executor.js';
import { assemble, extractPredicate } from './workspace.js';
import type { Role, Task, TaskArtifact, TeamAdmin, TeamAttempt, TeamClaim, TeamDetail,
  TeamEvent, TeamIntegration, TeamMember, TeamProject, TeamResult, TeamSummary } from './contracts.js';

export class TeamError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

const tasks: Task[] = ['dates', 'paid', 'integrate'];
const workLimit = 16;
const maxAttempts = 3;
const supportedSpec = JSON.stringify(PILOT_SPEC);
const activeLease = "julianday(a.startedAt) > julianday('now','-5 minutes')";
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const TEAM_SPEC_HASH = hash(supportedSpec);
const now = () => new Date().toISOString();
const summarySql = `SELECT r.id,r.projectId,r.status,r.version,r.createdAt,r.updatedAt,
  m.id AS memberId,m.name AS memberName FROM runs r JOIN members m ON m.id=r.implementerId`;
type SummaryRow = Omit<TeamSummary,'implementer'> & {memberId: string; memberName: string};
function summary({memberId, memberName, ...row}: SummaryRow): TeamSummary {
  return {...row, implementer: {id: memberId, name: memberName}};
}
function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && value.trim().length > 0;
}
function safeId(value: unknown) {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) && !value.startsWith('smt_') ? value : null;
}
function isCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}
function object(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
function ids(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= 32 && value.every(Number.isSafeInteger);
}
type Scope = {actor: string; action: string; projectId?: string; runId?: string; requestId?: string; attemptId?: string};
type TaskRow = {task: Task; status: TeamDetail['tasks'][number]['status']; generation: number};
type AttemptRow = Omit<TeamAttempt,'result'> & {resultJson: string | null};
type RunData = {specJson: string; decisionJson: string | null; archiveJson: string | null};

// Copy only the evidence fields in the protocol. The child process is an IPC boundary.
function readResult(claim: TeamClaim, input: unknown): TeamResult | null {
  if (!object(input)) return null;
  if (input.kind === 'failure' && bounded(input.error, 1000)) return {kind: 'failure', error: input.error};
  if (input.kind === 'task' && claim.task !== 'integrate') {
    const a = input.artifact;
    if (!object(a) || a.task !== claim.task || a.attemptId !== claim.attemptId || a.generation !== claim.generation ||
        !isCommit(a.commit) || !bounded(a.content, 4096) || /[\r\n]/.test(a.content)) return null;
    try {
      if (extractPredicate(claim.task, a.content) !== a.content) return null;
    } catch { return null; }
    const agent = readAgentEvidence(a.agent);
    if (a.agent !== undefined && !agent) return null;
    return {kind: 'task', artifact: {task: claim.task, attemptId: claim.attemptId, generation: claim.generation,
      commit: a.commit, content: a.content, ...(agent ? {agent} : {})}};
  }
  if (input.kind !== 'integration' || claim.task !== 'integrate') return null;
  const i = input.integration;
  if (!object(i) || !isCommit(i.commit) || !bounded(i.sql, 4096) || !Array.isArray(i.parents) ||
      i.parents.length !== 2 || !i.parents.every(isCommit) || !Array.isArray(i.checks) || i.checks.length > 16) return null;
  const checks: TeamIntegration['checks'] = [];
  for (const c of i.checks) {
    if (!object(c) || !bounded(c.name, 100) || typeof c.passed !== 'boolean' || !ids(c.actual) || !ids(c.expected)) return null;
    checks.push({name: c.name, expected: c.expected, actual: c.actual, passed: c.passed});
  }
  return {kind: 'integration', integration: {commit: i.commit, parents: [...i.parents], sql: i.sql, checks}};
}

function qualifies(spec: TeamDetail['spec'], result: TeamIntegration, artifacts: TeamClaim['inputs']) {
  if (!artifacts || artifacts.dates.commit === artifacts.paid.commit || result.parents.includes(result.commit) ||
      result.parents[0] !== artifacts.dates.commit || result.parents[1] !== artifacts.paid.commit ||
      result.sql !== assemble(artifacts.dates.content, artifacts.paid.content) || result.checks.length !== spec.criteria.length) return false;
  // Verify the retained SQL bytes too, so a passing report cannot cover a different query.
  const same = (left: number[], right: readonly number[]) => left.length === right.length && left.every((x, n) => x === right[n]);
  try {
    const local = checkPilotSql(result.sql);
    return spec.criteria.every(c => [local, result.checks].every(checks => checks.some(check =>
      check.name === c.name && check.passed && same(check.expected, c.expected) && same(check.actual, c.expected))));
  } catch { return false; }
}

export class TeamLedger {
  private db: Database.Database;
  constructor(filename: string) {
    this.db = new Database(filename);
    try {
      this.db.pragma('journal_mode=WAL');
      this.db.pragma('foreign_keys=ON');
      this.db.pragma('synchronous=FULL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,tokenHash TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,lastClaim INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS grants (
          projectId TEXT NOT NULL REFERENCES projects(id),memberId TEXT NOT NULL REFERENCES members(id),
          role TEXT NOT NULL CHECK(role IN ('developer','reviewer','both')), PRIMARY KEY(projectId,memberId));
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),implementerId TEXT NOT NULL REFERENCES members(id),
          specJson TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,
          decisionJson TEXT,archiveJson TEXT);
        CREATE INDEX IF NOT EXISTS team_project_runs ON runs(projectId,status);
        CREATE TABLE IF NOT EXISTS tasks (
          runId TEXT NOT NULL REFERENCES runs(id),task TEXT NOT NULL,status TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(runId,task));
        CREATE TABLE IF NOT EXISTS attempts (
          id TEXT PRIMARY KEY,runId TEXT NOT NULL,task TEXT NOT NULL,generation INTEGER NOT NULL,startedAt TEXT NOT NULL,
          finishedAt TEXT,status TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',resultJson TEXT,
          FOREIGN KEY(runId,task) REFERENCES tasks(runId,task),UNIQUE(runId,task,generation));
        CREATE INDEX IF NOT EXISTS team_live_runs ON runs(projectId,id) WHERE status IN ('queued','running');
        CREATE INDEX IF NOT EXISTS team_queued_tasks ON tasks(runId) WHERE status='queued';
        CREATE INDEX IF NOT EXISTS team_running_tasks ON tasks(runId) WHERE status='running';
        CREATE INDEX IF NOT EXISTS team_running_attempts ON attempts(runId) WHERE status='running';
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY,projectId TEXT,runId TEXT,version INTEGER,at TEXT NOT NULL,actor TEXT NOT NULL,
          action TEXT NOT NULL,reason TEXT NOT NULL,requestId TEXT,attemptId TEXT);
        CREATE INDEX IF NOT EXISTS team_run_events ON events(projectId,runId,id);
        CREATE TABLE IF NOT EXISTS receipts (
          projectId TEXT NOT NULL REFERENCES projects(id),memberId TEXT NOT NULL REFERENCES members(id),requestId TEXT NOT NULL,
          fingerprint TEXT NOT NULL,runId TEXT NOT NULL REFERENCES runs(id),PRIMARY KEY(projectId,memberId,requestId));
      `);
    } catch (e) { this.db.close(); throw e; }
  }
  close() { this.db.close(); }

  private event(s: Scope, reason = '') {
    this.db.prepare(`INSERT INTO events(projectId,runId,version,at,actor,action,reason,requestId,attemptId)
      VALUES (?,?,(SELECT version FROM runs WHERE id=? AND projectId=?),?,?,?,?,?,?)`).run(
      safeId(s.projectId), safeId(s.runId), safeId(s.runId), safeId(s.projectId), now(), safeId(s.actor) ?? 'unknown',
      s.action, reason, safeId(s.requestId), safeId(s.attemptId));
  }
  // Roll back the command's changes on denial, then commit its audit in the outer transaction.
  private guarded<T>(scope: Scope, work: () => T): T {
    const result = this.db.transaction(() => {
      try { return {ok: true as const, value: this.db.transaction(work)()}; }
      catch (error) {
        if (!(error instanceof TeamError)) throw error;
        this.event({...scope, action: scope.action + '.denied'}, error.message);
        return {ok: false as const, error};
      }
    }).immediate();
    if (!result.ok) throw result.error;
    return result.value;
  }
  createMember(rawName: string) {
    return this.guarded({actor: 'owner', action: 'createMember'}, () => {
      const name = this.validName(rawName);
      if (this.db.prepare('SELECT 1 FROM members WHERE name=?').get(name)) throw new TeamError(409, '成员名称已存在');
      const id = randomUUID();
      const token = 'smt_' + randomBytes(32).toString('base64url');
      this.db.prepare('INSERT INTO members VALUES (?,?,?)').run(id, name, hash(token));
      this.event({actor: 'owner', action: 'createMember'}, id);
      return {id, name, token};
    });
  }
  private validName(raw: string) {
    if (!bounded(raw, 80) || [...raw].some(c => c.charCodeAt(0) < 32)) throw new TeamError(400, '名称无效');
    return raw.trim();
  }
  createProject(rawName: string) {
    return this.guarded({actor: 'owner', action: 'createProject'}, () => {
      const name = this.validName(rawName);
      if (this.db.prepare('SELECT 1 FROM projects WHERE name=?').get(name)) throw new TeamError(409, '项目名称已存在');
      const id = randomUUID();
      this.db.prepare('INSERT INTO projects(id,name) VALUES (?,?)').run(id, name);
      this.event({actor: 'owner', action: 'createProject', projectId: id});
      return {id, name};
    });
  }
  member(id: string): TeamMember {
    const row = this.db.prepare('SELECT id,name FROM members WHERE id=?').get(id) as TeamMember | undefined;
    if (!row) throw new TeamError(404, '找不到成员');
    return row;
  }
  authenticate(token: string): string {
    const member = typeof token === 'string' && /^smt_[a-zA-Z0-9_-]{43}$/.test(token) ?
      this.db.prepare('SELECT id FROM members WHERE tokenHash=?').get(hash(token)) as {id: string} | undefined : undefined;
    if (!member) throw new TeamError(401, '需要有效的团队成员凭据');
    return member.id;
  }
  admin(): TeamAdmin {
    return this.db.transaction(() => ({
      members: this.db.prepare('SELECT id,name FROM members ORDER BY name').all() as TeamAdmin['members'],
      projects: this.db.prepare('SELECT id,name FROM projects ORDER BY name').all() as TeamAdmin['projects'],
      grants: this.db.prepare('SELECT projectId,memberId,role FROM grants ORDER BY projectId,memberId').all() as TeamAdmin['grants'],
    }))();
  }
  grant(projectId: string, memberId: string, role: Role | null) {
    const scope = {actor: 'owner', action: 'grant', projectId};
    return this.guarded(scope, () => {
      if (role !== null && !['developer','reviewer','both'].includes(role)) throw new TeamError(400, '角色无效');
      this.member(memberId);
      if (!this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) throw new TeamError(404, '找不到项目');
      if (role) this.db.prepare(`INSERT INTO grants VALUES (?,?,?) ON CONFLICT(projectId,memberId)
        DO UPDATE SET role=excluded.role`).run(projectId, memberId, role);
      else this.db.prepare('DELETE FROM grants WHERE projectId=? AND memberId=?').run(projectId, memberId);
      this.event(scope, memberId + ' ' + (role ?? 'revoked'));
      if (role === null || role === 'reviewer') {
        const active = this.db.prepare(`SELECT id FROM runs WHERE projectId=? AND implementerId=?
          AND status IN ('queued','running')`).all(projectId, memberId) as {id: string}[];
        for (const {id} of active) this.block(projectId, id, '实现责任人的开发授权已撤销', 'owner');
      }
    });
  }
  private authorize(memberId: string, projectId: string, required?: 'developer'|'reviewer'): Role {
    const grant = this.db.prepare('SELECT role FROM grants WHERE projectId=? AND memberId=?').get(projectId, memberId) as
      {role: Role} | undefined;
    if (!grant || (required && grant.role !== required && grant.role !== 'both')) throw new TeamError(403, '缺少此项目所需的授权');
    return grant.role;
  }
  projects(memberId: string): TeamProject[] {
    return this.db.prepare(`SELECT p.id,p.name,g.role FROM projects p JOIN grants g ON p.id=g.projectId
      WHERE g.memberId=? ORDER BY p.name`).all(memberId) as TeamProject[];
  }
  runs(memberId: string, projectId: string) {
    return this.guarded({actor: memberId, action: 'runs', projectId}, () => {
      this.authorize(memberId, projectId);
      return (this.db.prepare(summarySql + ' WHERE r.projectId=? ORDER BY r.rowid DESC').all(projectId) as SummaryRow[]).map(summary);
    });
  }
  private receipt(scope: Scope & {projectId: string; requestId: string}, input: unknown[], work: () => string) {
    if (!safeId(scope.requestId)) throw new TeamError(400, '请求标识无效');
    const key = [scope.projectId, scope.actor, scope.requestId];
    const fingerprint = hash(JSON.stringify(input));
    const old = this.db.prepare('SELECT fingerprint,runId FROM receipts WHERE projectId=? AND memberId=? AND requestId=?').get(...key) as
      {fingerprint: string; runId: string} | undefined;
    if (old) {
      if (old.fingerprint !== fingerprint) throw new TeamError(409, '请求标识已用于不同输入');
      return {id: old.runId};
    }
    const id = work();
    this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?,?)').run(...key, fingerprint, id);
    return {id};
  }
  start(memberId: string, projectId: string, requestId: string, expectedSpecHash: string) {
    const scope = {actor: memberId, projectId, action: 'start', requestId};
    return this.guarded(scope, () => {
      this.authorize(memberId, projectId, 'developer');
      return this.receipt(scope, ['start', expectedSpecHash], () => {
        if (expectedSpecHash !== TEAM_SPEC_HASH) throw new TeamError(409, '规格预览已变，请重新核对冻结内容');
        const count = this.db.prepare(`SELECT count(*) FROM runs WHERE projectId=? AND status IN ('running','queued')`)
          .pluck().get(projectId) as number;
        if (count >= workLimit) throw new TeamError(429, '此项目的待执行运行已满');
        const id = randomUUID();
        const at = now();
        this.db.prepare(`INSERT INTO runs(id,projectId,implementerId,specJson,status,version,createdAt,updatedAt)
          VALUES (?,?,?,?,'queued',1,?,?)`).run(id, projectId, memberId, supportedSpec, at, at);
        const insert = this.db.prepare('INSERT INTO tasks(runId,task,status) VALUES (?,?,?)');
        for (const task of tasks) insert.run(id, task, task === 'integrate' ? 'waiting' : 'queued');
        this.event({...scope, runId: id}, '冻结订单样例规格及两项实现任务');
        return id;
      });
    });
  }

  private attempts(runId: string): TeamAttempt[] {
    const rows = this.db.prepare(`SELECT id,task,generation,startedAt,finishedAt,status,reason,resultJson
      FROM attempts WHERE runId=? ORDER BY rowid`).all(runId) as AttemptRow[];
    return rows.map(({resultJson, ...a}) => ({...a, result: resultJson ? JSON.parse(resultJson) as TeamResult : null}));
  }
  private artifacts(runId: string): TeamClaim['inputs'] {
    const rows = this.db.prepare(`SELECT a.resultJson FROM tasks t JOIN attempts a USING(runId,task,generation)
      WHERE t.runId=? AND t.status='finished' AND t.task IN ('dates','paid')`).pluck().all(runId) as string[];
    const found: Partial<Record<'dates'|'paid', TaskArtifact>> = {};
    for (const row of rows) {
      const result = JSON.parse(row) as TeamResult;
      if (result.kind === 'task') found[result.artifact.task] = result.artifact;
    }
    return found.dates && found.paid ? {dates: found.dates, paid: found.paid} : undefined;
  }
  private detail(projectId: string, runId: string, reviewer?: string): TeamDetail {
    const row = this.db.prepare(summarySql + ' WHERE r.projectId=? AND r.id=?').get(projectId, runId) as SummaryRow | undefined;
    if (!row) throw new TeamError(404, '在此项目找不到运行');
    const run = summary(row);
    const {specJson, decisionJson} = this.db.prepare('SELECT specJson,decisionJson FROM runs WHERE id=?').get(runId) as RunData;
    const spec: TeamDetail['spec'] = JSON.parse(specJson);
    const taskRows = this.db.prepare('SELECT task,status,generation FROM tasks WHERE runId=? ORDER BY rowid').all(runId) as TaskRow[];
    const attempts = this.attempts(runId);
    const integrationTask = taskRows.find(t => t.task === 'integrate');
    const latest = attempts.find(a => a.task === 'integrate' && a.generation === integrationTask?.generation)?.result;
    const integration = latest?.kind === 'integration' ? latest.integration : null;
    const events = this.db.prepare(`SELECT at,actor,action,reason,requestId,attemptId,version FROM events
      WHERE projectId=? AND runId=? ORDER BY id`).all(projectId, runId) as TeamEvent[];
    return {...run, spec, frozenBaseline: {version: 1, frozenAt: run.createdAt, specSha256: hash(specJson)},
      tasks: taskRows.map(t => ({...t, responsible: run.implementer})), attempts, integration, events,
      canAccept: !!reviewer && reviewer !== run.implementer.id && run.status === 'review' &&
        !!integration && qualifies(spec, integration, this.artifacts(runId)),
      decision: decisionJson ? JSON.parse(decisionJson) : null};
  }
  get(memberId: string, projectId: string, runId: string) {
    return this.guarded({actor: memberId, action: 'read', projectId, runId}, () => {
      const role = this.authorize(memberId, projectId);
      return this.detail(projectId, runId, role === 'developer' ? undefined : memberId);
    });
  }
  private transition(scope: Scope & {runId: string}, status: TeamSummary['status'], reason: string) {
    this.db.prepare('UPDATE runs SET status=?,version=version+1,updatedAt=? WHERE id=?').run(status, now(), scope.runId);
    this.event(scope, reason);
  }
  private block(projectId: string, runId: string, reason: string, actor: string) {
    this.db.prepare(`UPDATE attempts SET status='interrupted',finishedAt=?,reason=? WHERE runId=? AND status='running'`)
      .run(now(), reason, runId);
    this.db.prepare("UPDATE tasks SET status='blocked' WHERE runId=? AND status IN ('waiting','running','queued')").run(runId);
    this.transition({projectId, runId, actor, action: 'block'}, 'blocked', reason);
  }
  accept(memberId: string, projectId: string, runId: string, version: number, commit: string, reason: string, requestId: string) {
    const scope = {actor: memberId, projectId, runId, requestId, action: 'accept'};
    return this.guarded(scope, () => {
      this.authorize(memberId, projectId, 'reviewer');
      if (!Number.isSafeInteger(version) || version < 1 || !isCommit(commit) || !bounded(reason, 1000)) {
        throw new TeamError(400, '验收版本、提交或理由无效');
      }
      const run = this.detail(projectId, runId, memberId);
      if (run.implementer.id === memberId) throw new TeamError(403, '本次实现责任人须回避验收');
      return this.receipt(scope, ['accept', runId, version, commit, reason], () => {
        if (version !== run.version || commit !== run.integration?.commit) throw new TeamError(409, '验收目标已变');
        if (!run.canAccept) throw new TeamError(409, '尚无合格的集成证据');
        const decision: TeamDetail['decision'] = {reviewer: this.member(memberId), reason, version, commit, at: now()};
        this.db.prepare('UPDATE runs SET decisionJson=? WHERE id=?').run(JSON.stringify(decision), runId);
        this.transition(scope, 'archived', reason);
        this.db.prepare('UPDATE runs SET archiveJson=? WHERE id=?').run(JSON.stringify(this.detail(projectId, runId)), runId);
        return runId;
      });
    });
  }
  archive(memberId: string, projectId: string, runId: string): TeamDetail {
    return this.guarded({actor: memberId, action: 'archive', projectId, runId}, () => {
      this.authorize(memberId, projectId);
      const row = this.db.prepare('SELECT archiveJson FROM runs WHERE projectId=? AND id=?').get(projectId, runId) as RunData | undefined;
      if (!row) throw new TeamError(404, '在此项目找不到运行');
      if (!row.archiveJson) throw new TeamError(409, '尚未完成验收归档');
      return JSON.parse(row.archiveJson) as TeamDetail;
    });
  }

  private activeClaims(expiredOnly: boolean): TeamClaim[] {
    // A rowid scan satisfies the ordering but reads all historical attempts. Read the bounded active set first.
    return this.db.prepare(`SELECT r.projectId,a.runId,a.id AS attemptId,a.task,a.generation
      FROM attempts a INDEXED BY team_running_attempts JOIN runs r ON r.id=a.runId
      WHERE a.status='running' ${expiredOnly ? 'AND NOT (' + activeLease + ')' : ''} ORDER BY a.rowid`).all() as TeamClaim[];
  }
  private blockUnsupportedRuns() {
    const unsupported = this.db.prepare(`SELECT projectId,id FROM runs WHERE status IN ('queued','running') AND specJson<>?`)
      .all(supportedSpec) as {projectId: string; id: string}[];
    for (const r of unsupported) this.block(r.projectId, r.id, '执行器不支持此运行的冻结规格', 'service');
  }
  recover() {
    this.db.transaction(() => {
      this.blockUnsupportedRuns();
      for (const c of this.activeClaims(false)) this.endInterrupted(c, '服务重启，旧尝试失效');
    }).immediate();
  }
  claim(): TeamClaim | null {
    return this.db.transaction(() => {
      this.blockUnsupportedRuns();
      for (const c of this.activeClaims(true)) this.endInterrupted(c, 'Worker 租约已到期');
      const row = this.db.prepare(`SELECT p.id AS projectId,t.runId,t.task,t.generation FROM tasks t JOIN runs r ON t.runId=r.id
        JOIN projects p ON p.id=r.projectId JOIN grants g ON g.projectId=p.id AND g.memberId=r.implementerId
        WHERE t.status='queued' AND r.status IN ('queued','running') AND g.role IN ('developer','both') AND r.specJson=?
        AND (SELECT count(*) FROM runs other JOIN tasks active ON active.runId=other.id
          WHERE other.projectId=p.id AND other.status IN ('queued','running') AND active.status='running')<2
        ORDER BY p.lastClaim,r.rowid,t.rowid LIMIT 1`).get(supportedSpec) as Omit<TeamClaim,'attemptId'> | undefined;
      if (!row) return null;
      const c: TeamClaim = {...row, generation: row.generation + 1, attemptId: randomUUID()};
      if (c.task === 'integrate') {
        c.inputs = this.artifacts(c.runId);
        if (!c.inputs) throw new Error('集成派工缺少所依赖的任务工件');
      }
      this.db.prepare("UPDATE tasks SET status='running',generation=? WHERE runId=? AND task=?").run(c.generation, c.runId, c.task);
      this.db.prepare(`INSERT INTO attempts(id,runId,task,generation,startedAt,status) VALUES (?,?,?,?,?,'running')`)
        .run(c.attemptId, c.runId, c.task, c.generation, now());
      this.db.prepare('UPDATE projects SET lastClaim=(SELECT MAX(lastClaim)+1 FROM projects) WHERE id=?').run(c.projectId);
      this.transition({...c, actor: 'service', action: 'claim'}, 'running', c.task);
      return c;
    }).immediate();
  }
  isActive(c: TeamClaim): boolean {
    return !!this.db.prepare(`SELECT 1 FROM attempts a JOIN tasks t USING(runId,task,generation) JOIN runs r ON r.id=t.runId
      JOIN grants g ON g.projectId=r.projectId AND g.memberId=r.implementerId WHERE r.projectId=? AND t.runId=? AND t.task=?
      AND a.id=? AND a.generation=? AND a.status='running' AND t.status='running' AND r.status='running'
      AND g.role IN ('developer','both') AND r.specJson=? AND ${activeLease}`).get(
        c.projectId, c.runId, c.task, c.attemptId, c.generation, supportedSpec);
  }
  private endInterrupted(c: TeamClaim, reason: string) {
    const changed = this.db.prepare(`UPDATE attempts SET status='interrupted',finishedAt=?,reason=? WHERE id=? AND status='running'`)
      .run(now(), reason, c.attemptId).changes;
    if (!changed) return;
    if (c.generation >= maxAttempts) {
      this.block(c.projectId, c.runId, '已达到任务尝试次数上限', 'service');
      return;
    }
    this.db.prepare("UPDATE tasks SET status='queued' WHERE runId=? AND task=?").run(c.runId, c.task);
    this.transition({...c, actor: 'service', action: 'interrupt'}, this.workStatus(c.runId), reason);
  }
  private workStatus(runId: string) {
    return this.db.prepare("SELECT 1 FROM tasks WHERE runId=? AND status='running'").get(runId) ? 'running' : 'queued';
  }
  interrupt(c: TeamClaim, reason: string): boolean {
    return this.db.transaction(() => {
      if (!this.isActive(c)) {
        this.event({...c, actor: 'service', action: 'interrupt.denied'}, '尝试范围、代次或租约已失效');
        return false;
      }
      this.endInterrupted(c, bounded(reason, 1000) ? reason : 'Worker 中断');
      return true;
    }).immediate();
  }
  complete(c: TeamClaim, raw: unknown): boolean {
    return this.db.transaction(() => {
      const scope = {...c, actor: 'worker', action: 'finish'};
      const result = this.isActive(c) ? readResult(c, raw) : null;
      if (!result) {
        this.event({...scope, action: 'finish.denied'}, '尝试、代次、租约或证据格式无效');
        return false;
      }
      if (result.kind === 'integration') {
        const input = this.artifacts(c.runId);
        const {parents, commit} = result.integration;
        if (!input || parents.includes(commit) || parents[0] === parents[1] ||
          parents[0] !== input.dates.commit || parents[1] !== input.paid.commit) {
          this.event({...scope, action: 'finish.denied'}, '集成父提交与任务工件不符');
          return false;
        }
      }
      this.db.prepare("UPDATE attempts SET status='finished',finishedAt=?,resultJson=? WHERE id=?")
        .run(now(), JSON.stringify(result), c.attemptId);
      if (result.kind === 'failure') {
        this.event(scope, result.error);
        this.block(c.projectId, c.runId, result.error, 'worker');
      } else if (result.kind === 'integration' && !qualifies(PILOT_SPEC, result.integration, this.artifacts(c.runId))) {
        this.event(scope, '已记录集成证据');
        this.block(c.projectId, c.runId, '集成证据未满足冻结条件或未对应两项任务工件', 'service');
      } else {
        this.db.prepare("UPDATE tasks SET status='finished' WHERE runId=? AND task=?").run(c.runId, c.task);
        if (result.kind === 'task' && this.artifacts(c.runId)) {
          this.db.prepare("UPDATE tasks SET status='queued' WHERE runId=? AND task='integrate' AND status='waiting'").run(c.runId);
        }
        this.transition(scope, result.kind === 'integration' ? 'review' : this.workStatus(c.runId), c.task);
      }
      return true;
    }).immediate();
  }
}
