import { afterEach, describe, expect, it } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildApp } from '../../src/server/app.js';
import { encodeSecret } from '../../src/shared/credentials.js';

const runFile = promisify(execFile);
const dirs: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const headers = { host: '127.0.0.1:43227', origin: 'http://127.0.0.1:43227' };
const agentHeaders = { host: headers.host, authorization: 'Bearer agent-token' };
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup(maxProjectRecordsBytes?: number) {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-handoff-data-')); dirs.push(dataDir);
  const repoDir = await mkdtemp(join(tmpdir(), 'specmill-handoff-repo-')); dirs.push(repoDir);
  const commit = (args: string[]) => {
    const result = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_AUTHOR_NAME: '测试', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: '测试', GIT_COMMITTER_EMAIL: 'test@example.com' } });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  commit(['init', '-q']);
  await writeFile(join(repoDir, 'README.md'), '# 示例仓库\n');
  commit(['add', 'README.md']);
  commit(['commit', '-q', '-m', 'init']);
  const app = await buildApp({ dataDir, port: 43227, ownerToken: 'owner-token', agentToken: 'agent-token', maxProjectRecordsBytes }); apps.push(app);
  await app.listen({ host: '127.0.0.1', port: 43227 });
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
  const ownerHeaders = { ...headers, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
  const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: ownerHeaders, payload: { name: '交接项目', requestId: 'handoff-project' } });
  const projectId = project.json().resourceId as string;
  const workspace = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders,
    payload: { requestId: 'handoff-workspace', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
  const workspaceId = workspace.json().resourceId as string;
  const change = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
    payload: { requestId: 'handoff-change', expectedVersion: null, payload: { title: '交接变更', goal: '完成一次真实续做', scope: '仅限示例仓库', nonGoals: '不重建数据库', criteria: ['README 包含说明', '测试全部通过'] } } });
  const changeId = change.json().resourceId as string;
  return { app, dataDir, repoDir, projectId, workspaceId, changeId, ownerHeaders, commit };
}
async function startSession(app: Awaited<ReturnType<typeof buildApp>>, changeId: string, workspaceId: string, requestId: string) {
  const started = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/writer-sessions`, headers: { ...agentHeaders, 'x-specmill-writer-token': 'a'.repeat(64) },
    payload: { requestId, expectedVersion: 1, payload: { workspaceId, expectedBindingVersion: 1, toolLabel: '工具 A' } } });
  expect(started.statusCode).toBe(201);
  return started.json() as { resourceId: string; generation: number };
}
async function observe(app: Awaited<ReturnType<typeof buildApp>>, workspaceId: string, requestId: string, session: { resourceId: string; generation: number }) {
  const observed = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/observations`, headers: { ...agentHeaders, 'x-specmill-writer-token': 'a'.repeat(64) },
    payload: { requestId, expectedBindingVersion: 1, selectedUntracked: [], writerSessionId: session.resourceId, generation: session.generation } });
  return observed;
}
async function saveCheckpoint(app: Awaited<ReturnType<typeof buildApp>>, changeId: string, version: number, requestId: string, observationId: string, session: { resourceId: string; generation: number }) {
  const saved = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/checkpoints`, headers: { ...agentHeaders, 'x-specmill-writer-token': 'a'.repeat(64) },
    payload: { requestId, expectedVersion: version, writerSessionId: session.resourceId, generation: session.generation, payload: { observationId, done: '完成初始化与观察', failures: '暂无', unverified: '续做流程未验证', blockers: '无', nextSteps: '工具 B 接手续做' } } });
  return saved;
}
const usedBytes = async (app: Awaited<ReturnType<typeof buildApp>>, projectId: string, ownerHeaders: Record<string, unknown>) => {
  const before = (await app.inject({ url: `/api/v1/projects/${projectId}/capacity`, headers: ownerHeaders })).json().records as { used: number };
  return before.used;
};

describe('fixed handoff snapshots', () => {
  it('captures a fixed snapshot, renders deterministically and counts toward capacity', async () => {
    const { app, projectId, workspaceId, changeId, ownerHeaders } = await setup();
    const session = await startSession(app, changeId, workspaceId, 'm1-start');
    const observed = await observe(app, workspaceId, 'm1-observe', session);
    expect(observed.statusCode).toBe(201);
    const observationId = observed.json().resourceId as string;
    const saved = await saveCheckpoint(app, changeId, 2, 'm1-checkpoint', observationId, session);
    expect(saved.statusCode).toBe(201);
    const beforeBytes = await usedBytes(app, projectId, ownerHeaders);
    const created = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/handoffs`, headers: agentHeaders, payload: { requestId: 'm1-snapshot' } });
    expect(created.statusCode).toBe(201);
    const snapshotId = created.json().resourceId as string;
    const afterBytes = await usedBytes(app, projectId, ownerHeaders);
    expect(afterBytes).toBeGreaterThan(beforeBytes);
    // 快照不改写变更版本，重放返回同一快照
    const change = (await app.inject({ url: `/api/v1/changes/${changeId}`, headers: ownerHeaders })).json() as { version: number };
    expect(change.version).toBe(3);
    const replay = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/handoffs`, headers: agentHeaders, payload: { requestId: 'm1-snapshot' } });
    expect(replay.json().resourceId).toBe(snapshotId);
    // 新的请求标识产生新的固定快照
    const second = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/handoffs`, headers: agentHeaders, payload: { requestId: 'm1-snapshot-2' } });
    expect(second.statusCode).toBe(201);
    expect(second.json().resourceId).not.toBe(snapshotId);
    // 读取与渲染固定内容
    const rendered = (await app.inject({ url: `/api/v1/handoffs/${snapshotId}/render`, headers: ownerHeaders })).json() as { markdown: string; sha256: string };
    expect(rendered.markdown).toContain('交接变更');
    expect(rendered.markdown).toContain('完成一次真实续做');
    expect(rendered.markdown).toContain('完成初始化与观察');
    expect(rendered.markdown).toContain('工具 B 接手续做');
    expect(rendered.markdown).toContain('未确认草案修订');
    expect(rendered.markdown).toContain('续做须知');
    expect(rendered.markdown).not.toContain('undefined');
    const again = (await app.inject({ url: `/api/v1/handoffs/${snapshotId}/render`, headers: ownerHeaders })).json() as { markdown: string };
    expect(again.markdown).toBe(rendered.markdown);
    // 变更推进后旧快照保持不变
    const patch = await app.inject({ method: 'PATCH', url: `/api/v1/changes/${changeId}`, headers: ownerHeaders,
      payload: { requestId: 'm1-edit', expectedVersion: 3, payload: { title: '交接变更', goal: '目标已修改', scope: '', nonGoals: '', criteria: [] } } });
    expect(patch.statusCode).toBe(200);
    const afterEdit = (await app.inject({ url: `/api/v1/handoffs/${snapshotId}/render`, headers: ownerHeaders })).json() as { markdown: string };
    expect(afterEdit.markdown).toBe(rendered.markdown);
    expect(afterEdit.markdown).not.toContain('目标已修改');
    const listed = (await app.inject({ url: `/api/v1/changes/${changeId}/handoffs`, headers: ownerHeaders })).json() as { snapshots: { id: string }[] };
    expect(listed.snapshots.map(item => item.id).sort()).toEqual([snapshotId, second.json().resourceId].sort());
  }, 20000);

  it('compares saved progress with real files and reports unsaved work without rolling back', async () => {
    const { app, repoDir, workspaceId, changeId, commit } = await setup();
    const session = await startSession(app, changeId, workspaceId, 'cont-start');
    const observed = await observe(app, workspaceId, 'cont-observe', session);
    const observationId = observed.json().resourceId as string;
    expect((await saveCheckpoint(app, changeId, 2, 'cont-checkpoint', observationId, session)).statusCode).toBe(201);
    const base = (await app.inject({ url: `/api/v1/changes/${changeId}/continuation/${workspaceId}`, headers: agentHeaders })).json() as { hasUnsavedChanges: boolean };
    expect(base.hasUnsavedChanges).toBe(false);
    // 保存点之后新增未提交修改：对比报告差异且不回滚文件
    await writeFile(join(repoDir, 'README.md'), '# 示例仓库\n\n工具 A 之后的新修改\n');
    await writeFile(join(repoDir, 'notes.txt'), '未跟踪的新文件\n');
    const diff = (await app.inject({ url: `/api/v1/changes/${changeId}/continuation/${workspaceId}`, headers: agentHeaders })).json() as {
      hasUnsavedChanges: boolean; diff: { headChanged: boolean; trackedDiffChanged: boolean | null; added: { path: string }[]; removed: { path: string }[] }; notice: string;
    };
    expect(diff.hasUnsavedChanges).toBe(true);
    expect(diff.diff.trackedDiffChanged).toBe(true);
    expect(diff.diff.added.map(item => item.path)).toContain('notes.txt');
    expect(diff.notice).toContain('不要自动回滚');
    expect(await readFile(join(repoDir, 'README.md'), 'utf8')).toContain('工具 A 之后的新修改');
    // 提交后 HEAD 前进同样被识别
    await writeFile(join(repoDir, 'README.md'), '# 示例仓库\n\n工具 A 之后的新修改\n');
    commit(['add', 'README.md']);
    commit(['commit', '-q', '-m', 'tool a work']);
    const committed = (await app.inject({ url: `/api/v1/changes/${changeId}/continuation/${workspaceId}`, headers: agentHeaders })).json() as { diff: { headChanged: boolean } };
    expect(committed.diff.headChanged).toBe(true);
    // 工作区目录被移动等身份变化会明确报错
    const missing = await app.inject({ url: `/api/v1/changes/${changeId}/continuation/not-a-workspace`, headers: agentHeaders });
    expect(missing.statusCode).toBe(404);
  }, 30000);

  it('renders through the CLI, refuses to overwrite files and keeps snapshots on output failure', async () => {
    const { app, dataDir, workspaceId, changeId, ownerHeaders } = await setup();
    await writeFile(join(dataDir, 'cli-token'), await encodeSecret('agent-token'), { mode: 0o600 });
    const session = await startSession(app, changeId, workspaceId, 'cli-start');
    const observed = await observe(app, workspaceId, 'cli-observe', session);
    const observationId = observed.json().resourceId as string;
    expect((await saveCheckpoint(app, changeId, 2, 'cli-checkpoint', observationId, session)).statusCode).toBe(201);
    const cli = (...args: string[]) => runFile(process.execPath, ['--import', 'tsx', resolve('src/cli/main.ts'), ...args, '--data-dir', dataDir, '--server', 'http://127.0.0.1:43227'], { timeout: 20000 });
    const created = await cli('handoff', 'create', '--change', changeId, '--request-id', 'cli-snapshot', '--json');
    const snapshotId = JSON.parse(created.stdout).resourceId as string;
    expect(snapshotId).toBeTruthy();
    const raw = await cli('handoff', 'show', '--snapshot', snapshotId);
    expect(raw.stdout).toContain('# SpecMill 交接材料');
    expect(raw.stdout).toContain('工具 B 接手续做');
    const outputFile = join(dataDir, 'handoff-material.md');
    const written = await cli('handoff', 'show', '--snapshot', snapshotId, '--file', outputFile, '--json');
    const meta = JSON.parse(written.stdout);
    expect(meta.file).toBeTruthy();
    const serverRendered = (await app.inject({ url: `/api/v1/handoffs/${snapshotId}/render`, headers: ownerHeaders })).json() as { markdown: string; sha256: string };
    expect(await readFile(outputFile, 'utf8')).toBe(serverRendered.markdown);
    expect(meta.sha256).toBe(serverRendered.sha256);
    // 已有文件不被静默覆盖；输出失败不影响快照的读取与渲染
    const refused = await cli('handoff', 'show', '--snapshot', snapshotId, '--file', outputFile, '--json').catch((error: { code: number; stderr: string }) => error);
    expect(refused.code).toBe(6);
    expect(JSON.parse(refused.stderr).code).toBe('OUTPUT_FILE_EXISTS');
    expect((await app.inject({ url: `/api/v1/handoffs/${snapshotId}/render`, headers: ownerHeaders })).statusCode).toBe(200);
    // 释放会话后（失效授权）工具仍能生成快照：快照不依赖写会话
    const release = await app.inject({ method: 'POST', url: `/api/v1/writer-sessions/${session.resourceId}/release`, headers: { ...agentHeaders, 'x-specmill-writer-token': 'a'.repeat(64) },
      payload: { requestId: 'cli-release', expectedVersion: 3, generation: session.generation } });
    expect(release.statusCode).toBe(200);
    const afterRelease = await cli('handoff', 'create', '--change', changeId, '--request-id', 'cli-snapshot-after-release', '--json');
    expect(JSON.parse(afterRelease.stdout).resourceId).toBeTruthy();
  }, 30000);

  it('rejects snapshots beyond capacity while existing snapshots stay readable', async () => {
    const { app, projectId, workspaceId, changeId, ownerHeaders } = await setup(12000);
    const session = await startSession(app, changeId, workspaceId, 'budget-start');
    const observed = await observe(app, workspaceId, 'budget-observe', session);
    const observationId = observed.json().resourceId as string;
    expect((await saveCheckpoint(app, changeId, 2, 'budget-checkpoint', observationId, session)).statusCode).toBe(201);
    const created = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/handoffs`, headers: agentHeaders, payload: { requestId: 'budget-snapshot' } });
    expect(created.statusCode).toBe(201);
    const snapshotId = created.json().resourceId as string;
    const capacity = async () => (await app.inject({ url: `/api/v1/projects/${projectId}/capacity`, headers: ownerHeaders })).json().records as { used: number; limit: number };
    const remaining = async () => { const budget = await capacity(); return budget.limit - budget.used; };
    const probe = await capacity();
    const firstFill = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
      payload: { requestId: 'budget-fill-0', expectedVersion: null, payload: { title: '填充', goal: '', scope: '', nonGoals: '', criteria: [] } } });
    expect(firstFill.statusCode).toBe(201);
    const perFill = (await capacity()).used - probe.used;
    const beforeTakeoverBytes = await remaining();
    await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
      payload: { requestId: 'budget-fill-1', expectedVersion: null, payload: { title: '填充', goal: 'x'.repeat(Math.max(0, Math.floor((beforeTakeoverBytes - 100 - perFill) / 2))), scope: '', nonGoals: '', criteria: [] } } });
    expect(await remaining()).toBeLessThan(110);
    const rejected = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/handoffs`, headers: agentHeaders, payload: { requestId: 'budget-snapshot-2' } });
    expect(rejected.statusCode).toBe(413);
    expect(rejected.json().code).toBe('PROJECT_CAPACITY_EXCEEDED');
    // 超限拒绝不影响既有保存点与快照的读取和渲染
    expect((await app.inject({ url: `/api/v1/changes/${changeId}/checkpoints`, headers: ownerHeaders })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/v1/changes/${changeId}/handoffs`, headers: ownerHeaders })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/v1/handoffs/${snapshotId}/render`, headers: ownerHeaders })).statusCode).toBe(200);
    // 请求标识未被污染，释放容量后可重试
    expect((await app.inject({ url: '/api/v1/receipts/budget-snapshot-2', headers: ownerHeaders })).statusCode).toBe(404);
  }, 30000);
});
