import { afterEach, describe, expect, it } from 'vitest';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../../src/server/app.js';
import { decodeSecret, encodeSecret } from '../../src/shared/credentials.js';

const runFile = promisify(execFile);
const dirs: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('thin CLI', () => {
  it('reads a change and starts/releases a scoped session through HTTP', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'specmill-cli-data-')); dirs.push(dataDir);
    const repoDir = await mkdtemp(join(tmpdir(), 'specmill-cli-repo-')); dirs.push(repoDir);
    const init = spawnSync('git', ['-C', repoDir, 'init', '-q'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } });
    if (init.status !== 0) throw new Error(init.stderr);
    const app = await buildApp({ dataDir, port: 43229, ownerToken: 'owner-token', agentToken: 'agent-token' }); apps.push(app);
    await app.listen({ host: '127.0.0.1', port: 43229 });
    const storedToken = await encodeSecret('agent-token');
    if (process.platform === 'win32') expect(storedToken).not.toContain('agent-token');
    await writeFile(join(dataDir, 'cli-token'), storedToken, { mode: 0o600 });
    const headers = { host: '127.0.0.1:43229', origin: 'http://127.0.0.1:43229' };
    const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
    const ownerHeaders = { ...headers, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: ownerHeaders, payload: { name: 'CLI', requestId: 'cli-project' } });
    const projectId = project.json().resourceId as string;
    const workspace = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders,
      payload: { requestId: 'cli-workspace', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
    const change = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
      payload: { requestId: 'cli-change', expectedVersion: null, payload: { title: 'CLI 草案', goal: '完成命令行续做', scope: '', nonGoals: '', criteria: [] } } });
    const changeId = change.json().resourceId as string;
    const workspaceId = workspace.json().resourceId as string;
    const cli = (...args: string[]) => runFile(process.execPath, ['--import', 'tsx', resolve('src/cli/main.ts'), ...args, '--data-dir', dataDir, '--server', 'http://127.0.0.1:43229', '--json'], { timeout: 20000 });
    const shown = await cli('change', 'show', '--change', changeId);
    expect(JSON.parse(shown.stdout)).toEqual(expect.objectContaining({ id: changeId, phase: 'Draft', version: 1 }));
    const grantFile = join(dataDir, 'grant.json');
    const started = await cli('session', 'start', '--change', changeId, '--workspace', workspaceId, '--binding-version', '1', '--version', '1', '--tool', 'CLI A', '--request-id', 'cli-start', '--grant-file', grantFile);
    const storedGrant = await readFile(grantFile, 'utf8');
    const grant = JSON.parse(await decodeSecret(storedGrant));
    if (process.platform === 'win32') expect(storedGrant).not.toContain(grant.writerToken);
    expect(JSON.parse(started.stdout)).toEqual(expect.objectContaining({ resourceId: grant.sessionId, recordVersion: 2, generation: 1 }));
    expect(started.stdout).not.toContain(grant.writerToken);
    const observed = await cli('workspace', 'observe', '--workspace', workspaceId, '--binding-version', '1', '--request-id', 'cli-observe', '--grant-file', grantFile);
    const observationId = JSON.parse(observed.stdout).resourceId as string;
    const input = join(dataDir, 'checkpoint.json');
    await writeFile(input, JSON.stringify({ done: '完成基础结构', failures: '测试未通过', unverified: '恢复尚未验证', blockers: '无', nextSteps: '继续实现' }));
    const saved = await cli('checkpoint', 'save', '--change', changeId, '--version', '2', '--request-id', 'cli-checkpoint', '--observation', observationId, '--grant-file', grantFile, '--file', input);
    const receipt = JSON.parse(saved.stdout);
    expect(receipt).toEqual(expect.objectContaining({ requestId: 'cli-checkpoint', recordVersion: 3 }));
    expect(JSON.parse((await cli('receipt', 'show', '--request-id', 'cli-checkpoint')).stdout)).toEqual(receipt);
    const streamed = await new Promise<{ code: number | null; stdout: string }>((resolveChild, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/cli/main.ts'), 'checkpoint', 'save', '--change', changeId, '--version', '3', '--request-id', 'cli-stdin', '--observation', observationId, '--grant-file', grantFile, '--stdin', '--data-dir', dataDir, '--server', 'http://127.0.0.1:43229', '--json']);
      let stdout = ''; child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.on('error', reject); child.on('close', code => resolveChild({ code, stdout }));
      child.stdin.end(JSON.stringify({ done: 'stdin 保存', failures: '无', unverified: '未知', blockers: '无', nextSteps: '继续' }));
    });
    expect(streamed.code).toBe(0);
    expect(JSON.parse(streamed.stdout).recordVersion).toBe(4);
    const released = await cli('session', 'release', '--grant-file', grantFile, '--version', '4', '--request-id', 'cli-release');
    expect(JSON.parse(released.stdout)).toEqual(expect.objectContaining({ resourceId: grant.sessionId, recordVersion: 5 }));
    expect(JSON.parse((await cli('change', 'show', '--change', changeId)).stdout).activeSession).toBeNull();
  }, 45000);

  it('does not forward writer credentials on redirects and treats corrupt success responses as unknown', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'specmill-cli-network-')); dirs.push(dataDir);
    const writerToken = 'a'.repeat(64);
    await writeFile(join(dataDir, 'cli-token'), await encodeSecret('agent-token'));
    const grantFile = join(dataDir, 'grant');
    await writeFile(grantFile, await encodeSecret(JSON.stringify({ requestId: 'start', sessionId: 'session', generation: 1, writerToken })));
    let followed = false;
    const target = createServer((_request, response) => { followed = true; response.end('{}'); });
    await new Promise<void>(resolveListen => target.listen(0, '127.0.0.1', resolveListen));
    const targetPort = (target.address() as AddressInfo).port;
    let mode: 'redirect' | 'corrupt' | 'failure' | 'success' = 'redirect';
    const source = createServer((_request, response) => {
      if (mode === 'redirect') response.writeHead(307, { location: `http://127.0.0.1:${targetPort}/capture` }).end();
      else if (mode === 'corrupt') response.writeHead(200, { 'content-type': 'application/json' }).end('{');
      else if (mode === 'failure') response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: '模拟失败' }));
      else response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ requestId: 'stdin-recovery', resourceId: 'checkpoint', recordVersion: 3, committedAt: '2026-01-01T00:00:00Z' }));
    });
    await new Promise<void>(resolveListen => source.listen(0, '127.0.0.1', resolveListen));
    const sourcePort = (source.address() as AddressInfo).port;
    const run = async () => {
      try {
        await runFile(process.execPath, ['--import', 'tsx', resolve('src/cli/main.ts'), 'session', 'release', '--grant-file', grantFile, '--version', '2', '--request-id', 'release', '--data-dir', dataDir, '--server', `http://127.0.0.1:${sourcePort}`, '--json'], { timeout: 20000 });
        throw new Error('expected CLI failure');
      } catch (error) { return error as Error & { code: number; stdout: string; stderr: string }; }
    };
    try {
      const blocked = await run();
      expect(blocked.code).toBe(6);
      expect(blocked.stderr).not.toContain(writerToken);
      expect(followed).toBe(false);
      mode = 'corrupt';
      const corrupt = await run();
      expect(corrupt.code).toBe(6);
      expect(JSON.parse(corrupt.stderr).code).toBe('INVALID_RESPONSE');
      mode = 'failure';
      const body = JSON.stringify({ done: 'stdin 待恢复内容', failures: '无', unverified: '无', blockers: '无', nextSteps: '重试' });
      const failed = await new Promise<{ code: number | null; stderr: string }>((resolveChild, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/cli/main.ts'), 'checkpoint', 'save', '--change', 'change', '--version', '2', '--request-id', 'stdin-recovery', '--observation', 'observation', '--grant-file', grantFile, '--stdin', '--data-dir', dataDir, '--server', `http://127.0.0.1:${sourcePort}`, '--json']);
        let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk); });
        child.on('error', reject); child.on('close', code => resolveChild({ code, stderr })); child.stdin.end(body);
      });
      expect(failed.code).toBe(6);
      const pendingFile = JSON.parse(failed.stderr).pendingInputFile as string;
      expect(await decodeSecret(await readFile(pendingFile, 'utf8'))).toBe(body);
      mode = 'success';
      const restored = await runFile(process.execPath, ['--import', 'tsx', resolve('src/cli/main.ts'), 'checkpoint', 'save', '--change', 'change', '--version', '2', '--request-id', 'stdin-recovery', '--observation', 'observation', '--grant-file', grantFile, '--pending-file', pendingFile, '--data-dir', dataDir, '--server', `http://127.0.0.1:${sourcePort}`, '--json'], { timeout: 20000 });
      expect(JSON.parse(restored.stdout)).toEqual(expect.objectContaining({ requestId: 'stdin-recovery', retainedInputFile: pendingFile }));
    } finally {
      await new Promise<void>(resolveClose => source.close(() => resolveClose()));
      await new Promise<void>(resolveClose => target.close(() => resolveClose()));
    }
  }, 30000);
});
