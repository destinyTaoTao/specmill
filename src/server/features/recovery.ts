import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRecords } from '../storage/project-capacity.js';
import { requestIdUsedElsewhere } from '../storage/request-ids.js';
import { buildZip, MAX_ZIP_ENTRIES, zipSize, type ZipEntry } from '../recovery/zip.js';
import { getRestoreReceipt, restoreFromPackage } from '../recovery/import.js';

const EXPORT_DEADLINE_MS = 300 * 1000;
const RESTORE_BODY_LIMIT = 64 * 1024 * 1024;
type Operation = { id: string; projectId: string; status: string; sha256: string | null; size: number | null; error: string | null; createdAt: string; finishedAt: string | null; deadlineAt: string | null };

export function registerRecovery(app: FastifyInstance, db: Database.Database, dataDir: string, recordsLimit: number, isOwner: (request: FastifyRequest) => boolean) {
  const attachmentsDir = join(dataDir, 'attachments');
  const exportsDir = join(dataDir, 'exports');
  const getOperationRow = (operationId: string) => db.prepare('SELECT id, project_id AS projectId, status, sha256, size, error, created_at AS createdAt, finished_at AS finishedAt, deadline_at AS deadlineAt FROM export_operations WHERE id = ?').get(operationId) as (Operation & { id: string }) | undefined;
  const zipPath = (operationId: string) => join(exportsDir, `${operationId}.zip`);

  // 惰性生成：首次查询状态时执行准备。截止时间已过、已取消则不生成；
  // 附件先逐一校验，生成完整成功才发布输出文件并置为 ready。
  const preparing = new Map<string, Promise<Operation>>();
  const prepareOnce = async (operation: Operation): Promise<Operation> => {
    if (operation.status !== 'preparing') return operation;
    const stopped = (): Operation | null => {
      const current = getOperationRow(operation.id)!;
      if (current.status !== 'preparing') return current;
      if (current.deadlineAt !== null && Date.now() > new Date(current.deadlineAt).getTime()) {
        db.prepare("UPDATE export_operations SET status = 'failed', error = '导出超过截止时间', finished_at = ? WHERE id = ? AND status = 'preparing'").run(new Date().toISOString(), operation.id);
        return getOperationRow(operation.id)!;
      }
      return null;
    };
    const initial = stopped();
    if (initial) return initial;
    let outputCreated = false;
    try {
      const snapshot = db.transaction(() => projectRecords(db, operation.projectId))();
      if (!snapshot) throw new Error('项目不存在');
      if (snapshot.attachments.length + 2 > MAX_ZIP_ENTRIES) throw new Error('ZIP 文件项超过格式上限，无法完整导出此项目。');
      // 凭据不进入恢复包：会话授权哈希在导出投影中剥离。
      const records = { ...snapshot, writerSessions: (snapshot.writerSessions as { claim_hash?: string }[]).map(row => { const { claim_hash: _unused, ...rest } = row; void _unused; return rest; }) };
      const broken: string[] = [];
      const attachmentEntries: ZipEntry[] = [];
      for (const attachment of snapshot.attachments as { id: string; sha256: string; size: number }[]) {
        const content = await readFile(join(attachmentsDir, operation.projectId, attachment.sha256)).catch(() => null);
        const interrupted = stopped();
        if (interrupted) return interrupted;
        if (!content || content.length !== attachment.size || createHash('sha256').update(content).digest('hex') !== attachment.sha256) {
          broken.push(attachment.id);
          continue;
        }
        attachmentEntries.push({ name: `attachments/${attachment.sha256}`, data: content });
      }
      const interrupted = stopped();
      if (interrupted) return interrupted;
      if (broken.length > 0) throw new Error(`受管理附件缺失或摘要不符，导出失败：${broken.join('、')}`);
      const schemaVersion = db.pragma('user_version', { simple: true }) as number;
      const recordsJson = Buffer.from(JSON.stringify(records), 'utf8');
      const manifest = {
        formatVersion: 1,
        schemaVersion,
        projectId: operation.projectId,
        generatedAt: new Date().toISOString(),
        files: [
          { path: 'records.json', sha256: createHash('sha256').update(recordsJson).digest('hex'), size: recordsJson.length },
          ...attachmentEntries.map(entry => ({ path: entry.name, sha256: createHash('sha256').update(entry.data).digest('hex'), size: entry.data.length })),
        ],
      };
      const manifestJson = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
      const entries = [{ name: 'manifest.json', data: manifestJson }, { name: 'records.json', data: recordsJson }, ...attachmentEntries];
      if (zipSize(entries) > RESTORE_BODY_LIMIT) throw new Error('恢复包超过 64 MiB，当前恢复接口无法接收，导出失败。');
      const zip = buildZip(entries);
      const sha256 = createHash('sha256').update(zip).digest('hex');
      await mkdir(exportsDir, { recursive: true });
      const beforeOpen = stopped();
      if (beforeOpen) return beforeOpen;
      const file = await open(zipPath(operation.id), 'wx');
      outputCreated = true;
      let afterOpen: Operation | null = null;
      try { afterOpen = stopped(); if (!afterOpen) await file.writeFile(zip); } finally { await file.close(); }
      if (afterOpen) { await rm(zipPath(operation.id), { force: true }); return afterOpen; }
      const doneAt = new Date().toISOString();
      if (operation.deadlineAt !== null && Date.now() > new Date(operation.deadlineAt).getTime()) {
        db.prepare("UPDATE export_operations SET status = 'failed', error = '导出超过截止时间', finished_at = ? WHERE id = ? AND status = 'preparing'").run(doneAt, operation.id);
      } else {
        db.prepare("UPDATE export_operations SET status = 'ready', sha256 = ?, size = ?, finished_at = ? WHERE id = ? AND status = 'preparing'").run(sha256, zip.length, doneAt, operation.id);
      }
      const result = getOperationRow(operation.id)!;
      if (result.status !== 'ready') await rm(zipPath(operation.id), { force: true });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出失败';
      const failedAt = new Date().toISOString();
      db.prepare("UPDATE export_operations SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'preparing'").run(message, failedAt, operation.id);
      const result = getOperationRow(operation.id)!;
      if (outputCreated && result.status !== 'ready') await rm(zipPath(operation.id), { force: true });
      return result;
    }
  };
  const prepareOperation = (operation: Operation): Promise<Operation> => {
    if (operation.status !== 'preparing') return Promise.resolve(operation);
    const existing = preparing.get(operation.id);
    if (existing) return existing;
    const pending = prepareOnce(operation).finally(() => preparing.delete(operation.id));
    preparing.set(operation.id, pending);
    return pending;
  };

  app.post<{ Params: { projectId: string }; Body: { requestId: string } }>('/api/v1/projects/:projectId/exports', {
    schema: { body: { type: 'object', required: ['requestId'], additionalProperties: false, properties: { requestId: { type: 'string', minLength: 1, maxLength: 128 } } } },
  }, async (request, reply) => {
    const { projectId } = request.params;
    const { requestId } = request.body;
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) return reply.code(404).send({ code: 'NOT_FOUND', message: '项目不存在。', requestId: request.id });
    const prior = db.prepare('SELECT id, project_id AS projectId, status FROM export_operations WHERE request_id = ?').get(requestId) as { id: string; projectId: string; status: string } | undefined;
    if (prior) {
      if (prior.projectId !== projectId) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
      return reply.code(201).send({ requestId, resourceId: prior.id, status: prior.status });
    }
    if (requestIdUsedElsewhere(db, requestId, 'exports')) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    // 单操作限制：本项目已有准备中的导出时拒绝新导出。
    const inFlight = db.prepare("SELECT id FROM export_operations WHERE project_id = ? AND status = 'preparing'").get(projectId);
    if (inFlight) return reply.code(409).send({ code: 'EXPORT_IN_PROGRESS', message: '本项目已有正在准备的导出操作，请等待其完成或取消。', requestId: request.id });
    const committedAt = new Date().toISOString();
    const operationId = randomUUID();
    const deadlineAt = new Date(Date.now() + EXPORT_DEADLINE_MS).toISOString();
    db.prepare('INSERT INTO export_operations(id,project_id,request_id,status,deadline_at,created_at) VALUES (?,?,?,?,?,?)').run(operationId, projectId, requestId, 'preparing', deadlineAt, committedAt);
    return reply.code(201).send({ requestId, resourceId: operationId, status: 'preparing', createdAt: committedAt, deadlineAt });
  });

  app.post<{ Params: Record<string, never>; Querystring: { requestId: string }; Body: Buffer }>('/api/v1/restore', {
    bodyLimit: RESTORE_BODY_LIMIT,
    schema: { querystring: { type: 'object', required: ['requestId'], additionalProperties: false, properties: { requestId: { type: 'string', minLength: 1, maxLength: 128 } } } },
  }, async (request, reply) => {
    const { requestId } = request.query;
    const zip = request.body as Buffer;
    if (!Buffer.isBuffer(zip) || zip.length === 0) return reply.code(400).send({ code: 'INVALID_PACKAGE', message: '恢复包内容为空。', requestId: request.id });
    const result = await restoreFromPackage(db, attachmentsDir, zip, recordsLimit, requestId);
    if ('code' in result) {
      const status = result.code === 'PROJECT_EXISTS' || result.code === 'SCHEMA_VERSION_MISMATCH' || result.code === 'UNSUPPORTED_FORMAT' || result.code === 'REQUEST_ID_CONFLICT' ? 409 : result.code === 'PROJECT_CAPACITY_EXCEEDED' ? 413 : 400;
      return reply.code(status).send({ code: result.code, message: result.message, requestId: request.id });
    }
    return reply.code(201).send({ requestId, resourceId: result.projectId, restoredProjectId: result.projectId, sourceBindingRequired: true, counts: result.counts, committedAt: result.committedAt });
  });

  app.get<{ Params: { requestId: string } }>('/api/v1/restores/:requestId', async (request, reply) => {
    if (!isOwner(request)) return reply.code(403).send({ code: 'FORBIDDEN', message: '恢复回执仅限用户查看。', requestId: request.id });
    const receipt = getRestoreReceipt(db, request.params.requestId);
    if (!receipt) return reply.code(404).send({ code: 'NOT_FOUND', message: '尚未找到恢复回执；操作可能仍在进行。', requestId: request.id });
    return { requestId: request.params.requestId, resourceId: receipt.projectId, restoredProjectId: receipt.projectId, sourceBindingRequired: true, counts: receipt.counts, committedAt: receipt.committedAt };
  });

    app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/exports', async (request, reply) => {
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(request.params.projectId)) return reply.code(404).send({ code: 'NOT_FOUND', message: '项目不存在。', requestId: request.id });
    const rows = db.prepare('SELECT id, project_id AS projectId, status, sha256, size, error, created_at AS createdAt, finished_at AS finishedAt, deadline_at AS deadlineAt FROM export_operations WHERE project_id = ? ORDER BY created_at DESC, id DESC').all(request.params.projectId) as Operation[];
    return { exports: await Promise.all(rows.map(row => prepareOperation(row))) };
  });

  app.get<{ Params: { operationId: string } }>('/api/v1/exports/:operationId', async (request, reply) => {
    const row = getOperationRow(request.params.operationId);
    if (!row) return reply.code(404).send({ code: 'NOT_FOUND', message: '导出操作不存在。', requestId: request.id });
    return await prepareOperation(row);
  });

  app.post<{ Params: { operationId: string }; Body: { requestId: string } }>('/api/v1/exports/:operationId/cancel', {
    schema: { body: { type: 'object', required: ['requestId'], additionalProperties: false, properties: { requestId: { type: 'string', minLength: 1, maxLength: 128 } } } },
  }, async (request, reply) => {
    if (!isOwner(request)) return reply.code(403).send({ code: 'FORBIDDEN', message: '取消导出仅限用户。', requestId: request.id });
    const { requestId } = request.body;
    const row = getOperationRow(request.params.operationId);
    if (!row) return reply.code(404).send({ code: 'NOT_FOUND', message: '导出操作不存在。', requestId: request.id });
    const result = db.transaction((): { requestId: string; resourceId: string; status: string } | string => {
      const latest = getOperationRow(request.params.operationId);
      if (!latest) return 'NOT_FOUND';
      if (latest.status !== 'preparing') return 'INVALID_STATE';
      db.prepare("UPDATE export_operations SET status = 'canceled', finished_at = ? WHERE id = ? AND status = 'preparing'").run(new Date().toISOString(), row.id);
      return { requestId, resourceId: row.id, status: 'canceled' };
    })();
    if (typeof result === 'string') {
      if (result === 'NOT_FOUND') return reply.code(404).send({ code: result, message: '导出操作不存在。', requestId: request.id });
      return reply.code(409).send({ code: result, message: '只有准备中的导出可以取消。', requestId: request.id });
    }
    return reply.code(200).send(result);
  });

  app.get<{ Params: { operationId: string } }>('/api/v1/exports/:operationId/download', async (request, reply) => {
    if (!isOwner(request)) return reply.code(403).send({ code: 'FORBIDDEN', message: '恢复包下载仅限用户。', requestId: request.id });
    const row = getOperationRow(request.params.operationId);
    if (!row) return reply.code(404).send({ code: 'NOT_FOUND', message: '导出操作不存在。', requestId: request.id });
    const operation = await prepareOperation(row);
    if (operation.status !== 'ready' || !operation.sha256) return reply.code(409).send({ code: 'EXPORT_NOT_READY', message: `导出操作状态为 ${operation.status}，没有可下载的恢复包。`, requestId: request.id });
    try {
      const content = await readFile(zipPath(operation.id));
      if (createHash('sha256').update(content).digest('hex') !== operation.sha256) return reply.code(503).send({ code: 'EXPORT_CORRUPTED', message: '恢复包内容摘要与记录不一致。', requestId: request.id });
      return reply.header('Content-Type', 'application/zip').header('Content-Disposition', `attachment; filename="specmill-export-${operation.projectId.slice(0, 8)}.zip"`).header('Content-Length', content.length).send(content);
    } catch {
      return reply.code(503).send({ code: 'EXPORT_FILE_MISSING', message: '恢复包文件缺失。', requestId: request.id });
    }
  });
}
