import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildApp } from '../../src/server/app.js';

const dirs: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const headers = { host: '127.0.0.1:43127', origin: 'http://127.0.0.1:43127' };
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-baseline-data-')); dirs.push(dataDir);
  const repoDir = await mkdtemp(join(tmpdir(), 'specmill-baseline-repo-')); dirs.push(repoDir);
  const init = spawnSync('git', ['-C', repoDir, 'init', '-q'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } });
  if (init.status !== 0) throw new Error(init.stderr);
  await writeFile(join(repoDir, '需求.md'), '# 目标\n允许跨会话续做。\n\n# 附加\n其他内容。\n');
  const app = await buildApp({ dataDir, port: 43127, ownerToken: 'owner-token', agentToken: 'agent-token' }); apps.push(app);
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
  const ownerHeaders = { ...headers, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
  const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: ownerHeaders, payload: { name: '基线项目', requestId: 'baseline-project' } });
  const projectId = project.json().resourceId as string;
  const bind = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders,
    payload: { requestId: 'baseline-workspace', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
  const create = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
    payload: { requestId: 'baseline-change', expectedVersion: null, payload: { title: '续做', goal: '接着开发', scope: '本机', nonGoals: '多人', criteria: ['能保存进度'] } } });
  return { app, repoDir, projectId, ownerHeaders, workspaceId: bind.json().resourceId as string, changeId: create.json().resourceId as string };
}

