import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { buildApp } from '../../src/server/app.js';
import { encodeSecret } from '../../src/shared/credentials.js';
import * as attachmentStorage from '../../src/server/storage/attachments.js';

const runFile = promisify(execFile);

const testAgentToken = 'c'.repeat(64);
const dirs: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const headers = { host: '127.0.0.1:43224', origin: 'http://127.0.0.1:43224' };
const agentHeaders = { host: headers.host, authorization: `Bearer ${testAgentToken}` };
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
  const app = await buildApp({ dataDir, port: 43224, ownerToken: 'owner-token', agentToken: testAgentToken, maxProjectRecordsBytes }); apps.push(app);
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
  const run = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/executions`, headers: { ...agentHeaders, 'x-specmill-writer-token': 'a'.repeat(64) },
    payload: { requestId: 'attach-run', writerSessionId: session.resourceId, generation: session.generation, workspaceId, payload: { method: 'node --test', result: 'passed', claimedCommit: headSha, claimedClean: true } } });
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
  it('enforces project and session scope for agent uploads, including an in-flight deduplication', async () => {
    const { app, projectId, changeId, ownerHeaders, session } = await setup();
    const query = `writerSessionId=${session.resourceId}&generation=${session.generation}`;
    const auth = { ...agentHeaders, 'x-specmill-writer-token': 'a'.repeat(64), 'content-type': 'application/octet-stream' };
    const upload = (id: string, project = projectId, requestHeaders = auth) => app.inject({ method: 'POST', url: `/api/v1/projects/${project}/attachments?requestId=${id}&filename=guard.txt&${query}`, headers: requestHeaders, payload: Buffer.from('scope-test') }).then(response => response);
    expect((await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=scope-missing&filename=guard.txt`, headers: auth, payload: Buffer.from('scope-test') })).json().code).toBe('SESSION_EXPIRED');
    expect((await upload('scope-wrong-token', projectId, { ...auth, 'x-specmill-writer-token': 'b'.repeat(64) })).statusCode).toBe(403);
    const other = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: ownerHeaders, payload: { name: '其他项目', requestId: 'scope-other' } });
    expect((await upload('scope-other-project', other.json().resourceId)).json().code).toBe('WORKSPACE_CHANGED');
    const original = await upload('scope-original');
    expect(original.statusCode).toBe(201);
    expect((await upload('scope-original')).json().resourceId).toBe(original.json().resourceId);
    let release = () => {}; let report = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { report = resolve; });
    const actual = attachmentStorage.checkAttachmentHealth;
    const spy = vi.spyOn(attachmentStorage, 'checkAttachmentHealth').mockImplementationOnce(async (...args) => { report(); await gate; return actual(...args); });
    try {
      const pending = upload('scope-delayed');
      await started;
      const takeover = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/writer-sessions/takeover`, headers: ownerHeaders, payload: { requestId: 'scope-takeover', expectedVersion: 3, payload: { writerSessionId: session.resourceId, expectedGeneration: session.generation, expectedCheckpointId: null, toolLabel: '用户接管' } } });
      expect(takeover.statusCode).toBe(201);
      release();
      expect((await pending).json().code).toBe('SESSION_EXPIRED');
    } finally { release(); spy.mockRestore(); }
    expect((await upload('scope-original')).json().code).toBe('SESSION_EXPIRED');
    expect((await app.inject({ url: '/api/v1/receipts/scope-original', headers: agentHeaders })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/v1/receipts/scope-delayed', headers: agentHeaders })).statusCode).toBe(404);
  }, 30000);
  it('enforces the distinct attachment limit atomically under concurrent uploads', async () => {
    const { app, dataDir, projectId } = await setup();
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const db = new Database(join(dataDir, 'specmill.db'));
    try {
      const insert = db.prepare('INSERT INTO attachments(id,project_id,sha256,size,filename,content_type,created_at) VALUES (?,?,?,?,?,?,?)');
      db.transaction(() => {
        for (let index = 0; index < 9997; index++) insert.run(`seed-${index}`, projectId, createHash('sha256').update(`seed-${index}`).digest('hex'), 1, 'seed.txt', 'text/plain', '2026-01-01T00:00:00Z');
      })();
    } finally { db.close(); }
    const restarted = await buildApp({ dataDir, port: 43224, ownerToken: 'owner-token', agentToken: testAgentToken }); apps.push(restarted);
    const initialLogin = await restarted.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
    const initialOwner = { ...headers, cookie: initialLogin.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const send = (id: string, content: string) => restarted.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=${id}&filename=sample.txt`, headers: { ...initialOwner, 'content-type': 'application/octet-stream' }, payload: Buffer.from(content) });
    const attempts = await Promise.all([send('last-slot-a', 'new-a'), send('last-slot-b', 'new-b')]);
    expect(attempts.map(item => item.statusCode).sort()).toEqual([201, 413]);
    const winnerIndex = attempts.findIndex(item => item.statusCode === 201);
    const loserIndex = 1 - winnerIndex;
    expect(attempts[loserIndex].json().code).toBe('ATTACHMENT_COUNT_EXCEEDED');
    const winningContent = winnerIndex === 0 ? 'new-a' : 'new-b';
    const losingContent = loserIndex === 0 ? 'new-a' : 'new-b';
    const losingHash = createHash('sha256').update(losingContent).digest('hex');
    await expect(stat(join(dataDir, 'attachments', projectId, losingHash))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await send('same-content-new-request', winningContent)).statusCode).toBe(201);
    expect((await send(winnerIndex === 0 ? 'last-slot-a' : 'last-slot-b', winningContent)).statusCode).toBe(201);
    expect((await send('beyond-limit', 'new-c')).json().code).toBe('ATTACHMENT_COUNT_EXCEEDED');
    const login = await restarted.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
    const owner = { ...headers, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const other = await restarted.inject({ method: 'POST', url: '/api/v1/projects', headers: owner, payload: { name: '另一个项目', requestId: 'other-project' } });
    expect((await restarted.inject({ method: 'POST', url: `/api/v1/projects/${other.json().resourceId}/attachments?requestId=other-upload&filename=sample.txt`, headers: { ...owner, 'content-type': 'application/octet-stream' }, payload: Buffer.from('new-c') })).statusCode).toBe(201);
    await restarted.close(); apps.splice(apps.indexOf(restarted), 1);
    const legacyDb = new Database(join(dataDir, 'specmill.db'));
    try { legacyDb.prepare('INSERT INTO attachments(id,project_id,sha256,size,filename,content_type,created_at) VALUES (?,?,?,?,?,?,?)').run('legacy-extra', projectId, createHash('sha256').update('legacy-extra').digest('hex'), 1, 'legacy.txt', 'text/plain', '2026-01-01T00:00:00Z'); } finally { legacyDb.close(); }
    const legacy = await buildApp({ dataDir, port: 43224, ownerToken: 'owner-token', agentToken: testAgentToken }); apps.push(legacy);
    const legacyLogin = await legacy.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
    const legacyOwner = { ...headers, cookie: legacyLogin.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const legacySend = (id: string, content: string) => legacy.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=${id}&filename=sample.txt`, headers: { ...legacyOwner, 'content-type': 'application/octet-stream' }, payload: Buffer.from(content) });
    expect((await legacySend('legacy-new', 'new-d')).json().code).toBe('ATTACHMENT_COUNT_EXCEEDED');
    expect((await legacySend('legacy-duplicate', winningContent)).statusCode).toBe(201);
  }, 30000);
  it('deduplicates simultaneous uploads without reporting an incomplete file as corrupted', async () => {
    const { app, projectId, ownerHeaders } = await setup();
    const content = Buffer.alloc(4 * 1024 * 1024, 7);
    const responses = await Promise.all(Array.from({ length: 4 }, (_, index) => app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=parallel-${index}&filename=parallel.txt`, headers: { ...ownerHeaders, 'content-type': 'application/octet-stream' }, payload: content })));
    expect(responses.map(response => response.statusCode)).toEqual([201, 201, 201, 201]);
    expect(new Set(responses.map(response => response.json().resourceId)).size).toBe(1);
    const list = (await app.inject({ url: `/api/v1/projects/${projectId}/attachments`, headers: ownerHeaders })).json().attachments as unknown[];
    expect(list).toHaveLength(1);
  }, 30000);
  it('enforces capacity for new duplicate-upload receipts while retaining idempotent replay', async () => {
    const { app, projectId, ownerHeaders } = await setup(16000);
    const content = Buffer.from('same attachment');
    const send = (requestId: string) => app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=${requestId}&filename=copy.txt`, headers: { ...ownerHeaders, 'content-type': 'application/octet-stream' }, payload: content });
    const initial = await send('capacity-original');
    expect(initial.statusCode).toBe(201);
    let rejectedId = '';
    for (let index = 0; index < 100; index++) {
      const requestId = `capacity-copy-${index}`;
      const before = (await app.inject({ url: `/api/v1/projects/${projectId}/capacity`, headers: ownerHeaders })).json().records.used as number;
      const response = await send(requestId);
      if (response.statusCode === 413) {
        rejectedId = requestId;
        expect(response.json().code).toBe('PROJECT_CAPACITY_EXCEEDED');
        expect((await app.inject({ url: `/api/v1/projects/${projectId}/capacity`, headers: ownerHeaders })).json().records.used).toBe(before);
        break;
      }
      expect(response.statusCode).toBe(201);
    }
    expect(rejectedId).not.toBe('');
    expect((await send('capacity-original')).statusCode).toBe(201);
    expect((await send(rejectedId)).statusCode).toBe(413);
  }, 30000);

  it('stores content-addressed attachments, deduplicates content and links them to evidence', async () => {
    const { app, dataDir, projectId, changeId, ownerHeaders, runId, baselineId, criterionId, headSha, session } = await setup();
    const content = Buffer.from('测试日志内容：全部通过\n第二行\n', 'utf8');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const usedBefore = (await app.inject({ url: `/api/v1/projects/${projectId}/capacity`, headers: ownerHeaders })).json().records as { used: number };
    const upload = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=att-1&filename=${encodeURIComponent('测试 日志.txt')}&contentType=text%2Fplain`, headers: { ...ownerHeaders, 'content-type': 'application/octet-stream' }, payload: content });
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
    const duplicate = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=att-2&filename=log-copy.txt`, headers: { ...ownerHeaders, 'content-type': 'application/octet-stream' }, payload: content });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json().resourceId).toBe(attachmentId);
    expect(duplicate.json().deduplicated).toBe(true);
    const usedAfter = (await app.inject({ url: `/api/v1/projects/${projectId}/capacity`, headers: ownerHeaders })).json().records as { used: number };
    expect(usedAfter.used - usedBefore.used).toBeGreaterThanOrEqual(content.length);
    // 关联到证据：健康且保留正式资格
    const evidence = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/evidence`, headers: { ...agentHeaders, 'x-specmill-writer-token': 'a'.repeat(64) },
      payload: { requestId: 'attach-evidence', writerSessionId: session.resourceId, generation: session.generation, payload: { executionId: runId, criterion: { kind: 'baseline', baselineId, criterionId }, criterionIndex: 1, result: 'passed', actualCommit: headSha, attachmentIds: [attachmentId] } } });
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
    const duplicateDamaged = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=damaged-copy&filename=log-copy.txt`, headers: { ...ownerHeaders, 'content-type': 'application/octet-stream' }, payload: content });
    expect(duplicateDamaged.statusCode).toBe(503);
    expect((await app.inject({ url: '/api/v1/receipts/damaged-copy', headers: ownerHeaders })).statusCode).toBe(404);
    const originalReplay = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=att-1&filename=${encodeURIComponent('测试 日志.txt')}&contentType=text%2Fplain`, headers: { ...ownerHeaders, 'content-type': 'application/octet-stream' }, payload: content });
    expect(originalReplay.statusCode).toBe(201);
    expect(originalReplay.json().resourceId).toBe(attachmentId);
    await writeFile(join(dataDir, 'attachments', projectId, sha256), content);
    // 缺失后同样明确暴露
    const { unlink } = await import('node:fs/promises');
    await unlink(join(dataDir, 'attachments', projectId, sha256));
    expect((await app.inject({ url: `/api/v1/attachments/${attachmentId}`, headers: agentHeaders })).json().code).toBe('ATTACHMENT_MISSING');
    const duplicateMissing = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=missing-copy&filename=log-copy.txt`, headers: { ...ownerHeaders, 'content-type': 'application/octet-stream' }, payload: content });
    expect(duplicateMissing.statusCode).toBe(503);
    expect(duplicateMissing.json().code).toBe('ATTACHMENT_MISSING');
    // 历史附件不可删除（无删除入口）
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/attachments/${attachmentId}`, headers: ownerHeaders })).statusCode).toBe(404);
    // 引用不存在的附件被拒
    const badRef = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/evidence`, headers: { ...agentHeaders, 'x-specmill-writer-token': 'a'.repeat(64) },
      payload: { requestId: 'attach-evidence-bad', writerSessionId: session.resourceId, generation: session.generation, payload: { executionId: runId, criterion: { kind: 'baseline', baselineId, criterionId }, criterionIndex: 1, result: 'passed', attachmentIds: ['missing-attachment'] } } });
    expect(badRef.statusCode).toBe(404);
  }, 30000);

  it('rejects oversized uploads and keeps no reference when storage faults', async () => {
    const { app, dataDir, projectId, ownerHeaders } = await setup();
    // 超过 5 MiB 拒绝
    const oversized = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=att-big&filename=big.bin`, headers: { ...ownerHeaders, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(5 * 1024 * 1024 + 1) });
    expect(oversized.statusCode).toBe(413);
    // 同地址已有损坏内容：上传明确失败且不登记引用
    const content = Buffer.from('存储冲突样本\n', 'utf8');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(dataDir, 'attachments', projectId), { recursive: true });
    await writeFile(join(dataDir, 'attachments', projectId, sha256), Buffer.from('损坏的旧内容', 'utf8'));
    const conflict = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=att-conflict&filename=conflict.txt`, headers: { ...ownerHeaders, 'content-type': 'application/octet-stream' }, payload: content });
    expect(conflict.statusCode).toBe(503);
    expect(conflict.json().code).toBe('ATTACHMENT_CORRUPTED');
    expect((await app.inject({ url: '/api/v1/receipts/att-conflict', headers: ownerHeaders })).statusCode).toBe(404);
    // 注入数据库故障：本次创建的内容也应清理，已有冲突文件不得被删除。
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const db = new Database(join(dataDir, 'specmill.db'));
    db.exec("CREATE TRIGGER fail_attachment_receipt BEFORE INSERT ON attachment_requests BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END");
    db.close();
    const restarted = await buildApp({ dataDir, port: 43224, ownerToken: 'owner-token', agentToken: testAgentToken, maxProjectRecordsBytes: undefined }); apps.push(restarted);
    // 重启后用户登录会话失效，需用口令重新登录
    const reLogin = await restarted.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
    const reOwnerHeaders = { ...headers, cookie: reLogin.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const faulted = await restarted.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=att-fault&filename=fault.txt`, headers: { ...reOwnerHeaders, 'content-type': 'application/octet-stream' }, payload: Buffer.from('触发器故障样本\n', 'utf8') });
    expect(faulted.statusCode).toBe(503);
    const faultDigest = createHash('sha256').update('触发器故障样本\n', 'utf8').digest('hex');
    await expect(stat(join(dataDir, 'attachments', projectId, faultDigest))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(dataDir, 'attachments', projectId, sha256), 'utf8')).toBe('损坏的旧内容');
    expect((await restarted.inject({ url: '/api/v1/receipts/att-fault', headers: reOwnerHeaders })).statusCode).toBe(404);
    const listed = (await restarted.inject({ url: `/api/v1/projects/${projectId}/attachments`, headers: reOwnerHeaders })).json().attachments as unknown[];
    expect(listed).toHaveLength(0);
    void dataDir;
  }, 30000);

  it('uploads and lists attachments through the CLI with idempotent retries', async () => {
    const { dataDir, projectId, session } = await setup();
    const grantFile = join(dataDir, 'attachment-grant');
    await writeFile(grantFile, await encodeSecret(JSON.stringify({ sessionId: session.resourceId, generation: session.generation, writerToken: 'a'.repeat(64) })));
    await writeFile(join(dataDir, 'cli-token'), await encodeSecret(testAgentToken), { mode: 0o600 });
    const cliFile = join(dataDir, 'evidence.log');
    const content = 'CLI 附件内容\n';
    await writeFile(cliFile, content, 'utf8');
    const cli = (...args: string[]) => runFile(process.execPath, ['--import', 'tsx', resolve('src/cli/main.ts'), ...args, '--data-dir', dataDir, '--server', 'http://127.0.0.1:43224', '--json'], { timeout: 30000 });
    const uploaded = JSON.parse((await cli('attachment', 'add', '--project', projectId, '--grant-file', grantFile, '--file', cliFile, '--request-id', 'cli-att')).stdout);
    expect(uploaded.resourceId).toBeTruthy();
    expect(uploaded.deduplicated).toBe(false);
    const replay = JSON.parse((await cli('attachment', 'add', '--project', projectId, '--grant-file', grantFile, '--file', cliFile, '--request-id', 'cli-att')).stdout);
    expect(replay.resourceId).toBe(uploaded.resourceId);
    const other = JSON.parse((await cli('attachment', 'add', '--project', projectId, '--grant-file', grantFile, '--file', cliFile, '--request-id', 'cli-att-2')).stdout);
    expect(other.resourceId).toBe(uploaded.resourceId);
    expect(other.deduplicated).toBe(true);
    const listed = JSON.parse((await cli('attachment', 'list', '--project', projectId)).stdout);
    expect(listed.attachments).toHaveLength(1);
    expect(listed.attachments[0].size).toBe(Buffer.byteLength(content, 'utf8'));
  }, 60000);
});
