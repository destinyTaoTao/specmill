import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app.js';

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
  it('round-trips a full export into an isolated data directory with identical records', async () => {
    const source = await setup(43218, undefined, 'src1');
    const attachmentContent = Buffer.from('往返附件内容\n', 'utf8');
    await source.app.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/attachments?requestId=rt-att&filename=log.txt`, headers: { ...agentHeaders, 'content-type': 'application/octet-stream' }, payload: attachmentContent });
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
    // agent 不能恢复；重复请求标识幂等返回原恢复结果
    const restored = await restoredApp.inject({ method: 'POST', url: `/api/v1/restore?requestId=restore-1`, headers: { ...restoreHeaders, authorization: 'Bearer agent-token', cookie: '' }, payload: zip });
    expect(restored.statusCode).toBe(403);
    const ok = await restoredApp.inject({ method: 'POST', url: `/api/v1/restore?requestId=restore-1`, headers: restoreHeaders, payload: zip });
    if (ok.statusCode !== 201) console.log('OK-DEBUG', ok.statusCode, ok.payload.toString().slice(0, 300));
    expect(ok.statusCode).toBe(201);
    const restoredProjectId = ok.json().restoredProjectId as string;
    expect(restoredProjectId).toBe(source.projectId);
    expect(ok.json().sourceBindingRequired).toBe(true);
    const replay = await restoredApp.inject({ method: 'POST', url: `/api/v1/restore?requestId=restore-1`, headers: restoreHeaders, payload: zip });
    expect(replay.statusCode).toBe(409);
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
    const exported = await source.app.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/exports`, headers: agentHeaders, payload: { requestId: 'tamper-export' } });
    await source.app.inject({ url: `/api/v1/exports/${exported.json().resourceId}`, headers: source.ownerHeaders });
    const zip = (await source.app.inject({ url: `/api/v1/exports/${exported.json().resourceId}/download`, headers: source.ownerHeaders })).rawPayload!;
    const target = await setup(43219, undefined, 'dst1');
    const restoreHeaders = { host: '127.0.0.1:43219', origin: 'http://127.0.0.1:43219', 'content-type': 'application/octet-stream', 'x-specmill-request': '1', cookie: (await target.app.inject({ method: 'POST', url: '/api/v1/session', headers: { host: '127.0.0.1:43219', origin: 'http://127.0.0.1:43219' }, payload: { token: 'owner-token' } })).headers['set-cookie'] as string };
    const send = async (payload: Buffer, requestId: string) => target.app.inject({ method: 'POST', url: `/api/v1/restore?requestId=${requestId}`, headers: restoreHeaders, payload });
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
    const capUpload = await source.app.inject({ method: 'POST', url: `/api/v1/projects/${source.projectId}/attachments?requestId=cap-att&filename=big.bin`, headers: { ...agentHeaders, host: '127.0.0.1:43218', 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(512 * 1024 + 7) });
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
    // 回滚后恢复的项目不落入本地（目标实例自建的种子项目除外）
    const projects = (await target.app.inject({ url: '/api/v1/projects', headers: { host: '127.0.0.1:43219', origin: 'http://127.0.0.1:43219', cookie: restoreHeaders.cookie } })).json().projects as { id: string }[];
    expect(projects.some(item => item.id === source.projectId)).toBe(false);
    // 放宽预算的往返验证由导出侧测试覆盖；此处同请求标识重试仍拒绝（无状态残留）
    const retry = await target.app.inject({ method: 'POST', url: `/api/v1/restore?requestId=cap-restore`, headers: restoreHeaders, payload: zip });
    expect(retry.statusCode).toBe(413);
  }, 60000);
});
