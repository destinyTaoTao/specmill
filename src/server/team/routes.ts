import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { PILOT_SPEC } from '../pilot/sample.js';
import { isExecutor, isExecutorEntry, isModel, type ExecutorId } from '../workflow/executor.js';
import { WorkflowSupervisor } from '../workflow/supervisor.js';
import { TEAM_SPEC_HASH, TeamError, TeamLedger } from './ledger.js';
import { validateRepositoryConfig, verifyRepository, verifyRetainedRepository } from './repository.js';
import { verifyIntegration } from './verify.js';
import type { RepositoryConfig, TeamClaim, TeamDetail, TeamResult } from './contracts.js';

type Role = 'developer' | 'reviewer' | 'both';
type Project = { projectId: string };
type Run = Project & { runId: string };
type Accept = { requestId: string; version: number; commit: string; reason: string };
const string = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const object = (properties: Record<string, unknown>) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
const named = { schema: { body: object({ name: string(80) }) } };
const reviewCommand = {
  schema: { body: object({ version: { type: 'integer', minimum: 1 }, commit: { type: 'string', pattern: '^[0-9a-f]{40}$' },
    reason: string(1000), requestId: string(128) }) },
};
export type TeamOptions = { agentBin: string; workerModule?: URL; executor?: ExecutorId; model?: string; workers?: number;
  repository?: RepositoryConfig };

