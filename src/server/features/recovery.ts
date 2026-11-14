import type { FastifyInstance, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRecords } from '../storage/project-capacity.js';
import { requestIdUsedElsewhere } from '../storage/request-ids.js';
import { buildZip, type ZipEntry } from '../recovery/zip.js';

type Operation = { id: string; projectId: string; status: string; sha256: string | null; size: number | null; error: string | null; createdAt: string; finishedAt: string | null };

export function registerRecovery(app: FastifyInstance, db: Database.Database, dataDir: string, isOwner: (request: FastifyRequest) => boolean) {
  const attachmentsDir = join(dataDir, 'attachments');
  const exportsDir = join(dataDir, 'exports');
  const getOperation = (operationId: string) => db.prepare('SELECT id, project_id AS projectId, request_id AS requestId, status, sha256, size, error, created_at AS createdAt, finished_at AS finishedAt FROM export_operations WHERE id = ?').get(operationId) as (Operation & { requestId: string }) | undefined;
  const zipPath = (operationId: string) => join(exportsDir, `${operationId}.zip`);

  app.post<{ Params: { projectId: string }; Body: { requestId: string } }>('/api/v1/projects/:projectId/exports', {
    schema: { body: { type: 'object', required: ['requestId'], additionalProperties: false, properties: { requestId: { type: 'string', minLength: 1, maxLength: 128 } } } },
  }, async (request, reply) => {
    const { projectId } = request.params;
    const { requestId } = request.body;
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) return reply.code(404).send({ code: 'NOT_FOUND', message: '项目不存在。', requestId: request.id });
    const prior = db.prepare('SELECT id, project_id AS projectId, status, sha256, size, error, created_at AS createdAt, finished_at AS finishedAt FROM export_operations WHERE request_id = ?').get(requestId) as (Operation & { projectId: string }) | undefined;
    if (prior) {
      if (prior.projectId !== projectId) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
      return reply.code(201).send({ requestId, resourceId: prior.id, status: prior.status, sha256: prior.sha256, size: prior.size, error: prior.error, createdAt: prior.createdAt, finishedAt: prior.finishedAt });
    }
    if (requestIdUsedElsewhere(db, requestId, 'exports')) return reply.code(409).send({ code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的内容。', requestId: request.id });
    const committedAt = new Date().toISOString();
    const operationId = randomUUID();
    db.prepare("INSERT INTO export_operations(id,project_id,request_id,status,created_at) VALUES (?,?,?,?,?)").run(operationId, projectId, requestId, 'preparing', committedAt);
    // 一致性：全部项目记录在同一读取事务内选取；附件内容寻址文件不可变。
    const snapshot = db.transaction(() => projectRecords(db, projectId))();
    if (!snapshot) return reply.code(404).send({ code: 'NOT_FOUND', message: '项目不存在。', requestId: request.id });
    const failOperation = (error: string) => db.prepare("UPDATE export_operations SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(error, new Date().toISOString(), operationId);
    try {
      // 凭据不进入恢复包：会话授权哈希在导出投影中剥离。
      const records = { ...snapshot, writerSessions: (snapshot.writerSessions as { claim_hash?: string }[]).map(row => { const { claim_hash: _unused, ...rest } = row; void _unused; return rest; }) };
      const broken: string[] = [];
      const attachmentEntries: ZipEntry[] = [];
      for (const attachment of snapshot.attachments as { id: string; sha256: string; size: number }[]) {
        const content = await readFile(join(attachmentsDir, projectId, attachment.sha256)).catch(() => null);
        if (!content || content.length !== attachment.size || createHash('sha256').update(content).digest('hex') !== attachment.sha256) {
          broken.push(attachment.id);
          continue;
        }
        attachmentEntries.push({ name: `attachments/${attachment.sha256}`, data: content });
      }
      if (broken.length > 0) {
        const error = `受管理附件缺失或摘要不符，导出失败：${broken.join('、')}`;
        failOperation(error);
        return reply.code(503).send({ code: 'ATTACHMENT_UNAVAILABLE', message: error, requestId: request.id, resourceId: operationId });
      }
      const schemaVersion = db.pragma('user_version', { simple: true }) as number;
      const recordsJson = Buffer.from(JSON.stringify(records), 'utf8');
      const manifest = {
        formatVersion: 1,
        schemaVersion,
        projectId,
        generatedAt: new Date().toISOString(),
        files: [
          { path: 'records.json', sha256: createHash('sha256').update(recordsJson).digest('hex'), size: recordsJson.length },
          ...attachmentEntries.map(entry => ({ path: entry.name, sha256: createHash('sha256').update(entry.data).digest('hex'), size: entry.data.length })),
        ],
      };
      const manifestJson = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
      const zip = buildZip([{ name: 'manifest.json', data: manifestJson }, { name: 'records.json', data: recordsJson }, ...attachmentEntries]);
      const sha256 = createHash('sha256').update(zip).digest('hex');
      await mkdir(exportsDir, { recursive: true });
      await writeFile(zipPath(operationId), zip, { flag: 'wx' });
      db.prepare("UPDATE export_operations SET status = 'ready', sha256 = ?, size = ?, finished_at = ? WHERE id = ?").run(sha256, zip.length, new Date().toISOString(), operationId);
      return reply.code(201).send({ requestId, resourceId: operationId, status: 'ready', sha256, size: zip.length, error: null, createdAt: committedAt, finishedAt: new Date().toISOString() });
    } catch (error) {
      failOperation(error instanceof Error ? `导出失败：${error.message}` : '导出失败');
      return reply.code(503).send({ code: 'EXPORT_FAILED', message: '导出失败，操作状态已标为 failed；可按原请求标识重试。', requestId: request.id, resourceId: operationId });
    }
  });

  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/exports', async (request, reply) => {
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(request.params.projectId)) return reply.code(404).send({ code: 'NOT_FOUND', message: '项目不存在。', requestId: request.id });
    const rows = db.prepare('SELECT id, status, sha256, size, error, created_at AS createdAt, finished_at AS finishedAt FROM export_operations WHERE project_id = ? ORDER BY created_at DESC, id DESC').all(request.params.projectId);
    return { exports: rows };
  });

  app.get<{ Params: { operationId: string } }>('/api/v1/exports/:operationId', async (request, reply) => {
    const row = getOperation(request.params.operationId);
    if (!row) return reply.code(404).send({ code: 'NOT_FOUND', message: '导出操作不存在。', requestId: request.id });
    const { requestId: _requestId, ...operation } = row;
    void _requestId;
    return operation;
  });

  app.get<{ Params: { operationId: string } }>('/api/v1/exports/:operationId/download', async (request, reply) => {
    if (!isOwner(request)) return reply.code(403).send({ code: 'FORBIDDEN', message: '恢复包下载仅限用户。', requestId: request.id });
    const row = getOperation(request.params.operationId);
    if (!row) return reply.code(404).send({ code: 'NOT_FOUND', message: '导出操作不存在。', requestId: request.id });
    if (row.status !== 'ready' || !row.sha256) return reply.code(409).send({ code: 'EXPORT_NOT_READY', message: `导出操作状态为 ${row.status}，没有可下载的恢复包。`, requestId: request.id });
    try {
      const content = await readFile(zipPath(row.id));
      if (createHash('sha256').update(content).digest('hex') !== row.sha256) return reply.code(503).send({ code: 'EXPORT_CORRUPTED', message: '恢复包内容摘要与记录不一致。', requestId: request.id });
      return reply.header('Content-Type', 'application/zip').header('Content-Disposition', `attachment; filename="specmill-export-${row.projectId.slice(0, 8)}.zip"`).header('Content-Length', content.length).send(content);
    } catch {
      return reply.code(503).send({ code: 'EXPORT_FILE_MISSING', message: '恢复包文件缺失。', requestId: request.id });
    }
  });
}