describe('specification baseline', () => {
  it('freezes explicitly selected Markdown and retains it when the source changes', async () => {
    const { app, repoDir, projectId, ownerHeaders, workspaceId, changeId } = await setup();
    const preview = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/spec-preview`, headers: ownerHeaders,
      payload: { expectedBindingVersion: 1, path: '需求.md' } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual(expect.objectContaining({ path: '需求.md', head: null, committed: false, content: expect.stringContaining('允许跨会话续做。'), sha256: expect.any(String) }));
    const adopt = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/baselines`, headers: ownerHeaders,
      payload: { requestId: 'adopt-1', expectedVersion: 1, payload: { workspaceId, expectedBindingVersion: 1, path: '需求.md', expectedSha256: preview.json().sha256, selection: '允许跨会话续做。', criterionLinks: [null], previousSourceItemId: null } } });
    expect(adopt.statusCode).toBe(201);
    const baselineId = adopt.json().resourceId;
    await writeFile(join(repoDir, '需求.md'), '# 修改后的来源\n');
    const baseline = await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${baselineId}`, headers: ownerHeaders });
    expect(baseline.statusCode).toBe(200);
    expect(baseline.json()).toEqual(expect.objectContaining({ id: baselineId, selection: '允许跨会话续做。', sourceCommitted: false,
      criteria: [expect.objectContaining({ text: '能保存进度', id: expect.any(String), revisionId: expect.any(String) })] }));
    const list = await app.inject({ url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders });
    expect(list.json().changes).toEqual([expect.objectContaining({ id: changeId, phase: 'Working', version: 2, baselineId })]);
    const history = await app.inject({ url: `/api/v1/changes/${changeId}/transitions`, headers: ownerHeaders });
    expect(history.json().transitions).toEqual([expect.objectContaining({ from: 'Draft', to: 'Working', cycle: 1, recordVersion: 2 })]);
    const status = await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${baselineId}/source-status`, headers: ownerHeaders });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ status: 'changed' });
  });

  it('adopts a new baseline only after explicit criterion matching', async () => {
    const { app, ownerHeaders, workspaceId, changeId } = await setup();
    const preview = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/spec-preview`, headers: ownerHeaders,
      payload: { expectedBindingVersion: 1, path: '需求.md' } });
    const source = { workspaceId, expectedBindingVersion: 1, path: '需求.md', expectedSha256: preview.json().sha256, selection: '允许跨会话续做。' };
    const first = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/baselines`, headers: ownerHeaders,
      payload: { requestId: 'baseline-first', expectedVersion: 1, payload: { ...source, criterionLinks: [null], previousSourceItemId: null } } });
    expect(first.statusCode).toBe(201);
    const original = await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${first.json().resourceId}`, headers: ownerHeaders });
    const update = await app.inject({ method: 'PATCH', url: `/api/v1/changes/${changeId}`, headers: ownerHeaders,
      payload: { requestId: 'working-draft-update', expectedVersion: 2, payload: { title: '续做', goal: '尚未采用的新目标', scope: '本机', nonGoals: '多人', criteria: ['能恢复已保存的进度'] } } });
    expect(update.statusCode).toBe(200);
    const context = await app.inject({ url: `/api/v1/changes/${changeId}`, headers: ownerHeaders });
    expect(context.json().draft.goal).toBe('尚未采用的新目标');
    expect(context.json().basis).toEqual(expect.objectContaining({ kind: 'baseline', goal: '接着开发', id: first.json().resourceId }));
    const second = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/baselines`, headers: ownerHeaders,
      payload: { requestId: 'baseline-second', expectedVersion: 3, payload: { ...source, criterionLinks: [original.json().criteria[0].id], previousSourceItemId: original.json().sourceItemId } } });
    expect(second.statusCode).toBe(201);
    const adopted = await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${second.json().resourceId}`, headers: ownerHeaders });
    expect(adopted.json().sourceItemId).toBe(original.json().sourceItemId);
    expect(adopted.json().criteria[0].id).toBe(original.json().criteria[0].id);
    expect(adopted.json().criteria[0].revisionId).not.toBe(original.json().criteria[0].revisionId);
    expect(adopted.json().criteria[0].text).toBe('能恢复已保存的进度');
    expect((await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${first.json().resourceId}`, headers: ownerHeaders })).json()).toEqual(original.json());
  });

  it('lets two changes explicitly share an item while keeping immutable independent revisions', async () => {
    const { app, repoDir, projectId, ownerHeaders, workspaceId, changeId } = await setup();
    const preview = () => app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/spec-preview`, headers: ownerHeaders, payload: { expectedBindingVersion: 1, path: '需求.md' } });
    const firstPreview = await preview();
    const first = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/baselines`, headers: ownerHeaders,
      payload: { requestId: 'shared-a', expectedVersion: 1, payload: { workspaceId, expectedBindingVersion: 1, path: '需求.md', expectedSha256: firstPreview.json().sha256, selection: '允许跨会话续做。', criterionLinks: [null], previousSourceItemId: null } } });
    expect(first.statusCode).toBe(201);
    const a = (await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${first.json().resourceId}`, headers: ownerHeaders })).json();
    expect(a.sourceRevisionId).toEqual(expect.any(String));
    const createB = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
      payload: { requestId: 'shared-create-b', expectedVersion: null, payload: { title: '续做', goal: '其他目标', scope: '本机', nonGoals: '多人', criteria: ['第二变更的条件'] } } });
    const bId = createB.json().resourceId as string;
    await writeFile(join(repoDir, '需求.md'), '# 目标\n允许跨工具续做。\n');
    const secondPreview = await preview();
    const source = { workspaceId, expectedBindingVersion: 1, path: '需求.md', expectedSha256: secondPreview.json().sha256, selection: '允许跨工具续做。', criterionLinks: [null], previousSourceItemId: a.sourceItemId, previousSourceRevisionId: a.sourceRevisionId };
    const bad = await app.inject({ method: 'POST', url: `/api/v1/changes/${bId}/baselines`, headers: ownerHeaders,
      payload: { requestId: 'shared-b-bad', expectedVersion: 1, payload: { ...source, previousSourceRevisionId: 'unknown' } } });
    expect(bad.statusCode).toBe(409);
    const catalog = await app.inject({ url: `/api/v1/projects/${projectId}/spec-items`, headers: ownerHeaders });
    expect(catalog.json().revisions).toContainEqual(expect.objectContaining({ sourceItemId: a.sourceItemId, sourceRevisionId: a.sourceRevisionId, selection: a.selection }));
    const second = await app.inject({ method: 'POST', url: `/api/v1/changes/${bId}/baselines`, headers: ownerHeaders,
      payload: { requestId: 'shared-b', expectedVersion: 1, payload: source } });
    expect(second.statusCode).toBe(201);
    const b = (await app.inject({ url: `/api/v1/changes/${bId}/baselines/${second.json().resourceId}`, headers: ownerHeaders })).json();
    expect(b.sourceItemId).toBe(a.sourceItemId);
    expect(b.sourceRevisionId).not.toBe(a.sourceRevisionId);
    expect((await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${first.json().resourceId}`, headers: ownerHeaders })).json()).toEqual(a);
    const changes = (await app.inject({ url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders })).json().changes;
    expect(changes).toEqual(expect.arrayContaining([expect.objectContaining({ id: changeId, baselineId: first.json().resourceId }), expect.objectContaining({ id: bId, baselineId: second.json().resourceId })]));
  }, 15000);

  it('distinguishes committed, modified and untracked Markdown sources', async () => {
    const { app, repoDir, ownerHeaders, workspaceId } = await setup();
    const run = (args: string[]) => {
      const result = spawnSync('git', ['-C', repoDir, '-c', 'user.name=SpecMill Test', '-c', 'user.email=specmill@example.invalid', '-c', 'core.hooksPath=NUL', ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    run(['add', '需求.md']); run(['commit', '-qm', 'test']);
    const preview = (path: string) => app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/spec-preview`, headers: ownerHeaders, payload: { expectedBindingVersion: 1, path } });
    expect((await preview('需求.md')).json().committed).toBe(true);
    await writeFile(join(repoDir, '需求.md'), 'modified');
    expect((await preview('需求.md')).json().committed).toBe(null);
    await writeFile(join(repoDir, 'new.md'), 'new');
    expect((await preview('new.md')).json().committed).toBe(false);
  }, 15000);

  it('rejects stale previews and replays a successful adoption without rereading the file', async () => {
    const { app, repoDir, ownerHeaders, workspaceId, changeId } = await setup();
    const preview = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/spec-preview`, headers: ownerHeaders,
      payload: { expectedBindingVersion: 1, path: '需求.md' } });
    const payload = { requestId: 'stale-adoption', expectedVersion: 1, payload: { workspaceId, expectedBindingVersion: 1, path: '需求.md', expectedSha256: preview.json().sha256, selection: '允许跨会话续做。', criterionLinks: [null], previousSourceItemId: null } };
    await writeFile(join(repoDir, '需求.md'), '# 新内容\n');
    const stale = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/baselines`, headers: ownerHeaders, payload });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('SOURCE_CHANGED');
    const fresh = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/spec-preview`, headers: ownerHeaders,
      payload: { expectedBindingVersion: 1, path: '需求.md' } });
    const command = { ...payload, requestId: 'fresh-adoption', payload: { ...payload.payload, expectedSha256: fresh.json().sha256, selection: '# 新内容' } };
    const saved = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/baselines`, headers: ownerHeaders, payload: command });
    expect(saved.statusCode).toBe(201);
    await rm(join(repoDir, '需求.md'));
    const retry = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/baselines`, headers: ownerHeaders, payload: command });
    expect(retry.json()).toEqual(saved.json());
    const conflict = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/baselines`, headers: ownerHeaders,
      payload: { ...command, payload: { ...command.payload, selection: '不同内容' } } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('REQUEST_ID_CONFLICT');
  }, 15000);

  it('does not read a Markdown source outside the workspace', async () => {
    const { app, ownerHeaders, workspaceId } = await setup();
    const preview = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/spec-preview`, headers: ownerHeaders,
      payload: { expectedBindingVersion: 1, path: '../outside.md' } });
    expect(preview.statusCode).toBe(400);
    expect(preview.json().code).toBe('INVALID_SPEC_SOURCE');
  });

  it('preserves CRLF excerpts and rejects ranges that split an emoji', async () => {
    const { app, repoDir, ownerHeaders, workspaceId, changeId } = await setup();
    await writeFile(join(repoDir, '需求.md'), '第一行😀\r\n第二行\r\n');
    const preview = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/spec-preview`, headers: ownerHeaders, payload: { expectedBindingVersion: 1, path: '需求.md' } });
    const base = { workspaceId, expectedBindingVersion: 1, path: '需求.md', expectedSha256: preview.json().sha256, criterionLinks: [null], previousSourceItemId: null };
    const split = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/baselines`, headers: ownerHeaders,
      payload: { requestId: 'split-surrogate', expectedVersion: 1, payload: { ...base, selectionRange: { start: 3, end: 4 } } } });
    expect(split.statusCode).toBe(400);
    const blank = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/baselines`, headers: ownerHeaders,
      payload: { requestId: 'blank-selection', expectedVersion: 1, payload: { ...base, selection: '\n' } } });
    expect(blank.statusCode).toBe(400);
    const saved = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/baselines`, headers: ownerHeaders,
      payload: { requestId: 'crlf-selection', expectedVersion: 1, payload: { ...base, selection: '第一行😀\n第二行' } } });
    expect(saved.statusCode).toBe(201);
    const baseline = await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${saved.json().resourceId}`, headers: ownerHeaders });
    expect(baseline.json().selection).toBe('第一行😀\r\n第二行');
    const replay = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/baselines`, headers: ownerHeaders,
      payload: { expectedVersion: 1, requestId: 'crlf-selection', payload: { selection: '第一行😀\n第二行', previousSourceItemId: null, criterionLinks: [null], expectedSha256: preview.json().sha256, path: '需求.md', expectedBindingVersion: 1, workspaceId } } });
    expect(replay.json()).toEqual(saved.json());
  }, 15000);

  it('freezes a large source using a bounded range request', async () => {
    const { app, repoDir, ownerHeaders, workspaceId, changeId } = await setup();
    const content = `# 目标\n${'a'.repeat(1100000)}\n`;
    await writeFile(join(repoDir, '需求.md'), content);
    const preview = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/spec-preview`, headers: ownerHeaders, payload: { expectedBindingVersion: 1, path: '需求.md' } });
    const saved = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/baselines`, headers: ownerHeaders,
      payload: { requestId: 'large-selection', expectedVersion: 1, payload: { workspaceId, expectedBindingVersion: 1, path: '需求.md', expectedSha256: preview.json().sha256, selectionRange: { start: 0, end: content.length }, criterionLinks: [null], previousSourceItemId: null } } });
    expect(saved.statusCode).toBe(201);
    const baseline = await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${saved.json().resourceId}`, headers: ownerHeaders });
    expect(baseline.json().selection).toBe(content);
  }, 20000);

  it('requires confirming the existing baseline when reopening a canceled working change', async () => {
    const { app, ownerHeaders, projectId, workspaceId, changeId } = await setup();
    const preview = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/spec-preview`, headers: ownerHeaders, payload: { expectedBindingVersion: 1, path: '需求.md' } });
    const first = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/baselines`, headers: ownerHeaders,
      payload: { requestId: 'working-baseline', expectedVersion: 1, payload: { workspaceId, expectedBindingVersion: 1, path: '需求.md', expectedSha256: preview.json().sha256, selection: '允许跨会话续做。', criterionLinks: [null], previousSourceItemId: null } } });
    const canceled = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/cancel`, headers: ownerHeaders,
      payload: { requestId: 'working-cancel', expectedVersion: 2, payload: { reason: '暂停' } } });
    expect(canceled.statusCode).toBe(200);
    const unconfirmed = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/reopen`, headers: ownerHeaders,
      payload: { requestId: 'working-reopen-unconfirmed', expectedVersion: 3, payload: {} } });
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json().code).toBe('BASELINE_CONFIRMATION_REQUIRED');
    const reopened = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/reopen`, headers: ownerHeaders,
      payload: { requestId: 'working-reopen', expectedVersion: 3, payload: { baselineId: first.json().resourceId } } });
    expect(reopened.statusCode).toBe(200);
    const list = await app.inject({ url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders });
    expect(list.json().changes).toEqual([expect.objectContaining({ id: changeId, phase: 'Working', cycle: 2, baselineId: first.json().resourceId })]);
  }, 15000);
});
