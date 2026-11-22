import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runSampleGit } from '../../src/server/pilot/sample.js';
import { repositoryArtifactName } from '../../src/server/team/contracts.js';
import type { RepositoryConfig, TeamClaim, TeamResult } from '../../src/server/team/contracts.js';
import {
  assertRepositoryDataPath, loadRepositoryConfig, REPOSITORY_CONTENT_MAX_BYTES, verifyRepository, verifyRetainedRepository,
} from '../../src/server/team/repository.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

const original = 'initial: 待完善\r\n';
const first = 'warning: keep review visible\n';
const revised = 'status: ready\n';
const model = 'test/repository';
type Job = TeamClaim & { root: string; agentBin: string; executor: 'pi'; model: string };

function invoke(job: Job): Promise<TeamResult> {
  return new Promise((resolve, reject) => {
    const worker = fork(new URL('../../src/server/team/worker.ts', import.meta.url), [], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const deadline = setTimeout(() => worker.kill(), 35000);
    let result: TeamResult | undefined;
    worker.once('message', value => { result = value as TeamResult; });
    worker.once('error', reject);
    worker.once('close', code => {
      clearTimeout(deadline);
      if (code === 0 && result) resolve(result);
      else reject(new Error('仓库试点 Worker 未返回结果。'));
    });
    worker.send(job);
  });
}

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'specmill-repository-test-'));
  roots.push(root);
  const source = join(root, 'approved repository');
  const audit = join(root, 'attempts');
  const path = 'docs/STATUS.md';
  await mkdir(join(source, 'docs'), { recursive: true });
  await runSampleGit(source, ['init', '--quiet', '--template=', '--object-format=sha1', '--initial-branch=main']);
  await runSampleGit(source, ['commit', '--quiet', '--allow-empty', '-m', 'previous history']);
  await writeFile(join(source, path), original);
  await writeFile(join(source, 'other.txt'), 'OTHER-TRACKED-CONTENT');
  await runSampleGit(source, ['add', '--', path, 'other.txt']);
  await runSampleGit(source, ['commit', '--quiet', '-m', 'pinned']);
  const baseCommit = (await runSampleGit(source, ['rev-parse', 'HEAD'])).trim();
  const config: RepositoryConfig = {
    projectId: 'test-project', source,
    spec: { kind: 'repository-v1', title: '仓库试点', requirement: '将状态设为 ready。', baseCommit, path,
      checks: [{ name: 'ready', text: 'status: ready', present: true }, { name: 'warning-removed', text: 'warning:', present: false }] },
  };
  const filename = join(root, 'repository.json');
  await writeFile(filename, JSON.stringify(config));
  const agentBin = join(root, 'approved-agent.mjs');
  await writeFile(agentBin, `
    import assert from 'node:assert/strict';
    import { readFileSync, readdirSync } from 'node:fs';
    assert(process.argv.includes('--no-tools'));
    assert.deepEqual(readdirSync(process.cwd()), []);
    const prompt = readFileSync(0, 'utf8');
    for (const privateData of ['OTHER-TRACKED-CONTENT', 'DIRTY-TEXT', 'MOVED-HEAD', 'approved repository']) {
      assert(!prompt.includes(privateData));
    }
    const data = JSON.parse(prompt.slice(prompt.indexOf('\\n') + 1));
    assert.equal(data.original, ${JSON.stringify(original)});
    assert.equal(data.requirement, ${JSON.stringify(config.spec.requirement)});
    assert.deepEqual(data.checks, ${JSON.stringify(config.spec.checks)});
    if (data.previous) assert.deepEqual(data.previous, {
      content: ${JSON.stringify(first)}, reason: '请检查失败的字面条件',
    });
    console.log(JSON.stringify({ type: 'agent_end', messages: [{
      role: 'assistant', stopReason: 'stop', provider: 'test', model: 'repository',
      content: [{ type: 'text', text: data.previous ? ${JSON.stringify(revised)} : ${JSON.stringify(first)} }],
    }] }));
  `);
  const job: Job = { projectId: config.projectId, runId: 'run-one', task: 'repository', attemptId: 'first-attempt',
    generation: 1, repository: { source, spec: config.spec }, root: audit, agentBin, executor: 'pi', model };
  return { config, filename, source, audit, path, job };
}

