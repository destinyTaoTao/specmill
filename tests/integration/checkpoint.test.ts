import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildApp } from '../../src/server/app.js';
import Database from 'better-sqlite3';

const dirs: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const headers = { host: '127.0.0.1:43127', origin: 'http://127.0.0.1:43127' };
const agentHeaders = { host: headers.host, authorization: 'Bearer agent-token', 'x-specmill-writer-token': 'a'.repeat(64) };
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup(maxProjectRecordsBytes?: number) {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-checkpoint-data-')); dirs.push(dataDir);
  const repoDir = await mkdtemp(join(tmpdir(), 'specmill-checkpoint-repo-')); dirs.push(repoDir);
  const result = spawnSync('git', ['-C', repoDir, 'init', '-q'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } });
  if (result.status !== 0) throw new Error(result.stderr);
  await writeFile(join(repoDir, 'work.txt'), '尚未提交');
  const app = await buildApp({ dataDir, port: 43127, ownerToken: 'owner-token', agentToken: 'agent-token', maxProjectRecordsBytes }); apps.push(app);
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
  const ownerHeaders = { ...headers, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
  const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: ownerHeaders, payload: { name: '保存点', requestId: 'checkpoint-project' } });
  const projectId = project.json().resourceId as string;
  const workspace = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders,
    payload: { requestId: 'checkpoint-workspace', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
  const workspaceId = workspace.json().resourceId as string;
  const observation = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/observations`, headers: ownerHeaders,
    payload: { requestId: 'checkpoint-observe', expectedBindingVersion: 1, selectedUntracked: ['work.txt'] } });
  expect(observation.statusCode).toBe(201);
  const change = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
    payload: { requestId: 'checkpoint-change', expectedVersion: null, payload: { title: '续做', goal: '完成开发', scope: '', nonGoals: '', criteria: [] } } });
  const changeId = change.json().resourceId as string;
  const started = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/writer-sessions`, headers: agentHeaders,
    payload: { requestId: 'checkpoint-session', expectedVersion: 1, payload: { workspaceId, expectedBindingVersion: 1, toolLabel: '工具 A' } } });
  expect(started.statusCode).toBe(201);
  return { app, dataDir, repoDir, projectId, workspaceId, changeId, ownerHeaders, observationId: observation.json().resourceId as string, sessionId: started.json().resourceId as string };
}

