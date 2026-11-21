import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { FastifyInstance, FastifyError } from 'fastify';
import { PilotError, PilotLedger } from './ledger.js';
import { PilotSupervisor } from './supervisor.js';

export type PilotOptions = { agentBin: string; workerModule?: URL };
type Decision = { requestId: string; version: number; action: 'freeze' | 'return' | 'accept'; reason: string };
const requestId = { type: 'string', minLength: 1, maxLength: 128 };
const object = (properties: Record<string, unknown>) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});

export async function registerPilot(app: FastifyInstance, dataDir: string, options: PilotOptions) {
  if (!isAbsolute(options.agentBin) || !(await stat(options.agentBin).catch(() => null))?.isFile() ||
      (process.platform === 'win32' && !options.agentBin.toLowerCase().endsWith('.exe'))) {
    throw new Error('--pilot-agent 需要 Codex 原生可执行文件的绝对路径（Windows 使用 codex.exe）。');
  }
  const root = join(dataDir, 'pilot');
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Open on ready so a failed service start cannot leave a dispatch loop behind.
  app.register(async function pilot(scope) {
    const ledger = new PilotLedger(join(root, 'workflow.sqlite'));
    const supervisor = new PilotSupervisor(ledger, root, options.agentBin, options.workerModule, () => {
      scope.log.error('切片 A 调度存储暂时不可用，将重新核对队列。');
    });
    scope.addHook('onReady', async () => supervisor.start());
    scope.addHook('onClose', async () => {
      try { await supervisor.stop(); } finally { ledger.close(); }
    });
    scope.setErrorHandler((error: FastifyError, request, reply) => {
      if (error instanceof PilotError) {
        return reply.code(error.statusCode).send({ code: 'PILOT_COMMAND_REJECTED', message: error.message, requestId: request.id });
      }
      throw error;
    });
    scope.get('/runs', async () => ({ runs: ledger.list() }));
    scope.post<{ Body: { requestId: string } }>('/runs', { schema: { body: object({ requestId }) } },
      async (request, reply) => reply.code(201).send(ledger.create(request.body.requestId)));
    scope.get<{ Params: { id: string } }>('/runs/:id', async (request, reply) => {
      const run = ledger.get(request.params.id);
      return run ?? reply.code(404).send({ code: 'NOT_FOUND', message: '找不到试点运行。', requestId: request.id });
    });
    scope.post<{ Params: { id: string }; Body: Decision }>('/runs/:id/decisions', { schema: { body: object({
      requestId, version: { type: 'integer', minimum: 1 }, action: { enum: ['freeze', 'return', 'accept'] },
      reason: { type: 'string', maxLength: 1000 },
    }) } }, async request => {
      const { action, version, reason, requestId } = request.body;
      const receipt = ledger.decide(request.params.id, action, version, reason, requestId);
      supervisor.wake();
      return receipt;
    });
    scope.get<{ Params: { id: string } }>('/runs/:id/archive', async (request, reply) => {
      const archive = ledger.archive(request.params.id);
      return reply.header('Content-Disposition', 'attachment; filename="specmill-pilot-archive.json"')
        .header('Cache-Control', 'no-store').send(archive);
    });
  }, { prefix: '/api/v1/pilot' });
}
