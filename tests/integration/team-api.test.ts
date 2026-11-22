import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { runSampleGit } from '../../src/server/pilot/sample.js';
import type { RepositoryConfig, TeamDetail, TeamProject } from '../../src/server/team/contracts.js';

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

  it('binds repository return, redispatch and archive to a named reviewer and exact Git targets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'specmill-team-repository-api-'));
    const dataDir = join(directory, 'data');
    const source = join(directory, 'approved');
    const agentBin = join(directory, 'approved-pi.mjs');
    const path = 'release.txt';
    const model = 'test/repository';
    const reviewReason = 'Append REVIEWED after READY.';
    const open = (repository?: RepositoryConfig, storage = dataDir) => buildApp({
      dataDir: storage, port: 43327, ownerToken: 'owner-for-team-test', agentToken: 'legacy-tool-for-team-test',
      team: { agentBin, executor: 'pi', model, repository, workerModule: new URL('../fixtures/repository-worker.mjs', import.meta.url) },
    });
    let app: FastifyInstance | undefined;
    try {
      await mkdir(source);
      await runSampleGit(source, ['init', '--quiet', '--template=', '--initial-branch=main', '--object-format=sha1']);
      await writeFile(join(source, path), 'DRAFT\n');
      await runSampleGit(source, ['add', '--', path]);
      await runSampleGit(source, ['commit', '-qm', 'Frozen base']);
      const baseCommit = (await runSampleGit(source, ['rev-parse', 'HEAD'])).trim();
      await writeFile(agentBin, `
        import assert from 'node:assert/strict';
        import { readFileSync } from 'node:fs';
        const prompt = readFileSync(0, 'utf8');
        const input = JSON.parse(prompt.slice(prompt.indexOf('\\n') + 1));
        assert.equal(input.original, 'DRAFT\\n');
        if (input.previous) assert.deepEqual(input.previous, {content:'READY\\n', reason:${JSON.stringify(reviewReason)}});
        const text = input.previous ? 'READY\\nREVIEWED\\n' : 'READY\\n';
        console.log(JSON.stringify({type:'agent_end', messages:[{role:'assistant', stopReason:'stop',
          provider:'test', model:'repository', content:[{type:'text', text}]}]}));
      `);
      app = await open();
      const login = (service: FastifyInstance) => service.inject({ method: 'POST', url: '/api/v1/session',
        headers: { host, origin }, payload: { token: 'owner-for-team-test' } });
      const admin = async (service: FastifyInstance) =>
        http(service, { cookie: String((await login(service)).headers['set-cookie']).split(';')[0] });
      let owner = await admin(app);
      const { id: projectId } = (await owner('/admin/projects', { name: 'Release repository' })).json();
      const { id: other } = (await owner('/admin/projects', { name: 'Other' })).json();
      const author = (await owner('/admin/members', { name: 'Fixture author' })).json();
      const reviewer = (await owner('/admin/members', { name: 'Fixture reviewer' })).json();
      const outsider = (await owner('/admin/members', { name: 'Fixture outsider' })).json();
      const grant = (memberId: string, role: string | null, project = projectId) =>
        owner('/admin/grants', {projectId: project, memberId, role});
      expect((await grant(author.id, 'both')).statusCode).toBe(200);
      expect((await grant(reviewer.id, 'reviewer')).statusCode).toBe(200);
      expect((await grant(outsider.id, 'both', other)).statusCode).toBe(200);
      await app.close();
      app = undefined;
      const config: RepositoryConfig = { projectId, source, spec: {kind:'repository-v1', title:'Release',
        requirement:'Set READY.', path, baseCommit, checks:[{name:'Ready', text:'READY', present:true}] } };
      await expect(open(config, join(source, 'prohibited'))).rejects.toThrow('仓库');
      const aliasedStorage = join(directory, 'aliased-data');
      await mkdir(aliasedStorage);
      await symlink(source, join(aliasedStorage, 'team'), 'junction');
      await expect(open(config, aliasedStorage)).rejects.toThrow('仓库');
      expect(await runSampleGit(source, ['status', '--porcelain'])).toBe('');
      app = await open(config);
      owner = await admin(app);
      const principal = (service: FastifyInstance, token: string) => http(service, { authorization:'Bearer ' + token });
      const dev = principal(app, author.token), review = principal(app, reviewer.token), foreign = principal(app, outsider.token);
      const memberDirectory = (await dev('/projects')).json<{projects: TeamProject[]; specHash: string}>();
      const specHash = memberDirectory.projects[0].repository!.specHash;
      expect((await foreign('/projects')).body).not.toContain(specHash);
      const list = '/projects/' + projectId + '/runs';
      expect((await dev(list, {requestId:randomUUID(), specHash:memberDirectory.specHash})).statusCode).toBe(409);
      const started = await dev(list, {requestId:randomUUID(), specHash});
      expect(started.statusCode).toBe(201);
      const target = list + '/' + started.json().id;
      const read = async () => (await review(target)).json<TeamDetail>();
      await expect.poll(async () => (await read()).status, {timeout:15000}).toBe('review');
      const first = await read();
      expect(first.repositoryEvidence).toMatchObject({path, parent:baseCommit, content:'READY\n'});
      const sendBack = {requestId:randomUUID(), version:first.version, commit:first.repositoryEvidence!.commit, reason:reviewReason};
      expect((await dev(target + '/return', sendBack)).statusCode).toBe(403);
      expect([403, 404]).toContain((await foreign(target + '/return', sendBack)).statusCode);
      await grant(reviewer.id, null);
      expect([403, 404]).toContain((await review(target + '/return', sendBack)).statusCode);
      await grant(reviewer.id, 'reviewer');
      expect((await review(target + '/return', {...sendBack, commit:'0'.repeat(40)})).statusCode).toBe(409);
      for (let retry = 0; retry < 2; retry++) expect((await review(target + '/return', sendBack)).statusCode).toBe(200);
      expect((await review(target + '/accept', {...sendBack, requestId:randomUUID()})).statusCode).toBe(409);
      await expect.poll(async () => (await read()).status, {timeout:15000}).toBe('review');
      const second = await read();
      expect(second.frozenBaseline).toEqual(first.frozenBaseline);
      expect(second.returns).toMatchObject([{reviewer:{id:reviewer.id}, commit:sendBack.commit, version:first.version, reason:reviewReason}]);
      expect(second.attempts.map(attempt => attempt.generation)).toEqual([1, 2]);
      expect(second.repositoryEvidence).toMatchObject({path, parent:baseCommit, content:'READY\nREVIEWED\n'});
      expect(second.repositoryEvidence!.commit).not.toBe(sendBack.commit);
      const approved = {requestId:randomUUID(), version:second.version, commit:second.repositoryEvidence!.commit, reason:'Second target verified.'};
      const firstArtifact = join(dataDir, 'team', 'workspaces', second.attempts[0].repositoryArtifact!);
      const withheld = join(directory, 'withheld-artifact');
      await rename(firstArtifact, withheld);
      const missingArtifact = await review(target + '/accept', approved);
      expect(missingArtifact.statusCode).toBe(409);
      expect(missingArtifact.json().message).toContain('工件缺失');
      expect((await review(target + '/archive')).statusCode).toBe(409);
      await rename(withheld, firstArtifact);
      expect((await review(target + '/accept', approved)).statusCode).toBe(200);
      expect((await review(target + '/accept', approved)).statusCode).toBe(200);
      const archive = await review(target + '/archive');
      expect(archive.statusCode).toBe(200);
      expect(archive.json().attempts.map((a: TeamDetail['attempts'][number]) => a.repositoryArtifact)).toEqual(
        second.attempts.map(a => a.repositoryArtifact));
      expect(archive.json().decision).toMatchObject({reviewer:{id:reviewer.id}, commit:approved.commit, version:second.version});
      expect(archive.body).not.toContain(source);
      expect(archive.body).not.toContain(reviewer.token);
      await app.close();
      app = undefined;
      app = await open();
      expect((await principal(app, reviewer.token)(target + '/archive')).body).toBe(archive.body);
    } finally {
      await app?.close();
      await rm(directory, {recursive:true, force:true, maxRetries:3});
    }
  }, 45000);
});
