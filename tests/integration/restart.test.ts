import { afterEach, describe, expect, it } from 'vitest';
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const runFile = promisify(execFile);
const port = 43228;
const base = `http://127.0.0.1:${port}`;
const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await delay(300);
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
    // 强制终止后的单实例锁是数据目录的同级锁目录，一并清理。
    await rm(`${dir}.lock`, { recursive: true, force: true });
  }
});
function startServer(dataDir: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/server/main.ts'), '--data-dir', dataDir, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  return child;
}
// 等待服务打印一次性登录口令；进程因单实例锁退出时返回 null。
function waitOwnerToken(child: ChildProcess): Promise<string | null> {
  return new Promise(resolveWait => {
    let out = '';
    const finish = (value: string | null) => {
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      clearTimeout(timer);
      resolveWait(value);
    };
    const onData = (chunk: Buffer) => {
      out += String(chunk);
      const match = /本次登录口令：([0-9a-f]{64})/.exec(out);
      if (match) finish(match[1]);
    };
    const onExit = () => finish(null);
    const timer = setTimeout(() => finish(null), 20000);
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
}
// 强制终止服务；单实例锁按 stale 约定（约 10 秒）恢复，轮询重启直到成功。
async function stopServer(): Promise<void> {
  const previous = children.pop();
  if (previous) {
    previous.kill();
    await new Promise<void>(resolveExit => previous.once('exit', () => resolveExit()));
  }
}
async function startServerAfterLock(dataDir: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const next = startServer(dataDir);
    const ownerToken = await waitOwnerToken(next);
    if (ownerToken) return ownerToken;
    await delay(1000);
  }
  throw new Error('重启后的服务未能在预期时间内启动');
}
const cli = (dataDir: string, ...args: string[]) => runFile(process.execPath, ['--import', 'tsx', resolve('src/cli/main.ts'), ...args, '--data-dir', dataDir, '--server', base, '--json'], { timeout: 30000 });
const cliFailure = async (dataDir: string, ...args: string[]) => {
  try {
    await cli(dataDir, ...args);
    throw new Error('expected CLI failure');
  } catch (error) { return error as Error & { code: number; stderr: string }; }
};
async function spawnStdin(dataDir: string, args: string[], body: string) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveSpawn, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/cli/main.ts'), ...args, '--data-dir', dataDir, '--server', base, '--json']);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => resolveSpawn({ code, stdout, stderr }));
    child.stdin.end(body);
  });
}

