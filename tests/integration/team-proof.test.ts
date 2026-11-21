import { mkdir, mkdtemp, realpath, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { TeamClaim } from '../../src/server/team/contracts.js';
import { verifyIntegration } from '../../src/server/team/verify.js';
import { commitTask, createTeamWorkspace, integrateTasks } from '../../src/server/team/workspace.js';

it('replays the accepted task objects on a clean host and rejects a forged integration SHA or test report', async () => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, 'specmill-proof-test-'));
  try {
    const producer = join(root, 'producer');
    const proof = join(root, 'proof');
    await mkdir(proof);
    const scope = { projectId: 'project', runId: 'run', generation: 1 };
    const make = async (task: 'dates'|'paid', content: string) => {
      const claim = { ...scope, task, attemptId: task + '-1' };
      return commitTask(await createTeamWorkspace(producer, claim), claim, content);
    };
    const [dates, paid] = await Promise.all([
      make('dates', 'order_date BETWEEN :start_date AND :end_date'), make('paid', "status = 'paid'"),
    ]);
    const inputs = { dates, paid };
    const claim: TeamClaim = { ...scope, task: 'integrate', attemptId: 'integration-1', inputs };
    const original = await integrateTasks(await createTeamWorkspace(producer, claim), claim, inputs);
    // The service receives JSON over IPC. Original workspaces may be unavailable after a restore.
    const result = JSON.parse(JSON.stringify(original)) as typeof original;
    await rename(producer, join(root, 'offline'));
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(key, proof);
    expect(await verifyIntegration(claim, result)).toBe(true);
    expect(await verifyIntegration(claim, { ...result, commit: 'f'.repeat(40) })).toBe(false);
    expect(await verifyIntegration(claim, { ...result, parents: [paid.commit, dates.commit] })).toBe(false);
    expect(await verifyIntegration(claim, { ...result, checks: result.checks.map(c => ({ ...c, actual: [] })) })).toBe(false);
    expect(await verifyIntegration({ ...claim, inputs: { dates: { ...dates, generation: 2 }, paid } }, result)).toBe(false);
    expect(await readdir(proof)).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    const actual = await realpath(root);
    if (actual === root && dirname(actual) === temp) await rm(actual, { recursive: true, force: true });
  }
}, 60000);
