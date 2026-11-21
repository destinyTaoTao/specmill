import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/server/app.js';

const host = '127.0.0.1:43293';
const workerModule = new URL('../fixtures/pilot-worker.mjs', import.meta.url);
async function setup(dataDir: string) {
  const app = await buildApp({ dataDir, port: 43293, ownerToken: 'pilot-test-owner', agentToken: 'pilot-test-agent',
    pilot: { agentBin: process.execPath, workerModule } });
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers: { host, origin: 'http://' + host },
    payload: { token: 'pilot-test-owner' } });
  const headers = { host, origin: 'http://' + host, cookie: String(login.headers['set-cookie']).split(';')[0], 'x-specmill-request': '1' };
  const url = '/api/v1/pilot/runs';
  const post = (path: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: url + path, headers, payload });
  const get = (path: string) => app.inject({ method: 'GET', url: url + path, headers });
  return { app, url, post, get };
}

describe('opt-in pilot workflow', () => {
  it('requires the owner and survives forced Worker loss before review, rework and archival', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'specmill-pilot-api-'));
    const { app, url, post, get } = await setup(dir);
    try {
      const agent = { host, authorization: 'Bearer pilot-test-agent' };
      expect((await app.inject({ method: 'GET', url, headers: agent })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url, headers: agent, payload: { requestId: randomUUID() } })).statusCode).toBe(403);
      const { id } = (await post('', { requestId: randomUUID() })).json();
      const detail = async () => (await get('/' + id)).json();
      const command = (action: string, version: number, reason = '') => post('/' + id + '/decisions', { action, version, reason, requestId: randomUUID() });
      expect((await detail()).status).toBe('draft');
      expect((await get('/' + id + '/archive')).statusCode).toBe(409);
      await writeFile(join(dir, 'pilot', 'crash-next-worker'), '');
      expect((await command('freeze', (await detail()).version)).statusCode).toBe(200);
      await expect.poll(async () => (await detail()).status, { timeout: 10000 }).toBe('review');
      const first = await detail();
      expect(first.attempts).toHaveLength(2);
      expect(first.attempts.some((a: { status: string }) => a.status === 'interrupted')).toBe(true);
      expect((await command('return', first.version, '请复核首尾日期。')).statusCode).toBe(200);
      await expect.poll(async () => (await detail()).status, { timeout: 10000 }).toBe('review');
      expect((await command('accept', first.version, '旧预览')).statusCode).toBe(409);
      expect((await command('accept', (await detail()).version, '核对三项证据。')).statusCode).toBe(200);
      const archive = await get('/' + id + '/archive');
      expect(archive.statusCode).toBe(200);
      expect(archive.headers['content-disposition']).toContain('attachment');
      expect(archive.body).toContain('请复核首尾日期。');
      expect(archive.body).toContain('SELECT id FROM orders');
      expect((await get('/' + id + '/archive')).body).toBe(archive.body);
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
  }, 30000);

  it('resumes a persisted in-flight attempt after restarting the service', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'specmill-pilot-restart-'));
    let session = await setup(dir);
    try {
      const { id } = (await session.post('', { requestId: randomUUID() })).json();
      const file = join(dir, 'pilot', 'hold-worker');
      await writeFile(file, '');
      const run = (await session.get('/' + id)).json();
      await session.post('/' + id + '/decisions', { requestId: randomUUID(), version: run.version, action: 'freeze', reason: '' });
      await expect.poll(() => access(join(dir, 'pilot', 'worker-started')).then(() => true, () => false)).toBe(true);
      await session.app.close();
      await rm(file);
      session = await setup(dir);
      await expect.poll(async () => (await session.get('/' + id)).json().status, { timeout: 10000 }).toBe('review');
      expect((await session.get('/' + id)).json().attempts).toHaveLength(2);
    } finally { await session.app.close(); await rm(dir, { recursive: true, force: true }); }
  }, 30000);
});
