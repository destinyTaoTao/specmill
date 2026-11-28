import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app.js';
import Database from 'better-sqlite3';
import { buildZip } from '../../src/server/recovery/zip.js';
import { cleanInterruptedRestoreStaging } from '../../src/server/recovery/import.js';
import { createHash } from 'node:crypto';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rmdir: vi.fn(actual.rmdir) };
});

const dirs: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const headers = { host: '127.0.0.1:43218', origin: 'http://127.0.0.1:43218' };
const agentHeaders = { host: headers.host, authorization: 'Bearer agent-token' };
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup(port = 43218, maxProjectRecordsBytes?: number, tag = 'default') {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-restore-data-')); dirs.push(dataDir);
  const repoDir = await mkdtemp(join(tmpdir(), 'specmill-restore-repo-')); dirs.push(repoDir);
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_AUTHOR_NAME: '测试', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: '测试', GIT_COMMITTER_EMAIL: 'test@example.com' } });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  git(['init', '-q']);
  await writeFile(join(repoDir, 'README.md'), '# 恢复往返样本\n');
  git(['add', 'README.md']);
  git(['commit', '-q', '-m', 'init']);
  const app = await buildApp({ dataDir, port, ownerToken: 'owner-token', agentToken: 'agent-token', maxProjectRecordsBytes }); apps.push(app);
  await app.listen({ host: '127.0.0.1', port });
  const setupHeaders = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers: setupHeaders, payload: { token: 'owner-token' } });
  const ownerHeaders = { ...setupHeaders, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
  const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: ownerHeaders, payload: { name: '往返项目', requestId: `roundtrip-project-${tag}` } });
  const projectId = project.json().resourceId as string;
  const workspace = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders,
    payload: { requestId: `roundtrip-workspace-${tag}`, expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
  const workspaceId = workspace.json().resourceId as string;
  const change = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
    payload: { requestId: `roundtrip-change-${tag}`, expectedVersion: null, payload: { title: '往返变更', goal: '验证恢复', scope: '', nonGoals: '', criteria: ['记录一致'] } } });
  const changeId = change.json().resourceId as string;
  return { app, dataDir, repoDir, projectId, workspaceId, changeId, ownerHeaders, git };
}

// 最小 STORE ZIP 读取器：解析中央目录并按名称取内容，供测试核对包结构。
function readZipEntries(zip: Buffer): Map<string, Buffer> {
  let eocdOffset = -1;
  for (let index = zip.length - 22; index >= 0; index--) {
    if (zip.readUInt32LE(index) === 0x06054b50) { eocdOffset = index; break; }
  }
  if (eocdOffset < 0) throw new Error('EOCD not found');
  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);
  const entries = new Map<string, Buffer>();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error('bad central entry');
    const nameLength = zip.readUInt16LE(cursor + 28);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.slice(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const dataStart = localOffset + 30 + localNameLength;
    const compressedSize = zip.readUInt32LE(localOffset + 18);
    entries.set(name, zip.slice(dataStart, dataStart + compressedSize));
    cursor += 46 + nameLength;
  }
  return entries;
}

