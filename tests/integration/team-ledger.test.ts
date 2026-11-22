import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPilotSql, PILOT_SPEC } from '../../src/server/pilot/sample.js';
import type { RepositoryConfig, RepositoryEvidence, TeamClaim, TeamIntegration } from '../../src/server/team/contracts.js';
import { TeamLedger, TEAM_SPEC_HASH } from '../../src/server/team/ledger.js';
import { assemble } from '../../src/server/team/workspace.js';
import { repositoryChecks } from '../../src/server/team/repository.js';

let dir: string;
let ledger: TeamLedger;
let developer: string;
let reviewer: string;
let project: string;
const dates = 'order_date BETWEEN :start_date AND :end_date';
const paid = "status = 'paid'";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'specmill-team-ledger-'));
  ledger = new TeamLedger(join(dir, 'team.sqlite'));
  developer = ledger.createMember('Ada').id;
  reviewer = ledger.createMember('Lin').id;
  project = ledger.createProject('Orders').id;
  ledger.grant(project, developer, 'both');
  ledger.grant(project, reviewer, 'reviewer');
});
afterEach(() => {
  ledger.close();
  rmSync(dir, {recursive: true, force: true});
});

function task(c: TeamClaim) {
  const isDate = c.task === 'dates';
  return {kind: 'task', artifact: {task: c.task, attemptId: c.attemptId, generation: c.generation,
    commit: (isDate ? 'a' : 'b').repeat(40), content: isDate ? dates : paid}};
}
function integrate() {
  for (let i = 0; i < 2; i++) {
    const c = ledger.claim()!;
    expect(ledger.complete(c, task(c))).toBe(true);
  }
  const c = ledger.claim()!;
  const sql = assemble(dates, paid);
  const integration: TeamIntegration = {commit: 'c'.repeat(40),
    parents: [c.inputs!.dates.commit, c.inputs!.paid.commit], sql, checks: checkPilotSql(sql)};
  return {c, integration};
}

function repositoryConfig(): RepositoryConfig {
  return {projectId: project, source: join(dir, 'approved-source'), spec: {
    kind: 'repository-v1', title: 'Build instructions', requirement: 'Explain the build command in CONTRIBUTING.',
    baseCommit: '1'.repeat(40), path: 'docs/CONTRIBUTING.md', checks: [
      {name: 'Build command', text: 'npm run build', present: true},
      {name: 'No obsolete command', text: 'npm run bundle', present: false},
    ],
  }};
}

function reopen(config?: RepositoryConfig) {
  ledger.close();
  ledger = new TeamLedger(join(dir, 'team.sqlite'), config);
  ledger.recover();
}

function startRepository(requestId: string) {
  const preview = ledger.projects(developer).find(p => p.id === project)?.repository;
  expect(preview).toBeDefined();
  return ledger.start(developer, project, requestId, preview!.specHash).id;
}

function repositoryEvidence(claim: TeamClaim, content: string): RepositoryEvidence {
  const {spec} = claim.repository!;
  return {commit: String(claim.generation + 1).repeat(40), parent: spec.baseCommit, path: spec.path, content,
    contentSha256: createHash('sha256').update(content).digest('hex'), checks: repositoryChecks(spec, content)};
}