it('uses pinned Git bytes, retains auditable attempts, and independently replays both review rounds', async () => {
  const { config, filename, source, audit, path, job } = await fixture();
  expect(await loadRepositoryConfig(filename)).toEqual(config);
  await writeFile(join(source, path), 'MOVED-HEAD\n');
  await runSampleGit(source, ['add', '--', path]);
  await runSampleGit(source, ['commit', '--quiet', '-m', 'moved']);
  await runSampleGit(source, ['repack', '-a', '-d', '-q']);
  const movedHead = await runSampleGit(source, ['rev-parse', 'HEAD']);
  await writeFile(join(source, path), 'DIRTY-TEXT\n');
  const before = await runSampleGit(source, ['status', '--porcelain']);
  const gitConfig = join(source, '.git', 'config');
  const startConfig = await readFile(gitConfig, 'utf8');
  await writeFile(join(source, '.git', 'invalid-source-config'), '[invalid section\n');
  const brokenConfig = startConfig + '\n[include]\n\tpath = invalid-source-config\n';
  await writeFile(gitConfig, brokenConfig);
  await expect(runSampleGit(source, ['status', '--porcelain'])).rejects.toThrow();
  expect(await loadRepositoryConfig(filename)).toEqual(config);

  const firstRun = await invoke(job);
  expect(firstRun, JSON.stringify(firstRun)).toMatchObject({ kind: 'repository', evidence: {
    content: first, parent: config.spec.baseCommit,
    checks: [{ name: 'ready', passed: false }, { name: 'warning-removed', passed: false }],
  } });
  if (firstRun.kind !== 'repository') throw new Error('缺少首次 Git 证据。');
  expect(await verifyRepository(job, firstRun.evidence)).toBe(true);
  expect(await verifyRepository(job, firstRun.evidence, audit)).toBe(true);
  expect(await verifyRepository(job, { ...firstRun.evidence, contentSha256: '0'.repeat(64) })).toBe(false);
  expect(await verifyRepository(job, { ...firstRun.evidence, commit: config.spec.baseCommit })).toBe(false);
  expect(await verifyRepository(job, { ...firstRun.evidence, path: 'other.txt' })).toBe(false);
  expect(await verifyRepository(job, { ...firstRun.evidence, checks: [
    { name: 'ready', passed: true }, { name: 'warning-removed', passed: true },
  ] })).toBe(false);

  const next = { ...job, attemptId: 'second-attempt', generation: 2, repository: {
    ...job.repository!, previous: { commit: firstRun.evidence.commit, content: firstRun.evidence.content, reason: '请检查失败的字面条件' },
  } };
  const secondRun = await invoke(next);
  expect(secondRun, JSON.stringify(secondRun)).toMatchObject({ kind: 'repository', evidence: {
    content: revised, parent: config.spec.baseCommit, checks: [{ name: 'ready', passed: true }, { name: 'warning-removed', passed: true }],
  } });
  if (secondRun.kind !== 'repository') throw new Error('缺少返工 Git 证据。');
  expect(secondRun.evidence.commit).not.toBe(firstRun.evidence.commit);
  expect(await verifyRepository(next, secondRun.evidence, audit)).toBe(true);
  expect(await verifyRepository(job, secondRun.evidence)).toBe(false);
  const repeated = await invoke(next);
  expect(repeated).toMatchObject({ kind: 'repository', evidence: { commit: secondRun.evidence.commit } });
  expect((await readdir(audit)).sort()).toEqual(['repository-first-attempt', 'repository-second-attempt']);

  expect(await readFile(gitConfig, 'utf8')).toBe(brokenConfig);
  await writeFile(gitConfig, startConfig);
  expect(await runSampleGit(source, ['rev-parse', 'HEAD'])).toBe(movedHead);
  expect(await runSampleGit(source, ['status', '--porcelain'])).toBe(before);
  expect(await readFile(join(source, path), 'utf8')).toBe('DIRTY-TEXT\n');
  // Stored result and base snapshot can be inspected after the source is gone.
  await rm(source, { recursive: true, force: true });
  expect(await verifyRetainedRepository(job, firstRun.evidence, audit)).toBe(true);
  expect(await verifyRetainedRepository(next, secondRun.evidence, audit)).toBe(true);
  expect(await verifyRetainedRepository({ ...next, generation: 3 }, secondRun.evidence, audit)).toBe(false);
  for (const directory of await readdir(audit)) {
    const repo = join(audit, directory);
    const evidence = directory === 'repository-first-attempt' ? firstRun.evidence : secondRun.evidence;
    expect((await runSampleGit(repo, ['rev-parse', 'HEAD'])).trim()).toBe(evidence.commit);
    expect(await runSampleGit(repo, ['cat-file', 'blob', evidence.commit + ':' + path])).toBe(evidence.content);
    expect(await runSampleGit(repo, ['cat-file', 'blob', evidence.parent + ':' + path])).toBe(original);
    expect(await runSampleGit(repo, ['cat-file', 'blob', evidence.commit + ':other.txt'])).toBe('OTHER-TRACKED-CONTENT');
    expect((await runSampleGit(repo, ['rev-list', '--count', 'HEAD'])).trim()).toBe('2');
    await expect(readFile(join(repo, 'objects', 'info', 'alternates'))).rejects.toHaveProperty('code', 'ENOENT');
  }
}, 60000);

