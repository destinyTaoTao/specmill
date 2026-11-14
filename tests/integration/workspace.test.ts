import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildApp } from '../../src/server/app.js';
import Database from 'better-sqlite3';

const dirs: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const headers = { host: '127.0.0.1:43127', origin: 'http://127.0.0.1:43127' };
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup(maxProjectRecordsBytes?: number) {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-workspace-data-')); dirs.push(dataDir);
  const repoParent = await mkdtemp(join(tmpdir(), 'specmill-中文 space-')); dirs.push(repoParent);
  const repoDir = join(repoParent, 'repo 中文'); await mkdir(repoDir);
  const result = spawnSync('git', ['-C', repoDir, 'init', '-q'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } });
  if (result.status !== 0) throw new Error(result.stderr);
  const app = await buildApp({ dataDir, port: 43127, ownerToken: 'owner-token', agentToken: 'agent-token', maxProjectRecordsBytes }); apps.push(app);
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
  const ownerHeaders = { ...headers, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
  const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: ownerHeaders, payload: { name: '工作区项目', requestId: 'create-project' } });
  expect(project.statusCode).toBe(201);
  return { app, repoDir, dataDir, ownerHeaders, projectId: project.json().resourceId as string };
}
async function addWorktree(repoDir: string) {
  const parent = await mkdtemp(join(tmpdir(), 'specmill-worktree-')); dirs.push(parent);
  await writeFile(join(repoDir, 'sample.txt'), 'sample');
  const run = (args: string[]) => {
    const result = spawnSync('git', ['-C', repoDir, '-c', 'user.name=SpecMill Test', '-c', 'user.email=specmill@example.invalid', '-c', 'core.hooksPath=NUL', ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  run(['add', 'sample.txt']);
  run(['commit', '-qm', 'test']);
  const worktree = join(parent, '第二个 worktree');
  run(['worktree', 'add', '-q', '-b', 'test-other', worktree]);
  return worktree;
}

describe('workspace binding', () => {
  it('backs up and preserves existing T1 data before upgrading storage', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'specmill-migration-')); dirs.push(dataDir);
    const old = new Database(join(dataDir, 'specmill.db'));
    old.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE requests (request_id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id)); INSERT INTO projects VALUES ('existing', '旧项目', '2026-01-01T00:00:00.000Z'); PRAGMA user_version = 1");
    old.close();
    const app = await buildApp({ dataDir, port: 43127, ownerToken: 'owner-token', agentToken: 'agent-token' }); apps.push(app);
    const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
    const list = await app.inject({ url: '/api/v1/projects', headers: { ...headers, cookie: login.headers['set-cookie'] as string } });
    expect(list.json().projects).toEqual([expect.objectContaining({ id: 'existing', name: '旧项目' })]);
    const backups = await readdir(join(dataDir, 'backups'));
    expect(backups).toHaveLength(1);
    const backup = new Database(join(dataDir, 'backups', backups[0]), { readonly: true });
    try {
      expect(backup.pragma('user_version', { simple: true })).toBe(1);
      expect(backup.prepare('SELECT name FROM projects WHERE id = ?').get('existing')).toEqual({ name: '旧项目' });
    } finally { backup.close(); }
  });

  it('upgrades an earlier workspace schema without losing bindings', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'specmill-v2-migration-')); dirs.push(dataDir);
    const old = new Database(join(dataDir, 'specmill.db'));
    old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE requests (request_id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id));
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), path TEXT NOT NULL, path_key TEXT NOT NULL UNIQUE, common_dir TEXT NOT NULL, common_key TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE workspace_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, resource_id TEXT NOT NULL REFERENCES workspaces(id), record_version INTEGER NOT NULL, committed_at TEXT NOT NULL);
      INSERT INTO projects VALUES ('project-old', '旧项目', '2026-01-01T00:00:00.000Z');
      INSERT INTO workspaces VALUES ('workspace-old', 'project-old', 'old-path', 'old-path', 'old-common', 'old-common', 1, '2026-01-01T00:00:00.000Z');
      PRAGMA user_version = 2`);
    old.prepare('INSERT INTO workspace_requests VALUES (?,?,?,?,?)').run('old-request', JSON.stringify(['project-old', null, null, 'old-path']), 'workspace-old', 1, '2026-01-01T00:00:00.000Z');
    old.close();
    const app = await buildApp({ dataDir, port: 43127, ownerToken: 'owner-token', agentToken: 'agent-token' }); apps.push(app);
    const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
    const ownerHeaders = { ...headers, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const list = await app.inject({ url: '/api/v1/projects/project-old/workspaces', headers: ownerHeaders });
    expect(list.json().workspaces).toEqual([expect.objectContaining({ id: 'workspace-old', path: 'old-path', version: 1 })]);
    const capacity = await app.inject({ url: '/api/v1/projects/project-old/capacity', headers: ownerHeaders });
    expect(capacity.statusCode).toBe(200);
    const retry = await app.inject({ method: 'POST', url: '/api/v1/projects/project-old/workspaces', headers: ownerHeaders,
      payload: { requestId: 'old-request', expectedVersion: null, payload: { workspaceId: null, path: 'old-path' } } });
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual({ requestId: 'old-request', resourceId: 'workspace-old', recordVersion: 1, committedAt: '2026-01-01T00:00:00.000Z' });
    const backups = await readdir(join(dataDir, 'backups'));
    expect(backups).toHaveLength(1);
    const backup = new Database(join(dataDir, 'backups', backups[0]), { readonly: true });
    try { expect(backup.pragma('user_version', { simple: true })).toBe(2); } finally { backup.close(); }
  });
  it('binds and reads an existing Git directory with Chinese and spaces', async () => {
    const { app, repoDir, ownerHeaders, projectId } = await setup();
    const create = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders,
      payload: { requestId: 'bind-1', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toEqual({ requestId: 'bind-1', resourceId: expect.any(String), recordVersion: 1, committedAt: expect.any(String) });
    const list = await app.inject({ url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders });
    expect(list.statusCode).toBe(200);
    expect(list.json().workspaces).toEqual([expect.objectContaining({ id: create.json().resourceId, path: await realpath(repoDir), version: 1 })]);
  });

  it('replays concurrent identical binding requests and rejects a duplicate directory alias', async () => {
    const { app, repoDir, ownerHeaders, projectId } = await setup();
    const url = `/api/v1/projects/${projectId}/workspaces`;
    const payload = { requestId: 'bind-retry', expectedVersion: null, payload: { workspaceId: null, path: repoDir } };
    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url, headers: ownerHeaders, payload }),
      app.inject({ method: 'POST', url, headers: ownerHeaders, payload }),
    ]);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    const alias = join(dirname(repoDir), 'workspace alias');
    await symlink(repoDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const duplicate = await app.inject({ method: 'POST', url, headers: ownerHeaders, payload: { ...payload, requestId: 'bind-alias', payload: { ...payload.payload, path: alias } } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe('WORKSPACE_EXISTS');
    const list = await app.inject({ url, headers: ownerHeaders });
    expect(list.json().workspaces).toHaveLength(1);
  });

  it('rejects reuse of a workspace request ID for a different command', async () => {
    const { app, repoDir, ownerHeaders, projectId } = await setup();
    const bind = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders,
      payload: { requestId: 'shared-request', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
    expect(bind.statusCode).toBe(201);
    const create = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: ownerHeaders,
      payload: { name: '不同命令', requestId: 'shared-request' } });
    expect(create.statusCode).toBe(409);
    expect(create.json().code).toBe('REQUEST_ID_CONFLICT');
  });

  it('rebinds to a worktree from the same repository with version checks', async () => {
    const { app, repoDir, ownerHeaders, projectId } = await setup();
    const worktree = await addWorktree(repoDir);
    const url = `/api/v1/projects/${projectId}/workspaces`;
    const bind = await app.inject({ method: 'POST', url, headers: ownerHeaders,
      payload: { requestId: 'first-binding', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
    expect(bind.statusCode).toBe(201);
    const observation = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${bind.json().resourceId}/observations`, headers: ownerHeaders,
      payload: { requestId: 'before-rebind', expectedBindingVersion: 1, selectedUntracked: [] } });
    expect(observation.statusCode).toBe(201);
    const payload = { requestId: 'move-binding', expectedVersion: 1, payload: { workspaceId: bind.json().resourceId, path: worktree } };
    const updated = await app.inject({ method: 'POST', url, headers: ownerHeaders, payload });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ requestId: 'move-binding', resourceId: bind.json().resourceId, recordVersion: 2, committedAt: expect.any(String) });
    const replay = await app.inject({ method: 'POST', url, headers: ownerHeaders, payload });
    expect(replay.json()).toEqual(updated.json());
    const stale = await app.inject({ method: 'POST', url, headers: ownerHeaders, payload: { ...payload, requestId: 'stale-binding' } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual(expect.objectContaining({ code: 'VERSION_CONFLICT', currentVersion: 2 }));
    const list = await app.inject({ url, headers: ownerHeaders });
    expect(list.json().workspaces).toEqual([expect.objectContaining({ id: bind.json().resourceId, path: await realpath(worktree), version: 2 })]);
    const history = await app.inject({ url: `/api/v1/workspaces/${bind.json().resourceId}/observations/${observation.json().resourceId}`, headers: ownerHeaders });
    expect(history.json()).toEqual(expect.objectContaining({ path: await realpath(repoDir), bindingVersion: 1 }));
  });

  it('rebinds a moved repository when its recorded commit is present', async () => {
    const { app, repoDir, ownerHeaders, projectId } = await setup();
    await addWorktree(repoDir);
    const url = `/api/v1/projects/${projectId}/workspaces`;
    const bind = await app.inject({ method: 'POST', url, headers: ownerHeaders,
      payload: { requestId: 'before-move', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
    const workspaceId = bind.json().resourceId as string;
    const observation = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/observations`, headers: ownerHeaders,
      payload: { requestId: 'before-move-observation', expectedBindingVersion: 1, selectedUntracked: [] } });
    const oldObservation = await app.inject({ url: `/api/v1/workspaces/${workspaceId}/observations/${observation.json().resourceId}`, headers: ownerHeaders });
    expect(oldObservation.json().head).toMatch(/^[0-9a-f]{40}$/);
    const repoParent = dirname(repoDir);
    const movedDir = join(repoParent, 'repo moved');
    if (dirname(resolve(repoDir)) !== resolve(repoParent) || dirname(resolve(movedDir)) !== resolve(repoParent)) throw new Error('Invalid test move target');
    await rename(repoDir, movedDir);
    const rebound = await app.inject({ method: 'POST', url, headers: ownerHeaders,
      payload: { requestId: 'after-move', expectedVersion: 1, payload: { workspaceId, path: movedDir } } });
    expect(rebound.statusCode).toBe(200);
    const history = await app.inject({ url: `/api/v1/workspaces/${workspaceId}/observations/${observation.json().resourceId}`, headers: ownerHeaders });
    expect(history.json()).toEqual(expect.objectContaining({ path: oldObservation.json().path, head: oldObservation.json().head, bindingVersion: 1 }));
  });

  it('requires explicit confirmation for a moved repository without recorded commits', async () => {
    const { app, repoDir, ownerHeaders, projectId } = await setup();
    const url = `/api/v1/projects/${projectId}/workspaces`;
    const bind = await app.inject({ method: 'POST', url, headers: ownerHeaders,
      payload: { requestId: 'empty-before-move', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
    const movedDir = join(dirname(repoDir), 'repo moved');
    if (dirname(resolve(repoDir)) !== dirname(resolve(movedDir))) throw new Error('Invalid test move target');
    await rename(repoDir, movedDir);
    const payload = { requestId: 'empty-moved', expectedVersion: 1, payload: { workspaceId: bind.json().resourceId, path: movedDir } };
    const unconfirmed = await app.inject({ method: 'POST', url, headers: ownerHeaders, payload });
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json().code).toBe('REPOSITORY_UNVERIFIED');
    const confirmed = await app.inject({ method: 'POST', url, headers: ownerHeaders,
      payload: { ...payload, requestId: 'empty-moved-confirmed', payload: { ...payload.payload, confirmUnverified: true } } });
    expect(confirmed.statusCode).toBe(200);
  });

  it('does not treat an unrelated repository as a moved repository when a recorded commit is missing', async () => {
    const { app, repoDir, ownerHeaders, projectId } = await setup();
    await addWorktree(repoDir);
    const url = `/api/v1/projects/${projectId}/workspaces`;
    const bind = await app.inject({ method: 'POST', url, headers: ownerHeaders,
      payload: { requestId: 'unrelated-bind', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
    const workspaceId = bind.json().resourceId as string;
    const observation = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/observations`, headers: ownerHeaders,
      payload: { requestId: 'unrelated-observation', expectedBindingVersion: 1, selectedUntracked: [] } });
    expect(observation.statusCode).toBe(201);
    const parent = dirname(repoDir);
    const moved = join(parent, 'repo moved');
    const unrelated = join(parent, 'unrelated');
    if ([repoDir, moved, unrelated].some(path => dirname(resolve(path)) !== resolve(parent))) throw new Error('Invalid test paths');
    await rename(repoDir, moved);
    await mkdir(unrelated);
    const init = spawnSync('git', ['-C', unrelated, 'init', '-q'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } });
    if (init.status !== 0) throw new Error(init.stderr);
    const rejected = await app.inject({ method: 'POST', url, headers: ownerHeaders,
      payload: { requestId: 'unrelated-rebind', expectedVersion: 1, payload: { workspaceId, path: unrelated, confirmUnverified: true } } });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().code).toBe('REPOSITORY_MISMATCH');
  });

  it('rejects a binding over the project capacity without saving a partial binding or receipt', async () => {
    const { app, repoDir, ownerHeaders, projectId } = await setup(800);
    const url = `/api/v1/projects/${projectId}/workspaces`;
    const payload = { requestId: 'over-budget', expectedVersion: null, payload: { workspaceId: null, path: repoDir } };
    const rejected = await app.inject({ method: 'POST', url, headers: ownerHeaders, payload });
    expect(rejected.statusCode).toBe(413);
    expect(rejected.json()).toEqual(expect.objectContaining({ code: 'PROJECT_CAPACITY_EXCEEDED', dimension: 'records', limit: 800, used: expect.any(Number), requestedIncrement: expect.any(Number) }));
    const retry = await app.inject({ method: 'POST', url, headers: ownerHeaders, payload });
    expect(retry.statusCode).toBe(413);
    expect((await app.inject({ url, headers: ownerHeaders })).json().workspaces).toEqual([]);
    const capacity = await app.inject({ url: `/api/v1/projects/${projectId}/capacity`, headers: ownerHeaders });
    expect(capacity.statusCode).toBe(200);
    expect(capacity.json()).toEqual(expect.objectContaining({ records: expect.objectContaining({ limit: 800, used: expect.any(Number) }) }));
  });

  it('records an observation of an unborn repository and a selected untracked file', async () => {
    const { app, repoDir, ownerHeaders, projectId } = await setup();
    await writeFile(join(repoDir, '未提交.txt'), 'unfinished');
    const bind = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders,
      payload: { requestId: 'observe-bind', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
    const workspaceId = bind.json().resourceId as string;
    const observe = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/observations`, headers: ownerHeaders,
      payload: { requestId: 'observation-1', expectedBindingVersion: 1, selectedUntracked: ['未提交.txt'] } });
    expect(observe.statusCode).toBe(201);
    const result = await app.inject({ url: `/api/v1/workspaces/${workspaceId}/observations/${observe.json().resourceId}`, headers: ownerHeaders });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(expect.objectContaining({ workspaceId, bindingVersion: 1, head: null, dirty: true, stable: true,
      files: expect.arrayContaining([expect.objectContaining({ path: '未提交.txt', status: '??', sha256: '9b569cd062350ef2205068fc6eab4dee71ba9dc7d7855ce4815fde7aee7f5787' })]),
    }));
    const replay = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/observations`, headers: ownerHeaders,
      payload: { requestId: 'observation-1', expectedBindingVersion: 1, selectedUntracked: ['未提交.txt'] } });
    expect(replay.json()).toEqual(observe.json());
    const observations = await app.inject({ url: `/api/v1/workspaces/${workspaceId}/observations`, headers: ownerHeaders });
    expect(observations.json().observations).toEqual([expect.objectContaining({ id: observe.json().resourceId, head: null, bindingVersion: 1 })]);
    await rm(repoDir, { recursive: true, force: true });
    const history = await app.inject({ url: `/api/v1/workspaces/${workspaceId}/observations/${observe.json().resourceId}`, headers: ownerHeaders });
    expect(history.statusCode).toBe(200);
    const unavailable = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/observations`, headers: ownerHeaders,
      payload: { requestId: 'observation-missing', expectedBindingVersion: 1, selectedUntracked: [] } });
    expect(unavailable.statusCode).toBe(503);
  });

  it('refuses to create temporary Git data inside the observed workspace', async () => {
    const { app, repoDir, ownerHeaders, projectId } = await setup();
    const bind = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders,
      payload: { requestId: 'inside-temp-bind', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
    const oldTemp = process.env.TEMP;
    const oldTmp = process.env.TMP;
    process.env.TEMP = repoDir;
    process.env.TMP = repoDir;
    try {
      const result = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${bind.json().resourceId}/observations`, headers: ownerHeaders,
        payload: { requestId: 'inside-temp-observation', expectedBindingVersion: 1, selectedUntracked: [] } });
      expect(result.statusCode).toBe(503);
      expect(result.json().code).toBe('OBSERVATION_TEMP_INSIDE_WORKSPACE');
    } finally {
      if (oldTemp === undefined) delete process.env.TEMP; else process.env.TEMP = oldTemp;
      if (oldTmp === undefined) delete process.env.TMP; else process.env.TMP = oldTmp;
    }
  });

  it('does not scan a separate Git metadata directory inside the worktree', async () => {
    const { app, ownerHeaders, projectId } = await setup();
    const repoDir = await mkdtemp(join(tmpdir(), 'specmill-separate-git-')); dirs.push(repoDir);
    const gitDir = join(repoDir, 'Private-Git-Metadata');
    const init = spawnSync('git', ['init', '-q', '--separate-git-dir', gitDir, repoDir], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } });
    if (init.status !== 0) throw new Error(init.stderr);
    await writeFile(join(gitDir, 'private-marker'), 'private');
    const bind = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders,
      payload: { requestId: 'separate-bind', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
    expect(bind.statusCode).toBe(201);
    const observe = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${bind.json().resourceId}/observations`, headers: ownerHeaders,
      payload: { requestId: 'separate-observe', expectedBindingVersion: 1, selectedUntracked: [] } });
    expect(observe.statusCode).toBe(201);
    const result = await app.inject({ url: `/api/v1/workspaces/${bind.json().resourceId}/observations/${observe.json().resourceId}`, headers: ownerHeaders });
    expect(result.json().files.some((file: { path: string }) => file.path.startsWith('Private-Git-Metadata/'))).toBe(false);
  });

  it('respects a repository configured to check out symlinks as regular files', async () => {
    const { app, repoDir, ownerHeaders, projectId } = await setup();
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' };
    const run = (args: string[], input?: string) => {
      const result = spawnSync('git', ['-C', repoDir, '-c', 'user.name=SpecMill Test', '-c', 'user.email=specmill@example.invalid', '-c', 'core.hooksPath=NUL', ...args], { encoding: 'utf8', env, input });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    run(['config', '--local', 'core.symlinks', 'false']);
    await writeFile(join(repoDir, 'link.txt'), 'target');
    const object = run(['hash-object', '-w', '--stdin'], 'target');
    run(['update-index', '--add', '--cacheinfo', `120000,${object},link.txt`]);
    run(['commit', '-qm', 'symlink']);
    expect(run(['status', '--porcelain'])).toBe('');
    const bind = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders,
      payload: { requestId: 'symlink-bind', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
    const observe = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${bind.json().resourceId}/observations`, headers: ownerHeaders,
      payload: { requestId: 'symlink-observe', expectedBindingVersion: 1, selectedUntracked: [] } });
    expect(observe.statusCode).toBe(201);
    const result = await app.inject({ url: `/api/v1/workspaces/${bind.json().resourceId}/observations/${observe.json().resourceId}`, headers: ownerHeaders });
    expect(result.json().dirty).toBe(false);
  }, 15000);

  it('detects tracked changes without changing the repository', async () => {
    const { app, repoDir, ownerHeaders, projectId } = await setup();
    await addWorktree(repoDir);
    const url = `/api/v1/projects/${projectId}/workspaces`;
    const bind = await app.inject({ method: 'POST', url, headers: ownerHeaders,
      payload: { requestId: 'tracked-bind', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
    const workspaceId = bind.json().resourceId as string;
    const observe = async (requestId: string) => {
      const response = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/observations`, headers: ownerHeaders,
        payload: { requestId, expectedBindingVersion: 1, selectedUntracked: [] } });
      expect(response.statusCode).toBe(201);
      return (await app.inject({ url: `/api/v1/workspaces/${workspaceId}/observations/${response.json().resourceId}`, headers: ownerHeaders })).json();
    };
    const clean = await observe('tracked-clean');
    expect(clean.dirty).toBe(false);
    await writeFile(join(repoDir, 'sample.txt'), 'local edit');
    const dirty = await observe('tracked-dirty');
    expect(dirty.dirty).toBe(true);
    expect(dirty.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'sample.txt', status: ' M' })]));
    expect(dirty.trackedDiffSha256).not.toBe(clean.trackedDiffSha256);
    expect(await readFile(join(repoDir, 'sample.txt'), 'utf8')).toBe('local edit');
  }, 15000);

  it('does not run a repository clean filter while observing files', async () => {
    const { app, repoDir, ownerHeaders, projectId } = await setup();
    await addWorktree(repoDir);
    const marker = join(repoDir, 'filter-executed.txt');
    const command = `"${process.execPath.replaceAll('\\', '/')}" -e "require('fs').writeFileSync(process.argv[1], 'executed');process.stdin.pipe(process.stdout)" "${marker.replaceAll('\\', '/')}"`;
    for (const key of ['filter.specmill-test.clean', 'filter.specmill-test.process']) {
      const configure = spawnSync('git', ['-C', repoDir, 'config', '--local', key, command], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } });
      if (configure.status !== 0) throw new Error(configure.stderr);
    }
    await writeFile(join(repoDir, '.gitattributes'), 'sample.txt filter=specmill-test\n');
    await writeFile(join(repoDir, 'sample.txt'), 'modified');
    const bind = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders,
      payload: { requestId: 'filter-bind', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
    const traceFile = join(repoDir, 'trace-output.txt');
    const previousTrace = process.env.git_trace;
    process.env.git_trace = traceFile;
    let observe;
    try {
      observe = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${bind.json().resourceId}/observations`, headers: ownerHeaders,
        payload: { requestId: 'filter-observe', expectedBindingVersion: 1, selectedUntracked: [] } });
    } finally {
      if (previousTrace === undefined) delete process.env.git_trace;
      else process.env.git_trace = previousTrace;
    }
    expect(observe.statusCode).toBe(201);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(traceFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const record = await app.inject({ url: `/api/v1/workspaces/${bind.json().resourceId}/observations/${observe.json().resourceId}`, headers: ownerHeaders });
    expect(record.json().limitations).toEqual(expect.arrayContaining([expect.stringContaining('过滤器')]));
  });

  it('does not enter a submodule or run its private filters', async () => {
    const { app, repoDir, ownerHeaders, projectId } = await setup();
    await addWorktree(repoDir);
    const childDir = await mkdtemp(join(tmpdir(), 'specmill-submodule-')); dirs.push(childDir);
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' };
    const run = (directory: string, args: string[]) => {
      const result = spawnSync('git', ['-C', directory, '-c', 'user.name=SpecMill Test', '-c', 'user.email=specmill@example.invalid', '-c', 'core.hooksPath=NUL', '-c', 'protocol.file.allow=always', ...args], { encoding: 'utf8', env });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    run(childDir, ['init', '-q']);
    await writeFile(join(childDir, 'child.txt'), 'child');
    run(childDir, ['add', 'child.txt']);
    run(childDir, ['commit', '-qm', 'test']);
    run(repoDir, ['submodule', 'add', '-q', childDir, 'nested']);
    run(repoDir, ['commit', '-qam', 'add submodule']);
    const nested = join(repoDir, 'nested');
    const marker = join(nested, 'filter-executed.txt');
    const command = `"${process.execPath.replaceAll('\\', '/')}" -e "require('fs').writeFileSync(process.argv[1], 'executed');process.stdin.pipe(process.stdout)" "${marker.replaceAll('\\', '/')}"`;
    run(nested, ['config', '--local', 'filter.specmill-test.clean', command]);
    await writeFile(join(nested, '.gitattributes'), 'child.txt filter=specmill-test\n');
    await writeFile(join(nested, 'child.txt'), 'modified');
    const bind = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders,
      payload: { requestId: 'submodule-bind', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
    const observe = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${bind.json().resourceId}/observations`, headers: ownerHeaders,
      payload: { requestId: 'submodule-observe', expectedBindingVersion: 1, selectedUntracked: [] } });
    expect(observe.statusCode).toBe(201);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const record = await app.inject({ url: `/api/v1/workspaces/${bind.json().resourceId}/observations/${observe.json().resourceId}`, headers: ownerHeaders });
    expect(record.json().limitations).toEqual(expect.arrayContaining([expect.stringContaining('子模块')]));
  }, 15000);
});