describe('具名团队台账', () => {
  it('只保存成员凭据摘要，读取与幂等命令受当前项目角色约束', () => {
    const guest = ledger.createMember('Moe');
    expect(ledger.authenticate(guest.token)).toBe(guest.id);
    expect(() => ledger.authenticate(guest.token + 'x')).toThrow();
    expect(() => ledger.createMember(' Moe ')).toThrow();
    const db = new Database(join(dir, 'team.sqlite'), {readonly: true});
    try {
      const stored = db.prepare('SELECT * FROM members WHERE id=?').get(guest.id);
      expect(stored).toMatchObject({id: guest.id, tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/)});
      expect(JSON.stringify(stored)).not.toContain(guest.token);
    } finally { db.close(); }
    expect(JSON.stringify(ledger.admin())).not.toContain('token');
    expect(ledger.projects(guest.id)).toEqual([]);
    const other = ledger.createProject('Other').id;
    ledger.grant(other, guest.id, 'developer');
    const run = ledger.start(developer, project, 'same', TEAM_SPEC_HASH);
    const second = ledger.start(guest.id, other, 'same', TEAM_SPEC_HASH);
    expect(run.id).not.toBe(second.id);
    expect(ledger.start(developer, project, 'same', TEAM_SPEC_HASH)).toEqual(run);
    expect(() => ledger.get(guest.id, project, run.id)).toThrow();
    expect(() => ledger.get(guest.id, other, run.id)).toThrow();
    expect(() => ledger.archive(guest.id, project, run.id)).toThrow();
    expect(() => ledger.start(reviewer, project, 'same', TEAM_SPEC_HASH)).toThrow();
    expect(ledger.runs(developer, project)).toHaveLength(1);
    ledger.grant(project, developer, null);
    expect(() => ledger.start(developer, project, 'same', TEAM_SPEC_HASH)).toThrow();
    expect(ledger.get(reviewer, project, run.id).events).toEqual(expect.arrayContaining([
      expect.objectContaining({actor: guest.id, action: 'read.denied'}),
    ]));
  });

  it('按项目轮转领取并执行各自两个任务的配额，运行队列有上限', () => {
    const other = ledger.createProject('Second').id;
    ledger.grant(other, developer, 'developer');
    const first = ledger.start(developer, project, '1', TEAM_SPEC_HASH);
    ledger.start(developer, project, '2', TEAM_SPEC_HASH);
    const next = ledger.start(developer, other, '1', TEAM_SPEC_HASH);
    const secondConnection = new TeamLedger(join(dir, 'team.sqlite'));
    try {
      const claims = [ledger.claim()!, secondConnection.claim()!, ledger.claim()!, secondConnection.claim()!];
      expect(claims.map(c => c.runId)).toEqual([first.id, next.id, first.id, next.id]);
      expect(claims.map(c => c.task)).toEqual(['dates','dates','paid','paid']);
      expect(ledger.claim()).toBeNull();
      expect(new Set(claims.map(c => c.attemptId)).size).toBe(4);
      for (let i = 3; i <= 16; i++) ledger.start(developer, project, String(i), TEAM_SPEC_HASH);
      expect(() => ledger.start(developer, project, 'overflow', TEAM_SPEC_HASH)).toThrow();
      expect(ledger.start(developer, project, '1', TEAM_SPEC_HASH)).toEqual(first);
    } finally { secondConnection.close(); }
  });

  it('冻结必须提交当前预览摘要，请求回执按该摘要区分', () => {
    const stale = '0'.repeat(64);
    expect(() => ledger.start(developer, project, 'freeze', stale)).toThrow('规格预览已变');
    expect(ledger.runs(developer, project)).toEqual([]);
    const {id} = ledger.start(developer, project, 'freeze', TEAM_SPEC_HASH);
    expect(ledger.get(developer, project, id).frozenBaseline.specSha256).toBe(TEAM_SPEC_HASH);
    expect(() => ledger.start(developer, project, 'freeze', stale)).toThrow('请求标识已用于不同输入');
    expect(ledger.start(developer, project, 'freeze', TEAM_SPEC_HASH)).toEqual({id});
  });

  it('派工先阻断不支持的冻结规格，继续领取匹配的排队运行', () => {
    const legacy = ledger.start(developer, project, 'legacy', TEAM_SPEC_HASH).id;
    const current = ledger.start(developer, project, 'current', TEAM_SPEC_HASH).id;
    const fixture = new Database(join(dir, 'team.sqlite'));
    try {
      fixture.prepare('UPDATE runs SET specJson=? WHERE id=?').run(JSON.stringify({...PILOT_SPEC, templateRevision: 'old'}), legacy);
      expect(ledger.claim()).toMatchObject({runId: current, task: 'dates'});
      expect(ledger.get(reviewer, project, legacy)).toMatchObject({status: 'blocked', attempts: []});
    } finally { fixture.close(); }
  });

  it('开发角色变化原子终止已领和排队的工作，重新授予角色不会复活旧尝试', () => {
    const run = ledger.start(developer, project, 'run', TEAM_SPEC_HASH);
    const queued = ledger.start(developer, project, 'queued', TEAM_SPEC_HASH);
    const a = ledger.claim()!;
    const b = ledger.claim()!;
    ledger.grant(project, developer, 'reviewer');
    expect(ledger.isActive(a)).toBe(false);
    ledger.grant(project, developer, 'both');
    expect(ledger.claim()).toBeNull();
    expect(ledger.complete(a, task(a))).toBe(false);
    expect(ledger.interrupt(b, '迟到')).toBe(false);
    for (const id of [run.id, queued.id]) expect(ledger.get(reviewer, project, id).status).toBe('blocked');
    const detail = ledger.get(reviewer, project, run.id);
    expect(detail.attempts.every(a => a.finishedAt && a.status === 'interrupted' && !a.result)).toBe(true);
    expect(detail.events.slice(-2).map(e => e.action)).toEqual(['finish.denied', 'interrupt.denied']);
    expect(() => ledger.archive(developer, project, run.id)).toThrow();
  });

  it('拒绝交叉节点、代次、任务和父提交，对重启后的当前代次保留独立尝试记录', () => {
    const {id} = ledger.start(developer, project, 'new', TEAM_SPEC_HASH);
    const old = ledger.claim()!;
    ledger.close();
    ledger = new TeamLedger(join(dir, 'team.sqlite'));
    ledger.recover();
    ledger.recover();
    const dates = ledger.claim()!;
    const paid = ledger.claim()!;
    expect(dates).toMatchObject({task: old.task, generation: old.generation + 1});
    expect(ledger.complete(old, task(old))).toBe(false);
    expect(ledger.complete({...dates, projectId: 'elsewhere'}, task(dates))).toBe(false);
    expect(ledger.complete({...dates, task: 'paid'}, task(dates))).toBe(false);
    expect(ledger.complete(dates, task(old))).toBe(false);
    expect(ledger.complete(dates, task(paid))).toBe(false);
    expect(ledger.complete(dates, task(dates))).toBe(true);
    expect(ledger.claim()).toBeNull();
    expect(ledger.complete(paid, task(paid))).toBe(true);
    const integration = ledger.claim()!;
    expect(integration.inputs!.dates.attemptId).toBe(dates.attemptId);
    const swap = [integration.inputs!.paid.commit, integration.inputs!.dates.commit];
    expect(ledger.complete(integration, {kind: 'integration', integration: {
      commit: 'c'.repeat(40), parents: swap, sql: 'SELECT id FROM orders', checks: [],
    }})).toBe(false);
    expect(ledger.isActive(integration)).toBe(true);
    for (let i = 0; i < 3; i++) {
      const current = i === 0 ? integration : ledger.claim()!;
      expect(ledger.interrupt(current, 'Worker 退出')).toBe(true);
    }
    expect(ledger.claim()).toBeNull();
    expect(ledger.get(reviewer, project, id).status).toBe('blocked');
  });

  it.each(['failed', 'actual', 'expected', 'duplicate', 'sql', 'artifact'] as const)(
    '保存集成结果但拒绝不合格证据 %s', variant => {
      const {id} = ledger.start(developer, project, 'start', TEAM_SPEC_HASH);
      const {c, integration} = integrate();
      if (variant === 'failed') integration.checks[0].passed = false;
      if (variant === 'actual') integration.checks[0].actual = [];
      if (variant === 'expected') integration.checks[0].expected = [];
      if (variant === 'duplicate') integration.checks[1] = integration.checks[0];
      if (variant === 'sql') integration.sql = 'SELECT id FROM orders';
      if (variant === 'artifact') integration.sql = integration.sql.toLowerCase();
      expect(ledger.complete(c, {kind: 'integration', integration})).toBe(true);
      const detail = ledger.get(reviewer, project, id);
      expect(detail).toMatchObject({status: 'blocked', canAccept: false, integration});
      expect(() => ledger.accept(reviewer, project, id, detail.version, integration.commit, '检查', 'accept')).toThrow();
      expect(() => ledger.archive(developer, project, id)).toThrow();
    });

  it('用数据库时钟拒绝过期租约，旧规格在服务重启后转为阻断', () => {
    const {id} = ledger.start(developer, project, 'new', TEAM_SPEC_HASH);
    const old = ledger.claim()!;
    const fixture = new Database(join(dir, 'team.sqlite'));
    try {
      fixture.prepare('UPDATE attempts SET startedAt=? WHERE id=?').run('2000-01-01T00:00:00Z', old.attemptId);
      expect(ledger.isActive(old)).toBe(false);
      expect(ledger.complete(old, task(old))).toBe(false);
      const retry = ledger.claim()!;
      expect(retry).toMatchObject({task: old.task, generation: 2});
      fixture.prepare('UPDATE runs SET specJson=? WHERE id=?').run(JSON.stringify({...PILOT_SPEC, templateRevision: 'previous'}), id);
      expect(ledger.isActive(retry)).toBe(false);
      ledger.recover();
      expect(ledger.claim()).toBeNull();
      expect(ledger.get(reviewer, project, id)).toMatchObject({status: 'blocked',
        spec: {templateRevision: 'previous'}, attempts: [{status: 'interrupted'}, {status: 'interrupted'}]});
    } finally { fixture.close(); }
  });

  it('仅独立审批人可接受所见目标，已归档的字节与成员授权独立', () => {
    const {id} = ledger.start(developer, project, 'new', TEAM_SPEC_HASH);
    const {c, integration} = integrate();
    expect(ledger.complete(c, {kind: 'integration', integration})).toBe(true);
    const review = ledger.get(reviewer, project, id);
    expect(review.canAccept).toBe(true);
    ledger.grant(project, developer, 'reviewer');
    expect(ledger.get(developer, project, id).canAccept).toBe(false);
    const accept = (who: string, version: number, commit: string, reason = '逐项核对') =>
      ledger.accept(who, project, id, version, commit, reason, 'decision');
    expect(() => accept(developer, review.version, integration.commit)).toThrow();
    expect(() => accept(reviewer, review.version - 1, integration.commit)).toThrow();
    expect(() => accept(reviewer, review.version, 'd'.repeat(40))).toThrow();
    expect(accept(reviewer, review.version, integration.commit)).toEqual({id});
    expect(accept(reviewer, review.version, integration.commit)).toEqual({id});
    expect(() => accept(reviewer, review.version, integration.commit, '其他理由')).toThrow();
    const archive = ledger.archive(reviewer, project, id);
    expect(archive).toMatchObject({status: 'archived', spec: PILOT_SPEC, integration,
      implementer: {id: developer, name: 'Ada'}, decision: {reviewer: {id: reviewer, name: 'Lin'}, version: review.version}});
    expect(archive.attempts.every(a => a.startedAt && a.finishedAt && a.result)).toBe(true);
    ledger.grant(project, reviewer, null);
    expect(() => accept(reviewer, review.version, integration.commit)).toThrow();
    expect(() => ledger.archive(reviewer, project, id)).toThrow();
    ledger.close();
    ledger = new TeamLedger(join(dir, 'team.sqlite'));
    ledger.recover();
    expect(ledger.archive(developer, project, id)).toEqual(archive);
  });
});