export async function registerTeam(app: FastifyInstance, dataDir: string, options: TeamOptions) {
  const executor = options.executor ?? 'codex';
  const { model } = options;
  const workers = options.workers ?? 2;
  if (!isExecutor(executor) || !await isExecutorEntry(executor, options.agentBin)) {
    throw new Error('--team-agent 需要 Codex 可执行文件或 Pi JavaScript 入口的绝对路径。');
  }
  if (executor === 'pi' ? !isModel(model) : model !== undefined) {
    throw new Error('--team-model 仅用于 Pi，格式为 provider/model。');
  }
  if (!Number.isInteger(workers) || workers < 1 || workers > 8) throw new Error('--team-workers 必须是 1 至 8 的整数。');
  const repository = options.repository ? await validateRepositoryConfig(options.repository) : undefined;
  const root = join(dataDir, 'team');
  const workspaceRoot = join(root, 'workspaces');
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  app.register(async scope => {
    const ledger = new TeamLedger(join(root, 'team.sqlite'), repository);
    if (repository && !ledger.admin().projects.some(project => project.id === repository.projectId)) {
      ledger.close();
      throw new Error('团队仓库配置必须绑定已创建的项目 ID。');
    }
    const supervisor = new WorkflowSupervisor<TeamClaim, TeamResult>(ledger, workers, workspaceRoot, options.agentBin,
      options.workerModule ?? new URL('./worker.js', import.meta.url),
      () => scope.log.error('团队工作流调度暂时失败，将重试。'),
      async (claim, result) => {
        if (claim.task === 'repository' && result?.kind === 'repository') {
          const agent = result.evidence?.agent;
          if (!options.workerModule && (agent?.executor !== executor || (model && agent.model !== model))) {
            return { kind: 'failure', error: 'Worker 的执行器证据与服务配置不符。' };
          }
          if (!(await verifyRepository(claim, result.evidence, workspaceRoot))) {
            return { kind: 'failure', error: '服务端无法独立重建仓库提交并复核证据。' };
          }
        }
        if (!options.workerModule && claim.task !== 'integrate' && result?.kind === 'task' &&
            result.artifact?.agent?.executor !== executor) {
          return { kind: 'failure', error: 'Worker 的执行器证据与服务配置不符。' };
        }
        if (claim.task === 'integrate' && result?.kind === 'integration' &&
            !(await verifyIntegration(claim, result.integration))) {
          return { kind: 'failure', error: '服务端无法独立重建集成提交并复核证据。' };
        }
        return result;
      }, { executor, model });
    scope.addHook('onReady', async () => supervisor.start());
    scope.addHook('onClose', async () => { try { await supervisor.stop(); } finally { ledger.close(); } });
    scope.addHook('onRequest', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
    scope.setErrorHandler((error: FastifyError, request, reply) => {
      if (error instanceof TeamError) return reply.code(error.statusCode).send({
        code: 'TEAM_REQUEST_REJECTED', message: error.message, requestId: request.id,
      });
      throw error;
    });
    scope.get('/admin', async () => ledger.admin());
    scope.post<{ Body: { name: string } }>('/admin/members', named, async (request, reply) =>
      reply.code(201).send(ledger.createMember(request.body.name)));
    scope.post<{ Body: { name: string } }>('/admin/projects', named, async (request, reply) =>
      reply.code(201).send(ledger.createProject(request.body.name)));
    scope.post<{ Body: Project & { memberId: string; role: Role | null } }>('/admin/grants', {
      schema: { body: object({ projectId: string(100), memberId: string(100), role: { enum: ['developer', 'reviewer', 'both', null] } }) },
    }, async request => {
      const { projectId, memberId, role } = request.body;
      ledger.grant(projectId, memberId, role);
      supervisor.stopInvalid(c => ledger.isActive(c));
      supervisor.wake();
      return { ok: true };
    });
    function principal(request: FastifyRequest) {
      const auth = request.headers.authorization ?? '';
      return ledger.authenticate(auth.startsWith('Bearer ') ? auth.slice(7) : '');
    }
    scope.get('/projects', async request => {
      const id = principal(request);
      return { member: ledger.member(id), projects: ledger.projects(id), spec: PILOT_SPEC, specHash: TEAM_SPEC_HASH };
    });
    scope.get<{ Params: Project }>('/projects/:projectId/runs', async request =>
      ({ runs: ledger.runs(principal(request), request.params.projectId) }));
    scope.post<{ Params: Project; Body: { requestId: string; specHash: string } }>('/projects/:projectId/runs', {
      schema: { body: object({ requestId: string(128), specHash: { type: 'string', pattern: '^[a-f0-9]{64}$' } }) },
    }, async (request, reply) => {
      const result = ledger.start(principal(request), request.params.projectId, request.body.requestId, request.body.specHash);
      supervisor.wake();
      return reply.code(201).send(result);
    });
    scope.get<{ Params: Run }>('/projects/:projectId/runs/:runId', async request =>
      ledger.get(principal(request), request.params.projectId, request.params.runId));
    async function verifyReviewArtifacts(run: TeamDetail, authorization: RepositoryConfig) {
      if (!('kind' in run.spec)) return;
      const spec = run.spec;
      const artifacts = await Promise.all(run.attempts.map(attempt => {
        if (attempt.result?.kind !== 'repository') return true;
        const claim: TeamClaim = { projectId: run.projectId, runId: run.id, task: 'repository', generation: attempt.generation,
          attemptId: attempt.id, repository: {source: authorization.source, spec} };
        return verifyRetainedRepository(claim, attempt.result.evidence, workspaceRoot);
      }));
      if (!artifacts.every(Boolean)) throw new TeamError(409, 'Git 审计工件缺失或校验失败，请恢复工件后重新核对。');
    }
    scope.post<{ Params: Run; Body: Accept }>('/projects/:projectId/runs/:runId/accept', reviewCommand, async request => {
      const { reason, version, commit, requestId } = request.body;
      const { projectId, runId } = request.params;
      const reviewer = principal(request);
      if (repository?.projectId === projectId) {
        const run = ledger.get(reviewer, projectId, runId);
        if (run.canAccept && run.version === version && run.repositoryEvidence?.commit === commit) {
          await verifyReviewArtifacts(run, repository);
        }
      }
      // The ledger rechecks the exact snapshot, live role and idempotency receipt after asynchronous Git reads.
      return ledger.accept(reviewer, projectId, runId, version, commit, reason, requestId);
    });
    scope.post<{ Params: Run; Body: Accept }>('/projects/:projectId/runs/:runId/return', reviewCommand, async request => {
      const { reason, version, commit, requestId } = request.body;
      const result = ledger.returnForRework(principal(request), request.params.projectId, request.params.runId, version, commit, reason, requestId);
      supervisor.wake();
      return result;
    });
    scope.get<{ Params: Run }>('/projects/:projectId/runs/:runId/archive', async (request, reply) => {
      const archive = ledger.archive(principal(request), request.params.projectId, request.params.runId);
      return reply.header('Content-Disposition', 'attachment; filename="specmill-team-archive.json"').send(archive);
    });
  }, { prefix: '/api/v1/team' });
}
