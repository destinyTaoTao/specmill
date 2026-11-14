import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseZip, ZipFormatError } from './zip.js';
import { projectRecordBytes, ProjectCapacityExceeded } from '../storage/project-capacity.js';

type ImportFailure = { code: string; message: string };
type ImportSuccess = { projectId: string; counts: Record<string, number> };

// 恢复包内允许的文件项名称。
const allowedEntryName = (name: string) => name === 'manifest.json' || name === 'records.json' || /^attachments\/[0-9a-f]{64}$/.test(name);
// 激活前检查主键冲突的表（按项目隔离的记录）。
const ID_TABLES: { table: string; key: string }[] = [
  { table: 'projects', key: 'id' },
  { table: 'workspaces', key: 'id' },
  { table: 'workspace_observations', key: 'id' },
  { table: 'changes', key: 'id' },
  { table: 'change_revisions', key: 'id' },
  { table: 'baselines', key: 'id' },
  { table: 'writer_sessions', key: 'id' },
  { table: 'checkpoints', key: 'id' },
  { table: 'handoff_snapshots', key: 'id' },
  { table: 'executions', key: 'id' },
  { table: 'evidence_records', key: 'id' },
  { table: 'acceptance_targets', key: 'id' },
  { table: 'acceptance_proposals', key: 'id' },
  { table: 'attachments', key: 'id' },
  { table: 'decisions', key: 'id' },
  { table: 'failure_dispositions', key: 'id' },
  { table: 'review_previews', key: 'id' },
  { table: 'requests', key: 'request_id' },
  { table: 'workspace_requests', key: 'request_id' },
  { table: 'observation_requests', key: 'request_id' },
  { table: 'change_requests', key: 'request_id' },
  { table: 'baseline_requests', key: 'request_id' },
  { table: 'writer_session_requests', key: 'request_id' },
  { table: 'checkpoint_requests', key: 'request_id' },
  { table: 'handoff_requests', key: 'request_id' },
  { table: 'execution_requests', key: 'request_id' },
  { table: 'evidence_requests', key: 'request_id' },
  { table: 'acceptance_target_requests', key: 'request_id' },
  { table: 'acceptance_proposal_requests', key: 'request_id' },
  { table: 'attachment_requests', key: 'request_id' },
  { table: 'review_requests', key: 'request_id' },
];
// 投影键 → 表名。repository（project_repositories）不恢复：
// 用户须手动重新绑定源码目录，不能凭同名路径自动关联。
const TABLE_KEYS: { key: string; table: string }[] = [
  { key: 'projectRequests', table: 'requests' },
  { key: 'workspaces', table: 'workspaces' },
  { key: 'workspaceRequests', table: 'workspace_requests' },
  { key: 'observations', table: 'workspace_observations' },
  { key: 'observationRequests', table: 'observation_requests' },
  { key: 'changes', table: 'changes' },
  { key: 'changeRevisions', table: 'change_revisions' },
  { key: 'changeRequests', table: 'change_requests' },
  { key: 'changeTransitions', table: 'change_transitions' },
  { key: 'baselines', table: 'baselines' },
  { key: 'baselineRequests', table: 'baseline_requests' },
  { key: 'writerSessions', table: 'writer_sessions' },
  { key: 'writerSessionRequests', table: 'writer_session_requests' },
  { key: 'checkpoints', table: 'checkpoints' },
  { key: 'checkpointRequests', table: 'checkpoint_requests' },
  { key: 'handoffSnapshots', table: 'handoff_snapshots' },
  { key: 'handoffRequests', table: 'handoff_requests' },
  { key: 'executions', table: 'executions' },
  { key: 'executionRequests', table: 'execution_requests' },
  { key: 'evidenceRecords', table: 'evidence_records' },
  { key: 'evidenceRequests', table: 'evidence_requests' },
  { key: 'acceptanceTargets', table: 'acceptance_targets' },
  { key: 'acceptanceTargetRequests', table: 'acceptance_target_requests' },
  { key: 'acceptanceProposals', table: 'acceptance_proposals' },
  { key: 'acceptanceProposalRequests', table: 'acceptance_proposal_requests' },
  { key: 'attachments', table: 'attachments' },
  { key: 'attachmentRequests', table: 'attachment_requests' },
  { key: 'reviewPreviews', table: 'review_previews' },
  { key: 'decisions', table: 'decisions' },
  { key: 'failureDispositions', table: 'failure_dispositions' },
  { key: 'reviewRequests', table: 'review_requests' },
];

