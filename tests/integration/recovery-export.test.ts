import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app.js';

const dirs: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const headers = { host: '127.0.0.1:43222', origin: 'http://127.0.0.1:43222' };
const agentHeaders = { host: headers.host, authorization: 'Bearer agent-token' };
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup(maxProjectRecordsBytes?: number, port = 43222) {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-recovery-data-')); dirs.push(dataDir);
  const repoDir = await mkdtemp(join(tmpdir(), 'specmill-recovery-repo-')); dirs.push(repoDir);
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_AUTHOR_NAME: '测试', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: '测试', GIT_COMMITTER_EMAIL: 'test@example.com' } });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  git(['init', '-q']);
  await writeFile(join(repoDir, 'README.md'), '# 恢复样本\n');
  git(['add', 'README.md']);
  git(['commit', '-q', '-m', 'init']);
  const app = await buildApp({ dataDir, port, ownerToken: 'owner-token', agentToken: 'agent-token', maxProjectRecordsBytes }); apps.push(app);
  await app.listen({ host: '127.0.0.1', port });
  const setupHeaders = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers: setupHeaders, payload: { token: 'owner-token' } });
  const ownerHeaders = { ...setupHeaders, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
  const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: ownerHeaders, payload: { name: '恢复项目', requestId: 'recovery-project' } });
  const projectId = project.json().resourceId as string;
  const workspace = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders,
    payload: { requestId: 'recovery-workspace', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
  const workspaceId = workspace.json().resourceId as string;
  const change = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
    payload: { requestId: 'recovery-change', expectedVersion: null, payload: { title: '恢复变更', goal: '验证导出', scope: '', nonGoals: '', criteria: ['日志齐全'] } } });
  const changeId = change.json().resourceId as string;
  return { app, dataDir, repoDir, projectId, workspaceId, changeId, ownerHeaders };
}
async function uploadAttachment(app: Awaited<ReturnType<typeof buildApp>>, projectId: string, requestId: string, content: Buffer, filename = 'evidence.log') {
  const upload = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=${requestId}&filename=${encodeURIComponent(filename)}`, headers: { ...agentHeaders, 'content-type': 'application/octet-stream' }, payload: content });
  expect(upload.statusCode).toBe(201);
  return upload.json().resourceId as string;
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

describe('project recovery export', () => {
  it('exports a consistent zip with manifest, records and verified attachments without credentials', async () => {
    const { app, projectId, ownerHeaders } = await setup();
    const logContent = Buffer.from('证据日志内容\n第二行\n', 'utf8');
    await uploadAttachment(app, projectId, 'export-att-1', logContent);
    const usedBefore = (await app.inject({ url: `/api/v1/projects/${projectId}/capacity`, headers: ownerHeaders })).json().records as { used: number };
    const start = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/exports`, headers: agentHeaders, payload: { requestId: 'export-1' } });
    expect(start.statusCode).toBe(201);
    expect(start.json().status).toBe('preparing');
    const operationId = start.json().resourceId as string;
    // 首次状态查询触发惰性生成
    const status = await app.inject({ url: `/api/v1/exports/${operationId}`, headers: ownerHeaders });
    expect(status.json().status).toBe('ready');
    const sha256 = status.json().sha256 as string;
    // 操作状态不占用项目预算
    const usedAfter = (await app.inject({ url: `/api/v1/projects/${projectId}/capacity`, headers: ownerHeaders })).json().records as { used: number };
    expect(usedAfter.used).toBe(usedBefore.used);
    // 幂等重放：同一请求标识返回同一操作
    const replay = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/exports`, headers: agentHeaders, payload: { requestId: 'export-1' } });
    expect(replay.json().resourceId).toBe(operationId);
    const download = await app.inject({ url: `/api/v1/exports/${operationId}/download`, headers: ownerHeaders });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    const zip = download.rawPayload!;
    expect(createHash('sha256').update(zip).digest('hex')).toBe(sha256);
    const entries = readZipEntries(zip);
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as { formatVersion: number; schemaVersion: number; projectId: string; files: { path: string; sha256: string; size: number }[] };
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.schemaVersion).toBe(16);
    expect(manifest.projectId).toBe(projectId);
    for (const file of manifest.files) {
      const content = entries.get(file.path)!;
      expect(createHash('sha256').update(content).digest('hex')).toBe(file.sha256);
      expect(content.length).toBe(file.size);
    }
    const attachmentSha = createHash('sha256').update(logContent).digest('hex');
    expect(manifest.files.some(item => item.path === `attachments/${attachmentSha}`)).toBe(true);
    const records = JSON.parse(entries.get('records.json')!.toString('utf8')) as { project: { id: string; name: string }; writerSessions: Record<string, unknown>[] };
    expect(records.project.id).toBe(projectId);
    expect(JSON.stringify(records)).toContain('恢复变更');
    expect(JSON.stringify(records)).not.toContain('claim_hash');
    expect(entries.get(`attachments/${attachmentSha}`)).toEqual(logContent);
    // 下载仅限用户
    expect((await app.inject({ url: `/api/v1/exports/${operationId}/download`, headers: agentHeaders })).statusCode).toBe(403);
  }, 30000);

  it('fails the export with specific references when attachments are broken and stays consistent across restarts', async () => {
    const { app, dataDir, projectId, ownerHeaders } = await setup();
    const attachmentId = await uploadAttachment(app, projectId, 'export-att-broken', Buffer.from('待损坏附件\n', 'utf8'));
    const sha256 = createHash('sha256').update(Buffer.from('待损坏附件\n', 'utf8')).digest('hex');
    await writeFile(join(dataDir, 'attachments', projectId, sha256), Buffer.from('损坏内容\n', 'utf8'));
    const start = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/exports`, headers: agentHeaders, payload: { requestId: 'export-broken' } });
    expect(start.statusCode).toBe(201);
    const status = (await app.inject({ url: `/api/v1/exports/${start.json().resourceId}`, headers: ownerHeaders })).json() as { status: string; error: string };
    expect(status.status).toBe('failed');
    expect(status.error).toContain(attachmentId);
    expect((await app.inject({ url: `/api/v1/exports/${start.json().resourceId}/download`, headers: ownerHeaders })).json().code).toBe('EXPORT_NOT_READY');
    // 修复附件后按新请求导出成功
    await writeFile(join(dataDir, 'attachments', projectId, sha256), Buffer.from('待损坏附件\n', 'utf8'));
    const ok = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/exports`, headers: agentHeaders, payload: { requestId: 'export-fixed' } });
    expect(ok.statusCode).toBe(201);
    expect((await app.inject({ url: `/api/v1/exports/${ok.json().resourceId}`, headers: ownerHeaders })).json().status).toBe('ready');
    // 重启：准备中的操作标为失败
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const db = new Database(join(dataDir, 'specmill.db'));
    db.prepare("INSERT INTO export_operations(id,project_id,request_id,status,created_at) VALUES ('op-preparing', ?, 'export-preparing', 'preparing', ?)").run(projectId, new Date().toISOString());
    db.close();
    const restarted = await buildApp({ dataDir, port: 43222, ownerToken: 'owner-token', agentToken: 'agent-token' }); apps.push(restarted);
    const reLogin = await restarted.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
    const reOwnerHeaders = { ...headers, cookie: reLogin.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const marked = (await restarted.inject({ url: '/api/v1/exports/op-preparing', headers: reOwnerHeaders })).json() as { status: string; error: string };
    expect(marked.status).toBe('failed');
    expect(marked.error).toContain('重启');
  }, 30000);

  it('enforces the single-operation limit, supports cancel and keeps exports project-scoped', async () => {
    const first = await setup();
    // 单操作限制：准备中的导出阻塞第二个导出
    const startA = await first.app.inject({ method: 'POST', url: `/api/v1/projects/${first.projectId}/exports`, headers: agentHeaders, payload: { requestId: 'scope-export-a' } });
    expect(startA.statusCode).toBe(201);
    const blocked = await first.app.inject({ method: 'POST', url: `/api/v1/projects/${first.projectId}/exports`, headers: agentHeaders, payload: { requestId: 'scope-export-b' } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('EXPORT_IN_PROGRESS');
    // 准备阶段可取消（仅用户）；取消后不生成、无下载
    const agentCancel = await first.app.inject({ method: 'POST', url: `/api/v1/exports/${startA.json().resourceId}/cancel`, headers: agentHeaders, payload: { requestId: 'cancel-agent' } });
    expect(agentCancel.statusCode).toBe(403);
    const canceled = await first.app.inject({ method: 'POST', url: `/api/v1/exports/${startA.json().resourceId}/cancel`, headers: first.ownerHeaders, payload: { requestId: 'cancel-1' } });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json().status).toBe('canceled');
    expect((await first.app.inject({ url: `/api/v1/exports/${startA.json().resourceId}`, headers: first.ownerHeaders })).json().status).toBe('canceled');
    expect((await first.app.inject({ url: `/api/v1/exports/${startA.json().resourceId}/download`, headers: first.ownerHeaders })).json().code).toBe('EXPORT_NOT_READY');
    // 取消后可再次发起
    const startB = await first.app.inject({ method: 'POST', url: `/api/v1/projects/${first.projectId}/exports`, headers: agentHeaders, payload: { requestId: 'scope-export-c' } });
    expect(startB.statusCode).toBe(201);
    expect((await first.app.inject({ url: `/api/v1/exports/${startB.json().resourceId}`, headers: first.ownerHeaders })).json().status).toBe('ready');
    const zipA = (await first.app.inject({ url: `/api/v1/exports/${startB.json().resourceId}/download`, headers: first.ownerHeaders })).rawPayload!;
    const recordsA = JSON.parse(readZipEntries(zipA).get('records.json')!.toString('utf8')) as { project: { id: string } };
    expect(recordsA.project.id).toBe(first.projectId);
    // 同一应用内新建第二个项目：同请求标识跨项目被拒；新请求正常导出且不含项目 A 的记录
    const projectB = await first.app.inject({ method: 'POST', url: '/api/v1/projects', headers: first.ownerHeaders, payload: { name: '恢复项目B', requestId: 'recovery-project-b' } });
    const projectBId = projectB.json().resourceId as string;
    const crossProject = await first.app.inject({ method: 'POST', url: `/api/v1/projects/${projectBId}/exports`, headers: agentHeaders, payload: { requestId: 'scope-export-a' } });
    expect(crossProject.statusCode).toBe(409);
    const exportB = await first.app.inject({ method: 'POST', url: `/api/v1/projects/${projectBId}/exports`, headers: agentHeaders, payload: { requestId: 'scope-export-b' } });
    expect(exportB.statusCode).toBe(201);
    const zipB = (await first.app.inject({ url: `/api/v1/exports/${exportB.json().resourceId}/download`, headers: first.ownerHeaders })).rawPayload!;
    const recordsB = JSON.parse(readZipEntries(zipB).get('records.json')!.toString('utf8')) as { project: { id: string } };
    expect(recordsB.project.id).toBe(projectBId);
    expect(JSON.stringify(recordsB)).not.toContain(first.projectId);
    // 操作状态不占用项目预算：接近上限的项目仍可完整导出
    const tight = await setup(12000, 43221);
    const capacity = async () => (await tight.app.inject({ url: `/api/v1/projects/${tight.projectId}/capacity`, headers: tight.ownerHeaders })).json().records as { used: number; limit: number };
    const before = await capacity();
    const tightExport = await tight.app.inject({ method: 'POST', url: `/api/v1/projects/${tight.projectId}/exports`, headers: { ...agentHeaders, host: '127.0.0.1:43221' }, payload: { requestId: 'tight-export' } });
    expect(tightExport.statusCode).toBe(201);
    expect((await capacity()).used).toBe(before.used);
  }, 60000);
});
