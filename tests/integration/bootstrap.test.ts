import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { buildApp } from '../../src/server/app.js';

const dirs: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-test-')); dirs.push(dataDir);
  const app = await buildApp({ dataDir, port: 43127, ownerToken: 'test-owner-token', agentToken: 'test-agent-token' });
  apps.push(app); return { app, dataDir };
}
const headers = { host: '127.0.0.1:43127', origin: 'http://127.0.0.1:43127' };
async function login(app: Awaited<ReturnType<typeof buildApp>>) {
  const result = await app.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'test-owner-token' } });
  expect(result.statusCode).toBe(200);
  return result.headers['set-cookie'] as string;
}
describe('local project service', () => {
  it('returns a traceable Chinese error for unauthenticated requests', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects', headers });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      code: 'UNAUTHORIZED',
      message: expect.stringMatching(/[\u4e00-\u9fff]/),
      requestId: expect.any(String),
    });
    expect(response.json().requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('requires authentication even when the API path is percent-encoded', async () => {
    const { app } = await setup();
    const read = await app.inject({ url: '/%61pi/v1/projects', headers });
    expect(read.statusCode).toBe(401);
    const write = await app.inject({ method: 'POST', url: '/%61pi/v1/projects', headers, payload: { name: 'blocked', requestId: 'encoded' } });
    expect(write.statusCode).toBe(401);
    const cookie = await login(app);
    const list = await app.inject({ url: '/api/v1/projects', headers: { ...headers, cookie } });
    expect(list.json().projects).toEqual([]);
  });
  it('returns the same error contract for rejected input, access and conflicts', async () => {
    const { app } = await setup();
    const cookie = await login(app);
    const ownerHeaders = { ...headers, cookie, 'x-specmill-request': '1' };
    const create = (name: string) => app.inject({ method: 'POST', url: '/api/v1/projects', headers: ownerHeaders, payload: { name, requestId: 'same-request' } });
    expect((await create('原项目')).statusCode).toBe(201);
    const responses = [
      [403, 'FORBIDDEN_HOST', await app.inject({ url: '/api/v1/projects', headers: { host: 'evil.example' } })],
      [403, 'FORBIDDEN_ORIGIN', await app.inject({ url: '/api/v1/projects', headers: { ...headers, origin: 'https://evil.example' } })],
      [401, 'UNAUTHORIZED', await app.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'wrong' } })],
      [403, 'FORBIDDEN', await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { ...headers, cookie }, payload: { name: 'x' } })],
      [400, 'INVALID_REQUEST', await app.inject({ method: 'POST', url: '/api/v1/projects', headers: ownerHeaders, payload: {} })],
      [400, 'INVALID_NAME', await create('   ')],
      [409, 'REQUEST_ID_CONFLICT', await create('另一项目')],
      [404, 'NOT_FOUND', await app.inject({ url: '/api/v1/no-such-resource', headers: ownerHeaders })],
      [413, 'PAYLOAD_TOO_LARGE', await app.inject({ method: 'POST', url: '/api/v1/projects', headers: ownerHeaders, payload: { name: 'x'.repeat(1024 * 1024), requestId: 'big' } })],
    ] as const;
    const requestIds = new Set<string>();
    for (const [status, code, response] of responses) {
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ code, message: expect.stringMatching(/[\u4e00-\u9fff]/), requestId: expect.any(String) });
      expect(response.json().requestId).toMatch(/^[0-9a-f-]{36}$/);
      requestIds.add(response.json().requestId);
    }
    expect(requestIds.size).toBe(responses.length);
  });

  it('rejects unexpected input fields instead of silently changing a command', async () => {
    const { app } = await setup();
    const cookie = await login(app);
    const ownerHeaders = { ...headers, cookie, 'x-specmill-request': '1' };
    const response = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: ownerHeaders,
      payload: { name: '项目', requestId: 'extra-field', unexpected: 'should not be ignored' } });
    expect(response.statusCode).toBe(400);
    const list = await app.inject({ url: '/api/v1/projects', headers: ownerHeaders });
    expect(list.json().projects).toEqual([]);
  });
  it('reports unexpected service failures without exposing error details in responses or diagnostics', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'specmill-test-')); dirs.push(dataDir);
    const script = `
      import { buildApp } from './src/server/app.ts';
      const app = await buildApp({ dataDir: process.argv[1], port: 43127, ownerToken: 'test-owner-token', agentToken: 'test-agent-token' });
      app.get('/api/v1/test-failure', async () => { throw Object.assign(new Error('SECRET_ERROR_DETAIL'), { code: 'SQLITE_FULL' }); });
      const headers = { host: '127.0.0.1:43127', authorization: 'Bearer test-agent-token' };
      const response = await app.inject({ url: '/api/v1/test-failure', headers });
      console.log('RESPONSE=' + JSON.stringify({ status: response.statusCode, body: response.json() }));
      await app.close();
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dataDir], { cwd: process.cwd(), encoding: 'utf8' });
    expect(child.status).toBe(0);
    const responseLine = child.stdout.split('\n').find(line => line.startsWith('RESPONSE='));
    expect(responseLine).toBeDefined();
    const response = JSON.parse(responseLine!.slice('RESPONSE='.length));
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ code: 'SERVICE_UNAVAILABLE', message: expect.stringMatching(/[\u4e00-\u9fff]/), requestId: expect.any(String) });
    const diagnosticLines = child.stdout.split('\n').filter(line => !line.startsWith('RESPONSE=')).join('\n') + child.stderr;
    expect(diagnosticLines).toContain(response.body.requestId);
    expect(diagnosticLines).toContain('SERVICE_UNAVAILABLE');
    expect(diagnosticLines).toContain('SQLITE_FULL');
    expect(diagnosticLines).not.toContain('SECRET_ERROR_DETAIL');
    expect(diagnosticLines).not.toContain('test-agent-token');
  });
  it('persists projects after restart and blocks unauthenticated access', async () => {
    const { app, dataDir } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects', headers })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: '未授权', requestId: 'unauthorized' } })).statusCode).toBe(401);
    const cookie = await login(app);
    const result = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { ...headers, cookie, 'x-specmill-request': '1' }, payload: { name: '示例项目', requestId: 'req-1' } });
    expect(result.statusCode).toBe(201);
    const receipt = result.json();
    expect(receipt).toEqual({ requestId: 'req-1', resourceId: expect.any(String), recordVersion: 1, committedAt: expect.any(String) });
    expect(Number.isNaN(Date.parse(receipt.committedAt))).toBe(false);
    const retry = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { ...headers, cookie, 'x-specmill-request': '1' }, payload: { name: '示例项目', requestId: 'req-1' } });
    expect(retry.json()).toEqual(result.json());
    const mismatch = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { ...headers, cookie, 'x-specmill-request': '1' }, payload: { name: '不同', requestId: 'req-1' } });
    expect(mismatch.statusCode).toBe(409);
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const next = await buildApp({ dataDir, port: 43127, ownerToken: 'test-owner-token', agentToken: 'test-agent-token' }); apps.push(next);
    const nextCookie = await login(next);
    const replay = await next.inject({ method: 'POST', url: '/api/v1/projects', headers: { ...headers, cookie: nextCookie, 'x-specmill-request': '1' }, payload: { name: '示例项目', requestId: 'req-1' } });
    expect(replay.json()).toEqual(receipt);
    const list = await next.inject({ method: 'GET', url: '/api/v1/projects', headers: { ...headers, cookie: nextCookie } });
    expect(list.json().projects.map((p: {name: string}) => p.name)).toEqual(['示例项目']);
    expect(list.json().projects[0].id).toBe(receipt.resourceId);
  });
  it('rejects foreign host, origin, missing CSRF marker and agent mutations', async () => {
    const { app } = await setup(); const cookie = await login(app);
    expect((await app.inject({ url: '/api/v1/projects', headers: { host: 'evil.example', cookie } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/v1/projects', headers: { ...headers, origin: 'https://evil.example', cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { ...headers, cookie }, payload: { name: 'x' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { host: headers.host, authorization: 'Bearer test-agent-token' }, payload: { name: 'x' } })).statusCode).toBe(403);
  });
  it('rejects a second app using the same directory', async () => {
    const { dataDir } = await setup();
    await expect(buildApp({ dataDir, port: 43127, ownerToken: 'x', agentToken: 'y' })).rejects.toThrow();
    const other = new Database(join(dataDir, 'specmill.db'), { timeout: 10 });
    try { expect(() => other.prepare('SELECT * FROM projects').all()).toThrow(); } finally { other.close(); }
    const child = spawnSync(process.execPath, ['-e', "const D=require('better-sqlite3');const db=new D(process.argv[1],{timeout:10});try{db.prepare('select * from projects').all();process.exitCode=1}catch(e){process.exitCode=e.code==='SQLITE_BUSY'?0:2}finally{db.close()}", join(dataDir, 'specmill.db')], { cwd: process.cwd() });
    expect(child.status).toBe(0);
  });
  it('rejects an unsupported schema without changing it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'specmill-test-')); dirs.push(dataDir);
    const db = new Database(join(dataDir, 'specmill.db')); db.pragma('user_version = 99'); db.close();
    await expect(buildApp({ dataDir, port: 43127, ownerToken: 'x', agentToken: 'y' })).rejects.toThrow('Unsupported database schema');
    const check = new Database(join(dataDir, 'specmill.db')); expect(check.pragma('user_version', { simple: true })).toBe(99); check.close();
  });
  it('reports a port conflict without affecting the first server', async () => {
    const firstDir = await mkdtemp(join(tmpdir(), 'specmill-test-')); dirs.push(firstDir);
    const secondDir = await mkdtemp(join(tmpdir(), 'specmill-test-')); dirs.push(secondDir);
    const opts = { port: 43391, ownerToken: 'owner', agentToken: 'agent' };
    const first = await buildApp({ ...opts, dataDir: firstDir }); apps.push(first);
    const second = await buildApp({ ...opts, dataDir: secondDir }); apps.push(second);
    await first.listen({ host: '127.0.0.1', port: opts.port });
    await expect(second.listen({ host: '127.0.0.1', port: opts.port })).rejects.toThrow();
    expect((await first.inject({ url: '/api/v1/projects', headers: { host: '127.0.0.1:43391' } })).statusCode).toBe(401);
  });
});
