import { execFile, fork } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PILOT_SPEC, checkPilotSql, commitPilotSql, createPilotRepo, extractPilotSql, type PilotJob, type PilotResult } from '../../src/server/pilot/sample.js';

const run = promisify(execFile);
const sql = "SELECT id FROM orders WHERE order_date >= :start_date AND order_date <= :end_date AND status = 'paid' ORDER BY id ASC;";
const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('frozen synthetic order query', () => {
  it('checks inclusive dates, paid status and deterministic ordering against independent rows', () => {
    for (const query of [sql, sql.replace('order_date >= :start_date AND order_date <= :end_date', 'order_date BETWEEN :start_date AND :end_date')]) {
      expect(checkPilotSql(query)).toEqual(PILOT_SPEC.criteria.map(({ name, expected }) => ({ name, expected, actual: expected, passed: true })));
    }
    const strict = checkPilotSql(sql.replace('<=', '<'));
    expect(strict.map(check => check.passed)).toEqual([false, true, true]);
    expect(strict[0].actual).toEqual([10]);
    const allStatuses = checkPilotSql(sql.replace(" AND status = 'paid'", ''));
    expect(allStatuses.map(check => check.passed)).toEqual([true, false, true]);
    expect(allStatuses[1].actual).toEqual([25, 30, 35, 37]);
    const excludedKnownStatuses = checkPilotSql(sql.replace("status = 'paid'", "status <> 'pending' AND status <> 'cancelled'"));
    expect(excludedKnownStatuses.map(check => check.passed)).toEqual([true, false, true]);
    expect(excludedKnownStatuses[1].actual).toEqual([30, 37]);
    const unordered = checkPilotSql(sql.replace(' ORDER BY id ASC', ''));
    expect(unordered.map(check => check.passed)).toEqual([true, true, false]);
    expect(unordered[2].actual).toEqual([9, 2, 5]);
  });

  it('permits one bounded query and refuses file access, subqueries, comments and arbitrary output', () => {
    expect(extractPilotSql('\x60\x60\x60sql\n' + sql + '\n\x60\x60\x60')).toBe(sql + '\n');
    for (const output of [
      sql + ' SELECT id FROM orders', 'ATTACH DATABASE \'sample.sqlite\' AS other',
      'SELECT readfile(\'orders.sql\') FROM orders', 'SELECT id FROM (SELECT id FROM orders)',
      sql + ' -- token', sql.replace(':end_date', ':END_DATE'), sql.replace('id ASC', 'random()'),
      'secret-provider-error', ' '.repeat(4096) + sql,
    ]) expect(extractPilotSql(output)).toBeNull();
    expect(() => checkPilotSql('SELECT id FROM sqlite_master')).toThrow();
  });

  it('reads evidence from the new Git commit in an isolated repository and excludes ambient config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'specmill-pilot-sample-'));
    temporary.push(root);
    const hostileConfig = join(root, 'global-config');
    await writeFile(hostileConfig, '[commit]\n\tgpgSign = true\n[user]\n\tname = externalAuthor\n');
    vi.stubEnv('GIT_CONFIG_GLOBAL', hostileConfig);
    vi.stubEnv('GIT_INDEX_FILE', join(root, 'must-not-create-index'));
    const job: PilotJob = { runId: 'sample', attemptId: 'one', root, agentBin: process.execPath, previousSql: null, reason: null, spec: PILOT_SPEC };
    const repo = await createPilotRepo(job);
    const first = await commitPilotSql(repo, job.attemptId, sql);
    expect(first.error).toBeNull();
    expect(first.commit).toMatch(/^[a-f0-9]{40}$/);
    const readGit = async (...args: string[]) => (await run('git', ['-C', repo, ...args], { windowsHide: true })).stdout;
    expect(await readGit('cat-file', 'blob', first.commit + ':orders.sql')).toBe(first.sql);
    expect(await readGit('ls-tree', '--name-only', first.commit!)).toBe('orders.sql\n');
    expect((await readGit('log', '-1', '--format=%an')).trim()).toBe('SpecMill Pilot');
    expect(first.checks.every(check => check.passed)).toBe(true);
    const secondRepo = await createPilotRepo({ ...job, attemptId: 'two' });
    const second = await commitPilotSql(secondRepo, 'two', sql.replace('<=', '<'));
    expect(second.commit).not.toBe(first.commit);
    expect(second.checks[0].passed).toBe(false);
    expect(await readFile(join(repo, 'orders.sql'), 'utf8')).toBe(first.sql);
    expect(await readdir(root)).not.toContain('must-not-create-index');
    const thirdRepo = await createPilotRepo({ ...job, attemptId: 'three' });
    const rejected = await commitPilotSql(thirdRepo, 'three', 'private-debug-message');
    expect(rejected).toMatchObject({ commit: null, checks: [], sql: '' });
    expect(JSON.stringify(rejected)).not.toContain('private-debug-message');
    expect(await readdir(thirdRepo)).toEqual(['.git']);
    await expect(createPilotRepo({ ...job, attemptId: '../outside' })).rejects.toThrow();
  }, 30000);

  it('returns bounded IPC failures for an unsupported freeze and a native CLI that exits unsuccessfully', async () => {
    const root = await mkdtemp(join(tmpdir(), 'specmill-pilot-worker-'));
    temporary.push(root);
    const job: PilotJob = {
      root, runId: 'sample', attemptId: 'worker', agentBin: process.execPath, reason: 'sensitive-review-marker', previousSql: null, spec: PILOT_SPEC,
    };
    const invoke = (input: PilotJob) => new Promise<PilotResult>((resolve, reject) => {
      const worker = fork(new URL('../../src/server/pilot/worker.ts', import.meta.url), [], {
        execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      const timeout = setTimeout(() => { worker.kill(); reject(new Error('Worker did not return')); }, 10000);
      let result: PilotResult | undefined;
      worker.on('message', value => { result = value as PilotResult; });
      worker.once('error', reject);
      worker.once('close', code => {
        clearTimeout(timeout);
        if (code === 0 && result) resolve(result);
        else reject(new Error('Worker exited without a result'));
      });
      worker.send(input);
    });
    const unsupported = await invoke({ ...job, spec: { ...PILOT_SPEC, queryContract: 'unsupported revision' } });
    expect(unsupported.error).toContain('冻结');
    expect(await readdir(root)).toEqual([]);
    // Node is a native executable but rejects the fixed Codex arguments. This exercises
    // both IPC boundaries without authenticating or making an inference request.
    const failed = await invoke(job);
    expect(failed.error).toContain('Codex CLI');
    expect(failed).toMatchObject({ commit: null, sql: '', checks: [] });
    expect(JSON.stringify(failed)).not.toContain(job.reason);
    const repos = await readdir(root);
    expect(repos).toHaveLength(1);
    expect(await readdir(join(root, repos[0]))).toEqual(['.git']);
  }, 25000);

  it.each(['disconnect', 'kill'])('reaps the running CLI when the Worker loses its parent via %s', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'specmill-pilot-orphan-'));
    temporary.push(root);
    const preload = join(root, 'guard-fixture.mjs');
    // The CLI stand-in is native Node with the unchanged Codex argv. Place an
    // "exec" script in its synthetic cwd before launch. No service test hooks.
    await writeFile(preload, [
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "if (process.argv[2] === '--agent-guard') process.once('message', ({repo}) => {",
      `  writeFileSync(join(repo, 'exec'), ${JSON.stringify("require('node:fs').writeFileSync('../cli.pid', String(process.pid)); setTimeout(() => {}, 15000);")});`,
      '});',
    ].join('\n'));
    const worker = fork(new URL('../../src/server/pilot/worker.ts', import.meta.url), [], {
      execArgv: ['--import', 'tsx', '--import', pathToFileURL(preload).href], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const job: PilotJob = { root, runId: 'demo', attemptId: 'orphan', agentBin: process.execPath, spec: PILOT_SPEC, reason: '', previousSql: null };
    try {
      worker.send(job);
      const pid = await vi.waitFor(async () => {
        const value = Number(await readFile(join(root, 'cli.pid'), 'utf8'));
        expect(value).toBeGreaterThan(0);
        return value;
      }, { timeout: 8000 });
      if (mode === 'kill') worker.kill('SIGKILL');
      else worker.disconnect();
      await vi.waitFor(() => {
        expect(worker.exitCode !== null || worker.signalCode !== null).toBe(true);
        expect(() => process.kill(pid, 0)).toThrow();
      }, { timeout: 8000 });
    } finally {
      if (worker.connected) worker.disconnect();
    }
  }, 20000);
});