describe('real process restart', () => {
  it('invalidates grants across a real restart and replays the delayed CLI write-back', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'specmill-restart-data-')); dirs.push(dataDir);
    const repoDir = await mkdtemp(join(tmpdir(), 'specmill-restart-repo-')); dirs.push(repoDir);
    const init = spawnSync('git', ['-C', repoDir, 'init', '-q'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } });
    if (init.status !== 0) throw new Error(init.stderr);
    const ownerToken = await waitOwnerToken(startServer(dataDir));
    expect(ownerToken).toBeTruthy();
    const login = await fetch(`${base}/api/v1/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token: ownerToken }) });
    expect(login.status).toBe(200);
    const ownerHeaders = { origin: base, cookie: login.headers.get('set-cookie')!.split(';')[0], 'content-type': 'application/json', 'x-specmill-request': '1' };
    const seed = async (path: string, payload: Record<string, unknown>) => {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify(payload) });
      expect(response.status).toBe(201);
      return (await response.json()).resourceId as string;
    };
    const projectId = await seed('/api/v1/projects', { name: '重启项目', requestId: 'restart-project' });
    const workspaceId = await seed(`/api/v1/projects/${projectId}/workspaces`, { requestId: 'restart-workspace', expectedVersion: null, payload: { workspaceId: null, path: repoDir } });
    const changeId = await seed(`/api/v1/projects/${projectId}/changes`, { requestId: 'restart-change', expectedVersion: null, payload: { title: '重启续做', goal: '', scope: '', nonGoals: '', criteria: [] } });
    const grantFile = join(dataDir, 'grant.json');
    const started = JSON.parse((await cli(dataDir, 'session', 'start', '--change', changeId, '--workspace', workspaceId, '--binding-version', '1', '--version', '1', '--tool', 'CLI 重启', '--request-id', 'restart-start', '--grant-file', grantFile)).stdout);
    expect(started).toEqual(expect.objectContaining({ generation: 1, recordVersion: 2 }));
    const observationId = JSON.parse((await cli(dataDir, 'workspace', 'observe', '--workspace', workspaceId, '--binding-version', '1', '--request-id', 'restart-observe', '--grant-file', grantFile)).stdout).resourceId as string;
    const committedBody = JSON.stringify({ done: '已提交内容', failures: '无', unverified: '重启后回放未验证', blockers: '无', nextSteps: '核对回执' });
    const inputFile = join(dataDir, 'checkpoint.json');
    await writeFile(inputFile, committedBody);
    const saved = JSON.parse((await cli(dataDir, 'checkpoint', 'save', '--change', changeId, '--version', '2', '--request-id', 'delayed-checkpoint', '--observation', observationId, '--grant-file', grantFile, '--file', inputFile)).stdout);
    expect(saved).toEqual(expect.objectContaining({ requestId: 'delayed-checkpoint', recordVersion: 3 }));
    // 强制终止服务后按原请求重试：失败并留下加密的待写回文件
    await stopServer();
    const saveArgs = ['checkpoint', 'save', '--change', changeId, '--version', '2', '--request-id', 'delayed-checkpoint', '--observation', observationId, '--grant-file', grantFile];
    const lostResponse = await spawnStdin(dataDir, [...saveArgs, '--stdin'], committedBody);
    expect(lostResponse.code).toBe(6);
    const pendingFile = JSON.parse(lostResponse.stderr).pendingInputFile as string;
    expect(pendingFile).toBeTruthy();
    const unknownOutcome = await spawnStdin(dataDir, ['checkpoint', 'save', '--change', changeId, '--version', '2', '--request-id', 'never-committed', '--observation', observationId, '--grant-file', grantFile, '--stdin'],
      JSON.stringify({ done: '服务中断期间的内容', failures: '无', unverified: '未知', blockers: '无', nextSteps: '接管后重试' }));
    expect(unknownOutcome.code).toBe(6);
    const pendingUnknown = JSON.parse(unknownOutcome.stderr).pendingInputFile as string;
    expect(pendingUnknown).toBeTruthy();
    // 真实重启后：登录会话随进程失效，用新口令重新登录；活跃会话被标记中断，旧授权不能继续写
    const nextOwnerToken = await startServerAfterLock(dataDir);
    expect(nextOwnerToken).toBeTruthy();
    const nextLogin = await fetch(`${base}/api/v1/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token: nextOwnerToken }) });
    expect(nextLogin.status).toBe(200);
    const nextOwnerHeaders = { origin: base, cookie: nextLogin.headers.get('set-cookie')!.split(';')[0], 'content-type': 'application/json', 'x-specmill-request': '1' };
    const staleOwner = await fetch(`${base}/api/v1/projects`, { headers: { origin: base, cookie: login.headers.get('set-cookie')!.split(';')[0] } });
    expect(staleOwner.status).toBe(401);
    const history = await (await fetch(`${base}/api/v1/changes/${changeId}/writer-sessions`, { headers: { origin: base, cookie: nextOwnerHeaders.cookie } })).json() as { sessions: { status: string; generation: number }[] };
    expect(history.sessions).toEqual([expect.objectContaining({ id: started.resourceId, status: 'interrupted', generation: 1 })]);
    const staleRelease = await cliFailure(dataDir, 'session', 'release', '--grant-file', grantFile, '--version', '3', '--request-id', 'late-release');
    expect(staleRelease.code).toBe(3);
    expect(JSON.parse(staleRelease.stderr).code).toBe('SESSION_EXPIRED');
    // 已在崩溃前提交的原请求重试成功：幂等回放返回原回执，且不产生第二条保存点
    const replayed = JSON.parse((await cli(dataDir, ...saveArgs, '--pending-file', pendingFile)).stdout);
    expect(replayed).toEqual(expect.objectContaining({ requestId: 'delayed-checkpoint', recordVersion: 3, retainedInputFile: pendingFile }));
    // 从未提交过的原请求重试被会话 fencing 拒绝，待写回内容仍保留
    const rejected = await cliFailure(dataDir, 'checkpoint', 'save', '--change', changeId, '--version', '2', '--request-id', 'never-committed', '--observation', observationId, '--grant-file', grantFile, '--pending-file', pendingUnknown);
    expect(rejected.code).toBe(3);
    const rejectedError = JSON.parse(rejected.stderr);
    expect(rejectedError.code).toBe('SESSION_EXPIRED');
    expect(rejectedError.pendingInputFile).toBe(pendingUnknown);
    const checkpoints = await (await fetch(`${base}/api/v1/changes/${changeId}/checkpoints`, { headers: { origin: base, cookie: nextOwnerHeaders.cookie } })).json() as { checkpoints: { id: string }[] };
    expect(checkpoints.checkpoints).toHaveLength(1);
  }, 120000);
});