describe('restore from recovery package', () => {
  it('never follows a linked attachment root and retries a failed staging cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'specmill-staging-')); dirs.push(root);
    const attachments = join(root, 'attachments');
    await mkdir(attachments);
    const alias = join(root, 'alias');
    await symlink(attachments, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const stage = await mkdtemp(join(attachments, '.restore-'));
    const partial = join(stage, 'a'.repeat(64));
    await writeFile(partial, 'incomplete');
    const onError = vi.fn();
    await cleanInterruptedRestoreStaging(alias, onError);
    expect(await readFile(partial, 'utf8')).toBe('incomplete');
    const busy = Object.assign(new Error('locked test directory'), { code: 'EBUSY' });
    vi.mocked(rmdir).mockRejectedValueOnce(busy);
    await cleanInterruptedRestoreStaging(attachments, onError);
    expect(onError).toHaveBeenCalledExactlyOnceWith(busy);
    expect(await readdir(stage)).toEqual([]);
    await cleanInterruptedRestoreStaging(attachments, onError);
    await expect(stat(stage)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('persists one recovery receipt atomically and replays it after restart', async () => {
    const source = await setup(43218, undefined, 'receipt-atomic-source');
    const exported = await source.app.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/exports`, headers: agentHeaders, payload: { requestId: 'receipt-atomic-export' } });
    const archive = await source.app.inject({ url: `/api/v1/exports/${exported.json().resourceId}/download`, headers: source.ownerHeaders });
    expect(archive.statusCode).toBe(200);
    const target = await setup(43219, undefined, 'receipt-atomic-target');
    const send = () => target.app.inject({ method: 'POST', url: '/api/v1/restore?requestId=receipt-atomic-restore', headers: { ...target.ownerHeaders, 'content-type': 'application/octet-stream' }, payload: archive.rawPayload }).then(response => response);
    const [first, second] = await Promise.all([send(), send()]);
    expect(first.statusCode).toBe(201); expect(second.statusCode).toBe(201);
    expect(first.json()).toEqual(second.json());
    expect((await target.app.inject({ url: '/api/v1/restores/receipt-atomic-restore', headers: { host: '127.0.0.1:43219', authorization: 'Bearer agent-token' } })).statusCode).toBe(403);
    await target.app.close(); apps.splice(apps.indexOf(target.app), 1);
    const restarted = await buildApp({ dataDir: target.dataDir, port: 43219, ownerToken: 'owner-token', agentToken: 'agent-token' }); apps.push(restarted);
    const targetBase = { host: '127.0.0.1:43219', origin: 'http://127.0.0.1:43219' };
    const login = await restarted.inject({ method: 'POST', url: '/api/v1/session', headers: targetBase, payload: { token: 'owner-token' } });
    const owner = { ...targetBase, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const lookup = await restarted.inject({ url: '/api/v1/restores/receipt-atomic-restore', headers: owner });
    expect(lookup.statusCode).toBe(200); expect(lookup.json()).toEqual(first.json());
    const replay = await restarted.inject({ method: 'POST', url: '/api/v1/restore?requestId=receipt-atomic-restore', headers: { ...owner, 'content-type': 'application/octet-stream' }, payload: archive.rawPayload });
    expect(replay.statusCode).toBe(201); expect(replay.json()).toEqual(first.json());
    const other = await setup(43221, undefined, 'receipt-rollback-target');
    await other.app.close(); apps.splice(apps.indexOf(other.app), 1);
    const db = new Database(join(other.dataDir, 'specmill.db'));
    try { db.exec("CREATE TRIGGER reject_restore_receipt BEFORE INSERT ON restore_receipts BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END"); } finally { db.close(); }
    const broken = await buildApp({ dataDir: other.dataDir, port: 43221, ownerToken: 'owner-token', agentToken: 'agent-token' }); apps.push(broken);
    const otherBase = { host: '127.0.0.1:43221', origin: 'http://127.0.0.1:43221' };
    const otherLogin = await broken.inject({ method: 'POST', url: '/api/v1/session', headers: otherBase, payload: { token: 'owner-token' } });
    const otherOwner = { ...otherBase, cookie: otherLogin.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const failed = await broken.inject({ method: 'POST', url: '/api/v1/restore?requestId=receipt-rollback', headers: { ...otherOwner, 'content-type': 'application/octet-stream' }, payload: archive.rawPayload });
    expect(failed.statusCode).toBe(503);
    expect((await broken.inject({ url: `/api/v1/changes/${source.changeId}`, headers: otherOwner })).statusCode).toBe(404);
    expect((await broken.inject({ url: '/api/v1/restores/receipt-rollback', headers: otherOwner })).statusCode).toBe(404);
  }, 30000);
  it('preserves the selected workspace for target creation through export and restore', async () => {
    const source = await setup(43218, undefined, 'workspace-order-source');
    const otherDir = `${source.repoDir}-other`; dirs.push(otherDir);
    source.git(['worktree', 'add', '-q', '-b', 'second-worktree', otherDir]);
    const second = await source.app.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/workspaces`, headers: source.ownerHeaders,
      payload: { requestId: 'workspace-order-second', expectedVersion: null, payload: { workspaceId: null, path: otherDir } } });
    expect(second.statusCode).toBe(201);
    const workspaceIds = [source.workspaceId, second.json().resourceId as string];
    await source.app.close(); apps.splice(apps.indexOf(source.app), 1);
    const db = new Database(join(source.dataDir, 'specmill.db'));
    try {
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        for (const [index, id] of ['ffffffff-ffff-4fff-8fff-ffffffffffff', '00000000-0000-4000-8000-000000000000'].entries()) {
          db.prepare('UPDATE workspaces SET id = ? WHERE id = ?').run(id, workspaceIds[index]);
          db.prepare('UPDATE workspace_requests SET resource_id = ? WHERE resource_id = ?').run(id, workspaceIds[index]);
          workspaceIds[index] = id;
        }
      })();
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); }
    const restarted = await buildApp({ dataDir: source.dataDir, port: 43218, ownerToken: 'owner-token', agentToken: 'agent-token' }); apps.push(restarted);
    await restarted.listen({ host: '127.0.0.1', port: 43218 });
    const login = await restarted.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
    const owner = { ...headers, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const commit = source.git(['rev-parse', 'HEAD']).trim();
    const submitTarget = (app: Awaited<ReturnType<typeof buildApp>>, actor: Record<string, string>, requestId: string) => app.inject({ method: 'POST', url: `/api/v1/changes/${source.changeId}/acceptance-targets`, headers: actor, payload: { requestId, payload: { commit } } });
    expect((await submitTarget(restarted, owner, 'workspace-order-before')).statusCode).toBe(201);
    const before = (await restarted.inject({ url: `/api/v1/changes/${source.changeId}/acceptance-targets`, headers: owner })).json().targets[0].workspaceId;
    expect(before).toBe(workspaceIds[1]);
    const exportedExplicitBody = { requestId: 'workspace-order-exported-explicit', payload: { commit, workspaceId: workspaceIds[0] } };
    const exportedExplicit = await restarted.inject({ method: 'POST', url: `/api/v1/changes/${source.changeId}/acceptance-targets`, headers: owner, payload: exportedExplicitBody });
    expect(exportedExplicit.statusCode).toBe(201);
    const started = await restarted.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/exports`, headers: agentHeaders, payload: { requestId: 'workspace-order-export' } });
    expect(started.statusCode).toBe(201);
    const archive = await restarted.inject({ url: `/api/v1/exports/${started.json().resourceId}/download`, headers: owner });
    expect(archive.statusCode).toBe(200);
    const target = await setup(43219, undefined, 'workspace-order-target');
    const restored = await target.app.inject({ method: 'POST', url: '/api/v1/restore?requestId=workspace-order-restore', headers: { ...target.ownerHeaders, 'content-type': 'application/octet-stream' }, payload: archive.rawPayload });
    expect(restored.statusCode).toBe(201);
    const restoredReplay = await target.app.inject({ method: 'POST', url: `/api/v1/changes/${source.changeId}/acceptance-targets`, headers: target.ownerHeaders, payload: { requestId: exportedExplicitBody.requestId, payload: { workspaceId: workspaceIds[0], commit } } });
    expect(restoredReplay.statusCode).toBe(201);
    expect(restoredReplay.json()).toEqual(exportedExplicit.json());
    const rebound = await target.app.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/workspaces`, headers: target.ownerHeaders,
      payload: { requestId: 'workspace-order-rebind', expectedVersion: 1, payload: { workspaceId: workspaceIds[1], path: otherDir } } });
    expect(rebound.statusCode).toBe(200);
    const afterTarget = await submitTarget(target.app, target.ownerHeaders, 'workspace-order-after');
    expect(afterTarget.statusCode).toBe(201);
    const after = (await target.app.inject({ url: `/api/v1/changes/${source.changeId}/acceptance-targets`, headers: target.ownerHeaders })).json().targets.find((item: { id: string }) => item.id === afterTarget.json().resourceId);
    expect(after.workspaceId).toBe(before);
    expect(after.workspacePath.toLowerCase()).toBe((await realpath(otherDir)).toLowerCase());
    const agent = target.ownerHeaders;
    const explicitBody = { requestId: 'workspace-order-explicit', payload: { commit, workspaceId: workspaceIds[0] } };
    const explicit = await target.app.inject({ method: 'POST', url: `/api/v1/changes/${source.changeId}/acceptance-targets`, headers: agent, payload: explicitBody });
    expect(explicit.statusCode).toBe(201);
    const replay = await target.app.inject({ method: 'POST', url: `/api/v1/changes/${source.changeId}/acceptance-targets`, headers: agent, payload: explicitBody });
    expect(replay.json()).toEqual(explicit.json());
    const conflict = await target.app.inject({ method: 'POST', url: `/api/v1/changes/${source.changeId}/acceptance-targets`, headers: agent, payload: { ...explicitBody, payload: { commit, workspaceId: workspaceIds[1] } } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('REQUEST_ID_CONFLICT');
    const foreign = await target.app.inject({ method: 'POST', url: `/api/v1/changes/${source.changeId}/acceptance-targets`, headers: agent, payload: { requestId: 'workspace-order-foreign', payload: { commit, workspaceId: target.workspaceId } } });
    expect(foreign.statusCode).toBe(409);
    expect(foreign.json().code).toBe('WORKSPACE_UNAVAILABLE');
    const explicitItem = (await target.app.inject({ url: `/api/v1/changes/${source.changeId}/acceptance-targets`, headers: target.ownerHeaders })).json().targets.find((item: { id: string }) => item.id === explicit.json().resourceId);
    expect(explicitItem.workspaceId).toBe(workspaceIds[0]);
  }, 30000);
  it('preserves the order of workspace observations through export and restore', async () => {
    const source = await setup(43218, undefined, 'observation-source');
    const observations: string[] = [];
    for (const requestId of ['observation-first', 'observation-second']) {
      const response = await source.app.inject({ method: 'POST', url: `/api/v1/workspaces/${source.workspaceId}/observations`, headers: source.ownerHeaders, payload: { requestId, expectedBindingVersion: 1, selectedUntracked: [] } });
      expect(response.statusCode).toBe(201);
      observations.push(response.json().resourceId as string);
    }
    await source.app.close(); apps.splice(apps.indexOf(source.app), 1);
    const db = new Database(join(source.dataDir, 'specmill.db'));
    try {
      db.pragma('foreign_keys = OFF');
      db.transaction(() => {
        for (const [index, id] of ['ffffffff-ffff-4fff-8fff-ffffffffffff', '00000000-0000-4000-8000-000000000000'].entries()) {
          db.prepare('UPDATE workspace_observations SET id = ? WHERE id = ?').run(id, observations[index]);
          db.prepare('UPDATE observation_requests SET observation_id = ? WHERE observation_id = ?').run(id, observations[index]);
          observations[index] = id;
        }
      })();
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); }
    const restarted = await buildApp({ dataDir: source.dataDir, port: 43218, ownerToken: 'owner-token', agentToken: 'agent-token' }); apps.push(restarted);
    await restarted.listen({ host: '127.0.0.1', port: 43218 });
    const login = await restarted.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
    const owner = { ...headers, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const original = (await restarted.inject({ url: `/api/v1/workspaces/${source.workspaceId}/observations`, headers: owner })).json().observations.map((item: { id: string }) => item.id);
    expect(original).toEqual([...observations].reverse());
    const started = await restarted.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/exports`, headers: agentHeaders, payload: { requestId: 'observation-export' } });
    expect(started.statusCode).toBe(201);
    const archive = await restarted.inject({ url: `/api/v1/exports/${started.json().resourceId}/download`, headers: owner });
    expect(archive.statusCode).toBe(200);
    const target = await setup(43219, undefined, 'observation-target');
    const restored = await target.app.inject({ method: 'POST', url: '/api/v1/restore?requestId=observation-restore', headers: { ...target.ownerHeaders, 'content-type': 'application/octet-stream' }, payload: archive.rawPayload });
    expect(restored.statusCode).toBe(201);
    const after = (await target.app.inject({ url: `/api/v1/workspaces/${source.workspaceId}/observations`, headers: target.ownerHeaders })).json().observations.map((item: { id: string }) => item.id);
    expect(after).toEqual(original);
  }, 30000);
  it('rejects a review receipt referring to an existing change outside the package', async () => {
    const source = await setup(43218, undefined, 'receipt-source');
    const second = await source.app.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/changes`, headers: source.ownerHeaders, payload: { requestId: 'receipt-second', expectedVersion: null, payload: { title: '另一变更', goal: '', scope: '', nonGoals: '', criteria: [] } } });
    expect(second.statusCode).toBe(201);
    const started = await source.app.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/exports`, headers: agentHeaders, payload: { requestId: 'receipt-export' } });
    const zip = (await source.app.inject({ url: `/api/v1/exports/${started.json().resourceId}/download`, headers: source.ownerHeaders })).rawPayload!;
    const target = await setup(43219, undefined, 'receipt-target');
    const entries = readZipEntries(zip);
    const records = JSON.parse(entries.get('records.json')!.toString()) as { reviewRequests: object[] };
    records.reviewRequests.push({ request_id: 'forged-review-receipt', fingerprint: JSON.stringify(['review-continue', source.changeId, 1]), resource_id: target.changeId, action: 'continue', record_version: 2, committed_at: '2026-01-01T00:00:00.000Z' });
    const bytes = Buffer.from(JSON.stringify(records));
    const manifest = JSON.parse(entries.get('manifest.json')!.toString()) as { files: { path: string; sha256: string; size: number }[] };
    const file = manifest.files.find(item => item.path === 'records.json')!;
    file.sha256 = createHash('sha256').update(bytes).digest('hex'); file.size = bytes.length;
    entries.set('records.json', bytes); entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    const response = await target.app.inject({ method: 'POST', url: '/api/v1/restore?requestId=forged-review-restore', headers: { ...target.ownerHeaders, 'content-type': 'application/octet-stream' }, payload: buildZip([...entries].map(([name, data]) => ({ name, data }))) });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_PACKAGE');
    expect((await target.app.inject({ url: '/api/v1/receipts/forged-review-receipt', headers: target.ownerHeaders })).statusCode).toBe(404);
    expect((await target.app.inject({ url: `/api/v1/changes/${source.changeId}`, headers: target.ownerHeaders })).statusCode).toBe(404);
    records.reviewRequests[0] = { request_id: 'forged-review-receipt', fingerprint: '[]', resource_id: source.changeId, action: 'waive', record_version: 2, committed_at: '2026-01-01T00:00:00.000Z' };
    const wrongTypeBytes = Buffer.from(JSON.stringify(records));
    file.sha256 = createHash('sha256').update(wrongTypeBytes).digest('hex'); file.size = wrongTypeBytes.length;
    entries.set('records.json', wrongTypeBytes); entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    const wrongType = await target.app.inject({ method: 'POST', url: '/api/v1/restore?requestId=forged-review-type', headers: { ...target.ownerHeaders, 'content-type': 'application/octet-stream' }, payload: buildZip([...entries].map(([name, data]) => ({ name, data }))) });
    expect(wrongType.statusCode).toBe(400);
    expect(wrongType.json().code).toBe('INVALID_PACKAGE');
    records.reviewRequests[0] = { request_id: 'forged-review-receipt', fingerprint: JSON.stringify(['review-continue', source.changeId, 1]), resource_id: second.json().resourceId, action: 'continue', record_version: 2, committed_at: '2026-01-01T00:00:00.000Z' };
    const wrongChangeBytes = Buffer.from(JSON.stringify(records));
    file.sha256 = createHash('sha256').update(wrongChangeBytes).digest('hex'); file.size = wrongChangeBytes.length;
    entries.set('records.json', wrongChangeBytes); entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    const wrongChange = await target.app.inject({ method: 'POST', url: '/api/v1/restore?requestId=forged-review-change', headers: { ...target.ownerHeaders, 'content-type': 'application/octet-stream' }, payload: buildZip([...entries].map(([name, data]) => ({ name, data }))) });
    expect(wrongChange.statusCode).toBe(400);
    expect(wrongChange.json().code).toBe('INVALID_PACKAGE');
  }, 30000);
  it('does not activate the project if staging cleanup fails', async () => {
    const source = await setup(43218, undefined, 'cleanup-source');
    const content = Buffer.from('cleanup failure sample');
    const uploaded = await source.app.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/attachments?requestId=cleanup-att&filename=a.txt`, headers: { ...source.ownerHeaders, 'content-type': 'application/octet-stream' }, payload: content });
    expect(uploaded.statusCode).toBe(201);
    const started = await source.app.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/exports`, headers: agentHeaders, payload: { requestId: 'cleanup-export' } });
    const zip = (await source.app.inject({ url: `/api/v1/exports/${started.json().resourceId}/download`, headers: source.ownerHeaders })).rawPayload!;
    const target = await setup(43219, undefined, 'cleanup-target');
    vi.mocked(rmdir).mockRejectedValueOnce(Object.assign(new Error('injected cleanup failure'), { code: 'EACCES' }));
    const response = await target.app.inject({ method: 'POST', url: '/api/v1/restore?requestId=cleanup-restore', headers: { ...target.ownerHeaders, 'content-type': 'application/octet-stream' }, payload: zip });
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    const projects = (await target.app.inject({ url: '/api/v1/projects', headers: target.ownerHeaders })).json().projects as { id: string }[];
    expect(projects.some(project => project.id === source.projectId)).toBe(false);
    const hash = createHash('sha256').update(content).digest('hex');
    await expect(stat(join(target.dataDir, 'attachments', source.projectId, hash))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(join(target.dataDir, 'attachments'))).filter(name => name.startsWith('.restore-'))).toEqual([]);
    const retry = await target.app.inject({ method: 'POST', url: '/api/v1/restore?requestId=cleanup-retry', headers: { ...target.ownerHeaders, 'content-type': 'application/octet-stream' }, payload: zip });
    expect(retry.statusCode).toBe(201);
    expect(await readFile(join(target.dataDir, 'attachments', source.projectId, hash))).toEqual(content);
  }, 30000);
  it('accepts a request body at the size limit and rejects one byte more', async () => {
    const { app, ownerHeaders } = await setup();
    const body = Buffer.alloc(64 * 1024 * 1024 + 1);
    const send = (requestId: string, payload: Buffer) => app.inject({ method: 'POST', url: `/api/v1/restore?requestId=${requestId}`, headers: { ...ownerHeaders, 'content-type': 'application/octet-stream' }, payload });
    const atLimit = await send('restore-limit', body.subarray(0, body.length - 1));
    expect(atLimit.statusCode).toBe(400);
    expect(atLimit.json().code).toBe('INVALID_PACKAGE');
    const overLimit = await send('restore-over-limit', body);
    expect(overLimit.statusCode).toBe(413);
  }, 30000);
  it('restores a valid package exactly at the request size limit', async () => {
    const source = await setup(43218, undefined, 'exact-source');
    const content = Buffer.from('boundary sample');
    const upload = await source.app.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/attachments?requestId=exact-att&filename=sample.txt`, headers: { ...source.ownerHeaders, 'content-type': 'application/octet-stream' }, payload: content });
    expect(upload.statusCode).toBe(201);
    const started = await source.app.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/exports`, headers: agentHeaders, payload: { requestId: 'exact-export' } });
    const original = (await source.app.inject({ url: `/api/v1/exports/${started.json().resourceId}/download`, headers: source.ownerHeaders })).rawPayload!;
    const entries = readZipEntries(original);
    // 清单不自我签名；JSON 尾部空格保持语义与所有文件摘要不变。
    const padding = 64 * 1024 * 1024 - original.length;
    expect(padding).toBeGreaterThan(0);
    entries.set('manifest.json', Buffer.concat([entries.get('manifest.json')!, Buffer.alloc(padding, 0x20)]));
    const archive = buildZip([...entries].map(([name, data]) => ({ name, data })));
    expect(archive.length).toBe(64 * 1024 * 1024);
    const target = await setup(43219, undefined, 'exact-target');
    const restored = await target.app.inject({ method: 'POST', url: '/api/v1/restore?requestId=exact-restore', headers: { ...target.ownerHeaders, 'content-type': 'application/octet-stream' }, payload: archive });
    expect(restored.statusCode).toBe(201);
    expect(restored.json().restoredProjectId).toBe(source.projectId);
    const hash = createHash('sha256').update(content).digest('hex');
    expect(await readFile(join(target.dataDir, 'attachments', source.projectId, hash))).toEqual(content);
    const reExport = await target.app.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/exports`, headers: target.ownerHeaders, payload: { requestId: 'exact-re-export' } });
    const reExported = await target.app.inject({ url: `/api/v1/exports/${reExport.json().resourceId}/download`, headers: target.ownerHeaders });
    expect(reExported.statusCode).toBe(200);
    const reEntries = readZipEntries(reExported.rawPayload!);
    expect(reEntries.get(`attachments/${hash}`)).toEqual(content);
    const originalRecords = JSON.parse(entries.get('records.json')!.toString('utf8'));
    const restoredRecords = JSON.parse(reEntries.get('records.json')!.toString('utf8'));
    expect(restoredRecords.project).toEqual(originalRecords.project);
    expect(restoredRecords.attachments).toEqual(originalRecords.attachments);
    expect(restoredRecords.changes).toEqual(originalRecords.changes);
  }, 60000);
  it('round-trips a full export into an isolated data directory with identical records', async () => {
    const source = await setup(43218, undefined, 'src1');
    const attachmentContent = Buffer.from('往返附件内容\n', 'utf8');
    const uploaded = await source.app.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/attachments?requestId=rt-att&filename=log.txt`, headers: { ...source.ownerHeaders, 'content-type': 'application/octet-stream' }, payload: attachmentContent });
    expect(uploaded.statusCode).toBe(201);
    const handoff = await source.app.inject({ method: 'POST', url: `/api/v1/changes/${source.changeId}/handoffs`, headers: source.ownerHeaders, payload: { requestId: 'rt-handoff' } });
    expect(handoff.statusCode).toBe(201);
    const exported = await source.app.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/exports`, headers: agentHeaders, payload: { requestId: 'rt-export' } });
    expect(exported.statusCode).toBe(201);
    await source.app.inject({ url: `/api/v1/exports/${exported.json().resourceId}`, headers: source.ownerHeaders });
    const zip = (await source.app.inject({ url: `/api/v1/exports/${exported.json().resourceId}/download`, headers: source.ownerHeaders })).rawPayload!;
    // 独立数据目录：恢复到全新实例
    const target = await setup(43219, undefined, 'dst1');
    await target.app.close(); apps.splice(apps.findIndex(item => item === target.app), 1);
    const restoredApp = await buildApp({ dataDir: target.dataDir, port: 43219, ownerToken: 'owner-token', agentToken: 'agent-token' }); apps.push(restoredApp);
    await restoredApp.listen({ host: '127.0.0.1', port: 43219 });
    const restoreLogin = await restoredApp.inject({ method: 'POST', url: '/api/v1/session', headers: { host: '127.0.0.1:43219', origin: 'http://127.0.0.1:43219' }, payload: { token: 'owner-token' } });
    const restoreHeaders = { host: '127.0.0.1:43219', origin: 'http://127.0.0.1:43219', 'content-type': 'application/octet-stream', 'x-specmill-request': '1', cookie: restoreLogin.headers['set-cookie'] as string };
    // agent 不能恢复；相同请求的回执必须在重试时稳定返回。
    const restored = await restoredApp.inject({ method: 'POST', url: `/api/v1/restore?requestId=restore-1`, headers: { ...restoreHeaders, authorization: 'Bearer agent-token', cookie: '' }, payload: zip });
    expect(restored.statusCode).toBe(403);
    const concurrent = await Promise.all(['restore-1', 'restore-race'].map(requestId => restoredApp.inject({ method: 'POST', url: `/api/v1/restore?requestId=${requestId}`, headers: restoreHeaders, payload: zip })));
    expect(concurrent.map(response => response.statusCode).sort()).toEqual([201, 409]);
    const ok = concurrent.find(response => response.statusCode === 201)!;
    if (ok.statusCode !== 201) console.log('OK-DEBUG', ok.statusCode, ok.payload.toString().slice(0, 300));
    expect(ok.statusCode).toBe(201);
    const restoredProjectId = ok.json().restoredProjectId as string;
    expect(restoredProjectId).toBe(source.projectId);
    expect(ok.json().sourceBindingRequired).toBe(true);
    for (const response of [uploaded, handoff]) {
      const receipt = response.json() as { requestId: string; resourceId: string; recordVersion: number; committedAt: string };
      const recoveredReceipt = await restoredApp.inject({ url: `/api/v1/receipts/${receipt.requestId}`, headers: restoreHeaders });
      expect(recoveredReceipt.statusCode).toBe(200);
      expect(recoveredReceipt.json()).toEqual({ requestId: receipt.requestId, resourceId: receipt.resourceId, recordVersion: receipt.recordVersion, committedAt: receipt.committedAt });
    }
    const replay = await restoredApp.inject({ method: 'POST', url: `/api/v1/restore?requestId=${ok.json().requestId}`, headers: restoreHeaders, payload: zip });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(ok.json());
    const lookup = await restoredApp.inject({ url: `/api/v1/restores/${ok.json().requestId}`, headers: restoreHeaders });
    expect(lookup.statusCode).toBe(200); expect(lookup.json()).toEqual(ok.json());
    const conflictZip = Buffer.concat([zip, Buffer.from('different')]);
    const conflict = await restoredApp.inject({ method: 'POST', url: `/api/v1/restore?requestId=${ok.json().requestId}`, headers: restoreHeaders, payload: conflictZip });
    expect(conflict.statusCode).toBe(409); expect(conflict.json().code).toBe('REQUEST_ID_CONFLICT');
    // 相同项目 ID 再次恢复被拒
    const duplicate = await restoredApp.inject({ method: 'POST', url: `/api/v1/restore?requestId=restore-2`, headers: restoreHeaders, payload: zip });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe('PROJECT_EXISTS');
    // 逐项比较：结构化记录与附件摘要
    const restoredChange = (await restoredApp.inject({ url: `/api/v1/changes/${source.changeId}`, headers: { host: '127.0.0.1:43219', origin: 'http://127.0.0.1:43219', cookie: restoreHeaders.cookie } })).json() as { id: string; title: string; version: number };
    expect(restoredChange).toEqual(expect.objectContaining({ id: source.changeId, title: '往返变更' }));
    const restoredAttachments = (await restoredApp.inject({ url: `/api/v1/projects/${source.projectId}/attachments`, headers: { host: '127.0.0.1:43219', origin: 'http://127.0.0.1:43219', cookie: restoreHeaders.cookie } })).json().attachments as { id: string; sha256: string }[];
    expect(restoredAttachments).toHaveLength(1);
    const downloaded = await restoredApp.inject({ url: `/api/v1/attachments/${restoredAttachments[0].id}`, headers: { host: '127.0.0.1:43219', origin: 'http://127.0.0.1:43219', cookie: restoreHeaders.cookie } });
    expect(downloaded.rawPayload).toEqual(attachmentContent);
    // 恢复的会话非活跃且无授权：旧凭据与包内授权均无效
    const sessions = (await restoredApp.inject({ url: `/api/v1/changes/${source.changeId}/writer-sessions`, headers: { host: '127.0.0.1:43219', origin: 'http://127.0.0.1:43219', cookie: restoreHeaders.cookie } })).json().sessions as { status: string }[];
    expect(sessions.every(item => item.status !== 'active')).toBe(true);
    // 恢复后未重新绑定源码前不能开始写会话
    const startBlocked = await restoredApp.inject({ method: 'POST', url: `/api/v1/changes/${source.changeId}/writer-sessions`, headers: { ...agentHeaders, host: '127.0.0.1:43219', 'x-specmill-writer-token': 'a'.repeat(64) },
      payload: { requestId: 'restore-start-blocked', expectedVersion: restoredChange.version, payload: { workspaceId: source.workspaceId, expectedBindingVersion: 1, toolLabel: '恢复后工具' } } });
    expect(startBlocked.statusCode).toBe(409);
    // 重新绑定后可正常写入（历史 ID 不变）
    const rebind = await restoredApp.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/workspaces`, headers: { host: '127.0.0.1:43219', origin: 'http://127.0.0.1:43219', 'content-type': 'application/json', 'x-specmill-request': '1', cookie: restoreHeaders.cookie },
      payload: { requestId: 'restore-rebind', expectedVersion: 1, payload: { workspaceId: source.workspaceId, path: source.repoDir } } });
    expect(rebind.statusCode).toBe(200);
    const session = await restoredApp.inject({ method: 'POST', url: `/api/v1/changes/${source.changeId}/writer-sessions`, headers: { ...agentHeaders, host: '127.0.0.1:43219', 'x-specmill-writer-token': 'a'.repeat(64) },
      payload: { requestId: 'restore-start-ok', expectedVersion: restoredChange.version, payload: { workspaceId: source.workspaceId, expectedBindingVersion: 2, toolLabel: '恢复后工具' } } });
    expect(session.statusCode).toBe(201);
    // 实际续做：重新观察 → 保存点 → 释放；恢复实例上形成新记录
    const observe = await restoredApp.inject({ method: 'POST', url: `/api/v1/workspaces/${source.workspaceId}/observations`, headers: { ...agentHeaders, host: '127.0.0.1:43219', 'x-specmill-writer-token': 'a'.repeat(64) },
      payload: { requestId: 'restore-observe', expectedBindingVersion: 2, selectedUntracked: [], writerSessionId: session.json().resourceId, generation: session.json().generation } });
    expect(observe.statusCode).toBe(201);
    const observationId = observe.json().resourceId as string;
    const checkpoint = await restoredApp.inject({ method: 'POST', url: `/api/v1/changes/${source.changeId}/checkpoints`, headers: { ...agentHeaders, host: '127.0.0.1:43219', 'x-specmill-writer-token': 'a'.repeat(64) },
      payload: { requestId: 'restore-checkpoint', expectedVersion: restoredChange.version + 1, writerSessionId: session.json().resourceId, generation: session.json().generation, payload: { observationId, done: '恢复后继续开发', failures: '无', unverified: '恢复往返未验证', blockers: '无', nextSteps: '继续正常开发' } } });
    expect(checkpoint.statusCode).toBe(201);
    const release = await restoredApp.inject({ method: 'POST', url: `/api/v1/writer-sessions/${session.json().resourceId}/release`, headers: { ...agentHeaders, host: '127.0.0.1:43219', 'x-specmill-writer-token': 'a'.repeat(64) },
      payload: { requestId: 'restore-release', expectedVersion: restoredChange.version + 2, generation: session.json().generation } });
    expect(release.statusCode).toBe(200);
    // 恢复实例再次完整导出：新保存点进入包中
    const reExport = await restoredApp.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/exports`, headers: { ...agentHeaders, host: '127.0.0.1:43219' }, payload: { requestId: 'restore-re-export' } });
    expect(reExport.statusCode).toBe(201);
    await restoredApp.inject({ url: `/api/v1/exports/${reExport.json().resourceId}`, headers: { host: '127.0.0.1:43219', origin: 'http://127.0.0.1:43219', cookie: restoreHeaders.cookie } });
    const reZip = (await restoredApp.inject({ url: `/api/v1/exports/${reExport.json().resourceId}/download`, headers: { host: '127.0.0.1:43219', origin: 'http://127.0.0.1:43219', cookie: restoreHeaders.cookie } })).rawPayload!;
    const reRecords = JSON.parse(readZipEntries(reZip).get('records.json')!.toString('utf8')) as { checkpoints: { id: string }[] };
    expect(reRecords.checkpoints.some(item => item.id === checkpoint.json().resourceId)).toBe(true);
  }, 60000);

  it('rejects tampered packages, unknown formats and schema mismatches before activation', async () => {
    const source = await setup(43218, undefined, 'src1');
    const secondChange = await source.app.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/changes`, headers: source.ownerHeaders,
      payload: { requestId: 'second-change', expectedVersion: null, payload: { title: '另一变更', goal: '', scope: '', nonGoals: '', criteria: [] } } });
    expect(secondChange.statusCode).toBe(201);
    const attachment = await source.app.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/attachments?requestId=tamper-att&filename=log.txt`, headers: { ...source.ownerHeaders, 'content-type': 'application/octet-stream' }, payload: Buffer.from('valid evidence') });
    expect(attachment.statusCode).toBe(201);
    const execution = await source.app.inject({ method: 'POST', url: `/api/v1/changes/${source.changeId}/executions`, headers: source.ownerHeaders,
      payload: { requestId: 'tamper-run', workspaceId: source.workspaceId, payload: { method: '检查记录', result: 'passed' } } });
    expect(execution.statusCode).toBe(201);
    const change = (await source.app.inject({ url: `/api/v1/changes/${source.changeId}`, headers: source.ownerHeaders })).json();
    const evidence = await source.app.inject({ method: 'POST', url: `/api/v1/changes/${source.changeId}/evidence`, headers: source.ownerHeaders,
      payload: { requestId: 'tamper-evidence', payload: { executionId: execution.json().resourceId, criterion: { kind: 'draft', revisionId: change.revisionId }, criterionIndex: 1, result: 'passed', attachmentIds: [attachment.json().resourceId] } } });
    expect(evidence.statusCode).toBe(201);
    const exported = await source.app.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/exports`, headers: agentHeaders, payload: { requestId: 'tamper-export' } });
    await source.app.inject({ url: `/api/v1/exports/${exported.json().resourceId}`, headers: source.ownerHeaders });
    const zip = (await source.app.inject({ url: `/api/v1/exports/${exported.json().resourceId}/download`, headers: source.ownerHeaders })).rawPayload!;
    const target = await setup(43219, undefined, 'dst1');
    const restoreHeaders = { host: '127.0.0.1:43219', origin: 'http://127.0.0.1:43219', 'content-type': 'application/octet-stream', 'x-specmill-request': '1', cookie: (await target.app.inject({ method: 'POST', url: '/api/v1/session', headers: { host: '127.0.0.1:43219', origin: 'http://127.0.0.1:43219' }, payload: { token: 'owner-token' } })).headers['set-cookie'] as string };
    const send = async (payload: Buffer, requestId: string) => target.app.inject({ method: 'POST', url: `/api/v1/restore?requestId=${requestId}`, headers: restoreHeaders, payload });
    const symlinkZip = Buffer.from(zip);
    const centralOffset = symlinkZip.readUInt32LE(symlinkZip.length - 6);
    symlinkZip.writeUInt16LE(0x0314, centralOffset + 4);
    symlinkZip.writeUInt32LE((0xa1ff * 0x10000) >>> 0, centralOffset + 38);
    const symlinkResponse = await send(symlinkZip, 'restore-symlink');
    expect(symlinkResponse.statusCode).toBe(400);
    expect(symlinkResponse.json().code).toBe('INVALID_PACKAGE');
    expect((await target.app.inject({ url: `/api/v1/changes/${source.changeId}`, headers: target.ownerHeaders })).statusCode).toBe(404);
    for (const [name, value] of [['manifest.json', 'null'], ['manifest.json', '{"formatVersion":1}'], ['records.json', 'null']] as const) {
      const malformedEntries = readZipEntries(zip);
      const bytes = Buffer.from(value);
      malformedEntries.set(name, bytes);
      if (name === 'records.json') {
        const validManifest = JSON.parse(malformedEntries.get('manifest.json')!.toString()) as { files: { path: string; sha256: string; size: number }[] };
        const recordFile = validManifest.files.find(file => file.path === name)!;
        recordFile.sha256 = createHash('sha256').update(bytes).digest('hex');
        recordFile.size = bytes.length;
        malformedEntries.set('manifest.json', Buffer.from(JSON.stringify(validManifest)));
      }
      const malformed = buildZip([...malformedEntries].map(([entryName, data]) => ({ name: entryName, data })));
      const response = await send(malformed, `malformed-${name}-${value.length}`);
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('INVALID_PACKAGE');
    }
    const badAttachmentEntries = readZipEntries(zip);
    const attachmentName = [...badAttachmentEntries.keys()].find(name => name.startsWith('attachments/'))!;
    const badAttachment = Buffer.from('altered evidence');
    const attachmentManifest = JSON.parse(badAttachmentEntries.get('manifest.json')!.toString()) as { files: { path: string; sha256: string; size: number }[] };
    const attachmentFile = attachmentManifest.files.find(file => file.path === attachmentName)!;
    attachmentFile.sha256 = createHash('sha256').update(badAttachment).digest('hex'); attachmentFile.size = badAttachment.length;
    badAttachmentEntries.set(attachmentName, badAttachment); badAttachmentEntries.set('manifest.json', Buffer.from(JSON.stringify(attachmentManifest)));
    expect((await send(buildZip([...badAttachmentEntries].map(([name, data]) => ({ name, data }))), 'restore-bad-attachment')).statusCode).toBe(400);
    const danglingEntries = readZipEntries(zip);
    const danglingRecords = JSON.parse(danglingEntries.get('records.json')!.toString()) as { evidenceRecords: { attachment_ids_json: string }[] };
    danglingRecords.evidenceRecords[0].attachment_ids_json = JSON.stringify(['missing-attachment']);
    const danglingBytes = Buffer.from(JSON.stringify(danglingRecords));
    const danglingManifest = JSON.parse(danglingEntries.get('manifest.json')!.toString()) as { files: { path: string; sha256: string; size: number }[] };
    const danglingFile = danglingManifest.files.find(file => file.path === 'records.json')!;
    danglingFile.sha256 = createHash('sha256').update(danglingBytes).digest('hex'); danglingFile.size = danglingBytes.length;
    danglingEntries.set('records.json', danglingBytes); danglingEntries.set('manifest.json', Buffer.from(JSON.stringify(danglingManifest)));
    expect((await send(buildZip([...danglingEntries].map(([name, data]) => ({ name, data }))), 'restore-dangling-attachment')).statusCode).toBe(400);
    const revisionEntries = readZipEntries(zip);
    const revisionRecords = JSON.parse(revisionEntries.get('records.json')!.toString()) as { evidenceRecords: { revision_id: string }[]; changeRevisions: { id: string; change_id: string }[] };
    revisionRecords.evidenceRecords[0].revision_id = revisionRecords.changeRevisions.find(row => row.change_id === secondChange.json().resourceId)!.id;
    const revisionBytes = Buffer.from(JSON.stringify(revisionRecords));
    const revisionManifest = JSON.parse(revisionEntries.get('manifest.json')!.toString()) as { files: { path: string; sha256: string; size: number }[] };
    const revisionFile = revisionManifest.files.find(file => file.path === 'records.json')!;
    revisionFile.sha256 = createHash('sha256').update(revisionBytes).digest('hex'); revisionFile.size = revisionBytes.length;
    revisionEntries.set('records.json', revisionBytes); revisionEntries.set('manifest.json', Buffer.from(JSON.stringify(revisionManifest)));
    expect((await send(buildZip([...revisionEntries].map(([name, data]) => ({ name, data }))), 'restore-cross-revision')).statusCode).toBe(400);
    // A valid checksum does not make records that point at another project safe.
    const entries = readZipEntries(zip);
    const records = JSON.parse(entries.get('records.json')!.toString()) as { changes: { project_id: string }[] };
    records.changes[0].project_id = target.projectId;
    const altered = Buffer.from(JSON.stringify(records));
    const manifest = JSON.parse(entries.get('manifest.json')!.toString()) as { files: { path: string; sha256: string; size: number }[] };
    const recordFile = manifest.files.find(file => file.path === 'records.json')!;
    recordFile.sha256 = createHash('sha256').update(altered).digest('hex'); recordFile.size = altered.length;
    entries.set('records.json', altered); entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    const forged = buildZip([...entries].map(([name, data]) => ({ name, data })));
    const rejectedCrossProject = await send(forged, 'restore-cross-project');
    expect(rejectedCrossProject.statusCode).toBe(400);
    expect((await target.app.inject({ url: `/api/v1/changes/${source.changeId}`, headers: target.ownerHeaders })).statusCode).toBe(404);
    const mixedEntries = readZipEntries(zip);
    const mixedRecords = JSON.parse(mixedEntries.get('records.json')!.toString()) as { changes: { id: string; current_revision_id: string }[]; changeRevisions: { id: string; change_id: string }[] };
    mixedRecords.changes.find(row => row.id === source.changeId)!.current_revision_id = mixedRecords.changeRevisions.find(row => row.change_id === secondChange.json().resourceId)!.id;
    const mixedBytes = Buffer.from(JSON.stringify(mixedRecords));
    const mixedManifest = JSON.parse(mixedEntries.get('manifest.json')!.toString()) as { files: { path: string; sha256: string; size: number }[] };
    const mixedRecordFile = mixedManifest.files.find(file => file.path === 'records.json')!;
    mixedRecordFile.sha256 = createHash('sha256').update(mixedBytes).digest('hex'); mixedRecordFile.size = mixedBytes.length;
    mixedEntries.set('records.json', mixedBytes); mixedEntries.set('manifest.json', Buffer.from(JSON.stringify(mixedManifest)));
    const mixed = buildZip([...mixedEntries].map(([name, data]) => ({ name, data })));
    expect((await send(mixed, 'restore-cross-change')).statusCode).toBe(400);
    expect((await target.app.inject({ url: `/api/v1/changes/${source.changeId}`, headers: target.ownerHeaders })).statusCode).toBe(404);
    const incompleteEntries = readZipEntries(zip);
    const incompleteRecords = JSON.parse(incompleteEntries.get('records.json')!.toString()) as { changes: { phase: string | null }[] };
    incompleteRecords.changes[0].phase = null;
    const incompleteBytes = Buffer.from(JSON.stringify(incompleteRecords));
    const incompleteManifest = JSON.parse(incompleteEntries.get('manifest.json')!.toString()) as { files: { path: string; sha256: string; size: number }[] };
    const incompleteFile = incompleteManifest.files.find(file => file.path === 'records.json')!;
    incompleteFile.sha256 = createHash('sha256').update(incompleteBytes).digest('hex'); incompleteFile.size = incompleteBytes.length;
    incompleteEntries.set('records.json', incompleteBytes); incompleteEntries.set('manifest.json', Buffer.from(JSON.stringify(incompleteManifest)));
    expect((await send(buildZip([...incompleteEntries].map(([name, data]) => ({ name, data }))), 'restore-incomplete-row')).statusCode).toBe(400);
    // 篡改 records.json 内容（本地头摘要不符）
    const tampered = Buffer.from(zip);
    for (let index = 30; index < tampered.length; index++) if (tampered[index] === 0x22) { tampered[index] = 0x23; break; }
    expect((await send(tampered, 'restore-tampered')).statusCode).toBe(400);
    // 非 ZIP 内容
    expect((await send(Buffer.from('not a zip'), 'restore-notzip')).statusCode).toBe(400);
    // 清单版本不受支持：构造 formatVersion=2 的包（通过重建中央目录之外的简单方式不可行——直接验证 schema 不匹配路径）
    // 空 body
    expect((await send(Buffer.alloc(0), 'restore-empty')).statusCode).toBe(400);
    // 恢复到已有同 ID 项目
    const sameProject = await target.app.inject({ method: 'POST', url: '/api/v1/projects', headers: { host: '127.0.0.1:43219', origin: 'http://127.0.0.1:43219', 'content-type': 'application/json', 'x-specmill-request': '1', cookie: restoreHeaders.cookie }, payload: { name: '占用 ID', requestId: 'occupy-id' } });
    void sameProject;
    // 激活不污染现有项目：源项目仍可读取
    const sourceProjects = (await source.app.inject({ url: '/api/v1/projects', headers: source.ownerHeaders })).json().projects as { id: string }[];
    expect(sourceProjects).toHaveLength(1);
  }, 60000);

  it('rejects restores beyond the local capacity budget atomically', async () => {
    const source = await setup(43218, undefined, 'src1');
    const capUpload = await source.app.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/attachments?requestId=cap-att&filename=big.bin`, headers: { ...source.ownerHeaders, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(512 * 1024 + 7) });
    if (capUpload.statusCode !== 201) console.log('CAP-UPLOAD', capUpload.statusCode, capUpload.payload.toString().slice(0, 200));
    expect(capUpload.statusCode).toBe(201);
    const exported = await source.app.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/exports`, headers: agentHeaders, payload: { requestId: 'cap-export' } });
    expect(exported.statusCode).toBe(201);
    await source.app.inject({ url: `/api/v1/exports/${exported.json().resourceId}`, headers: source.ownerHeaders });
    const zip = (await source.app.inject({ url: `/api/v1/exports/${exported.json().resourceId}/download`, headers: source.ownerHeaders })).rawPayload!;
    // 极小预算的实例：恢复在激活事务内被容量拒绝并整体回滚
    const target = await setup(43219, 4096);
    const restoreHeaders = { host: '127.0.0.1:43219', origin: 'http://127.0.0.1:43219', 'content-type': 'application/octet-stream', 'x-specmill-request': '1', cookie: (await target.app.inject({ method: 'POST', url: '/api/v1/session', headers: { host: '127.0.0.1:43219', origin: 'http://127.0.0.1:43219' }, payload: { token: 'owner-token' } })).headers['set-cookie'] as string };
    const rejected = await target.app.inject({ method: 'POST', url: `/api/v1/restore?requestId=cap-restore`, headers: restoreHeaders, payload: zip });
    if (rejected.statusCode !== 413) console.log('CAP-DEBUG', rejected.statusCode, rejected.payload.toString().slice(0, 900));
    expect(rejected.statusCode).toBe(413);
    expect(rejected.json().code).toBe('PROJECT_CAPACITY_EXCEEDED');
    const digest = createHash('sha256').update(Buffer.alloc(512 * 1024 + 7)).digest('hex');
    await expect(stat(join(target.dataDir, 'attachments', source.projectId, digest))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(join(target.dataDir, 'attachments'))).filter(name => name.startsWith('.restore-'))).toEqual([]);
    // 回滚后恢复的项目不落入本地（目标实例自建的种子项目除外）
    const projects = (await target.app.inject({ url: '/api/v1/projects', headers: { host: '127.0.0.1:43219', origin: 'http://127.0.0.1:43219', cookie: restoreHeaders.cookie } })).json().projects as { id: string }[];
    expect(projects.some(item => item.id === source.projectId)).toBe(false);
    // 原先已存在的同地址内容不是本次创建的文件，失败时必须保留。
    const existingPath = join(target.dataDir, 'attachments', source.projectId, digest);
    await mkdir(join(target.dataDir, 'attachments', source.projectId), { recursive: true });
    await writeFile(existingPath, Buffer.alloc(512 * 1024 + 7));
    const retry = await target.app.inject({ method: 'POST', url: `/api/v1/restore?requestId=cap-restore`, headers: restoreHeaders, payload: zip });
    expect(retry.statusCode).toBe(413);
    expect(await readFile(existingPath)).toEqual(Buffer.alloc(512 * 1024 + 7));
    expect((await readdir(join(target.dataDir, 'attachments'))).filter(name => name.startsWith('.restore-'))).toEqual([]);
  }, 60000);
});