export async function restoreFromPackage(db: Database.Database, attachmentsDir: string, zip: Buffer, recordsLimit: number): Promise<ImportSuccess | ImportFailure> {
  let entries: Map<string, Buffer>;
  try {
    entries = parseZip(zip, allowedEntryName);
  } catch (error) {
    if (error instanceof ZipFormatError) return { code: 'INVALID_PACKAGE', message: error.message };
    throw error;
  }
  const manifestRaw = entries.get('manifest.json');
  const recordsRaw = entries.get('records.json');
  if (!manifestRaw || !recordsRaw) return { code: 'INVALID_PACKAGE', message: '恢复包缺少 manifest.json 或 records.json。' };
  let manifest: { formatVersion: number; schemaVersion: number; projectId: string; files: { path: string; sha256: string; size: number }[] };
  try { manifest = JSON.parse(manifestRaw.toString('utf8')); } catch { return { code: 'INVALID_PACKAGE', message: 'manifest.json 不是有效 JSON。' }; }
  if (manifest.formatVersion !== 1) return { code: 'UNSUPPORTED_FORMAT', message: `恢复包格式版本不受支持（${manifest.formatVersion}）。` };
  const schemaVersion = db.pragma('user_version', { simple: true }) as number;
  if (manifest.schemaVersion !== schemaVersion) return { code: 'SCHEMA_VERSION_MISMATCH', message: `恢复包记录结构版本（${manifest.schemaVersion}）与本机（${schemaVersion}）不一致，请升级后重新导出。` };
  if (typeof manifest.projectId !== 'string' || !/^[0-9a-f-]{36}$/.test(manifest.projectId)) return { code: 'INVALID_PACKAGE', message: '清单缺少有效的项目标识。' };
  if (db.prepare('SELECT 1 FROM projects WHERE id = ?').get(manifest.projectId)) return { code: 'PROJECT_EXISTS', message: '本机已存在同标识的项目，不能重复恢复。' };
  // 清单完整性：逐文件核对摘要与长度，未声明的文件拒绝
  for (const file of manifest.files) {
    const content = entries.get(file.path);
    if (!content) return { code: 'INVALID_PACKAGE', message: `清单引用的文件缺失：${file.path}` };
    if (content.length !== file.size || createHash('sha256').update(content).digest('hex') !== file.sha256) return { code: 'INVALID_PACKAGE', message: `文件摘要不符：${file.path}` };
  }
  for (const name of entries.keys()) if (name !== 'manifest.json' && !manifest.files.some(item => item.path === name)) return { code: 'INVALID_PACKAGE', message: `文件未在清单中声明：${name}` };
  let records: Record<string, unknown>;
  try { records = JSON.parse(recordsRaw.toString('utf8')) as Record<string, unknown>; } catch { return { code: 'INVALID_PACKAGE', message: 'records.json 不是有效 JSON。' }; }
  const projectRow = records.project as Record<string, unknown> | undefined;
  if (!projectRow || projectRow.id !== manifest.projectId) return { code: 'INVALID_PACKAGE', message: '记录与清单的项目标识不一致。' };
  // 激活前检查主键冲突
  for (const { table, key } of ID_TABLES) {
    for (const row of (records[key] ?? []) as Record<string, unknown>[]) {
      if (db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(row[key])) return { code: 'PROJECT_EXISTS', message: '本机已存在恢复包中的记录标识，不能重复恢复。' };
    }
  }
  // 附件先落位（内容寻址）；激活事务失败后遗留的未引用文件不占预算。
  for (const attachment of (records.attachments ?? []) as { sha256: string }[]) {
    const content = entries.get(`attachments/${attachment.sha256}`);
    if (!content) return { code: 'INVALID_PACKAGE', message: `附件缺失：${attachment.sha256}` };
    await mkdir(join(attachmentsDir, manifest.projectId), { recursive: true });
    const target = join(attachmentsDir, manifest.projectId, attachment.sha256);
    try {
      await writeFile(target, content, { flag: 'wx' });
    } catch {
      // 已有同地址文件：内容一致则复用，不一致则拒绝（不能覆盖损坏内容伪装成功）。
      const existing = await readFile(target).catch(() => null);
      if (!existing || createHash('sha256').update(existing).digest('hex') !== attachment.sha256 || existing.length !== content.length) {
        return { code: 'STORAGE_CONFLICT', message: `存储中已有同地址内容且摘要不符：${attachment.sha256}` };
      }
    }
  }
  // 激活事务：临时关闭外键按投影顺序批量导入（导出源自一致的完整快照）。
  db.pragma('foreign_keys = OFF');
  try {
    const activate = db.transaction((): ImportSuccess => {
      db.prepare('INSERT INTO projects(id,name,created_at) VALUES (@id,@name,@created_at)').run(projectRow as unknown as Record<string, string>);
      const counts: Record<string, number> = { project: 1 };
      for (const { key, table } of TABLE_KEYS) {
        const rows = (records[key] ?? []) as Record<string, unknown>[];
        for (const row of rows) {
          const columns = Object.keys(row);
          db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(column => {
            const value = row[column];
            // 包内会话一律非活跃且无授权哈希：旧 token 在恢复后无效。
            if (table === 'writer_sessions' && column === 'status' && value === 'active') return 'interrupted';
            if (table === 'writer_sessions' && column === 'claim_hash') return null;
            return value;
          }));
        }
        counts[table] = rows.length;
      }
      // 激活前按本地规则重新核算容量：拒绝伪报用量，回滚全部导入。
      const projected = projectRecordBytes(db, manifest.projectId);
      if (projected > recordsLimit) throw new ProjectCapacityExceeded(projected, Math.max(0, projected - recordsLimit), recordsLimit);
      return { projectId: manifest.projectId, counts };
    })();
    return activate;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
