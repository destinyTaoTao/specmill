import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import type { TeamDetail } from '../../src/server/team/contracts.js';

const host = '127.0.0.1:43327';
const origin = 'http://' + host;
const workerModule = new URL('../fixtures/team-worker.mjs', import.meta.url);
const setup = (dataDir: string) => buildApp({ dataDir, port: 43327, ownerToken: 'owner-for-team-test',
  agentToken: 'legacy-tool-for-team-test', team: { agentBin: process.execPath, workerModule } });

function http(app: FastifyInstance, auth: Record<string, string> = {}) {
  return (path: string, body?: Record<string, unknown>) => app.inject({
    url: '/api/v1/team' + path, method: body ? 'POST' : 'GET',
    headers: { host, origin, 'x-specmill-request': '1', ...auth }, payload: body,
  });
}

describe('team projects and independent acceptance through HTTP', () => {
  it('blocks a green Worker report whose integration target cannot be reconstructed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'specmill-team-proof-api-'));
    const app = await setup(directory);
    try {
      const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers: { host, origin }, payload: { token: 'owner-for-team-test' } });
      const admin = http(app, { cookie: String(login.headers['set-cookie']).split(';')[0] });
      const { id: projectId } = (await admin('/admin/projects', { name: 'Proof' })).json();
      const { token, id: memberId } = (await admin('/admin/members', { name: 'Author' })).json();
      await admin('/admin/grants', { projectId, memberId, role: 'developer' });
      const developer = http(app, { authorization: 'Bearer ' + token });
      const specHash = (await developer('/projects')).json().specHash;
      await writeFile(join(directory, 'team', 'workspaces', 'wrong-target'), '');
      const runs = '/projects/' + projectId + '/runs';
      const { id } = (await developer(runs, { requestId: randomUUID(), specHash })).json();
      const detail = async () => (await developer(runs + '/' + id)).json<TeamDetail>();
      await expect.poll(async () => (await detail()).status, { timeout: 20000 }).toBe('blocked');
      expect((await detail()).attempts.at(-1)?.result).toMatchObject({ kind: 'failure', error: expect.stringContaining('重建') });
      expect((await developer(runs + '/' + id + '/archive')).statusCode).toBe(409);
    } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
  }, 30000);

  it('checks live membership, implementation responsibility and reviewed target, then restores the same archive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'specmill-team-api-'));
    const restored = await mkdtemp(join(tmpdir(), 'specmill-team-restore-'));
    let app = await setup(directory);
    try {
      const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers: { host, origin }, payload: { token: 'owner-for-team-test' } });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const admin = http(app, { cookie });
      const project = (await admin('/admin/projects', { name: 'Orders' })).json().id;
      const other = (await admin('/admin/projects', { name: 'Other' })).json().id;
      const alice = (await admin('/admin/members', { name: '实施成员' })).json();
      const bob = (await admin('/admin/members', { name: '审阅成员' })).json();
      const eve = (await admin('/admin/members', { name: '其他项目成员' })).json();
      const grant = (projectId: string, memberId: string, role: string | null) => admin('/admin/grants', { projectId, memberId, role });
      await grant(project, alice.id, 'both');
      await grant(project, bob.id, 'reviewer');
      await grant(other, eve.id, 'both');
      const member = (token: string) => http(app, { authorization: 'Bearer ' + token });
      const dev = member(alice.token), reviewer = member(bob.token), outsider = member(eve.token);
      const list = '/projects/' + project + '/runs';
      const specHash = (await dev('/projects')).json().specHash;
      expect((await admin('/projects')).statusCode).toBe(401);
      expect((await http(app, { authorization: 'Bearer legacy-tool-for-team-test' })('/admin')).statusCode).toBe(403);
      expect((await outsider('/projects')).json().projects.map((p: {id: string}) => p.id)).toEqual([other]);
      expect((await dev('/admin')).statusCode).toBe(401);
      expect([403, 404]).toContain((await outsider(list, { requestId: randomUUID(), specHash })).statusCode);
      expect((await reviewer(list, { requestId: randomUUID(), specHash })).statusCode).toBe(403);
      const created = await dev(list, { requestId: randomUUID(), specHash });
      expect(created.statusCode).toBe(201);
      const path = list + '/' + created.json().id;
      const read = async () => (await reviewer(path)).json<TeamDetail>();
      await expect.poll(async () => (await read()).status, { timeout: 12000 }).toBe('review');
      const view = await read();
      const branches = view.attempts.filter(a => a.task !== 'integrate');
      expect(branches).toHaveLength(2);
      expect(Math.max(...branches.map(a => Date.parse(a.startedAt)))).toBeLessThan(Math.min(...branches.map(a => Date.parse(a.finishedAt!))));
      const accept = { requestId: randomUUID(), version: view.version, commit: view.integration!.commit, reason: '已检查集成提交和三个条件。' };
      expect([403, 404]).toContain((await outsider(path)).statusCode);
      expect([403, 404]).toContain((await outsider(path + '/archive')).statusCode);
      expect((await outsider('/projects/' + other + '/runs/' + created.json().id)).statusCode).toBe(404);
      expect((await dev(path + '/accept', accept)).statusCode).toBe(403);
      await grant(project, alice.id, 'reviewer');
      expect((await dev(path + '/accept', accept)).statusCode).toBe(403);
      await grant(project, bob.id, null);
      expect([403, 404]).toContain((await reviewer(path + '/accept', accept)).statusCode);
      await grant(project, bob.id, 'reviewer');
      expect((await reviewer(path + '/accept', { ...accept, commit: '0'.repeat(40) })).statusCode).toBe(409);
      expect((await reviewer(path + '/accept', accept)).statusCode).toBe(200);
      expect((await reviewer(path + '/accept', accept)).statusCode).toBe(200);
      const archive = await reviewer(path + '/archive');
      expect(archive.statusCode).toBe(200);
      expect(archive.json().decision.reviewer.id).toBe(bob.id);
      expect(archive.body).not.toContain(bob.token);
      expect(archive.body).not.toContain(alice.token);
      await grant(project, bob.id, null);
      expect([403, 404]).toContain((await reviewer(path + '/accept', accept)).statusCode);
      await app.close();
      await cp(join(directory, 'team'), join(restored, 'team'), { recursive: true });
      app = await setup(restored);
      expect([403, 404]).toContain((await member(bob.token)(path + '/archive')).statusCode);
      expect((await member(alice.token)(path + '/archive')).body).toBe(archive.body);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
      await rm(restored, { recursive: true, force: true });
    }
  }, 30000);
});