it('rejects reproducible evidence if its retained repository, reference, or packed objects are missing', async () => {
  const { config, audit, job } = await fixture();
  const result = await invoke(job);
  if (result.kind !== 'repository') throw new Error('缺少 Git 证据：' + JSON.stringify(result));
  const repo = join(audit, repositoryArtifactName(job.attemptId));
  const parked = join(audit, 'parked-audit');
  await rename(repo, parked);
  expect(await verifyRepository(job, result.evidence, audit)).toBe(false);
  await rename(parked, repo);

  const ref = join(repo, 'refs', 'heads', 'specmill-result');
  await writeFile(ref, config.spec.baseCommit + '\n');
  expect(await verifyRepository(job, result.evidence, audit)).toBe(false);
  expect(await verifyRetainedRepository(job, result.evidence, audit)).toBe(false);
  await writeFile(ref, result.evidence.commit + '\n');

  const pack = join(repo, 'objects', 'pack');
  await rename(pack, parked);
  await mkdir(pack);
  expect(await verifyRepository(job, result.evidence, audit)).toBe(false);
  expect(await verifyRepository(job, result.evidence)).toBe(true);
}, 40000);

it('rejects extra keys, nonlocal input, unsafe paths, ref names, oversized and executable files', async () => {
  const { config, filename, source, path } = await fixture();
  const badSpecs: Partial<RepositoryConfig['spec']>[] = [{ path: '../STATUS.md' }, { path: 'docs/.GIT/config' },
    { path: 'docs/COM1.txt' }, { path: 'docs/STATUS.md.' }, { path: 'other.txt/..' }, { baseCommit: 'HEAD' },
    { checks: [...config.spec.checks, config.spec.checks[0]] }];
  const variants = [...badSpecs.map(spec => ({ ...config, spec: { ...config.spec, ...spec } })),
    { ...config, source: '.' }, { ...config, source: 'https://example.invalid/repo' }, { ...config, arbitrary: true }];
  for (const value of variants) {
    await writeFile(filename, JSON.stringify(value));
    await expect(loadRepositoryConfig(filename)).rejects.toThrow();
  }
  await writeFile(join(source, path), 'x'.repeat(REPOSITORY_CONTENT_MAX_BYTES + 1));
  await runSampleGit(source, ['add', '--', path]);
  await runSampleGit(source, ['commit', '--quiet', '-m', 'huge']);
  config.spec.baseCommit = (await runSampleGit(source, ['rev-parse', 'HEAD'])).trim();
  await writeFile(filename, JSON.stringify(config));
  await expect(loadRepositoryConfig(filename)).rejects.toThrow();

  await writeFile(join(source, path), original);
  await runSampleGit(source, ['add', '--chmod=+x', '--', path]);
  await runSampleGit(source, ['commit', '--quiet', '-m', 'executable']);
  config.spec.baseCommit = (await runSampleGit(source, ['rev-parse', 'HEAD'])).trim();
  await writeFile(filename, JSON.stringify(config));
  await expect(loadRepositoryConfig(filename)).rejects.toThrow();
  await writeFile(filename, ' '.repeat(16 * 1024 + 1));
  await expect(loadRepositoryConfig(filename)).rejects.toThrow();
});

it('does not create a workspace inside the source or through an alias to the source', async () => {
  const { source, audit, job } = await fixture();
  const alias = audit + '-alias';
  await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(assertRepositoryDataPath(source, source)).rejects.toThrow();
  await expect(assertRepositoryDataPath(source, join(alias, 'nested', 'data'))).rejects.toThrow();
  await expect(assertRepositoryDataPath(source, source + '-sibling')).resolves.toBeUndefined();
  expect(await invoke({ ...job, root: join(source, 'new-workspace') })).toMatchObject({ kind: 'failure' });
  await expect(readdir(join(source, 'new-workspace'))).rejects.toHaveProperty('code', 'ENOENT');
});

it('does not retain an audit directory for an oversized snapshot', async () => {
  const { config, source, audit, job } = await fixture();
  await writeFile(join(source, 'large.bin'), randomBytes(16 * 1024 * 1024 + 1));
  await runSampleGit(source, ['add', '--', 'large.bin']);
  await runSampleGit(source, ['commit', '--quiet', '-m', 'oversized audit snapshot']);
  config.spec.baseCommit = (await runSampleGit(source, ['rev-parse', 'HEAD'])).trim();
  expect(await invoke(job)).toMatchObject({ kind: 'failure' });
  expect(await readdir(audit)).toEqual([]);
});
