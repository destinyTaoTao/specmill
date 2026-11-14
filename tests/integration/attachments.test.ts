import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { buildApp } from '../../src/server/app.js';
import { encodeSecret } from '../../src/shared/credentials.js';

const runFile = promisify(execFile);

const dirs: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const headers = { host: '127.0.0.1:43224', origin: 'http://127.0.0.1:43224' };
const agentHeaders = { host: headers.host, authorization: 'Bearer agent-token' };
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup(maxProjectRecordsBytes?: number) {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-attach-data-')); dirs.push(dataDir);
  const repoDir = await mkdtemp(join(tmpdir(), 'specmill-attach-repo-')); dirs.push(repoDir);
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_AUTHOR_NAME: '测试', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: '测试', GIT_COMMITTER_EMAIL: 'test@example.com' } });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  git(['init', '-q']);
  await writeFile(join(repoDir, 'README.md'), '# 附件样本\n');
  const specContent = '# 验收规格\n\n- 条件一：日志附件齐全\n- 条件二：截图可核对\n';
  await writeFile(join(repoDir, 'spec.md'), specContent);
  git(['add', 'README.md', 'spec.md']);
  git(['commit', '-q', '-m', 'init']);
  const headSha = git(['rev-parse', 'HEAD']).trim();
  const app = await buildApp({ dataDir, port: 43224, ownerToken: 'owner-token', agentToken: 'agent-token', maxProjectRecordsBytes }); apps.push(app);
  await app.listen({ host: '127.0.0.1', port: 43224 });
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
  const ownerHeaders = { ...headers, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
  const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: ownerHeaders, payload: { name: '附件项目', requestId: 'attach-project' } });
  const projectId = project.json().resourceId as string;
  const workspace = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders,
    payload: { requestId: 'attach-workspace', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
  const workspaceId = workspace.json().resourceId as string;
  const change = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
    payload: { requestId: 'attach-change', expectedVersion: null, payload: { title: '附件变更', goal: '验证附件流程', scope: '', nonGoals: '', criteria: ['日志齐全', '截图可核对'] } } });
  const changeId = change.json().resourceId as string;
  const session = await startSession(app, changeId, workspaceId, 'attach-start', 1);
  const run = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/executions`, headers: agentHeaders,
    payload: { requestId: 'attach-run', workspaceId, payload: { method: 'node --test', result: 'passed', claimedCommit: headSha, claimedClean: true } } });
  expect(run.statusCode).toBe(201);
  const frozen = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/baselines`, headers: ownerHeaders,
    payload: { requestId: 'attach-baseline', expectedVersion: 2, payload: { workspaceId, expectedBindingVersion: 1, path: 'spec.md', expectedSha256: createHash('sha256').update(specContent, 'utf8').digest('hex'), selection: '# 验收规格', criterionLinks: [null, null], previousSourceItemId: null } } });
  expect(frozen.statusCode).toBe(201);
  const baselineId = frozen.json().resourceId as string;
  const criteria = (await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${baselineId}`, headers: ownerHeaders })).json().criteria as { id: string }[];
  return { app, dataDir, repoDir, projectId, workspaceId, changeId, ownerHeaders, headSha, runId: run.json().resourceId as string, baselineId, criterionId: criteria[0].id, session };
}
async function startSession(app: Awaited<ReturnType<typeof buildApp>>, changeId: string, workspaceId: string, requestId: string, expectedVersion: number) {
  const started = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/writer-sessions`, headers: { ...agentHeaders, 'x-specmill-writer-token': 'a'.repeat(64) },
    payload: { requestId, expectedVersion, payload: { workspaceId, expectedBindingVersion: 1, toolLabel: '附件工具' } } });
  expect(started.statusCode).toBe(201);
  return started.json() as { resourceId: string; generation: number };
}

