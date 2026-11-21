import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PILOT_SPEC, runSampleGit } from '../../src/server/pilot/sample.js';
import type { TaskArtifact, TeamClaim, TeamResult } from '../../src/server/team/contracts.js';
import { extractPredicate, readIntegration } from '../../src/server/team/workspace.js';

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

const scope = { projectId: 'project', runId: 'run', generation: 1 };
type Job = TeamClaim & { root: string; agentBin: string };

function invoke(job: Job, preload?: string) {
  return new Promise<TeamResult>((resolve, reject) => {
    const worker = fork(new URL('../../src/server/team/worker.ts', import.meta.url), [], {
      execArgv: ['--import', 'tsx', ...(preload ? ['--import', pathToFileURL(preload).href] : [])],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const deadline = setTimeout(() => worker.kill(), 30000);
    let result: TeamResult | undefined;
    worker.once('message', value => { result = value as TeamResult; });
    worker.once('error', reject);
    worker.once('close', code => {
      clearTimeout(deadline);
      if (code === 0 && result) resolve(result);
      else reject(new Error('团队 Worker 未返回结果。'));
    });
    worker.send(job);
  });
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'specmill-team-worker-'));
  temporary.push(dir);
  const root = join(dir, 'attempts');
  await mkdir(root);
  // The stand-in is native Node running the adapter's unmodified fixed argv. Only
  // this test's guard preloader installs the "exec" program in the isolated cwd.
  const cli = [
    "const fs = require('node:fs');",
    "const prompt = fs.readFileSync(0, 'utf8');",
    "const isDate = prompt.includes('order_date');",
    "const wrong = process.cwd().includes('refund-case');",
    "const paid = wrong ? \"status <> 'pending' AND status <> 'cancelled'\" : \"status = 'paid'\";",
    "fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], isDate ? 'order_date BETWEEN :start_date AND :end_date' : paid);",
  ].join('\n');
  const preload = join(dir, 'fixture.mjs');
  await writeFile(preload, [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "if (process.argv[2] === '--agent-guard') process.once('message', ({repo}) => {",
    "  writeFileSync(join(repo, 'exec'), " + JSON.stringify(cli) + ");",
    '});',
  ].join('\n'));
  return { root, dir, preload };
}

async function repoFor(root: string, attemptId: string) {
  const entries = (await readdir(root)).filter(entry => entry.startsWith('attempt-' + attemptId + '-'));
  expect(entries).toHaveLength(1);
  return join(root, entries[0]);
}

async function codeTask(root: string, preload: string, task: TaskArtifact['task'], attemptId: string) {
  const result = await invoke({ ...scope, root, agentBin: process.execPath, task, attemptId }, preload);
  if (result.kind !== 'task') throw new Error('编码任务失败：' + JSON.stringify(result));
  return result.artifact;
}

describe('team execution on a frozen synthetic order query', () => {
  it('restricts each agent to the bounded predicate for its own task', () => {
    expect(extractPredicate('paid', "```sql\nstatus = 'paid';\n```")).toBe("status = 'paid'");
    expect(extractPredicate('dates', '`order_date BETWEEN :start_date AND :end_date`'))
      .toBe('order_date BETWEEN :start_date AND :end_date');
    for (const output of ["status = 'paid'", 'order_date < :START_DATE', 'order_date = :end_date -- comment',
      'SELECT id FROM orders', 'order_date = :end_date; SELECT 1', '`order_date = :end_date; SELECT 1`', ' '.repeat(513)]) {
      expect(() => extractPredicate('dates', output)).toThrow();
    }
    expect(() => extractPredicate('paid', "status = 'refunded'")).toThrow();
  });

  it('forks two isolated coding tasks, reconstructs them on a fresh root and retests the pinned two-parent commit', async () => {
    const { dir, root, preload } = await setup();
    const [dates, paid] = await Promise.all([
      codeTask(root, preload, 'dates', 'first'), codeTask(root, preload, 'paid', 'second'),
    ]);
    const dateRepo = await repoFor(root, 'first');
    const paidRepo = await repoFor(root, 'second');
    const [dateBase, paidBase] = await Promise.all([
      runSampleGit(dateRepo, ['rev-parse', dates.commit + '^']), runSampleGit(paidRepo, ['rev-parse', paid.commit + '^']),
    ]);
    expect(dateBase).toEqual(paidBase);
    expect(dates.commit).not.toBe(paid.commit);
    expect(await runSampleGit(dateRepo, ['ls-tree', '--name-only', dates.commit])).toBe('dates.sql\nspec.json\n');
    expect(await runSampleGit(paidRepo, ['ls-tree', '--name-only', paid.commit])).toBe('paid.sql\nspec.json\n');
    const inputs = { dates, paid };
    const restored = join(dir, 'independent-host');
    const job: Job = { ...scope, root: restored, agentBin: '', task: 'integrate', attemptId: 'merge', inputs };
    const result = await invoke(job);
    if (result.kind !== 'integration') throw new Error('集成失败：' + JSON.stringify(result));
    const { integration } = result;
    expect(integration.parents).toEqual([dates.commit, paid.commit]);
    expect(integration.checks).toEqual(PILOT_SPEC.criteria.map(({ name, expected }) => ({ name, expected, actual: expected, passed: true })));
    const repo = await repoFor(restored, 'merge');
    expect(await runSampleGit(repo, ['ls-tree', '--name-only', integration.commit])).toBe('dates.sql\norders.sql\npaid.sql\nspec.json\n');
    // Move HEAD and leave invalid working bytes. Historical evidence must still use the original SHA.
    await runSampleGit(repo, ['update-ref', 'HEAD', dates.commit, integration.commit]);
    await writeFile(join(repo, 'orders.sql'), 'invalid working copy');
    expect(await readIntegration(repo, integration.commit, inputs)).toEqual(integration);
    const repeated = await invoke({ ...job, root: join(dir, 'another-host') });
    expect(repeated).toEqual(result);
    for (const mutation of [{ runId: 'different-run' }, { inputs: { dates, paid: { ...paid, generation: 2 } } },
      { inputs: { dates: { ...dates, content: 'order_date < :end_date' }, paid } }, { attemptId: '../outside' }]) {
      expect(await invoke({ ...job, ...mutation })).toMatchObject({ kind: 'failure' });
    }
  }, 90000);

  it('reports the refunded-order regression from the integration Git object even though both branches produced commits', async () => {
    const { root, preload } = await setup();
    const [dates, paid] = await Promise.all([
      codeTask(root, preload, 'dates', 'boundaries'), codeTask(root, preload, 'paid', 'refund-case'),
    ]);
    const result = await invoke({ ...scope, root, agentBin: '', task: 'integrate', attemptId: 'check-refunds', inputs: { dates, paid } });
    if (result.kind !== 'integration') throw new Error('集成未产生可核对结果。');
    expect(result.integration.parents).toEqual([dates.commit, paid.commit]);
    expect(result.integration.checks.map(check => check.passed)).toEqual([true, false, true]);
    expect(result.integration.checks[1]).toEqual({ name: 'paid-only', expected: [30], actual: [30, 37], passed: false });
  }, 60000);
});