describe('真实仓库试点台账', () => {
  it('只在固定且授权的项目展示预览，冻结后复用精确规格，既有样例继续执行', () => {
    const sample = ledger.start(developer, project, 'sample', TEAM_SPEC_HASH).id;
    const other = ledger.createProject('Other').id;
    const guest = ledger.createMember('Moe').id;
    ledger.grant(other, guest, 'developer');
    const config = repositoryConfig();
    const expected = structuredClone(config.spec);
    reopen(config);
    expect(ledger.projects(guest)).toEqual([{id: other, name: 'Other', role: 'developer'}]);
    const [preview] = ledger.projects(developer);
    expect(preview.repository?.spec).toEqual(expected);
    expect(preview.repository?.specHash).toBe(createHash('sha256').update(JSON.stringify(expected)).digest('hex'));
    expect(JSON.stringify(preview)).not.toContain('approved-source');
    expect(() => ledger.start(reviewer, project, 'freeze', preview.repository!.specHash)).toThrow('授权');
    expect(() => ledger.start(developer, project, 'freeze', TEAM_SPEC_HASH)).toThrow('规格预览已变');
    config.spec.requirement = 'Mutated caller object';
    preview.repository!.spec.path = 'mutated-preview.md';
    const id = startRepository('freeze');
    expect(ledger.get(developer, project, id)).toMatchObject({spec: expected, repositoryEvidence: null, returns: [],
      frozenBaseline: {version: 1, specSha256: preview.repository?.specHash},
      tasks: [{task: 'repository', status: 'queued', generation: 0}]});
    expect(ledger.claim()).toMatchObject({runId: sample, task: 'dates'});
    expect(ledger.claim()).toMatchObject({runId: sample, task: 'paid'});
  });

  it('将失败的确定性检查交给审核，按精确版本退回、恢复后复测并归档两轮证据', () => {
    const config = repositoryConfig();
    reopen(config);
    const id = startRepository('freeze');
    const first = ledger.claim()!;
    expect(first).toMatchObject({task: 'repository', generation: 1, repository: {source: config.source, spec: config.spec}});
    expect(first.repository?.previous).toBeUndefined();
    const failed = repositoryEvidence(first, 'Use npm run bundle.');
    const finish = (claim: TeamClaim, evidence: RepositoryEvidence) => ledger.complete(claim, {kind: 'repository', evidence});
    const forgedClaim = {...first, repository: {...first.repository!, spec: {...config.spec, path: 'elsewhere.md'}}};
    expect(finish(forgedClaim, {...failed, path: 'elsewhere.md'})).toBe(false);
    expect(finish(first, {...failed, parent: 'a'.repeat(40)})).toBe(false);
    expect(finish(first, {...failed, contentSha256: '0'.repeat(64)})).toBe(false);
    expect(finish(first, {...failed, checks: failed.checks.map(c => ({...c, passed: true}))})).toBe(false);
    expect(finish(first, repositoryEvidence(first, '你'.repeat(1400)))).toBe(false);
    expect(finish(first, failed)).toBe(true);
    const review = ledger.get(reviewer, project, id);
    expect(review).toMatchObject({status: 'review', canAccept: false, canReturn: true, repositoryEvidence: failed});
    expect(() => ledger.accept(reviewer, project, id, review.version, failed.commit, '检查未过', 'accept-1')).toThrow('证据');
    const reason = '请删除旧命令并记录构建命令。';
    const returnRun = (who = reviewer, version = review.version, commit = failed.commit, why = reason) =>
      ledger.returnForRework(who, project, id, version, commit, why, 'return-1');
    expect(() => returnRun(developer)).toThrow('回避');
    expect(() => returnRun(reviewer, review.version - 1)).toThrow('目标已变');
    expect(() => returnRun(reviewer, review.version, 'a'.repeat(40))).toThrow('目标已变');
    expect(() => returnRun(reviewer, review.version, failed.commit, '   ')).toThrow('理由无效');
    expect(returnRun()).toEqual({id});
    expect(returnRun()).toEqual({id});
    expect(() => returnRun(reviewer, review.version, failed.commit, '更改理由')).toThrow('请求标识已用于不同输入');
    const queued = ledger.get(reviewer, project, id);
    expect(queued).toMatchObject({status: 'queued', repositoryEvidence: null, canReturn: false, canAccept: false,
      returns: [{reviewer: {id: reviewer, name: 'Lin'}, reason, commit: failed.commit, version: review.version}],
      attempts: [{id: first.attemptId, status: 'finished', result: {kind: 'repository', evidence: failed}}]});
    expect(queued.events.filter(e => e.action === 'return')).toEqual([
      expect.objectContaining({actor: reviewer, reason, requestId: 'return-1', attemptId: first.attemptId}),
    ]);
    ledger.grant(project, reviewer, null);
    expect(() => returnRun()).toThrow('授权');
    ledger.grant(project, reviewer, 'reviewer');
    reopen(config);
    const second = ledger.claim()!;
    expect(second).toMatchObject({runId: id, generation: 2,
      repository: {previous: {commit: failed.commit, content: failed.content, reason}}});
    const passed = repositoryEvidence(second, '构建：npm run build\n');
    expect(finish(first, failed)).toBe(false);
    expect(finish(second, {...passed, commit: failed.commit})).toBe(false);
    expect(finish(second, passed)).toBe(true);
    const retested = ledger.get(reviewer, project, id);
    expect(retested).toMatchObject({status: 'review', canAccept: true, canReturn: true, repositoryEvidence: passed,
      returns: queued.returns, frozenBaseline: review.frozenBaseline,
      attempts: [{id: first.attemptId}, {id: second.attemptId, result: {kind: 'repository', evidence: passed}}]});
    expect(() => ledger.accept(reviewer, project, id, review.version, failed.commit, '旧验收', 'accept-2')).toThrow('目标已变');
    expect(ledger.accept(reviewer, project, id, retested.version, passed.commit, '复测通过', 'accept-2')).toEqual({id});
    const archived = ledger.archive(developer, project, id);
    expect(archived).toMatchObject({status: 'archived', spec: config.spec, repositoryEvidence: passed, returns: queued.returns,
      decision: {reviewer: {id: reviewer, name: 'Lin'}, version: retested.version, commit: passed.commit, reason: '复测通过'}});
    reopen();
    expect(ledger.archive(developer, project, id)).toEqual(archived);
  });

  it('退回受排队配额限制，服务中断和重派合计最多三次，末次退回保留理由', () => {
    const config = repositoryConfig();
    reopen(config);
    const id = startRepository('freeze');
    const first = ledger.claim()!;
    const failed = repositoryEvidence(first, 'Old build command');
    expect(ledger.complete(first, {kind: 'repository', evidence: failed})).toBe(true);
    const initial = ledger.get(reviewer, project, id);
    for (let i = 0; i < 16; i++) startRepository(`fill-${i}`);
    const returnInitial = () => ledger.returnForRework(reviewer, project, id, initial.version, failed.commit, '命令不符', 'return-1');
    expect(returnInitial).toThrow('已满');
    expect(ledger.get(reviewer, project, id)).toMatchObject({version: initial.version, status: 'review', returns: []});
    const other = ledger.claim()!;
    expect(ledger.complete(other, {kind: 'failure', error: 'Worker rejected output'})).toBe(true);
    expect(returnInitial()).toEqual({id});
    const interrupted = ledger.claim()!;
    expect(interrupted).toMatchObject({runId: id, generation: 2});
    reopen(config);
    const third = ledger.claim()!;
    expect(third).toMatchObject({runId: id, generation: 3, repository: {previous: interrupted.repository!.previous}});
    const late = {kind: 'repository', evidence: repositoryEvidence(interrupted, 'Use npm run build.')};
    expect(ledger.complete(interrupted, late)).toBe(false);
    const result = repositoryEvidence(third, 'Still no command');
    expect(ledger.complete(third, {kind: 'repository', evidence: result})).toBe(true);
    const last = ledger.get(reviewer, project, id);
    expect(last.canReturn).toBe(true);
    expect(ledger.returnForRework(reviewer, project, id, last.version, result.commit, '仍缺构建命令', 'return-2')).toEqual({id});
    const blocked = ledger.get(reviewer, project, id);
    expect(blocked).toMatchObject({status: 'blocked', canReturn: false, canAccept: false, repositoryEvidence: result,
      returns: [{commit: failed.commit}, {commit: result.commit, reason: '仍缺构建命令', version: last.version}],
      attempts: [{status: 'finished'}, {status: 'interrupted'}, {status: 'finished'}]});
    expect(blocked.events.at(-1)).toMatchObject({action: 'block', reason: '审核已退回，且已达到任务尝试次数上限'});
    expect(ledger.claim()?.runId).not.toBe(id);
  });

  it.each(['disabled', 'new-source', 'new-spec', 'altered-frozen-spec'] as const)(
    '阻断配置失配的待执行真实运行，保留审核和无关样例 %s', change => {
      const config = repositoryConfig();
      reopen(config);
      const reviewId = startRepository('review');
      const reviewClaim = ledger.claim()!;
      const evidence = repositoryEvidence(reviewClaim, 'Use npm run build.');
      expect(ledger.complete(reviewClaim, {kind: 'repository', evidence})).toBe(true);
      const pendingId = startRepository('pending');
      const claim = ledger.claim()!;
      expect(claim.runId).toBe(pendingId);
      const other = ledger.createProject('Sample').id;
      ledger.grant(other, developer, 'developer');
      const sample = ledger.start(developer, other, 'sample', TEAM_SPEC_HASH).id;
      if (change === 'new-source') config.source += '-moved';
      if (change === 'new-spec') config.spec.requirement += ' Change.';
      if (change === 'altered-frozen-spec') {
        const fixture = new Database(join(dir, 'team.sqlite'));
        try {
          fixture.prepare('UPDATE runs SET specJson=? WHERE id IN (?,?)').run(JSON.stringify(PILOT_SPEC), pendingId, reviewId);
        } finally { fixture.close(); }
      }
      reopen(change === 'disabled' ? undefined : config);
      expect(ledger.get(reviewer, project, pendingId)).toMatchObject({status: 'blocked', attempts: [{status: 'interrupted'}]});
      expect(ledger.complete(claim, {kind: 'repository', evidence})).toBe(false);
      expect(ledger.claim()).toMatchObject({runId: sample, task: 'dates'});
      const review = ledger.get(reviewer, project, reviewId);
      expect(review).toMatchObject({status: 'review', repositoryEvidence: evidence, canAccept: false, canReturn: false});
      expect(() => ledger.accept(reviewer, project, reviewId, review.version, evidence.commit, '旧配置', 'accept')).toThrow('证据');
      expect(() => ledger.returnForRework(reviewer, project, reviewId, review.version, evidence.commit, '旧配置', 'return')).toThrow('无法退回');
    });
});