describe('managed attachments', () => {
  it('stores content-addressed attachments, deduplicates content and links them to evidence', async () => {
    const { app, dataDir, projectId, changeId, ownerHeaders, runId, baselineId, criterionId, headSha } = await setup();
    const content = Buffer.from('测试日志内容：全部通过\n第二行\n', 'utf8');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const usedBefore = (await app.inject({ url: `/api/v1/projects/${projectId}/capacity`, headers: ownerHeaders })).json().records as { used: number };
    const upload = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=att-1&filename=${encodeURIComponent('测试 日志.txt')}&contentType=text%2Fplain`, headers: { ...agentHeaders, 'content-type': 'application/octet-stream' }, payload: content });
    expect(upload.statusCode).toBe(201);
    const receipt = upload.json();
    expect(receipt).toEqual(expect.objectContaining({ sha256, size: content.length, deduplicated: false, filename: '测试 日志.txt' }));
    const attachmentId = receipt.resourceId as string;
    // 完整性：内容寻址落盘且下载一致
    expect(await readFile(join(dataDir, 'attachments', projectId, sha256))).toEqual(content);
    const download = await app.inject({ url: `/api/v1/attachments/${attachmentId}`, headers: agentHeaders });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(content);
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.headers['content-type']).toBe('application/octet-stream');
    // 重复内容按项目唯一附件计量
    const duplicate = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=att-2&filename=log-copy.txt`, headers: { ...agentHeaders, 'content-type': 'application/octet-stream' }, payload: content });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json().resourceId).toBe(attachmentId);
    expect(duplicate.json().deduplicated).toBe(true);
    const usedAfter = (await app.inject({ url: `/api/v1/projects/${projectId}/capacity`, headers: ownerHeaders })).json().records as { used: number };
    expect(usedAfter.used - usedBefore.used).toBeGreaterThanOrEqual(content.length);
    // 关联到证据：健康且保留正式资格
    const evidence = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/evidence`, headers: agentHeaders,
      payload: { requestId: 'attach-evidence', payload: { executionId: runId, criterion: { kind: 'baseline', baselineId, criterionId }, criterionIndex: 1, result: 'passed', actualCommit: headSha, attachmentIds: [attachmentId] } } });
    expect(evidence.statusCode).toBe(201);
    const rows = (await app.inject({ url: `/api/v1/changes/${changeId}/evidence`, headers: ownerHeaders })).json().evidence as { id: string; formal: boolean; formalEffective: boolean; attachments: { id: string; health: string; filename: string; sha256: string; size: number }[] }[];
    console.log('EV-ROWS', JSON.stringify(rows));
    const row = rows[0];
    expect(row.formal).toBe(true);
    expect(row.formalEffective).toBe(true);
    expect(row.attachments[0]).toEqual({ id: attachmentId, filename: '测试 日志.txt', sha256, size: content.length, health: 'ok' });
    // 损坏后：证据显示不合格，下载明确报错；恢复后重新合格
    await writeFile(join(dataDir, 'attachments', projectId, sha256), Buffer.from('被篡改的内容\n', 'utf8'));
    const corrupted = (await app.inject({ url: `/api/v1/changes/${changeId}/evidence`, headers: ownerHeaders })).json().evidence as { formalEffective: boolean; attachments: { health: string }[] }[];
    expect(corrupted[0].attachments[0].health).toBe('corrupted');
    expect(corrupted[0].formalEffective).toBe(false);
    expect((await app.inject({ url: `/api/v1/attachments/${attachmentId}`, headers: agentHeaders })).json().code).toBe('ATTACHMENT_CORRUPTED');
    await writeFile(join(dataDir, 'attachments', projectId, sha256), content);
    // 缺失后同样明确暴露
    const { unlink } = await import('node:fs/promises');
    await unlink(join(dataDir, 'attachments', projectId, sha256));
    expect((await app.inject({ url: `/api/v1/attachments/${attachmentId}`, headers: agentHeaders })).json().code).toBe('ATTACHMENT_MISSING');
    // 历史附件不可删除（无删除入口）
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/attachments/${attachmentId}`, headers: ownerHeaders })).statusCode).toBe(404);
    // 引用不存在的附件被拒
    const badRef = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/evidence`, headers: agentHeaders,
      payload: { requestId: 'attach-evidence-bad', payload: { executionId: runId, criterion: { kind: 'baseline', baselineId, criterionId }, criterionIndex: 1, result: 'passed', attachmentIds: ['missing-attachment'] } } });
    expect(badRef.statusCode).toBe(404);
  }, 30000);

  it('rejects oversized uploads and keeps no reference when storage faults', async () => {
    const { app, dataDir, projectId, ownerHeaders } = await setup();
    // 超过 5 MiB 拒绝
    const oversized = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=att-big&filename=big.bin`, headers: { ...agentHeaders, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(5 * 1024 * 1024 + 1) });
    expect(oversized.statusCode).toBe(413);
    // 同地址已有损坏内容：上传明确失败且不登记引用
    const content = Buffer.from('存储冲突样本\n', 'utf8');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(dataDir, 'attachments', projectId), { recursive: true });
    await writeFile(join(dataDir, 'attachments', projectId, sha256), Buffer.from('损坏的旧内容', 'utf8'));
    const conflict = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=att-conflict&filename=conflict.txt`, headers: { ...agentHeaders, 'content-type': 'application/octet-stream' }, payload: content });
    expect(conflict.statusCode).toBe(503);
    expect(conflict.json().code).toBe('ATTACHMENT_CORRUPTED');
    expect((await app.inject({ url: '/api/v1/receipts/att-conflict', headers: ownerHeaders })).statusCode).toBe(404);
    // 注入数据库故障：登记引用失败不留悬空有效引用；文件可留作未引用内容
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const db = new Database(join(dataDir, 'specmill.db'));
    db.exec("CREATE TRIGGER fail_attachment_receipt BEFORE INSERT ON attachment_requests BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END");
    db.close();
    const restarted = await buildApp({ dataDir, port: 43224, ownerToken: 'owner-token', agentToken: 'agent-token', maxProjectRecordsBytes: undefined }); apps.push(restarted);
    // 重启后用户登录会话失效，需用口令重新登录
    const reLogin = await restarted.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
    const reOwnerHeaders = { ...headers, cookie: reLogin.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const faulted = await restarted.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=att-fault&filename=fault.txt`, headers: { ...agentHeaders, 'content-type': 'application/octet-stream' }, payload: Buffer.from('触发器故障样本\n', 'utf8') });
    expect(faulted.statusCode).toBe(503);
    expect((await restarted.inject({ url: '/api/v1/receipts/att-fault', headers: reOwnerHeaders })).statusCode).toBe(404);
    const listed = (await restarted.inject({ url: `/api/v1/projects/${projectId}/attachments`, headers: reOwnerHeaders })).json().attachments as unknown[];
    expect(listed).toHaveLength(0);
    void dataDir;
  }, 30000);

  it('uploads and lists attachments through the CLI with idempotent retries', async () => {
    const { dataDir, projectId } = await setup();
    await writeFile(join(dataDir, 'cli-token'), await encodeSecret('agent-token'), { mode: 0o600 });
    const cliFile = join(dataDir, 'evidence.log');
    const content = 'CLI 附件内容\n';
    await writeFile(cliFile, content, 'utf8');
    const cli = (...args: string[]) => runFile(process.execPath, ['--import', 'tsx', resolve('src/cli/main.ts'), ...args, '--data-dir', dataDir, '--server', 'http://127.0.0.1:43224', '--json'], { timeout: 30000 });
    const uploaded = JSON.parse((await cli('attachment', 'add', '--project', projectId, '--file', cliFile, '--request-id', 'cli-att')).stdout);
    expect(uploaded.resourceId).toBeTruthy();
    expect(uploaded.deduplicated).toBe(false);
    const replay = JSON.parse((await cli('attachment', 'add', '--project', projectId, '--file', cliFile, '--request-id', 'cli-att')).stdout);
    expect(replay.resourceId).toBe(uploaded.resourceId);
    const other = JSON.parse((await cli('attachment', 'add', '--project', projectId, '--file', cliFile, '--request-id', 'cli-att-2')).stdout);
    expect(other.resourceId).toBe(uploaded.resourceId);
    expect(other.deduplicated).toBe(true);
    const listed = JSON.parse((await cli('attachment', 'list', '--project', projectId)).stdout);
    expect(listed.attachments).toHaveLength(1);
    expect(listed.attachments[0].size).toBe(Buffer.byteLength(content, 'utf8'));
  }, 60000);
});
