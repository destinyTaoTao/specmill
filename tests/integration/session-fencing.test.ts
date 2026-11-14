import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildApp } from '../../src/server/app.js';

const dirs: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const headers = { host: '127.0.0.1:43127', origin: 'http://127.0.0.1:43127' };
const agentHeaders = { host: headers.host, authorization: 'Bearer agent-token' };
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup(maxProjectRecordsBytes?: number) {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-session-data-')); dirs.push(dataDir);
  const repoDir = await mkdtemp(join(tmpdir(), 'specmill-session-repo-')); dirs.push(repoDir);
  const result = spawnSync('git', ['-C', repoDir, 'init', '-q'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } });
  if (result.status !== 0) throw new Error(result.stderr);
  const app = await buildApp({ dataDir, port: 43127, ownerToken: 'owner-token', agentToken: 'agent-token', maxProjectRecordsBytes }); apps.push(app);
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
  const ownerHeaders = { ...headers, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
  const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: ownerHeaders, payload: { name: '会话项目', requestId: 'session-project' } });
  const projectId = project.json().resourceId as string;
  const workspace = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders,
    payload: { requestId: 'session-workspace', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
  const workspaceId = workspace.json().resourceId as string;
  const createChange = async (name: string) => app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
    payload: { requestId: `create-${name}`, expectedVersion: null, payload: { title: name, goal: '', scope: '', nonGoals: '', criteria: [] } } });
  const changeId = (await createChange('一')).json().resourceId as string;
  return { app, dataDir, repoDir, projectId, workspaceId, changeId, createChange, ownerHeaders };
}
function start(app: Awaited<ReturnType<typeof buildApp>>, changeId: string, workspaceId: string, requestId: string, writerToken = 'a'.repeat(64)) {
  return app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/writer-sessions`, headers: { ...agentHeaders, 'x-specmill-writer-token': writerToken },
    payload: { requestId, expectedVersion: 1, payload: { workspaceId, expectedBindingVersion: 1, toolLabel: '工具 A' } } });
}

describe('writer sessions', () => {
  it('atomically claims a draft and workspace, and requires the session grant to release', async () => {
    const { app, projectId, workspaceId, changeId, repoDir, createChange, ownerHeaders } = await setup();
    const [a, b] = await Promise.all([start(app, changeId, workspaceId, 'start-a'), start(app, changeId, workspaceId, 'start-b')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const grant = (a.statusCode === 201 ? a : b).json();
    expect(grant).toEqual(expect.objectContaining({ resourceId: expect.any(String), generation: 1, recordVersion: 2 }));
    expect(grant).not.toHaveProperty('writerToken');
    const winningRequest = a.statusCode === 201 ? 'start-a' : 'start-b';
    const impersonation = await start(app, changeId, workspaceId, winningRequest, 'b'.repeat(64));
    expect(impersonation.statusCode).toBe(403);
    const replayStart = await start(app, changeId, workspaceId, winningRequest);
    expect(replayStart.json()).toEqual(grant);
    const change2 = (await createChange('二')).json().resourceId as string;
    const occupied = await start(app, change2, workspaceId, 'occupied');
    expect(occupied.statusCode).toBe(409);
    const rebind = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders,
      payload: { requestId: 'blocked-rebind', expectedVersion: 1, payload: { workspaceId, path: repoDir } } });
    expect(rebind.statusCode).toBe(409);
    expect(rebind.json().code).toBe('WORKSPACE_IN_USE');
    const releasePayload = { requestId: 'release-a', expectedVersion: 2, generation: grant.generation };
    const denied = await app.inject({ method: 'POST', url: `/api/v1/writer-sessions/${grant.resourceId}/release`, headers: agentHeaders, payload: releasePayload });
    expect(denied.statusCode).toBe(403);
    const release = await app.inject({ method: 'POST', url: `/api/v1/writer-sessions/${grant.resourceId}/release`, headers: { ...agentHeaders, 'x-specmill-writer-token': 'a'.repeat(64) }, payload: releasePayload });
    expect(release.statusCode).toBe(200);
    expect(release.json().recordVersion).toBe(3);
    const replay = await app.inject({ method: 'POST', url: `/api/v1/writer-sessions/${grant.resourceId}/release`, headers: { ...agentHeaders, 'x-specmill-writer-token': 'a'.repeat(64) }, payload: releasePayload });
    expect(replay.json()).toEqual(release.json());
    expect((await start(app, change2, workspaceId, 'start-after-release')).statusCode).toBe(201);
  }, 15000);

  it('invalidates active grants on restart while retaining session history', async () => {
    const { app, dataDir, workspaceId, changeId } = await setup();
    const first = await start(app, changeId, workspaceId, 'before-restart');
    expect(first.statusCode).toBe(201);
    const grant = first.json();
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const restarted = await buildApp({ dataDir, port: 43127, ownerToken: 'owner-token', agentToken: 'agent-token' }); apps.push(restarted);
    const history = await restarted.inject({ url: `/api/v1/changes/${changeId}/writer-sessions`, headers: agentHeaders });
    expect(history.json().sessions).toEqual([expect.objectContaining({ id: grant.resourceId, status: 'interrupted' })]);
    const stale = await restarted.inject({ method: 'POST', url: `/api/v1/writer-sessions/${grant.resourceId}/release`, headers: { ...agentHeaders, 'x-specmill-writer-token': 'a'.repeat(64) },
      payload: { requestId: 'old-grant', expectedVersion: 2, generation: grant.generation } });
    expect(stale.statusCode).toBe(409);
  }, 15000);

  it('returns a release receipt after restart without reviving the grant', async () => {
    const { app, dataDir, workspaceId, changeId } = await setup();
    const started = await start(app, changeId, workspaceId, 'release-before-restart');
    const grant = started.json();
    const release = { requestId: 'released-before-restart', expectedVersion: 2, generation: grant.generation };
    const authorized = { ...agentHeaders, 'x-specmill-writer-token': 'a'.repeat(64) };
    const first = await app.inject({ method: 'POST', url: `/api/v1/writer-sessions/${grant.resourceId}/release`, headers: authorized, payload: release });
    expect(first.statusCode).toBe(200);
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const restarted = await buildApp({ dataDir, port: 43127, ownerToken: 'owner-token', agentToken: 'agent-token' }); apps.push(restarted);
    const replay = await restarted.inject({ method: 'POST', url: `/api/v1/writer-sessions/${grant.resourceId}/release`, headers: authorized, payload: release });
    expect(replay.json()).toEqual(first.json());
    const other = await restarted.inject({ method: 'POST', url: `/api/v1/writer-sessions/${grant.resourceId}/release`, headers: authorized, payload: { ...release, requestId: 'different-release' } });
    expect(other.statusCode).toBe(409);
  }, 15000);

  it('reserves capacity to release even when the project approaches its limit', async () => {
    const { app, projectId, workspaceId, changeId, ownerHeaders } = await setup(8000);
    const started = await start(app, changeId, workspaceId, 'bounded-start');
    expect(started.statusCode).toBe(201);
    const capacity = async () => (await app.inject({ url: `/api/v1/projects/${projectId}/capacity`, headers: ownerHeaders })).json().records as { used: number; limit: number };
    const beforeFill = await capacity();
    let length = Math.max(0, Math.floor((beforeFill.limit - beforeFill.used - 600) / 2));
    let inserted = false;
    for (let attempt = 0; attempt < 20 && !inserted; attempt++) {
      const result = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
        payload: { requestId: 'fill-budget', expectedVersion: null, payload: { title: '容量填充', goal: 'x'.repeat(length), scope: '', nonGoals: '', criteria: [] } } });
      if (result.statusCode === 201) inserted = true;
      else { expect(result.statusCode).toBe(413); length = Math.max(0, length - 100); }
    }
    expect(inserted).toBe(true);
    const filled = await capacity();
    expect(filled.limit - filled.used).toBeLessThan(900);
    const released = await app.inject({ method: 'POST', url: `/api/v1/writer-sessions/${started.json().resourceId}/release`, headers: { ...agentHeaders, 'x-specmill-writer-token': 'a'.repeat(64) },
      payload: { requestId: '\u0001'.repeat(128), expectedVersion: 2, generation: 1 } });
    expect(released.statusCode).toBe(200);
    expect((await capacity()).used).toBeLessThanOrEqual(filled.limit);
  }, 15000);

  it('lets only the user take over, fences the old grant and requires release before rebinding', async () => {
    const { app, projectId, workspaceId, changeId, repoDir, ownerHeaders } = await setup();
    const started = await start(app, changeId, workspaceId, 'takeover-start');
    const old = started.json();
    const payload = { requestId: 'takeover', expectedVersion: 2, payload: { writerSessionId: old.resourceId, expectedGeneration: 1, expectedCheckpointId: null, toolLabel: 'Web 接管' } };
    const forbidden = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/writer-sessions/takeover`, headers: agentHeaders, payload });
    expect(forbidden.statusCode).toBe(403);
    const stale = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/writer-sessions/takeover`, headers: ownerHeaders,
      payload: { ...payload, requestId: 'takeover-stale', payload: { ...payload.payload, expectedCheckpointId: 'unknown' } } });
    expect(stale.statusCode).toBe(409);
    const takeover = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/writer-sessions/takeover`, headers: ownerHeaders, payload });
    expect(takeover.statusCode).toBe(201);
    expect(takeover.json()).toEqual(expect.objectContaining({ generation: 2, recordVersion: 3 }));
    const oldRelease = await app.inject({ method: 'POST', url: `/api/v1/writer-sessions/${old.resourceId}/release`, headers: { ...agentHeaders, 'x-specmill-writer-token': 'a'.repeat(64) },
      payload: { requestId: 'late-release', expectedVersion: 3, generation: 1 } });
    expect(oldRelease.statusCode).toBe(409);
    const rebindBody = { requestId: 'after-takeover-rebind', expectedVersion: 1, payload: { workspaceId, path: repoDir } };
    expect((await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders, payload: rebindBody })).json().code).toBe('WORKSPACE_IN_USE');
    const release = await app.inject({ method: 'POST', url: `/api/v1/writer-sessions/${takeover.json().resourceId}/release`, headers: ownerHeaders,
      payload: { requestId: 'takeover-release', expectedVersion: 3, generation: 2 } });
    expect(release.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders, payload: rebindBody })).statusCode).toBe(200);
  }, 15000);

  it('takes over near the capacity limit and rolls back atomically when the increment does not fit', async () => {
    const { app, projectId, workspaceId, changeId, ownerHeaders } = await setup(8000);
    const started = await start(app, changeId, workspaceId, 'bounded-start');
    expect(started.statusCode).toBe(201);
    const capacity = async () => (await app.inject({ url: `/api/v1/projects/${projectId}/capacity`, headers: ownerHeaders })).json().records as { used: number; limit: number };
    const remaining = async () => { const budget = await capacity(); return budget.limit - budget.used; };
    const fill = async (tag: string, goalLength: number) => {
      const result = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
        payload: { requestId: `fill-${tag}`, expectedVersion: null, payload: { title: '容量填充', goal: 'x'.repeat(goalLength), scope: '', nonGoals: '', criteria: [] } } });
      expect(result.statusCode).toBe(201);
    };
    const takeover = (requestId: string, session: { resourceId: string }, generation: number, expectedVersion: number) =>
      app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/writer-sessions/takeover`, headers: ownerHeaders,
        payload: { requestId, expectedVersion, payload: { writerSessionId: session.resourceId, expectedGeneration: generation, expectedCheckpointId: null, toolLabel: '接管' } } });
    // 先测量一次最小变更的容量增量，再校准填充到剩余约 1800 字节
    const beforeProbe = await capacity();
    await fill('0000', 0);
    const perFill = (await capacity()).used - beforeProbe.used;
    await fill('0001', Math.max(0, Math.floor((await remaining() - 1800 - perFill) / 2)));
    const beforeTakeover = await remaining();
    expect(beforeTakeover).toBeGreaterThan(0);
    // 接管前后都占用一个活跃会话：接近上限时接管仍应成功
    const nearLimit = await takeover('near-limit-takeover', started.json(), 1, 2);
    expect(nearLimit.statusCode).toBe(201);
    const second = nearLimit.json();
    expect(second.generation).toBe(2);
    const increment = beforeTakeover - await remaining();
    // 填充到剩余不足一次接管的开销（旧会话历史、新会话与回执）后应 413
    const gap = await remaining();
    if (gap >= perFill) {
      const extra = gap - perFill - Math.floor(increment / 2);
      await fill('0002', extra >= 0 ? Math.floor(extra / 2) : 0);
    }
    expect(await remaining()).toBeLessThan(increment);
    const rejected = await takeover('tight-takeover', second, 2, 3);
    expect(rejected.statusCode).toBe(413);
    expect(rejected.json()).toEqual(expect.objectContaining({ code: 'PROJECT_CAPACITY_EXCEEDED', dimension: 'records', limit: 8000 }));
    // 回执未记录、会话历史与变更版本未前进，撤销是原子的
    expect((await app.inject({ url: '/api/v1/receipts/tight-takeover', headers: ownerHeaders })).statusCode).toBe(404);
    const history = await app.inject({ url: `/api/v1/changes/${changeId}/writer-sessions`, headers: agentHeaders });
    expect(history.json().sessions).toEqual([
      expect.objectContaining({ id: second.resourceId, generation: 2, status: 'active' }),
      expect.objectContaining({ id: started.json().resourceId, generation: 1, status: 'taken_over' }),
    ]);
    // 释放由活跃会话预留保证可行，用户在回滚后仍有恢复路径
    const release = await app.inject({ method: 'POST', url: `/api/v1/writer-sessions/${second.resourceId}/release`, headers: ownerHeaders,
      payload: { requestId: 'after-rejected-release', expectedVersion: 3, generation: 2 } });
    expect(release.statusCode).toBe(200);
  }, 20000);
});
