import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app.js';

const dirs: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const headers = { host: '127.0.0.1:43127', origin: 'http://127.0.0.1:43127' };
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup(maxProjectRecordsBytes?: number) {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-change-')); dirs.push(dataDir);
  const options = { dataDir, port: 43127, ownerToken: 'owner-token', agentToken: 'agent-token', maxProjectRecordsBytes };
  const app = await buildApp(options); apps.push(app);
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
  const ownerHeaders = { ...headers, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
  const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: ownerHeaders, payload: { name: '草案项目', requestId: 'project-create' } });
  return { app, dataDir, options, ownerHeaders, projectId: project.json().resourceId as string };
}
const draft = { title: '跨会话续做', goal: '记录当前进度', scope: '个人项目', nonGoals: '多人审批', criteria: ['可以读取保存点'] };

describe('change draft', () => {
  it('creates a draft visible from its project after restart', async () => {
    const { app, options, ownerHeaders, projectId } = await setup();
    const create = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
      payload: { requestId: 'draft-create', expectedVersion: null, payload: draft } });
    expect(create.statusCode).toBe(201);
    const receipt = create.json();
    expect(receipt).toEqual({ requestId: 'draft-create', resourceId: expect.any(String), recordVersion: 1, committedAt: expect.any(String) });
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const next = await buildApp(options); apps.push(next);
    const login = await next.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
    const nextHeaders = { ...headers, cookie: login.headers['set-cookie'] as string };
    const response = await next.inject({ url: `/api/v1/projects/${projectId}/changes`, headers: nextHeaders });
    expect(response.statusCode).toBe(200);
    expect(response.json().changes).toEqual([expect.objectContaining({ id: receipt.resourceId, phase: 'Draft', version: 1, ...draft })]);
  });

  it('updates a draft with version checks and preserves the original revision', async () => {
    const { app, ownerHeaders, projectId } = await setup();
    const create = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
      payload: { requestId: 'draft-create', expectedVersion: null, payload: draft } });
    const changeId = create.json().resourceId as string;
    const payload = { requestId: 'draft-update', expectedVersion: 1, payload: { ...draft, goal: '明确续做目标' } };
    const update = await app.inject({ method: 'PATCH', url: `/api/v1/changes/${changeId}`, headers: ownerHeaders, payload });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toEqual({ requestId: 'draft-update', resourceId: changeId, recordVersion: 2, committedAt: expect.any(String) });
    const retry = await app.inject({ method: 'PATCH', url: `/api/v1/changes/${changeId}`, headers: ownerHeaders, payload });
    expect(retry.json()).toEqual(update.json());
    const stale = await app.inject({ method: 'PATCH', url: `/api/v1/changes/${changeId}`, headers: ownerHeaders, payload: { ...payload, requestId: 'stale-update' } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual(expect.objectContaining({ code: 'VERSION_CONFLICT', currentVersion: 2 }));
    const history = await app.inject({ url: `/api/v1/changes/${changeId}/revisions`, headers: ownerHeaders });
    expect(history.json().revisions).toEqual([
      expect.objectContaining({ version: 1, goal: '记录当前进度' }),
      expect.objectContaining({ version: 2, goal: '明确续做目标' }),
    ]);
  });

  it('cancels a draft with a reason and reopens it in a new draft cycle', async () => {
    const { app, ownerHeaders, projectId } = await setup();
    const create = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
      payload: { requestId: 'draft-create', expectedVersion: null, payload: draft } });
    const changeId = create.json().resourceId as string;
    const cancelPayload = { requestId: 'draft-cancel', expectedVersion: 1, payload: { reason: '暂缓' } };
    const canceled = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/cancel`, headers: ownerHeaders, payload: cancelPayload });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json().recordVersion).toBe(2);
    const canceledAgain = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/cancel`, headers: ownerHeaders, payload: cancelPayload });
    expect(canceledAgain.json()).toEqual(canceled.json());
    const edit = await app.inject({ method: 'PATCH', url: `/api/v1/changes/${changeId}`, headers: ownerHeaders,
      payload: { requestId: 'after-cancel', expectedVersion: 2, payload: draft } });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().code).toBe('INVALID_STATE');
    const reopened = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/reopen`, headers: ownerHeaders,
      payload: { requestId: 'draft-reopen', expectedVersion: 2, payload: {} } });
    expect(reopened.statusCode).toBe(200);
    const list = await app.inject({ url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders });
    expect(list.json().changes).toEqual([expect.objectContaining({ id: changeId, phase: 'Draft', cycle: 2, version: 3, goal: draft.goal })]);
    const history = await app.inject({ url: `/api/v1/changes/${changeId}/transitions`, headers: ownerHeaders });
    expect(history.json().transitions).toEqual([
      expect.objectContaining({ from: 'Draft', to: 'Canceled', reason: '暂缓', cycle: 1 }),
      expect.objectContaining({ from: 'Canceled', to: 'Draft', cycle: 2 }),
    ]);
  });

  it('does not save an oversized UTF-8 draft or advance its project budget', async () => {
    const { app, ownerHeaders, projectId } = await setup(1100);
    const before = await app.inject({ url: `/api/v1/projects/${projectId}/capacity`, headers: ownerHeaders });
    const command = { requestId: 'large-draft', expectedVersion: null, payload: { ...draft, goal: '中文"'.repeat(400) } };
    const rejected = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders, payload: command });
    expect(rejected.statusCode).toBe(413);
    expect(rejected.json().code).toBe('PROJECT_CAPACITY_EXCEEDED');
    const retry = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders, payload: command });
    expect(retry.statusCode).toBe(413);
    const after = await app.inject({ url: `/api/v1/projects/${projectId}/capacity`, headers: ownerHeaders });
    expect(after.json()).toEqual(before.json());
    const list = await app.inject({ url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders });
    expect(list.json().changes).toEqual([]);
  });

  it('accepts only one of two edits based on the same draft version', async () => {
    const { app, ownerHeaders, projectId } = await setup();
    const create = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
      payload: { requestId: 'draft-create', expectedVersion: null, payload: draft } });
    const changeId = create.json().resourceId as string;
    const [first, second] = await Promise.all(['one', 'two'].map(value => app.inject({ method: 'PATCH', url: `/api/v1/changes/${changeId}`, headers: ownerHeaders,
      payload: { requestId: `draft-${value}`, expectedVersion: 1, payload: { ...draft, goal: value } } })));
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    const history = await app.inject({ url: `/api/v1/changes/${changeId}/revisions`, headers: ownerHeaders });
    expect(history.json().revisions).toHaveLength(2);
  });
});