describe('checkpoint', () => {
  it('saves an uncommitted draft, supports idempotent receipts, and records the actual author', async () => {
    const { app, dataDir, changeId, workspaceId, ownerHeaders, sessionId } = await setup();
    const observeBody = { requestId: 'agent-observe', expectedBindingVersion: 1, selectedUntracked: ['work.txt'], writerSessionId: sessionId, generation: 1 };
    const denied = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/observations`, headers: { host: headers.host, authorization: 'Bearer agent-token' }, payload: observeBody });
    expect(denied.statusCode).toBe(403);
    const observed = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/observations`, headers: agentHeaders, payload: observeBody });
    expect(observed.statusCode).toBe(201);
    const observationId = observed.json().resourceId as string;
    const body = { requestId: 'save-1', expectedVersion: 2, writerSessionId: sessionId, generation: 1,
      payload: { observationId, done: '实现一部分', failures: '测试失败待修', unverified: '未验证恢复', blockers: '无', nextSteps: '继续排查' } };
    const save = () => app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/checkpoints`, headers: agentHeaders, payload: body });
    const first = await save();
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual(expect.objectContaining({ requestId: 'save-1', resourceId: expect.any(String), recordVersion: 3 }));
    expect((await save()).json()).toEqual(first.json());
    const conflict = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/checkpoints`, headers: agentHeaders, payload: { ...body, payload: { ...body.payload, done: '不同内容' } } });
    expect(conflict.statusCode).toBe(409);
    const wrongGeneration = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/checkpoints`, headers: agentHeaders, payload: { ...body, requestId: 'bad-generation', expectedVersion: 3, generation: 2 } });
    expect(wrongGeneration.statusCode).toBe(409);
    const wrongObservation = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/checkpoints`, headers: agentHeaders, payload: { ...body, requestId: 'bad-observation', expectedVersion: 3, payload: { ...body.payload, observationId: 'unknown' } } });
    expect(wrongObservation.statusCode).toBe(409);
    const manual = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/checkpoints`, headers: ownerHeaders,
      payload: { ...body, requestId: 'save-user', expectedVersion: 3, payload: { ...body.payload, done: '用户手工补充' } } });
    expect(manual.statusCode).toBe(201);
    const list = await app.inject({ url: `/api/v1/changes/${changeId}/checkpoints`, headers: ownerHeaders });
    expect(list.json().checkpoints).toEqual([expect.objectContaining({ id: manual.json().resourceId, actor: 'user', baselineId: null, draftRevisionId: expect.any(String) }), expect.objectContaining({ id: first.json().resourceId, actor: 'agent', failures: '测试失败待修' })]);
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const restarted = await buildApp({ dataDir, port: 43127, ownerToken: 'owner-token', agentToken: 'agent-token' }); apps.push(restarted);
    const receipt = await restarted.inject({ url: '/api/v1/receipts/save-1', headers: agentHeaders });
    expect(receipt.json()).toEqual(first.json());
    const stale = await restarted.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/checkpoints`, headers: agentHeaders, payload: { ...body, requestId: 'late-write', expectedVersion: 4 } });
    expect(stale.statusCode).toBe(409);
  }, 20000);

  it('does not advance the last checkpoint when capacity is exceeded', async () => {
    const { app, projectId, changeId, ownerHeaders, observationId, sessionId } = await setup(8000);
    const before = await app.inject({ url: `/api/v1/projects/${projectId}/capacity`, headers: ownerHeaders });
    const rejected = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/checkpoints`, headers: agentHeaders,
      payload: { requestId: 'large-checkpoint', expectedVersion: 2, writerSessionId: sessionId, generation: 1, payload: { observationId, done: '中文'.repeat(3000), failures: '无', unverified: '无', blockers: '无', nextSteps: '待做' } } });
    expect(rejected.statusCode).toBe(413);
    expect(rejected.json().code).toBe('PROJECT_CAPACITY_EXCEEDED');
    expect((await app.inject({ url: `/api/v1/projects/${projectId}/capacity`, headers: ownerHeaders })).json()).toEqual(before.json());
    expect((await app.inject({ url: `/api/v1/changes/${changeId}/checkpoints`, headers: ownerHeaders })).json().checkpoints).toEqual([]);
  }, 20000);

  it('rolls back the checkpoint and current pointer when receipt storage fails', async () => {
    const { app, dataDir, changeId, workspaceId, observationId, sessionId } = await setup();
    const progress = { observationId, done: '第一次保存', failures: '无', unverified: '未知', blockers: '无', nextSteps: '继续' };
    const first = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/checkpoints`, headers: agentHeaders,
      payload: { requestId: 'before-storage-failure', expectedVersion: 2, writerSessionId: sessionId, generation: 1, payload: progress } });
    expect(first.statusCode).toBe(201);
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const db = new Database(join(dataDir, 'specmill.db'));
    db.exec("CREATE TRIGGER fail_test_receipt BEFORE INSERT ON checkpoint_requests BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END");
    db.close();
    const restarted = await buildApp({ dataDir, port: 43127, ownerToken: 'owner-token', agentToken: 'agent-token' }); apps.push(restarted);
    const next = await restarted.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/writer-sessions`, headers: agentHeaders,
      payload: { requestId: 'session-after-fault', expectedVersion: 4, payload: { workspaceId, expectedBindingVersion: 1, toolLabel: '工具 B' } } });
    expect(next.statusCode).toBe(201);
    const failed = await restarted.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/checkpoints`, headers: agentHeaders,
      payload: { requestId: 'storage-failure', expectedVersion: 5, writerSessionId: next.json().resourceId, generation: 2, payload: { ...progress, done: '不应保存' } } });
    expect(failed.statusCode).toBe(503);
    const context = await restarted.inject({ url: `/api/v1/changes/${changeId}`, headers: agentHeaders });
    expect(context.json()).toEqual(expect.objectContaining({ version: 5, checkpointId: first.json().resourceId }));
    const history = await restarted.inject({ url: `/api/v1/changes/${changeId}/checkpoints`, headers: agentHeaders });
    expect(history.json().checkpoints).toHaveLength(1);
    const receipt = await restarted.inject({ url: '/api/v1/receipts/storage-failure', headers: agentHeaders });
    expect(receipt.statusCode).toBe(404);
  }, 20000);

  it('enforces one project budget across concurrent changes in distinct worktrees', async () => {
    const { app, repoDir, projectId, workspaceId, changeId, ownerHeaders, observationId, sessionId } = await setup(18000);
    const worktreeParent = await mkdtemp(join(tmpdir(), 'specmill-checkpoint-worktree-')); dirs.push(worktreeParent);
    const runGit = (args: string[]) => {
      const result = spawnSync('git', ['-C', repoDir, '-c', 'user.name=SpecMill Test', '-c', 'user.email=specmill@example.invalid', '-c', 'core.hooksPath=NUL', ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    runGit(['add', 'work.txt']); runGit(['commit', '-qm', 'test']);
    const secondPath = join(worktreeParent, 'second');
    runGit(['worktree', 'add', '-q', '-b', 'parallel-test', secondPath]);
    const bind = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders,
      payload: { requestId: 'parallel-bind', expectedVersion: null, payload: { workspaceId: null, path: secondPath } } });
    expect(bind.statusCode).toBe(201);
    const secondWorkspace = bind.json().resourceId as string;
    const observed = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${secondWorkspace}/observations`, headers: ownerHeaders,
      payload: { requestId: 'parallel-observe', expectedBindingVersion: 1, selectedUntracked: [] } });
    expect(observed.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
      payload: { requestId: 'parallel-change', expectedVersion: null, payload: { title: '并行变更', goal: '继续', scope: '', nonGoals: '', criteria: [] } } });
    const secondChange = second.json().resourceId as string;
    const secondAgent = { ...agentHeaders, 'x-specmill-writer-token': 'b'.repeat(64) };
    const started = await app.inject({ method: 'POST', url: `/api/v1/changes/${secondChange}/writer-sessions`, headers: secondAgent,
      payload: { requestId: 'parallel-session', expectedVersion: 1, payload: { workspaceId: secondWorkspace, expectedBindingVersion: 1, toolLabel: '工具 B' } } });
    expect(started.statusCode).toBe(201);
    const budget = (await app.inject({ url: `/api/v1/projects/${projectId}/capacity`, headers: ownerHeaders })).json().records as { used: number; limit: number };
    const size = Math.floor((budget.limit - budget.used - 1600) / 3);
    expect(size).toBeGreaterThan(500);
    const payload = { done: 'x'.repeat(size), failures: '无', unverified: '未知', blockers: '无', nextSteps: '继续' };
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/checkpoints`, headers: agentHeaders,
        payload: { requestId: 'parallel-a', expectedVersion: 2, writerSessionId: sessionId, generation: 1, payload: { ...payload, observationId } } }),
      app.inject({ method: 'POST', url: `/api/v1/changes/${secondChange}/checkpoints`, headers: secondAgent,
        payload: { requestId: 'parallel-b', expectedVersion: 2, writerSessionId: started.json().resourceId, generation: 1, payload: { ...payload, observationId: observed.json().resourceId } } }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 413]);
    const finalBudget = (await app.inject({ url: `/api/v1/projects/${projectId}/capacity`, headers: ownerHeaders })).json().records;
    expect(finalBudget.used).toBeLessThanOrEqual(finalBudget.limit);
    const aHistory = (await app.inject({ url: `/api/v1/changes/${changeId}/checkpoints`, headers: ownerHeaders })).json().checkpoints;
    const bHistory = (await app.inject({ url: `/api/v1/changes/${secondChange}/checkpoints`, headers: ownerHeaders })).json().checkpoints;
    expect(aHistory.length + bHistory.length).toBe(1);
    expect(workspaceId).not.toBe(secondWorkspace);
  }, 30000);
});
