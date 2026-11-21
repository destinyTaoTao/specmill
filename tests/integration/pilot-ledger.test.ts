import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PilotLedger } from '../../src/server/pilot/ledger.js';
import { PILOT_SPEC, type PilotResult } from '../../src/server/pilot/sample.js';

let dir: string;
let ledger: PilotLedger;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'specmill-pilot-ledger-'));
  ledger = new PilotLedger(join(dir, 'pilot.sqlite'));
});
afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

function report(): PilotResult {
  return {
    commit: '1'.repeat(40), sql: 'SELECT id FROM orders ORDER BY id', error: null,
    checks: PILOT_SPEC.criteria.map(({ name, expected }) =>
      ({ name, expected: [...expected], actual: [...expected], passed: true })),
  };
}
function start() {
  const { id } = ledger.create('new');
  ledger.decide(id, 'freeze', 1, '已核对条件', 'freeze');
  return { id, job: ledger.claim()! };
}
function decide(id: string, action: 'accept' | 'return', requestId: string) {
  return ledger.decide(id, action, ledger.get(id)!.version, '人工核对', requestId);
}

describe('isolated pilot ledger', () => {
  it('replays immutable receipts, rejects conflicting inputs and gates the first claim', () => {
    const { id } = ledger.create('new');
    expect(ledger.create('new')).toEqual({ id });
    expect(ledger.claim()).toBeNull();
    expect(() => ledger.archive(id)).toThrow();
    expect(() => ledger.decide(id, 'freeze', 1, '', 'new')).toThrow();
    expect(() => ledger.decide(id, 'freeze', 2, '', 'stale')).toThrow();
    expect(ledger.get(id)!.version).toBe(1);
    ledger.decide(id, 'freeze', 1, '冻结', 'freeze');
    const other = new PilotLedger(join(dir, 'pilot.sqlite'));
    try {
      const job = other.claim();
      expect(job?.runId).toBe(id);
      expect(ledger.claim()).toBeNull();
      expect(ledger.decide(id, 'freeze', 1, '冻结', 'freeze')).toEqual({ id });
      expect(() => ledger.decide(id, 'freeze', 1, '改写理由', 'freeze')).toThrow();
      expect(ledger.get(id)!.events.map(event => event.action)).toEqual(['create', 'freeze', 'claim']);
    } finally {
      other.close();
    }
  });

  it('uses frozen expectations and retains evidence from every human review round', () => {
    const { id, job } = start();
    const misleading = report();
    misleading.checks[0].expected = [99];
    misleading.checks[0].actual = [99];
    expect(ledger.finish(job.attemptId, misleading)).toBe(true);
    expect(() => decide(id, 'accept', 'deny')).toThrow();
    const reviewedVersion = ledger.get(id)!.version;
    expect(() => ledger.decide(id, 'return', reviewedVersion, ' ', 'empty')).toThrow();
    decide(id, 'return', 'return');
    const next = ledger.claim()!;
    expect(next).toMatchObject({ runId: id, reason: '人工核对', previousSql: misleading.sql });
    expect(next.attemptId).not.toBe(job.attemptId);
    expect(ledger.finish(job.attemptId, report())).toBe(false);
    expect(ledger.finish(next.attemptId, report())).toBe(true);
    expect(() => ledger.decide(id, 'accept', reviewedVersion, '旧预览', 'old')).toThrow();
    expect(() => ledger.decide(id, 'accept', ledger.get(id)!.version, '', 'empty-accept')).toThrow();
    decide(id, 'accept', 'accept');
    const archive = ledger.archive(id);
    expect(archive.spec).toEqual(PILOT_SPEC);
    expect(archive.frozenBaseline).toMatchObject({
      version: 2, specSha256: createHash('sha256').update(JSON.stringify(PILOT_SPEC)).digest('hex'),
    });
    expect(archive.attempts.map(attempt => attempt.result)).toEqual([misleading, report()]);
    expect(archive.events.at(-1)).toMatchObject({ action: 'accept', attemptId: next.attemptId, actor: 'owner' });
    ledger.close();
    ledger = new PilotLedger(join(dir, 'pilot.sqlite'));
    ledger.recover();
    expect(ledger.archive(id)).toEqual(archive);
    expect(ledger.list()).toHaveLength(1);
  });

  it('isolates grants between runs and preserves revision instructions across a worker retry', () => {
    const { id, job } = start();
    const { id: other } = ledger.create('second-run');
    ledger.decide(other, 'freeze', 1, '', 'freeze-second');
    const otherJob = ledger.claim()!;
    ledger.finish(job.attemptId, report());
    decide(id, 'return', 'rework');
    const rework = ledger.claim()!;
    ledger.interrupt(rework.attemptId, 'worker exited');
    const retry = ledger.claim()!;
    expect(retry).toMatchObject({ runId: id, reason: '人工核对', previousSql: report().sql, spec: PILOT_SPEC });
    expect(retry.attemptId).not.toBe(rework.attemptId);
    expect(ledger.finish(rework.attemptId, report())).toBe(false);
    expect(ledger.get(id)!.attempts.map(a => a.status)).toEqual(['finished', 'interrupted', 'running']);
    expect(ledger.get(other)).toMatchObject({ status: 'running', attempts: [{ id: otherJob.attemptId }] });
  });

  it('retains the local freeze note only in decision history across the initial dispatch and retry', () => {
    const note = 'local-only research note';
    const { id } = ledger.create('new');
    ledger.decide(id, 'freeze', 1, note, 'freeze');
    const first = ledger.claim()!;
    expect(JSON.stringify(first)).not.toContain(note);
    ledger.interrupt(first.attemptId, 'worker exited');
    expect(JSON.stringify(ledger.claim())).not.toContain(note);
    const detail = ledger.get(id)!;
    expect(detail.events.filter(event => event.reason === note).map(event => event.action)).toEqual(['freeze']);
    expect(detail.attempts.every(attempt => attempt.reason === '')).toBe(true);
  });

  it.each(['missing', 'duplicated', 'failed', 'wrong-actual', 'error', 'no-commit'] as const)(
    'keeps %s evidence pending human review', variant => {
      const { id, job } = start();
      const result = report();
      if (variant === 'missing') result.checks.pop();
      if (variant === 'duplicated') result.checks[1] = result.checks[0];
      if (variant === 'failed') result.checks[0].passed = false;
      if (variant === 'wrong-actual') result.checks[0].actual = [];
      if (variant === 'error') result.error = '脚本未正常退出';
      if (variant === 'no-commit') result.commit = null;
      expect(ledger.finish(job.attemptId, result)).toBe(true);
      expect(ledger.get(id)).toMatchObject({ status: 'review', canAccept: false });
      expect(() => decide(id, 'accept', 'accept')).toThrow();
    });

  it('fences invalid and late output, recovers running grants once, and bounds restarts', () => {
    const { id, job } = start();
    expect(ledger.finish(job.attemptId, { ...report(), checks: [null] } as unknown as PilotResult)).toBe(false);
    expect(ledger.get(id)!.status).toBe('running');
    ledger.close();
    ledger = new PilotLedger(join(dir, 'pilot.sqlite'));
    ledger.recover();
    const recovered = ledger.get(id)!;
    ledger.recover();
    expect(ledger.get(id)).toEqual(recovered);
    expect(recovered).toMatchObject({ status: 'queued', attempts: [{ status: 'interrupted' }] });
    expect(ledger.finish(job.attemptId, report())).toBe(false);
    expect(ledger.interrupt(job.attemptId, '重复')).toBe(false);
    for (let i = 0; i < 2; i++) expect(ledger.interrupt(ledger.claim()!.attemptId, '中断')).toBe(true);
    expect(ledger.get(id)!.status).toBe('blocked');
    expect(ledger.claim()).toBeNull();
    expect(() => ledger.archive(id)).toThrow();
  });

  it('preserves the final human return and stops dispatching after two rework rounds', () => {
    const { id, job } = start();
    let attemptId = job.attemptId;
    for (let i = 0; i < 3; i++) {
      ledger.finish(attemptId, report());
      expect(ledger.get(id)!.returnWillBlock).toBe(i === 2);
      decide(id, 'return', 'return-' + i);
      if (i < 2) attemptId = ledger.claim()!.attemptId;
    }
    expect(ledger.get(id)).toMatchObject({ status: 'blocked', events: expect.arrayContaining([
      expect.objectContaining({ requestId: 'return-2', reason: '人工核对' }),
    ]) });
    expect(ledger.claim()).toBeNull();
  });
});
