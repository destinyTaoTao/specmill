import Fastify, { LogController, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import Database from 'better-sqlite3';
import lockfile from 'proper-lockfile';
import { mkdir, realpath } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { registerWorkspaces } from './features/workspaces.js';
import { registerChanges } from './features/changes.js';
import { registerBaselines } from './features/baselines.js';
import { registerWriterSessions } from './features/writer-sessions.js';
import { registerCheckpoints } from './features/checkpoints.js';
import { registerHandoffs } from './features/handoffs.js';
import { registerEvidence } from './features/evidence.js';
import { registerReview } from './features/review.js';
import { registerRecovery } from './features/recovery.js';
import { checkProjectCapacity, DEFAULT_RECORDS_LIMIT, ProjectCapacityExceeded } from './storage/project-capacity.js';
import { requestIdUsedElsewhere } from './storage/request-ids.js';

export type AppOptions = { dataDir: string; port: number; ownerToken: string; agentToken: string; webDir?: string; allowedOrigin?: string; maxProjectRecordsBytes?: number };
export type Receipt = { requestId: string; resourceId: string; recordVersion: number; committedAt: string };
function equal(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function sendError(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ code, message, requestId: request.id });
}

export async function buildApp(options: AppOptions) {
  const recordsLimit = options.maxProjectRecordsBytes ?? DEFAULT_RECORDS_LIMIT;
  if (!Number.isSafeInteger(recordsLimit) || recordsLimit <= 0) throw new Error('Invalid project capacity limit');
  await mkdir(options.dataDir, { recursive: true });
  const dir = await realpath(options.dataDir);
  const unlock = await lockfile.lock(dir, { realpath: false, stale: 10000, retries: 0 });
  let db: Database.Database | undefined;
  try {
    db = new Database(join(dir, 'specmill.db'));
    const version = (db.prepare('select sqlite_version() as version').get() as {version: string}).version.split('.').map(Number);
    if (version[0] < 3 || (version[0] === 3 && (version[1] < 51 || (version[1] === 51 && version[2] < 3)))) throw new Error('SQLite 3.51.3 or later required');
    const schemaVersion = db.pragma('user_version', { simple: true }) as number;
    if (schemaVersion > 16) throw new Error('Unsupported database schema');
    db.pragma('journal_mode = WAL'); db.pragma('locking_mode = EXCLUSIVE'); db.pragma('foreign_keys = ON'); db.pragma('synchronous = FULL'); db.pragma('busy_timeout = 5000');
    db.exec('BEGIN EXCLUSIVE; COMMIT');
    if (schemaVersion === 0) db.transaction(() => {
      db!.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE requests (request_id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id)); PRAGMA user_version = 1');
    })();
    if (schemaVersion < 2) {
      if (schemaVersion === 1) {
        const backupDir = join(dir, 'backups');
        await mkdir(backupDir, { recursive: true });
        await db.backup(join(backupDir, `before-schema-2-${randomUUID()}.db`));
      }
      db.transaction(() => {
        db!.exec(`
          CREATE TABLE workspaces (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), path TEXT NOT NULL, path_key TEXT NOT NULL UNIQUE, common_dir TEXT NOT NULL, common_key TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE project_repositories (project_id TEXT PRIMARY KEY REFERENCES projects(id), common_dir TEXT NOT NULL, common_key TEXT NOT NULL);
          CREATE TABLE workspace_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, resource_id TEXT NOT NULL REFERENCES workspaces(id), record_version INTEGER NOT NULL, committed_at TEXT NOT NULL);
          CREATE TABLE workspace_observations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), project_id TEXT NOT NULL REFERENCES projects(id), binding_version INTEGER NOT NULL, path TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE observation_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, observation_id TEXT NOT NULL REFERENCES workspace_observations(id), committed_at TEXT NOT NULL);
          PRAGMA user_version = 2;
        `);
      })();
    }
    if (schemaVersion < 3) {
      if (schemaVersion === 2) {
        const backupDir = join(dir, 'backups');
        await mkdir(backupDir, { recursive: true });
        await db.backup(join(backupDir, `before-schema-3-${randomUUID()}.db`));
      }
      db.transaction(() => {
        db!.exec(`
          CREATE TABLE IF NOT EXISTS project_repositories (project_id TEXT PRIMARY KEY REFERENCES projects(id), common_dir TEXT NOT NULL, common_key TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS workspace_observations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), project_id TEXT NOT NULL REFERENCES projects(id), binding_version INTEGER NOT NULL, path TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS observation_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, observation_id TEXT NOT NULL REFERENCES workspace_observations(id), committed_at TEXT NOT NULL);
        `);
        if (db!.prepare('SELECT project_id FROM workspaces GROUP BY project_id HAVING COUNT(DISTINCT common_key) > 1').get()) throw new Error('Cannot migrate inconsistent repository bindings');
        db!.exec('INSERT OR IGNORE INTO project_repositories(project_id,common_dir,common_key) SELECT project_id, MIN(common_dir), MIN(common_key) FROM workspaces GROUP BY project_id; PRAGMA user_version = 3');
      })();
    }
    if (schemaVersion < 4) {
      if (schemaVersion === 3) {
        const backupDir = join(dir, 'backups');
        await mkdir(backupDir, { recursive: true });
        await db.backup(join(backupDir, `before-schema-4-${randomUUID()}.db`));
      }
      db.transaction(() => {
        db!.exec(`
          CREATE TABLE changes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), phase TEXT NOT NULL, cycle INTEGER NOT NULL, version INTEGER NOT NULL, current_revision_id TEXT NOT NULL REFERENCES change_revisions(id) DEFERRABLE INITIALLY DEFERRED, created_at TEXT NOT NULL);
          CREATE TABLE change_revisions (id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES changes(id), version INTEGER NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL, scope TEXT NOT NULL, non_goals TEXT NOT NULL, criteria_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(change_id, version));
          CREATE TABLE change_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, resource_id TEXT NOT NULL REFERENCES changes(id), record_version INTEGER NOT NULL, committed_at TEXT NOT NULL);
          PRAGMA user_version = 4;
        `);
      })();
    }
    if (schemaVersion < 5) {
      if (schemaVersion === 4) {
        const backupDir = join(dir, 'backups');
        await mkdir(backupDir, { recursive: true });
        await db.backup(join(backupDir, `before-schema-5-${randomUUID()}.db`));
      }
      db.transaction(() => {
        db!.exec(`CREATE TABLE change_transitions (id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES changes(id), from_phase TEXT NOT NULL, to_phase TEXT NOT NULL, cycle INTEGER NOT NULL, record_version INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL); PRAGMA user_version = 5`);
      })();
    }
    if (schemaVersion < 6) {
      if (schemaVersion === 5) {
        const backupDir = join(dir, 'backups');
        await mkdir(backupDir, { recursive: true });
        await db.backup(join(backupDir, `before-schema-6-${randomUUID()}.db`));
      }
      db.transaction(() => {
        db!.exec(`
          CREATE TABLE baselines (id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES changes(id), draft_revision_id TEXT NOT NULL REFERENCES change_revisions(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), binding_version INTEGER NOT NULL, source_path TEXT NOT NULL, source_sha256 TEXT NOT NULL, source_head TEXT, source_committed INTEGER, selection TEXT NOT NULL, source_item_id TEXT NOT NULL, criteria_json TEXT NOT NULL, goal TEXT NOT NULL, scope TEXT NOT NULL, non_goals TEXT NOT NULL, record_version INTEGER NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE baseline_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, baseline_id TEXT NOT NULL REFERENCES baselines(id), record_version INTEGER NOT NULL, committed_at TEXT NOT NULL);
          ALTER TABLE changes ADD COLUMN current_baseline_id TEXT REFERENCES baselines(id);
          PRAGMA user_version = 6;
        `);
      })();
    }
    if (schemaVersion < 7) {
      if (schemaVersion === 6) {
        const backupDir = join(dir, 'backups');
        await mkdir(backupDir, { recursive: true });
        await db.backup(join(backupDir, `before-schema-7-${randomUUID()}.db`));
      }
      db.transaction(() => {
        db!.exec('ALTER TABLE baselines ADD COLUMN source_revision_id TEXT');
        const rows = db!.prepare('SELECT id FROM baselines').all() as { id: string }[];
        const update = db!.prepare('UPDATE baselines SET source_revision_id = ? WHERE id = ?');
        for (const row of rows) update.run(randomUUID(), row.id);
        db!.exec('PRAGMA user_version = 7');
      })();
    }
    if (schemaVersion < 8) {
      if (schemaVersion === 7) {
        const backupDir = join(dir, 'backups');
        await mkdir(backupDir, { recursive: true });
        await db.backup(join(backupDir, `before-schema-8-${randomUUID()}.db`));
      }
      db.transaction(() => {
        db!.exec(`CREATE TABLE writer_sessions (id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES changes(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), binding_version INTEGER NOT NULL, tool_label TEXT NOT NULL, actor TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, ended_at TEXT);
          CREATE UNIQUE INDEX writer_active_change ON writer_sessions(change_id) WHERE status = 'active';
          CREATE UNIQUE INDEX writer_active_workspace ON writer_sessions(workspace_id) WHERE status = 'active';
          CREATE TABLE writer_session_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES writer_sessions(id), record_version INTEGER NOT NULL, committed_at TEXT NOT NULL);
          PRAGMA user_version = 8`);
      })();
    }
    if (schemaVersion < 9) {
      if (schemaVersion === 8) {
        const backupDir = join(dir, 'backups');
        await mkdir(backupDir, { recursive: true });
        await db.backup(join(backupDir, `before-schema-9-${randomUUID()}.db`));
      }
      db.transaction(() => { db!.exec('ALTER TABLE writer_sessions ADD COLUMN claim_hash TEXT; PRAGMA user_version = 9'); })();
    }
    if (schemaVersion < 10) {
      if (schemaVersion === 9) {
        const backupDir = join(dir, 'backups');
        await mkdir(backupDir, { recursive: true });
        await db.backup(join(backupDir, `before-schema-10-${randomUUID()}.db`));
      }
      db.transaction(() => {
        db!.exec(`CREATE TABLE checkpoints (id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES changes(id), cycle INTEGER NOT NULL, record_version INTEGER NOT NULL, draft_revision_id TEXT NOT NULL REFERENCES change_revisions(id), baseline_id TEXT REFERENCES baselines(id), writer_session_id TEXT NOT NULL REFERENCES writer_sessions(id), observation_id TEXT NOT NULL REFERENCES workspace_observations(id), actor TEXT NOT NULL, goal TEXT NOT NULL, done TEXT NOT NULL, failures TEXT NOT NULL, unverified TEXT NOT NULL, blockers TEXT NOT NULL, next_steps TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE checkpoint_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id), record_version INTEGER NOT NULL, committed_at TEXT NOT NULL);
          ALTER TABLE changes ADD COLUMN current_checkpoint_id TEXT REFERENCES checkpoints(id);
          PRAGMA user_version = 10`);
      })();
    }
    if (schemaVersion < 11) {
      if (schemaVersion === 10) {
        const backupDir = join(dir, 'backups');
        await mkdir(backupDir, { recursive: true });
        await db.backup(join(backupDir, `before-schema-11-${randomUUID()}.db`));
      }
      db.transaction(() => {
        db!.exec(`CREATE TABLE handoff_snapshots (id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES changes(id), project_id TEXT NOT NULL REFERENCES projects(id), cycle INTEGER NOT NULL, version INTEGER NOT NULL, phase TEXT NOT NULL, content_json TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE handoff_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, snapshot_id TEXT NOT NULL REFERENCES handoff_snapshots(id), committed_at TEXT NOT NULL);
          PRAGMA user_version = 11`);
      })();
    }
    if (schemaVersion < 12) {
      if (schemaVersion === 11) {
        const backupDir = join(dir, 'backups');
        await mkdir(backupDir, { recursive: true });
        await db.backup(join(backupDir, `before-schema-12-${randomUUID()}.db`));
      }
      db.transaction(() => {
        db!.exec(`CREATE TABLE executions (id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES changes(id), project_id TEXT NOT NULL REFERENCES projects(id), cycle INTEGER NOT NULL, record_version INTEGER NOT NULL, actor TEXT NOT NULL, method TEXT NOT NULL, result TEXT NOT NULL, exit_status TEXT NOT NULL, claimed_commit TEXT, claimed_clean INTEGER, notes TEXT NOT NULL, upload_workspace_id TEXT, upload_context_json TEXT, upload_limitation TEXT NOT NULL, commit_verified INTEGER, created_at TEXT NOT NULL);
          CREATE TABLE execution_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, execution_id TEXT NOT NULL REFERENCES executions(id), record_version INTEGER NOT NULL, committed_at TEXT NOT NULL);
          CREATE TABLE evidence_records (id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES changes(id), project_id TEXT NOT NULL REFERENCES projects(id), cycle INTEGER NOT NULL, record_version INTEGER NOT NULL, actor TEXT NOT NULL, execution_id TEXT NOT NULL REFERENCES executions(id), criterion_source TEXT NOT NULL, baseline_id TEXT, revision_id TEXT NOT NULL, criterion_id TEXT, criterion_index INTEGER NOT NULL, result TEXT NOT NULL, actual_commit TEXT, notes TEXT NOT NULL, formal INTEGER NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE evidence_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, evidence_id TEXT NOT NULL REFERENCES evidence_records(id), record_version INTEGER NOT NULL, committed_at TEXT NOT NULL);
          CREATE TABLE acceptance_targets (id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES changes(id), project_id TEXT NOT NULL REFERENCES projects(id), cycle INTEGER NOT NULL, record_version INTEGER NOT NULL, commit_sha TEXT NOT NULL, repository_key TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor TEXT NOT NULL, commit_verified INTEGER NOT NULL, status TEXT NOT NULL, confirmed_at TEXT, notes TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE acceptance_target_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, target_id TEXT NOT NULL REFERENCES acceptance_targets(id), action TEXT NOT NULL, committed_at TEXT NOT NULL);
          CREATE TABLE acceptance_proposals (id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES changes(id), project_id TEXT NOT NULL REFERENCES projects(id), cycle INTEGER NOT NULL, record_version INTEGER NOT NULL, actor TEXT NOT NULL, target_id TEXT, reason TEXT NOT NULL, evidence_ids_json TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE acceptance_proposal_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, proposal_id TEXT NOT NULL REFERENCES acceptance_proposals(id), record_version INTEGER NOT NULL, committed_at TEXT NOT NULL);
          PRAGMA user_version = 12`);
      })();
    }
    if (schemaVersion < 13) {
      if (schemaVersion === 12) {
        const backupDir = join(dir, 'backups');
        await mkdir(backupDir, { recursive: true });
        await db.backup(join(backupDir, `before-schema-13-${randomUUID()}.db`));
      }
      db.transaction(() => {
        db!.exec(`CREATE TABLE attachments (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), sha256 TEXT NOT NULL, size INTEGER NOT NULL, filename TEXT NOT NULL, content_type TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (project_id, sha256));
          CREATE TABLE attachment_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, attachment_id TEXT NOT NULL REFERENCES attachments(id), committed_at TEXT NOT NULL);
          ALTER TABLE evidence_records ADD COLUMN attachment_ids_json TEXT NOT NULL DEFAULT '[]';
          PRAGMA user_version = 13`);
      })();
    }
    if (schemaVersion < 14) {
      if (schemaVersion === 13) {
        const backupDir = join(dir, 'backups');
        await mkdir(backupDir, { recursive: true });
        await db.backup(join(backupDir, `before-schema-14-${randomUUID()}.db`));
      }
      db.transaction(() => {
        db!.exec(`CREATE TABLE review_previews (id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES changes(id), project_id TEXT NOT NULL REFERENCES projects(id), cycle INTEGER NOT NULL, baseline_id TEXT NOT NULL REFERENCES baselines(id), criterion_revision_id TEXT NOT NULL, target_id TEXT, record_version INTEGER NOT NULL, evidence_count INTEGER NOT NULL, decision_count INTEGER NOT NULL, disposition_count INTEGER NOT NULL, selections_json TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE decisions (id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES changes(id), project_id TEXT NOT NULL REFERENCES projects(id), cycle INTEGER NOT NULL, baseline_id TEXT NOT NULL REFERENCES baselines(id), criterion_revision_id TEXT NOT NULL, criterion_id TEXT NOT NULL, target_id TEXT, result TEXT NOT NULL, evidence_ids_json TEXT NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL, preview_id TEXT, superseded_by TEXT, created_at TEXT NOT NULL);
          CREATE TABLE failure_dispositions (id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES changes(id), project_id TEXT NOT NULL REFERENCES projects(id), cycle INTEGER NOT NULL, baseline_id TEXT NOT NULL, criterion_id TEXT NOT NULL, failure_evidence_id TEXT NOT NULL REFERENCES evidence_records(id), outcome TEXT NOT NULL, supporting_evidence_ids_json TEXT NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE review_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, resource_id TEXT NOT NULL, action TEXT NOT NULL, record_version INTEGER, committed_at TEXT NOT NULL);
          PRAGMA user_version = 14`);
      })();
    }
    if (schemaVersion < 15) {
      if (schemaVersion === 14) {
        const backupDir = join(dir, 'backups');
        await mkdir(backupDir, { recursive: true });
        await db.backup(join(backupDir, `before-schema-15-${randomUUID()}.db`));
      }
      db.transaction(() => {
        db!.exec(`CREATE TABLE export_operations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), request_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, sha256 TEXT, size INTEGER, error TEXT, created_at TEXT NOT NULL, finished_at TEXT);
          PRAGMA user_version = 15`);
      })();
    }
    if (schemaVersion < 16) {
      if (schemaVersion === 15) {
        const backupDir = join(dir, 'backups');
        await mkdir(backupDir, { recursive: true });
        await db.backup(join(backupDir, `before-schema-16-${randomUUID()}.db`));
      }
      db.transaction(() => {
        db!.exec('ALTER TABLE export_operations ADD COLUMN deadline_at TEXT; PRAGMA user_version = 16');
      })();
    }
    db.transaction(() => {
      db!.exec("UPDATE changes SET version = version + 1 WHERE id IN (SELECT change_id FROM writer_sessions WHERE status = 'active')");
      db!.prepare("UPDATE writer_sessions SET status = 'interrupted', ended_at = ? WHERE status = 'active'").run(new Date().toISOString());
      // 重启后未完成的导出准备标为失败：半成品不作为可恢复包发布。
      db!.prepare("UPDATE export_operations SET status = 'failed', error = '服务重启中断了导出准备', finished_at = ? WHERE status = 'preparing'").run(new Date().toISOString());
    })();
    const app = Fastify({ logger: { level: 'error' }, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 1024 * 1024, genReqId: () => randomUUID(), ajv: { customOptions: { removeAdditional: false, coerceTypes: false } }, forceCloseConnections: true });
    // 附件二进制正文：按内容寻址存储，单文件上限在路由上收紧。
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 6 * 1024 * 1024 }, (_request, body: unknown, done: (error: Error | null, result?: unknown) => void) => {
      if (!Buffer.isBuffer(body)) return done(new Error('Invalid attachment body'));
      done(null, body);
    });
    const sessions = new Set<string>();
    const allowedHosts = new Set([`127.0.0.1:${options.port}`]);
    const origin = `http://127.0.0.1:${options.port}`;
    app.addHook('onRequest', async (request, reply) => {
      if (!allowedHosts.has(request.headers.host ?? '')) return sendError(request, reply, 403, 'FORBIDDEN_HOST', '请求地址不受信任。');
      const requestOrigin = request.headers.origin;
      if (requestOrigin && requestOrigin !== origin && requestOrigin !== options.allowedOrigin) return sendError(request, reply, 403, 'FORBIDDEN_ORIGIN', '请求来源不受信任。');
      // Check the matched route rather than the raw URL: the router also accepts
      // percent-encoded path segments (for example, /%61pi/...).
      const route = request.routeOptions.url;
      if (!route?.startsWith('/api/')) return;
      if (request.method === 'POST' && route === '/api/v1/session') {
        if (!requestOrigin) return sendError(request, reply, 403, 'ORIGIN_REQUIRED', '登录请求缺少来源信息。');
        return;
      }
      const cookie = request.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('specmill_session='))?.slice('specmill_session='.length);
      const owner = !!cookie && sessions.has(cookie);
      const bearer = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const agent = !!bearer && equal(bearer, options.agentToken);
      if (!owner && !agent) return sendError(request, reply, 401, 'UNAUTHORIZED', '请先登录工作台。');
      if (request.method !== 'GET') {
        const agentRoute = request.method === 'POST' && (route === '/api/v1/changes/:changeId/writer-sessions' || route === '/api/v1/writer-sessions/:sessionId/release' || route === '/api/v1/changes/:changeId/checkpoints' || route === '/api/v1/workspaces/:workspaceId/observations' || route === '/api/v1/changes/:changeId/handoffs' || route === '/api/v1/changes/:changeId/executions' || route === '/api/v1/changes/:changeId/evidence' || route === '/api/v1/changes/:changeId/acceptance-targets' || route === '/api/v1/changes/:changeId/acceptance-proposals' || route === '/api/v1/projects/:projectId/attachments' || route === '/api/v1/projects/:projectId/exports' || route === '/api/v1/changes/:changeId/review/preview' || route === '/api/v1/changes/:changeId/review/failure-dispositions/preview');
        if (owner ? !requestOrigin || request.headers['x-specmill-request'] !== '1' : !agent || !agentRoute) return sendError(request, reply, 403, 'FORBIDDEN', '没有执行此操作的权限。');
      }
    });
    app.post<{Body: {token: string}}>('/api/v1/session', { schema: { body: { type: 'object', required: ['token'], additionalProperties: false, properties: { token: { type: 'string', maxLength: 256 } } } } }, async (request, reply) => {
      if (!equal(request.body.token, options.ownerToken)) return sendError(request, reply, 401, 'UNAUTHORIZED', '登录口令不正确。');
      const id = randomBytes(32).toString('hex'); sessions.add(id);
      return reply.header('Set-Cookie', `specmill_session=${id}; HttpOnly; SameSite=Strict; Path=/`).send({ ok: true });
    });
    app.get('/api/v1/projects', async () => ({ projects: db!.prepare('SELECT id, name, created_at as createdAt FROM projects ORDER BY created_at, id').all() }));
    app.post<{Body: {name: string; requestId: string}}>('/api/v1/projects', { schema: { body: { type: 'object', required: ['name', 'requestId'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, requestId: { type: 'string', minLength: 1, maxLength: 128 } } } } }, async (request, reply) => {
      const name = request.body.name.trim();
      if (!name) return sendError(request, reply, 400, 'INVALID_NAME', '项目名称不能为空。');
      const create = db!.transaction(() => {
        const previous = db!.prepare('SELECT p.id, p.name, p.created_at as createdAt FROM requests r JOIN projects p ON p.id = r.project_id WHERE r.request_id = ?').get(request.body.requestId) as {id: string; name: string; createdAt: string} | undefined;
        if (previous) return previous.name === name ? previous : null;
        if (requestIdUsedElsewhere(db!, request.body.requestId, 'projects')) return null;
        const project = { id: randomUUID(), name, createdAt: new Date().toISOString() };
        db!.prepare('INSERT INTO projects(id,name,created_at) VALUES (@id,@name,@createdAt)').run(project);
        db!.prepare('INSERT INTO requests(request_id,name,project_id) VALUES (?,?,?)').run(request.body.requestId, name, project.id);
        checkProjectCapacity(db!, project.id, 0, recordsLimit);
        return project;
      });
      const project = create();
      if (!project) return sendError(request, reply, 409, 'REQUEST_ID_CONFLICT', '请求标识已用于不同的内容。');
      // Projects cannot be updated in T1; every creation is version 1. The
      // creation timestamp is persisted in the same transaction as the request.
      const receipt: Receipt = { requestId: request.body.requestId, resourceId: project.id, recordVersion: 1, committedAt: project.createdAt };
      return reply.code(201).send(receipt);
    });
    const isOwner = (request: FastifyRequest) => {
      const cookie = request.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('specmill_session='))?.slice('specmill_session='.length);
      return !!cookie && sessions.has(cookie);
    };
    const authorizeWriter = registerWriterSessions(app, db, recordsLimit, isOwner);
    registerWorkspaces(app, db, recordsLimit, isOwner, authorizeWriter);
    registerChanges(app, db, recordsLimit);
    registerBaselines(app, db, recordsLimit);
    registerCheckpoints(app, db, recordsLimit, isOwner, authorizeWriter);
    registerHandoffs(app, db, recordsLimit);
    registerEvidence(app, db, recordsLimit, join(dir, 'attachments'));
    registerReview(app, db, recordsLimit, join(dir, 'attachments'));
    registerRecovery(app, db, dir, isOwner);
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof ProjectCapacityExceeded) return reply.code(413).send({ code: error.code, message: error.message, requestId: request.id, dimension: error.dimension, used: error.used, requestedIncrement: error.requestedIncrement, limit: error.limit });
      const errorStatus = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
      const status = typeof errorStatus === 'number' && errorStatus < 500 ? errorStatus : 503;
      if (status === 503) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        const category = typeof code === 'string' && /^SQLITE_[A-Z0-9_]{1,40}$/.test(code) ? code : 'UNEXPECTED_ERROR';
        request.log.error({ requestId: request.id, code: 'SERVICE_UNAVAILABLE', category }, '工作台请求失败');
      }
      const code = status === 503 ? 'SERVICE_UNAVAILABLE' : status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST';
      const message = status === 503 ? '工作台暂时不可用，请稍后重试。' : status === 413 ? '请求内容超过大小限制。' : '请求内容无效，请检查后重试。';
      return sendError(request, reply, status, code, message);
    });
    app.setNotFoundHandler((request, reply) => sendError(request, reply, 404, 'NOT_FOUND', '请求的资源不存在。'));
    if (options.webDir) await app.register(fastifyStatic, { root: resolve(options.webDir), prefix: '/' });
    app.addHook('onClose', async () => { db!.close(); await unlock(); });
    return app;
  } catch (error) {
    db?.close(); await unlock(); throw error;
  }
}
