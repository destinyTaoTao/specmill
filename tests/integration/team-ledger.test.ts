import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPilotSql, PILOT_SPEC } from '../../src/server/pilot/sample.js';
import type { TeamClaim, TeamIntegration } from '../../src/server/team/contracts.js';
import { TeamLedger, TEAM_SPEC_HASH } from '../../src/server/team/ledger.js';
import { assemble } from '../../src/server/team/workspace.js';

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
