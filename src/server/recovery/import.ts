import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseZip, ZipFormatError } from './zip.js';
import { projectRecordBytes, ProjectCapacityExceeded } from '../storage/project-capacity.js';
import { requestIdUsedElsewhere } from '../storage/request-ids.js';

type ImportFailure = { code: string; message: string };
type ImportSuccess = { projectId: string; counts: Record<string, number>; committedAt: string };
class RestoreRequestConflict extends Error {}
export function getRestoreReceipt(db: Database.Database, requestId: string) {
  const row = db.prepare('SELECT package_sha256 AS packageSha256, project_id AS projectId, counts_json AS countsJson, committed_at AS committedAt FROM restore_receipts WHERE request_id = ?').get(requestId) as { packageSha256: string; projectId: string; countsJson: string; committedAt: string } | undefined;
  return row ? { packageSha256: row.packageSha256, projectId: row.projectId, counts: JSON.parse(row.countsJson) as Record<string, number>, committedAt: row.committedAt } : null;
}

// 恢复包内允许的文件项名称。
const allowedEntryName = (name: string) => name === 'manifest.json' || name === 'records.json' || /^attachments\/[0-9a-f]{64}$/.test(name);
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

// 同一实例内串行恢复，避免并发恢复复用尚未激活的文件后，被失败请求清理。
const restoreQueues = new WeakMap<Database.Database, Promise<void>>();
export async function restoreFromPackage(db: Database.Database, attachmentsDir: string, zip: Buffer, recordsLimit: number, requestId: string): Promise<ImportSuccess | ImportFailure> {
  const previous = restoreQueues.get(db) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  restoreQueues.set(db, current);
  await previous;
  try {
    const packageSha256 = createHash('sha256').update(zip).digest('hex');
    const prior = getRestoreReceipt(db, requestId);
    if (prior) return prior.packageSha256 === packageSha256 ? { projectId: prior.projectId, counts: prior.counts, committedAt: prior.committedAt } : { code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于不同的恢复包。' };
    if (requestIdUsedElsewhere(db, requestId, 'restores')) return { code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于其他操作。' };
    try { return await restorePackage(db, attachmentsDir, zip, recordsLimit, requestId, packageSha256); }
    catch (error) { if (error instanceof RestoreRequestConflict) return { code: 'REQUEST_ID_CONFLICT', message: '请求标识已用于其他操作或恢复包中的记录。' }; throw error; }
  }
  finally { if (restoreQueues.get(db) === current) restoreQueues.delete(db); release(); }
}

async function restorePackage(db: Database.Database, attachmentsDir: string, zip: Buffer, recordsLimit: number, requestId: string, packageSha256: string): Promise<ImportSuccess | ImportFailure> {
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
  if (!manifest || typeof manifest !== 'object' || !Number.isInteger(manifest.formatVersion) || !Number.isInteger(manifest.schemaVersion) || !Array.isArray(manifest.files)) return { code: 'INVALID_PACKAGE', message: '恢复包清单结构无效。' };
  if (manifest.formatVersion !== 1) return { code: 'UNSUPPORTED_FORMAT', message: `恢复包格式版本不受支持（${manifest.formatVersion}）。` };
  const schemaVersion = db.pragma('user_version', { simple: true }) as number;
  if (manifest.schemaVersion !== schemaVersion && !(schemaVersion === 18 && (manifest.schemaVersion === 16 || manifest.schemaVersion === 17))) return { code: 'SCHEMA_VERSION_MISMATCH', message: `恢复包记录结构版本（${manifest.schemaVersion}）与本机（${schemaVersion}）不一致，请升级后重新导出。` };
  if (typeof manifest.projectId !== 'string' || !/^[0-9a-f-]{36}$/.test(manifest.projectId)) return { code: 'INVALID_PACKAGE', message: '清单缺少有效的项目标识。' };
  if (db.prepare('SELECT 1 FROM projects WHERE id = ?').get(manifest.projectId)) return { code: 'PROJECT_EXISTS', message: '本机已存在同标识的项目，不能重复恢复。' };
  // 清单完整性：逐文件核对摘要与长度，未声明的文件拒绝
  const declaredFiles = new Set<string>();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !allowedEntryName(file.path) || file.path === 'manifest.json' || !/^[0-9a-f]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || declaredFiles.has(file.path)) return { code: 'INVALID_PACKAGE', message: '恢复包清单文件项无效或重复。' };
    declaredFiles.add(file.path);
    const content = entries.get(file.path);
    if (!content) return { code: 'INVALID_PACKAGE', message: `清单引用的文件缺失：${file.path}` };
    if (content.length !== file.size || createHash('sha256').update(content).digest('hex') !== file.sha256) return { code: 'INVALID_PACKAGE', message: `文件摘要不符：${file.path}` };
  }
  for (const name of entries.keys()) if (name !== 'manifest.json' && !declaredFiles.has(name)) return { code: 'INVALID_PACKAGE', message: `文件未在清单中声明：${name}` };
  let records: Record<string, unknown>;
  try { records = JSON.parse(recordsRaw.toString('utf8')) as Record<string, unknown>; } catch { return { code: 'INVALID_PACKAGE', message: 'records.json 不是有效 JSON。' }; }
  if (!records || typeof records !== 'object' || Array.isArray(records)) return { code: 'INVALID_PACKAGE', message: '恢复包记录结构无效。' };
  const projectRow = records.project as Record<string, unknown> | undefined;
  if (!projectRow || projectRow.id !== manifest.projectId) return { code: 'INVALID_PACKAGE', message: '记录与清单的项目标识不一致。' };
  // Validate the untrusted projection against the local schema and require every
  // declared foreign key to resolve inside this package, never an existing project.
  const packageRows = new Map<string, Record<string, unknown>[]>([['projects', [projectRow]]]);
  for (const { key, table } of TABLE_KEYS) {
    if (!Array.isArray(records[key])) return { code: 'INVALID_PACKAGE', message: `恢复包缺少记录集合：${key}` };
    packageRows.set(table, records[key] as Record<string, unknown>[]);
  }
  const dispositionRows = packageRows.get('failure_dispositions')!;
  for (const row of dispositionRows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return { code: 'INVALID_PACKAGE', message: '失败处置记录格式无效。' };
    if (manifest.schemaVersion < 18) {
      if (Object.hasOwn(row, 'target_id')) return { code: 'INVALID_PACKAGE', message: '旧版失败处置包含不受支持的目标引用。' };
      row.target_id = null;
    } else if (!Object.hasOwn(row, 'target_id')) return { code: 'INVALID_PACKAGE', message: '失败处置缺少目标字段。' };
  }
  const targetRows = packageRows.get('acceptance_targets')!;
  if (manifest.schemaVersion === 16) {
    if (targetRows.some(row => !row || typeof row !== 'object' || Array.isArray(row) || Object.hasOwn(row, 'confirmation_order'))) return { code: 'INVALID_PACKAGE', message: '旧版目标记录包含不受支持的确认顺序。' };
    const counts = new Map<unknown, number>();
    for (const row of targetRows) if (row.status === 'confirmed') counts.set(row.change_id, (counts.get(row.change_id) ?? 0) + 1);
    for (const row of targetRows) row.confirmation_order = row.status === 'confirmed' && counts.get(row.change_id) === 1 ? 1 : null;
  }
  const targetOrders = new Set<string>();
  const targetOrdersByChange = new Map<unknown, number[]>();
  for (const row of targetRows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || !Object.hasOwn(row, 'confirmation_order') || (row.confirmation_order !== null && (!Number.isSafeInteger(row.confirmation_order) || (row.confirmation_order as number) < 1 || row.status !== 'confirmed'))) return { code: 'INVALID_PACKAGE', message: '目标确认顺序无效。' };
    if (row.confirmation_order !== null) {
      const key = JSON.stringify([row.change_id, row.confirmation_order]);
      if (targetOrders.has(key)) return { code: 'INVALID_PACKAGE', message: '目标确认顺序重复。' };
      targetOrders.add(key);
      const orders = targetOrdersByChange.get(row.change_id) ?? [];
      orders.push(row.confirmation_order as number); targetOrdersByChange.set(row.change_id, orders);
    }
  }
  for (const orders of targetOrdersByChange.values()) {
    orders.sort((a, b) => a - b);
    if (orders.some((order, index) => order !== index + 1)) return { code: 'INVALID_PACKAGE', message: '目标确认顺序不连续。' };
  }
  const referenceIndexes = new Map<string, Map<unknown, Record<string, unknown>>>();
  for (const [table, rows] of packageRows) {
    const columns = db.pragma(`table_info(${table})`) as { name: string; pk: number; notnull: number; dflt_value: string | null }[];
    const allowedColumns = new Set(columns.map(column => column.name));
    const primaryKey = columns.find(column => column.pk === 1)?.name;
    const seen = new Set<unknown>();
    const foreignKeys = db.pragma(`foreign_key_list(${table})`) as { table: string; from: string; to: string }[];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(column => !allowedColumns.has(column))) return { code: 'INVALID_PACKAGE', message: `记录格式无效：${table}` };
      if (columns.some(column => column.notnull === 1 && (row[column.name] === null || (row[column.name] === undefined && column.dflt_value === null)))) return { code: 'INVALID_PACKAGE', message: `记录缺少必填字段：${table}` };
      if (Object.values(row).some(value => value !== null && typeof value !== 'string' && typeof value !== 'number')) return { code: 'INVALID_PACKAGE', message: `记录字段类型无效：${table}` };
      if ('project_id' in row && row.project_id !== manifest.projectId) return { code: 'INVALID_PACKAGE', message: `记录项目归属不一致：${table}` };
      if (primaryKey) {
        const id = row[primaryKey];
        if (typeof id !== 'string' || !id || seen.has(id)) return { code: 'INVALID_PACKAGE', message: `记录标识缺失或重复：${table}` };
        seen.add(id);
        if (db.prepare(`SELECT 1 FROM ${table} WHERE ${primaryKey} = ?`).get(id)) return { code: 'PROJECT_EXISTS', message: '本机已存在恢复包中的记录标识，不能重复恢复。' };
      }
      for (const fk of foreignKeys) {
        const value = row[fk.from];
        const indexKey = `${fk.table}.${fk.to}`;
        if (!referenceIndexes.has(indexKey)) referenceIndexes.set(indexKey, new Map((packageRows.get(fk.table) ?? []).map(parent => [parent?.[fk.to], parent])));
        const parent = referenceIndexes.get(indexKey)!.get(value);
        if (value != null && !parent) return { code: 'INVALID_PACKAGE', message: `记录引用缺失或跨项目：${table}.${fk.from}` };
        const ownerChange = table === 'changes' ? row.id : row.change_id;
        if (parent && ownerChange != null && parent.change_id != null && ownerChange !== parent.change_id) return { code: 'INVALID_PACKAGE', message: `记录引用跨越变更：${table}.${fk.from}` };
      }
    }
  }
  // JSON 引用不受 SQLite 外键保护，必须在激活前核对目标及变更归属。
  const attachmentIds = new Set(packageRows.get('attachments')!.map(row => row.id));
  const evidenceById = new Map(packageRows.get('evidence_records')!.map(row => [row.id, row]));
  const jsonReferences: { table: string; column: string; target: 'attachment' | 'evidence' }[] = [
    { table: 'evidence_records', column: 'attachment_ids_json', target: 'attachment' },
    { table: 'acceptance_proposals', column: 'evidence_ids_json', target: 'evidence' },
    { table: 'decisions', column: 'evidence_ids_json', target: 'evidence' },
    { table: 'failure_dispositions', column: 'supporting_evidence_ids_json', target: 'evidence' },
  ];
  for (const { table, column, target } of jsonReferences) {
    for (const row of packageRows.get(table)!) {
      let ids: unknown;
      try { ids = JSON.parse(row[column] as string); } catch { return { code: 'INVALID_PACKAGE', message: `记录引用格式无效：${table}.${column}` }; }
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) return { code: 'INVALID_PACKAGE', message: `记录引用格式无效：${table}.${column}` };
      for (const id of ids) {
        if (target === 'attachment' ? !attachmentIds.has(id) : evidenceById.get(id)?.change_id !== row.change_id) return { code: 'INVALID_PACKAGE', message: `记录引用缺失或跨变更：${table}.${column}` };
      }
    }
  }
  for (const preview of packageRows.get('review_previews')!) {
    let value: unknown;
    try { value = JSON.parse(preview.selections_json as string); } catch { return { code: 'INVALID_PACKAGE', message: '审阅预览格式无效。' }; }
    const dispositions = !Array.isArray(value) && value !== null && typeof value === 'object' && (value as { kind?: unknown }).kind === 'dispositions';
    const rows: unknown = dispositions ? (value as { rows?: unknown }).rows : value;
    if (!Array.isArray(rows)) return { code: 'INVALID_PACKAGE', message: '审阅预览格式无效。' };
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return { code: 'INVALID_PACKAGE', message: '审阅预览格式无效。' };
      const references: unknown[] = dispositions ? [row.failureEvidenceId, ...(Array.isArray(row.supportingEvidenceIds) ? row.supportingEvidenceIds : row.supportingEvidenceIds === undefined ? [] : [null])] : Array.isArray(row.evidenceIds) ? row.evidenceIds : [null];
      if (references.some(id => typeof id !== 'string' || evidenceById.get(id)?.change_id !== preview.change_id)) return { code: 'INVALID_PACKAGE', message: '审阅预览引用缺失或跨变更。' };
    }
  }
  const logicalReferences: { table: string; column: string; target: string }[] = [
    { table: 'evidence_records', column: 'revision_id', target: 'change_revisions' },
    { table: 'evidence_records', column: 'baseline_id', target: 'baselines' },
    { table: 'acceptance_proposals', column: 'target_id', target: 'acceptance_targets' },
    { table: 'review_previews', column: 'criterion_revision_id', target: 'change_revisions' },
    { table: 'review_previews', column: 'target_id', target: 'acceptance_targets' },
    { table: 'decisions', column: 'criterion_revision_id', target: 'change_revisions' },
    { table: 'decisions', column: 'target_id', target: 'acceptance_targets' },
    { table: 'decisions', column: 'preview_id', target: 'review_previews' },
    { table: 'decisions', column: 'superseded_by', target: 'decisions' },
    { table: 'failure_dispositions', column: 'baseline_id', target: 'baselines' },
    { table: 'failure_dispositions', column: 'target_id', target: 'acceptance_targets' },
  ];
  const logicalIndexes = new Map<string, Map<unknown, Record<string, unknown>>>();
  for (const { table, column, target } of logicalReferences) {
    if (!logicalIndexes.has(target)) logicalIndexes.set(target, new Map(packageRows.get(target)!.map(row => [row.id, row])));
    for (const row of packageRows.get(table)!) {
      const id = row[column];
      if (id != null && logicalIndexes.get(target)!.get(id)?.change_id !== row.change_id) return { code: 'INVALID_PACKAGE', message: `记录引用缺失或跨变更：${table}.${column}` };
    }
  }
  // 审阅回执的 resource_id 是多态引用，数据库没有外键；不能指向包外已有项目。
  const reviewResources = new Map<string, Map<unknown, Record<string, unknown>>>();
  for (const table of ['changes', 'review_previews', 'decisions', 'failure_dispositions']) {
    reviewResources.set(table, new Map(packageRows.get(table)!.map(row => [row.id, row])));
  }
  const reviewTargets: Record<string, string[]> = {
    preview: ['review_previews'],
    confirm: ['decisions', 'review_previews'],
    waive: ['decisions'],
    'disposition-preview': ['review_previews'],
    'disposition-confirm': ['failure_dispositions'],
    continue: ['changes'],
  };
  for (const row of packageRows.get('review_requests')!) {
    const targets = typeof row.action === 'string' && Object.hasOwn(reviewTargets, row.action) ? reviewTargets[row.action] : undefined;
    let fingerprint: unknown;
    try { fingerprint = JSON.parse(row.fingerprint as string); } catch { return { code: 'INVALID_PACKAGE', message: '审阅回执指纹格式无效。' }; }
    const target = targets?.flatMap(table => {
      const resource = reviewResources.get(table)!.get(row.resource_id);
      return resource ? [table === 'changes' ? resource.id : resource.change_id] : [];
    });
    if (!target?.length || !Array.isArray(fingerprint) || typeof fingerprint[1] !== 'string' || !target.includes(fingerprint[1])) return { code: 'INVALID_PACKAGE', message: '审阅回执引用缺失或跨变更。' };
  }
  // 先核对记录中的内容地址与长度，清单摘要本身不能证明其与附件记录一致。
  const attachments = records.attachments as { sha256: string; size: number }[];
  const expectedAttachments = new Set<string>();
  for (const attachment of attachments) {
    if (typeof attachment.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(attachment.sha256) || !Number.isSafeInteger(attachment.size) || attachment.size < 0) return { code: 'INVALID_PACKAGE', message: '附件记录无效。' };
    const content = entries.get(`attachments/${attachment.sha256}`);
    if (!content) return { code: 'INVALID_PACKAGE', message: `附件缺失：${attachment.sha256}` };
    if (content.length !== attachment.size || createHash('sha256').update(content).digest('hex') !== attachment.sha256) return { code: 'INVALID_PACKAGE', message: `附件与记录的摘要或长度不一致：${attachment.sha256}` };
    expectedAttachments.add(`attachments/${attachment.sha256}`);
  }
  for (const name of entries.keys()) if (name.startsWith('attachments/') && !expectedAttachments.has(name)) return { code: 'INVALID_PACKAGE', message: `恢复包包含无记录的附件：${name}` };
  // 每次恢复使用独立暂存目录，只清理本次独占创建的文件。
  await mkdir(attachmentsDir, { recursive: true });
  const stagingDir = await mkdtemp(join(attachmentsDir, '.restore-'));
  const staged: string[] = [];
  const created: string[] = [];
  let activated = false;
  let stagingRemoved = false;
  try {
    for (const attachment of attachments) {
      const stage = join(stagingDir, attachment.sha256);
      // 记录路径后再写入，写失败留下的部分文件也会清理。
      staged.push(stage);
      await writeFile(stage, entries.get(`attachments/${attachment.sha256}`)!, { flag: 'wx' });
    }
    if (attachments.length) await mkdir(join(attachmentsDir, manifest.projectId), { recursive: true });
    for (const attachment of attachments) {
      const content = entries.get(`attachments/${attachment.sha256}`)!;
      const target = join(attachmentsDir, manifest.projectId, attachment.sha256);
      try {
        const file = await open(target, 'wx');
        created.push(target);
        try { await file.writeFile(await readFile(join(stagingDir, attachment.sha256))); } finally { await file.close(); }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        const existing = await readFile(target).catch(() => null);
        if (!existing || createHash('sha256').update(existing).digest('hex') !== attachment.sha256 || existing.length !== content.length) {
          return { code: 'STORAGE_CONFLICT', message: `存储中已有同地址内容且摘要不符：${attachment.sha256}` };
        }
      }
    }
    // 清理失败必须发生在激活前，避免项目已提交而请求因暂存清理报错。
    for (const path of staged) await unlink(path);
    await rmdir(stagingDir);
    stagingRemoved = true;
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
      if (requestIdUsedElsewhere(db, requestId, 'restores')) throw new RestoreRequestConflict();
      const committedAt = new Date().toISOString();
      db.prepare('INSERT INTO restore_receipts(request_id,package_sha256,project_id,counts_json,committed_at) VALUES (?,?,?,?,?)').run(requestId, packageSha256, manifest.projectId, JSON.stringify(counts), committedAt);
      return { projectId: manifest.projectId, counts, committedAt };
    })();
      activated = true;
      return activate;
    } finally {
      db.pragma('foreign_keys = ON');
    }
  } finally {
    if (!activated) for (const path of created) await unlink(path).catch(error => { if (error?.code !== 'ENOENT') throw error; });
    if (!stagingRemoved) {
      for (const path of staged) await unlink(path).catch(error => { if (error?.code !== 'ENOENT') throw error; });
      await rmdir(stagingDir);
    }
  }
}
