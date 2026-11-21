import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { PILOT_SPEC, runSampleGit } from '../../src/server/pilot/sample.js';
import type { TeamDetail } from '../../src/server/team/contracts.js';

const executors = [
  ['codex', process.env.SPECMILL_REAL_CODEX, undefined],
  ['pi', process.env.SPECMILL_REAL_PI, process.env.SPECMILL_REAL_PI_MODEL],
] as const;
const origin = 'http://127.0.0.1:43327';

for (const [executor, agentBin, model] of executors) {
  it.skipIf(!agentBin && process.env.SPECMILL_REQUIRE_REAL !== '1')(executor + ' satisfies the real executor contract', async () => {
    if (!agentBin) throw new Error('Both executor paths are required');
    // The real service must fork compiled Workers. Keep that build requirement out of the default suite.
    const compiled = new URL('../../dist-server/server/', import.meta.url);
    const { buildApp } = await import(new URL('app.js', compiled).href) as typeof import('../../src/server/app.js');
    const { askAgent } = await import(new URL('workflow/executor.js', compiled).href) as typeof import('../../src/server/workflow/executor.js');
    const root = await mkdtemp(join(tmpdir(), 'specmill-executor-contract-'));
    try {
      const input = { executor, bin: agentBin, repo: root, model, prompt: 'Return exactly SELECT 1;' };
      expect(await askAgent(input, AbortSignal.abort())).toHaveProperty('error');
      expect(await askAgent({ ...input, bin: 'relative' }, new AbortController().signal)).toHaveProperty('error');

      const app = await buildApp({ dataDir: root, port: 43327, ownerToken: 'synthetic-owner',
        agentToken: 'synthetic-unused', team: { agentBin, executor, model } });
      try {
        async function http(path: string, expected: number, auth: Record<string, string> = {}, body?: object) {
          const response = await app.inject({ url: '/api/v1' + path, method: body ? 'POST' : 'GET', payload: body,
            headers: { origin, host: new URL(origin).host, 'x-specmill-request': '1', ...auth } });
          expect(response.statusCode).toBe(expected);
          return response;
        }
        const login = await http('/session', 200, {}, { token: 'synthetic-owner' });
        const owner = { cookie: String(login.headers['set-cookie']).split(';')[0] };
        const project = (await http('/team/admin/projects', 201, owner, { name: 'Synthetic orders' })).json();
        const developer = (await http('/team/admin/members', 201, owner, { name: 'Synthetic author' })).json();
        const reviewer = (await http('/team/admin/members', 201, owner, { name: 'Synthetic reviewer' })).json();
        for (const [member, role] of [[developer, 'developer'], [reviewer, 'reviewer']]) {
          await http('/team/admin/grants', 200, owner, { projectId: project.id, memberId: member.id, role });
        }
        const author = { authorization: 'Bearer ' + developer.token };
        const approver = { authorization: 'Bearer ' + reviewer.token };
        const { specHash } = (await http('/team/projects', 200, author)).json();
        const list = '/team/projects/' + project.id + '/runs';
        const { id } = (await http(list, 201, author, { requestId: randomUUID(), specHash })).json();
        const path = list + '/' + id;
        const read = async () => (await http(path, 200, approver)).json<TeamDetail>();
        const deadline = Date.now() + 105000;
        let run = await read();
        while ((run.status === 'queued' || run.status === 'running') && Date.now() < deadline) {
          await sleep(250);
          run = await read();
        }
        expect(run.status, JSON.stringify(run.attempts.map(a => a.result?.kind === 'failure' ? a.result.error : a.status))).toBe('review');
        const code = run.attempts.flatMap(a => a.result?.kind === 'task' ? [a.result.artifact] : []);
        expect(code).toHaveLength(2);
        for (const artifact of code) {
          expect(artifact.agent).toMatchObject({ executor, protocol: 1, durationMs: expect.any(Number),
            usage: { inputTokens: expect.any(Number), outputTokens: expect.any(Number) } });
          if (executor === 'pi') expect(artifact.agent?.model).toBe(model);
          const parent = join(root, 'team', 'workspaces');
          const name = (await readdir(parent)).find(entry => entry.startsWith('attempt-' + artifact.attemptId + '-'));
          expect(name).toBeDefined();
          expect(await runSampleGit(join(parent, name!), ['ls-tree', '--name-only', artifact.commit]))
            .toBe(artifact.task + '.sql\nspec.json\n');
          expect(await runSampleGit(join(parent, name!), ['status', '--porcelain'])).toBe('');
        }
        expect(run.integration?.parents).toEqual(['dates', 'paid'].map(task => code.find(a => a.task === task)?.commit));
        expect(run.integration?.checks).toEqual(PILOT_SPEC.criteria.map(({ name, expected }) =>
          ({ name, expected, actual: expected, passed: true })));
        const { commit } = run.integration!;
        await http(path + '/accept', 200, approver, { commit, version: run.version, requestId: randomUUID(), reason: 'Synthetic contract review' });
        const archive = (await http(path + '/archive', 200, approver)).json<TeamDetail>();
        expect(archive.decision).toMatchObject({ commit, reviewer: { id: reviewer.id } });
        expect(archive.attempts).toEqual(run.attempts);
        console.log(JSON.stringify({ executor, commit, agent: code.map(a => a.agent) }));
      } finally {
        await app.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 130000);
}
