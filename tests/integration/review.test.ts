import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildApp } from '../../src/server/app.js';
import { buildZip, parseZip } from '../../src/server/recovery/zip.js';
import * as attachmentStorage from '../../src/server/storage/attachments.js';
import { encodeSecret } from '../../src/shared/credentials.js';

const testAgentToken = 'c'.repeat(64);
const dirs: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const headers = { host: '127.0.0.1:43220', origin: 'http://127.0.0.1:43220' };
const agentHeaders = { host: headers.host, authorization: `Bearer ${testAgentToken}` };
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup(maxProjectRecordsBytes?: number) {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-review-data-')); dirs.push(dataDir);
  const repoDir = await mkdtemp(join(tmpdir(), 'specmill-review-repo-')); dirs.push(repoDir);
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_AUTHOR_NAME: '测试', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: '测试', GIT_COMMITTER_EMAIL: 'test@example.com' } });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  git(['init', '-q']);
  await writeFile(join(repoDir, 'README.md'), '# 审阅样本\n');
  const specContent = '# 验收规格\n\n- 条件一：功能通过\n- 条件二：文档齐全\n';
  await writeFile(join(repoDir, 'spec.md'), specContent);
  git(['add', 'README.md', 'spec.md']);
  git(['commit', '-q', '-m', 'init']);
  const headSha = git(['rev-parse', 'HEAD']).trim();
  const app = await buildApp({ dataDir, port: 43220, ownerToken: 'owner-token', agentToken: testAgentToken, maxProjectRecordsBytes }); apps.push(app);
  await app.listen({ host: '127.0.0.1', port: 43220 });
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
  const ownerHeaders = { ...headers, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
  const project = await app.inject({ method: 'POST', url: `/api/v1/projects`, headers: ownerHeaders, payload: { name: '审阅项目', requestId: 'review-project' } });
  const projectId = project.json().resourceId as string;
  const workspace = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders,
    payload: { requestId: 'review-workspace', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
  const workspaceId = workspace.json().resourceId as string;
  const change = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
    payload: { requestId: 'review-change', expectedVersion: null, payload: { title: '审阅变更', goal: '', scope: '', nonGoals: '', criteria: ['功能通过', '文档齐全'] } } });
  const changeId = change.json().resourceId as string;
  return { app, dataDir, repoDir, projectId, workspaceId, changeId, ownerHeaders, git, headSha, specContent };
}
async function freeze(app: Awaited<ReturnType<typeof buildApp>>, changeId: string, workspaceId: string, ownerHeaders: Record<string, unknown>, expectedVersion: number, specContent: string) {
  const frozen = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/baselines`, headers: ownerHeaders,
    payload: { requestId: `freeze-${expectedVersion}`, expectedVersion, payload: { workspaceId, expectedBindingVersion: 1, path: 'spec.md', expectedSha256: createHash('sha256').update(specContent, 'utf8').digest('hex'), selection: '# 验收规格', criterionLinks: [null, null], previousSourceItemId: null } } });
  expect(frozen.statusCode).toBe(201);
  return frozen.json().resourceId as string;
}
async function formalEvidence(app: Awaited<ReturnType<typeof buildApp>>, changeId: string, workspaceId: string, ownerHeaders: Record<string, unknown>, requestId: string, criterionIndex: 1 | 2, criterionId: string, baselineId: string, headSha: string, attachmentIds: string[] = []) {
  const run = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/executions`, headers: ownerHeaders,
    payload: { requestId: `${requestId}-run`, workspaceId, payload: { method: 'node --test', result: 'passed', claimedCommit: headSha, claimedClean: true } } });
  expect(run.statusCode).toBe(201);
  const evidence = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/evidence`, headers: ownerHeaders,
    payload: { requestId: `${requestId}-ev`, payload: { executionId: run.json().resourceId, criterion: { kind: 'baseline', baselineId, criterionId }, criterionIndex, result: 'passed', actualCommit: headSha, attachmentIds } } });
  expect(evidence.statusCode).toBe(201);
  return evidence.json().resourceId as string;
}

describe('review confirmation and acceptance', () => {
  it('only clears a failure for the target that was explicitly dispositioned', async () => {
    const { app, dataDir, projectId, workspaceId, changeId, ownerHeaders, headSha, specContent } = await setup();
    const baselineId = await freeze(app, changeId, workspaceId, ownerHeaders, 1, specContent);
    const criteria = (await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${baselineId}`, headers: ownerHeaders })).json().criteria as { id: string }[];
    const run = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/executions`, headers: ownerHeaders, payload: { requestId: 'target-disposition-run', workspaceId, payload: { method: 'check', result: 'failed', claimedCommit: headSha, claimedClean: true } } });
    expect(run.statusCode).toBe(201);
    const failure = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/evidence`, headers: ownerHeaders, payload: { requestId: 'target-disposition-failure', payload: { executionId: run.json().resourceId, criterion: { kind: 'baseline', baselineId, criterionId: criteria[0].id }, criterionIndex: 1, result: 'failed', actualCommit: headSha } } });
    expect(failure.statusCode).toBe(201);
    const createTarget = (requestId: string) => app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets`, headers: ownerHeaders, payload: { requestId, payload: { commit: headSha } } });
    const first = await createTarget('target-disposition-first');
    expect(first.statusCode).toBe(201);
    const proposal = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-proposals`, headers: ownerHeaders, payload: { requestId: 'target-disposition-proposal', expectedVersion: 2, payload: { reason: '审阅', targetId: first.json().resourceId } } });
    expect(proposal.statusCode).toBe(201);
    const confirmTarget = (id: string, requestId: string) => app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets/${id}/confirm`, headers: ownerHeaders, payload: { requestId } });
    expect((await confirmTarget(first.json().resourceId, 'target-disposition-confirm-first')).statusCode).toBe(200);
    const dispose = async (version: number, suffix: string) => {
      const preview = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/failure-dispositions/preview`, headers: ownerHeaders, payload: { requestId: `target-disposition-preview-${suffix}`, expectedVersion: version, payload: { rows: [{ criterionId: criteria[0].id, failureEvidenceId: failure.json().resourceId, outcome: 'not_applicable', reason: '核对后不适用' }] } } });
      expect(preview.statusCode).toBe(201);
      return app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/failure-dispositions/confirm`, headers: ownerHeaders, payload: { requestId: `target-disposition-commit-${suffix}`, payload: { previewId: preview.json().resourceId } } });
    };
    const firstDisposition = await dispose(3, 'first');
    expect(firstDisposition.statusCode).toBe(200);
    const review = async () => (await app.inject({ url: `/api/v1/changes/${changeId}/review`, headers: ownerHeaders })).json();
    expect((await review()).criteria[0].blockingFailures).toHaveLength(0);
    const second = await createTarget('target-disposition-second');
    expect(second.statusCode).toBe(201);
    expect((await confirmTarget(second.json().resourceId, 'target-disposition-confirm-second')).statusCode).toBe(200);
    const changed = await review();
    expect(changed.criteria[0].blockingFailures.map((item: { id: string }) => item.id)).toContain(failure.json().resourceId);
    expect(changed.criteria[0].dispositions[0].targetId).toBe(first.json().resourceId);
    const secondDisposition = await dispose(firstDisposition.json().recordVersion, 'second');
    expect(secondDisposition.statusCode).toBe(200);
    const resolved = await review();
    expect(resolved.criteria[0].blockingFailures).toHaveLength(0);
    expect(resolved.criteria[0].dispositions.map((item: { targetId: string }) => item.targetId)).toEqual(expect.arrayContaining([first.json().resourceId, second.json().resourceId]));
    const exported = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/exports`, headers: ownerHeaders, payload: { requestId: 'disposition-legacy-export' } });
    const archive = await app.inject({ url: `/api/v1/exports/${exported.json().resourceId}/download`, headers: ownerHeaders });
    const entries = parseZip(archive.rawPayload, () => true);
    const records = JSON.parse(entries.get('records.json')!.toString()) as { failureDispositions: Record<string, unknown>[] };
    for (const row of records.failureDispositions) delete row.target_id;
    const bytes = Buffer.from(JSON.stringify(records));
    const manifest = JSON.parse(entries.get('manifest.json')!.toString()) as { schemaVersion: number; files: { path: string; sha256: string; size: number }[] };
    manifest.schemaVersion = 17;
    const file = manifest.files.find(item => item.path === 'records.json')!;
    file.sha256 = createHash('sha256').update(bytes).digest('hex'); file.size = bytes.length;
    entries.set('records.json', bytes); entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    const restoreDir = await mkdtemp(join(tmpdir(), 'specmill-disposition-v17-')); dirs.push(restoreDir);
    const restoredApp = await buildApp({ dataDir: restoreDir, port: 43221, ownerToken: 'owner-token', agentToken: testAgentToken }); apps.push(restoredApp);
    const base = { host: '127.0.0.1:43221', origin: 'http://127.0.0.1:43221' };
    const login = await restoredApp.inject({ method: 'POST', url: '/api/v1/session', headers: base, payload: { token: 'owner-token' } });
    const restoredOwner = { ...base, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const imported = await restoredApp.inject({ method: 'POST', url: '/api/v1/restore?requestId=disposition-legacy-restore', headers: { ...restoredOwner, 'content-type': 'application/octet-stream' }, payload: buildZip([...entries].map(([name, data]) => ({ name, data }))) });
    expect(imported.statusCode).toBe(201);
    const legacyReview = (await restoredApp.inject({ url: `/api/v1/changes/${changeId}/review`, headers: restoredOwner })).json();
    expect(legacyReview.criteria[0].blockingFailures).toHaveLength(1);
    expect(legacyReview.criteria[0].dispositions.every((item: { targetId: string | null }) => item.targetId === null)).toBe(true);
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const db = new Database(join(dataDir, 'specmill.db'));
    db.exec('DROP TABLE restore_receipts; ALTER TABLE failure_dispositions DROP COLUMN target_id; PRAGMA user_version = 17');
    db.close();
    const restarted = await buildApp({ dataDir, port: 43220, ownerToken: 'owner-token', agentToken: testAgentToken }); apps.push(restarted);
    expect((await readdir(join(dataDir, 'backups'))).some(name => name.startsWith('before-schema-18-'))).toBe(true);
    const renewed = await restarted.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
    const renewedOwner = { ...headers, cookie: renewed.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const migrated = (await restarted.inject({ url: `/api/v1/changes/${changeId}/review`, headers: renewedOwner })).json();
    expect(migrated.criteria[0].blockingFailures).toHaveLength(1);
    expect(migrated.criteria[0].dispositions.every((item: { targetId: string | null }) => item.targetId === null)).toBe(true);
  }, 30000);
  it('uses confirmation order even when the clock stays still or moves backwards', async () => {
    const { app, projectId, workspaceId, changeId, ownerHeaders, headSha, specContent } = await setup();
    await freeze(app, changeId, workspaceId, ownerHeaders, 1, specContent);
    const targets = [];
    for (let i = 0; i < 3; i++) {
      const result = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets`, headers: ownerHeaders, payload: { requestId: `order-target-${i}`, payload: { commit: headSha } } });
      expect(result.statusCode).toBe(201); targets.push(result.json().resourceId as string);
    }
    expect((await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-proposals`, headers: ownerHeaders, payload: { requestId: 'order-proposal', expectedVersion: 2, payload: { reason: '审阅', targetId: targets[0] } } })).statusCode).toBe(201);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (const [index, time] of ['2026-11-15T00:00:00.000Z', '2026-11-15T00:00:00.000Z', '2026-11-14T00:00:00.000Z'].entries()) {
        vi.setSystemTime(new Date(time));
        const result = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets/${targets[index]}/confirm`, headers: ownerHeaders, payload: { requestId: `order-confirm-${index}` } });
        expect(result.statusCode).toBe(200);
        const review = await app.inject({ url: `/api/v1/changes/${changeId}/review`, headers: ownerHeaders });
        expect(review.statusCode).toBe(200);
        expect(review.json().context.target.id).toBe(targets[index]);
      }
    } finally { vi.useRealTimers(); }
    const exported = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/exports`, headers: agentHeaders, payload: { requestId: 'order-export' } });
    expect(exported.statusCode).toBe(201);
    const archive = await app.inject({ url: `/api/v1/exports/${exported.json().resourceId}/download`, headers: ownerHeaders });
    expect(archive.statusCode).toBe(200);
    const restoreDir = await mkdtemp(join(tmpdir(), 'specmill-order-restore-')); dirs.push(restoreDir);
    const restoredApp = await buildApp({ dataDir: restoreDir, port: 43221, ownerToken: 'owner-token', agentToken: testAgentToken }); apps.push(restoredApp);
    const base = { host: '127.0.0.1:43221', origin: 'http://127.0.0.1:43221' };
    const login = await restoredApp.inject({ method: 'POST', url: '/api/v1/session', headers: base, payload: { token: 'owner-token' } });
    const owner = { ...base, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const restored = await restoredApp.inject({ method: 'POST', url: '/api/v1/restore?requestId=order-restore', headers: { ...owner, 'content-type': 'application/octet-stream' }, payload: archive.rawPayload });
    expect(restored.statusCode).toBe(201);
    const review = await restoredApp.inject({ url: `/api/v1/changes/${changeId}/review`, headers: owner });
    expect(review.statusCode).toBe(200);
    expect(review.json().context.target.id).toBe(targets[2]);
  }, 30000);
  it('requires a new confirmation for ambiguous v16 targets without rewriting historical receipts', async () => {
    const { app, dataDir, workspaceId, changeId, ownerHeaders, headSha, specContent } = await setup();
    await freeze(app, changeId, workspaceId, ownerHeaders, 1, specContent);
    const targets: string[] = [];
    for (let i = 0; i < 2; i++) {
      const result = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets`, headers: ownerHeaders, payload: { requestId: `legacy-order-target-${i}`, payload: { commit: headSha } } });
      expect(result.statusCode).toBe(201); targets.push(result.json().resourceId);
    }
    expect((await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-proposals`, headers: ownerHeaders, payload: { requestId: 'legacy-order-proposal', expectedVersion: 2, payload: { reason: '审阅', targetId: targets[0] } } })).statusCode).toBe(201);
    const receipts = [];
    for (const [index, id] of targets.entries()) {
      const response = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets/${id}/confirm`, headers: ownerHeaders, payload: { requestId: `legacy-order-confirm-${index}` } });
      expect(response.statusCode).toBe(200); receipts.push(response.json());
    }
    const projectId = (await app.inject({ url: `/api/v1/changes/${changeId}`, headers: ownerHeaders })).json().projectId as string;
    const exported = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/exports`, headers: agentHeaders, payload: { requestId: 'legacy-order-export' } });
    expect(exported.statusCode).toBe(201);
    const zip = await app.inject({ url: `/api/v1/exports/${exported.json().resourceId}/download`, headers: ownerHeaders });
    expect(zip.statusCode).toBe(200);
    const entries = parseZip(zip.rawPayload, () => true);
    const records = JSON.parse(entries.get('records.json')!.toString()) as { acceptanceTargets: Record<string, unknown>[]; failureDispositions: Record<string, unknown>[] };
    for (const row of records.acceptanceTargets) delete row.confirmation_order;
    for (const row of records.failureDispositions) delete row.target_id;
    const oldRecords = Buffer.from(JSON.stringify(records));
    const manifest = JSON.parse(entries.get('manifest.json')!.toString()) as { schemaVersion: number; files: { path: string; sha256: string; size: number }[] };
    manifest.schemaVersion = 16;
    const file = manifest.files.find(item => item.path === 'records.json')!;
    file.sha256 = createHash('sha256').update(oldRecords).digest('hex'); file.size = oldRecords.length;
    entries.set('records.json', oldRecords); entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    const legacyZip = buildZip([...entries].map(([name, data]) => ({ name, data })));
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const old = new Database(join(dataDir, 'specmill.db'));
    try { old.exec('DROP TABLE restore_receipts; ALTER TABLE failure_dispositions DROP COLUMN target_id; DROP INDEX target_confirmation_order; ALTER TABLE acceptance_targets DROP COLUMN confirmation_order; PRAGMA user_version = 16'); } finally { old.close(); }
    const restarted = await buildApp({ dataDir, port: 43220, ownerToken: 'owner-token', agentToken: testAgentToken }); apps.push(restarted);
    await restarted.listen({ host: '127.0.0.1', port: 43220 });
    const login = await restarted.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
    const owner = { ...headers, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    expect((await readdir(join(dataDir, 'backups'))).some(name => name.startsWith('before-schema-17-'))).toBe(true);
    const before = (await restarted.inject({ url: `/api/v1/changes/${changeId}/review`, headers: owner })).json();
    expect(before.context.target).toBeNull();
    expect(before.context.targetOrderUncertain).toBe(true);
    const preview = await restarted.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: owner, payload: { requestId: 'legacy-order-preview', payload: { selections: [] } } });
    expect(preview.statusCode).toBe(409); expect(preview.json().code).toBe('TARGET_REQUIRED');
    for (const [index, receipt] of receipts.entries()) expect((await restarted.inject({ url: `/api/v1/receipts/legacy-order-confirm-${index}`, headers: owner })).json()).toEqual(receipt);
    const candidate = await restarted.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets`, headers: owner, payload: { requestId: 'legacy-order-new-target', payload: { commit: headSha, workspaceId } } });
    expect(candidate.statusCode).toBe(201); expect(targets).not.toContain(candidate.json().resourceId);
    expect((await restarted.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets/${candidate.json().resourceId}/confirm`, headers: owner, payload: { requestId: 'legacy-order-new-confirm', expectedBindingVersion: 1 } })).statusCode).toBe(200);
    expect((await restarted.inject({ url: `/api/v1/changes/${changeId}/review`, headers: owner })).json().context.target.id).toBe(candidate.json().resourceId);
    const restoreDir = await mkdtemp(join(tmpdir(), 'specmill-legacy-order-restore-')); dirs.push(restoreDir);
    const restoredApp = await buildApp({ dataDir: restoreDir, port: 43221, ownerToken: 'owner-token', agentToken: testAgentToken }); apps.push(restoredApp);
    const restoreBase = { host: '127.0.0.1:43221', origin: 'http://127.0.0.1:43221' };
    const restoreLogin = await restoredApp.inject({ method: 'POST', url: '/api/v1/session', headers: restoreBase, payload: { token: 'owner-token' } });
    const restoreOwner = { ...restoreBase, cookie: restoreLogin.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const forgedEntries = parseZip(zip.rawPayload, () => true);
    const forgedRecords = JSON.parse(forgedEntries.get('records.json')!.toString()) as { acceptanceTargets: { confirmation_order: number | null }[] };
    forgedRecords.acceptanceTargets[1].confirmation_order = forgedRecords.acceptanceTargets[0].confirmation_order;
    const forgedBytes = Buffer.from(JSON.stringify(forgedRecords));
    const forgedManifest = JSON.parse(forgedEntries.get('manifest.json')!.toString()) as { files: { path: string; sha256: string; size: number }[] };
    const forgedFile = forgedManifest.files.find(item => item.path === 'records.json')!;
    forgedFile.sha256 = createHash('sha256').update(forgedBytes).digest('hex'); forgedFile.size = forgedBytes.length;
    forgedEntries.set('records.json', forgedBytes); forgedEntries.set('manifest.json', Buffer.from(JSON.stringify(forgedManifest)));
    const rejected = await restoredApp.inject({ method: 'POST', url: '/api/v1/restore?requestId=duplicate-order-restore', headers: { ...restoreOwner, 'content-type': 'application/octet-stream' }, payload: buildZip([...forgedEntries].map(([name, data]) => ({ name, data }))) });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().code).toBe('INVALID_PACKAGE');
    expect((await restoredApp.inject({ url: `/api/v1/changes/${changeId}`, headers: restoreOwner })).statusCode).toBe(404);
    forgedRecords.acceptanceTargets[1].confirmation_order = 42;
    const gapBytes = Buffer.from(JSON.stringify(forgedRecords));
    forgedFile.sha256 = createHash('sha256').update(gapBytes).digest('hex'); forgedFile.size = gapBytes.length;
    forgedEntries.set('records.json', gapBytes); forgedEntries.set('manifest.json', Buffer.from(JSON.stringify(forgedManifest)));
    const gap = await restoredApp.inject({ method: 'POST', url: '/api/v1/restore?requestId=gap-order-restore', headers: { ...restoreOwner, 'content-type': 'application/octet-stream' }, payload: buildZip([...forgedEntries].map(([name, data]) => ({ name, data }))) });
    expect(gap.statusCode).toBe(400); expect(gap.json().code).toBe('INVALID_PACKAGE');
    const forgedLegacyEntries = parseZip(legacyZip, () => true);
    const forgedLegacy = JSON.parse(forgedLegacyEntries.get('records.json')!.toString()) as { acceptanceTargets: Record<string, unknown>[] };
    forgedLegacy.acceptanceTargets[0].confirmation_order = 1;
    const forgedLegacyBytes = Buffer.from(JSON.stringify(forgedLegacy));
    const forgedLegacyManifest = JSON.parse(forgedLegacyEntries.get('manifest.json')!.toString()) as { files: { path: string; sha256: string; size: number }[] };
    const forgedLegacyFile = forgedLegacyManifest.files.find(item => item.path === 'records.json')!;
    forgedLegacyFile.sha256 = createHash('sha256').update(forgedLegacyBytes).digest('hex'); forgedLegacyFile.size = forgedLegacyBytes.length;
    forgedLegacyEntries.set('records.json', forgedLegacyBytes); forgedLegacyEntries.set('manifest.json', Buffer.from(JSON.stringify(forgedLegacyManifest)));
    const forgedOld = await restoredApp.inject({ method: 'POST', url: '/api/v1/restore?requestId=forged-v16-order', headers: { ...restoreOwner, 'content-type': 'application/octet-stream' }, payload: buildZip([...forgedLegacyEntries].map(([name, data]) => ({ name, data }))) });
    expect(forgedOld.statusCode).toBe(400); expect(forgedOld.json().code).toBe('INVALID_PACKAGE');
    const restored = await restoredApp.inject({ method: 'POST', url: '/api/v1/restore?requestId=legacy-order-restore', headers: { ...restoreOwner, 'content-type': 'application/octet-stream' }, payload: legacyZip });
    expect(restored.statusCode).toBe(201);
    const restoredReview = (await restoredApp.inject({ url: `/api/v1/changes/${changeId}/review`, headers: restoreOwner })).json();
    expect(restoredReview.context.target).toBeNull();
    expect(restoredReview.context.targetOrderUncertain).toBe(true);
    for (const [index, receipt] of receipts.entries()) expect((await restoredApp.inject({ url: `/api/v1/receipts/legacy-order-confirm-${index}`, headers: restoreOwner })).json()).toEqual(receipt);
  }, 30000);
  it('rolls back the schema upgrade if the new index cannot be created', async () => {
    const { app, dataDir } = await setup();
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const old = new Database(join(dataDir, 'specmill.db'));
    try { old.exec('DROP TABLE restore_receipts; ALTER TABLE failure_dispositions DROP COLUMN target_id; DROP INDEX target_confirmation_order; ALTER TABLE acceptance_targets DROP COLUMN confirmation_order; CREATE INDEX target_confirmation_order ON acceptance_targets(change_id); PRAGMA user_version = 16'); } finally { old.close(); }
    await expect(buildApp({ dataDir, port: 43220, ownerToken: 'owner-token', agentToken: testAgentToken })).rejects.toThrow();
    const db = new Database(join(dataDir, 'specmill.db'));
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(16);
      expect((db.pragma('table_info(acceptance_targets)') as { name: string }[]).some(column => column.name === 'confirmation_order')).toBe(false);
    } finally { db.close(); }
    expect((await readdir(join(dataDir, 'backups'))).some(name => name.startsWith('before-schema-17-'))).toBe(true);
  }, 30000);
  it('preserves accepted historical decisions when v16 target order is ambiguous', async () => {
    const { app, dataDir, workspaceId, changeId, ownerHeaders, headSha, specContent } = await setup();
    const baselineId = await freeze(app, changeId, workspaceId, ownerHeaders, 1, specContent);
    const criteria = (await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${baselineId}`, headers: ownerHeaders })).json().criteria as { id: string }[];
    const targets: string[] = [];
    for (let index = 0; index < 2; index++) {
      const target = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets`, headers: ownerHeaders, payload: { requestId: `accepted-legacy-target-${index}`, payload: { commit: headSha } } });
      expect(target.statusCode).toBe(201); targets.push(target.json().resourceId);
    }
    expect((await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-proposals`, headers: ownerHeaders, payload: { requestId: 'accepted-legacy-proposal', expectedVersion: 2, payload: { reason: '审阅', targetId: targets[0] } } })).statusCode).toBe(201);
    for (const [index, id] of targets.entries()) expect((await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets/${id}/confirm`, headers: ownerHeaders, payload: { requestId: `accepted-legacy-confirm-${index}` } })).statusCode).toBe(200);
    let version = 3;
    for (const [index, criterion] of criteria.entries()) {
      const waiver = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/waive`, headers: ownerHeaders, payload: { requestId: `accepted-legacy-waive-${index}`, expectedVersion: version, payload: { criterionId: criterion.id, reason: '接受历史风险', failureEvidenceIds: [] } } });
      expect(waiver.statusCode).toBe(200); version = waiver.json().recordVersion;
    }
    const preview = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: ownerHeaders, payload: { requestId: 'accepted-legacy-preview', payload: { selections: [] } } });
    expect(preview.statusCode).toBe(201);
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/confirm`, headers: ownerHeaders, payload: { requestId: 'accepted-legacy-final', payload: { previewId: preview.json().resourceId, complete: true } } });
    expect(accepted.statusCode).toBe(200);
    const before = (await app.inject({ url: `/api/v1/changes/${changeId}/review`, headers: ownerHeaders })).json();
    expect(before.accepted).toBe(true);
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const old = new Database(join(dataDir, 'specmill.db'));
    try { old.exec('DROP TABLE restore_receipts; ALTER TABLE failure_dispositions DROP COLUMN target_id; DROP INDEX target_confirmation_order; ALTER TABLE acceptance_targets DROP COLUMN confirmation_order; PRAGMA user_version = 16'); } finally { old.close(); }
    const restarted = await buildApp({ dataDir, port: 43220, ownerToken: 'owner-token', agentToken: testAgentToken }); apps.push(restarted);
    const login = await restarted.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
    const owner = { ...headers, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const after = (await restarted.inject({ url: `/api/v1/changes/${changeId}/review`, headers: owner })).json();
    expect(after.accepted).toBe(true);
    expect(after.context.target).toBeNull();
    expect(after.context.targetOrderUncertain).toBe(true);
    expect(after.criteria.map((item: { decision: unknown }) => item.decision)).toEqual(before.criteria.map((item: { decision: unknown }) => item.decision));
    const acceptedReceipt = accepted.json();
    expect((await restarted.inject({ url: '/api/v1/receipts/accepted-legacy-final', headers: owner })).json()).toEqual({ requestId: acceptedReceipt.requestId, resourceId: acceptedReceipt.resourceId, recordVersion: acceptedReceipt.recordVersion, committedAt: acceptedReceipt.committedAt });
  }, 30000);
  it('rejects ambiguous historical receipt identifiers instead of returning the wrong operation', async () => {
    const { app, dataDir, projectId, ownerHeaders } = await setup();
    const uploaded = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=old-attachment&filename=log.txt`, headers: { ...ownerHeaders, 'content-type': 'application/octet-stream' }, payload: Buffer.from('legacy collision') });
    expect(uploaded.statusCode).toBe(201);
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const db = new Database(join(dataDir, 'specmill.db'));
    try { db.prepare('UPDATE attachment_requests SET request_id = ? WHERE request_id = ?').run('review-project', 'old-attachment'); } finally { db.close(); }
    const restarted = await buildApp({ dataDir, port: 43220, ownerToken: 'owner-token', agentToken: testAgentToken }); apps.push(restarted);
    const response = await restarted.inject({ url: '/api/v1/receipts/review-project', headers: agentHeaders });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('REQUEST_ID_CONFLICT');
    expect(response.json()).not.toHaveProperty('resourceId');
    const ordinary = await restarted.inject({ url: '/api/v1/receipts/review-change', headers: agentHeaders });
    expect(ordinary.statusCode).toBe(200);
  }, 30000);
  it('finds durable receipts for evidence and review commands after restart', async () => {
    const { app, dataDir, projectId, workspaceId, changeId, ownerHeaders, headSha, specContent } = await setup();
    const baselineId = await freeze(app, changeId, workspaceId, ownerHeaders, 1, specContent);
    const criteria = (await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${baselineId}`, headers: ownerHeaders })).json().criteria as { id: string }[];
    const attachment = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=lookup-attachment&filename=log.txt`, headers: { ...ownerHeaders, 'content-type': 'application/octet-stream' }, payload: Buffer.from('receipt evidence') });
    expect(attachment.statusCode).toBe(201);
    const run = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/executions`, headers: ownerHeaders, payload: { requestId: 'lookup-run', workspaceId, payload: { method: 'check', result: 'passed', claimedCommit: headSha, claimedClean: true } } });
    expect(run.statusCode).toBe(201);
    const evidence = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/evidence`, headers: ownerHeaders, payload: { requestId: 'lookup-evidence', payload: { executionId: run.json().resourceId, criterion: { kind: 'baseline', baselineId, criterionId: criteria[0].id }, criterionIndex: 1, result: 'passed', actualCommit: headSha, attachmentIds: [attachment.json().resourceId] } } });
    expect(evidence.statusCode).toBe(201);
    const handoff = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/handoffs`, headers: ownerHeaders, payload: { requestId: 'lookup-handoff' } });
    expect(handoff.statusCode).toBe(201);
    const target = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets`, headers: ownerHeaders, payload: { requestId: 'lookup-target', payload: { commit: headSha } } });
    expect(target.statusCode).toBe(201);
    const proposal = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-proposals`, headers: ownerHeaders, payload: { requestId: 'lookup-proposal', expectedVersion: 2, payload: { reason: '审阅', targetId: target.json().resourceId } } });
    expect(proposal.statusCode).toBe(201);
    const confirmation = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets/${target.json().resourceId}/confirm`, headers: ownerHeaders, payload: { requestId: 'lookup-target-confirm', expectedBindingVersion: 1 } });
    expect(confirmation.statusCode).toBe(200);
    const preview = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: ownerHeaders, payload: { requestId: 'lookup-preview', payload: { selections: [{ criterionId: criteria[0].id, mode: 'new', evidenceIds: [evidence.json().resourceId] }] } } });
    expect(preview.statusCode).toBe(201);
    const decision = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/confirm`, headers: ownerHeaders, payload: { requestId: 'lookup-decision', payload: { previewId: preview.json().resourceId, complete: false } } });
    expect(decision.statusCode).toBe(200);
    const expected = [attachment, run, evidence, handoff, target, proposal, preview, decision].map(response => response.json() as { requestId: string; resourceId: string; recordVersion: number; committedAt: string });
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const restarted = await buildApp({ dataDir, port: 43220, ownerToken: 'owner-token', agentToken: testAgentToken }); apps.push(restarted);
    for (const receipt of expected) {
      const found = await restarted.inject({ url: `/api/v1/receipts/${receipt.requestId}`, headers: agentHeaders });
      expect(found.statusCode).toBe(200);
      expect(found.json()).toEqual({ requestId: receipt.requestId, resourceId: receipt.resourceId, recordVersion: receipt.recordVersion, committedAt: receipt.committedAt });
    }
    const foundConfirmation = await restarted.inject({ url: '/api/v1/receipts/lookup-target-confirm', headers: agentHeaders });
    expect(foundConfirmation.statusCode).toBe(200);
    expect(foundConfirmation.json()).toEqual(confirmation.json());
    const relogin = await restarted.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
    const newOwnerHeaders = { ...headers, cookie: relogin.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const replay = await restarted.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets/${target.json().resourceId}/confirm`, headers: newOwnerHeaders, payload: { requestId: 'lookup-target-confirm', expectedBindingVersion: 1 } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(confirmation.json());
    expect((await restarted.inject({ url: '/api/v1/receipts/lookup-unknown', headers: agentHeaders })).statusCode).toBe(404);
  }, 30000);
  it('rolls back target confirmation and continuing implementation when project capacity is full', async () => {
    const { app, dataDir, projectId, workspaceId, changeId, ownerHeaders, headSha, specContent } = await setup();
    await freeze(app, changeId, workspaceId, ownerHeaders, 1, specContent);
    const target = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets`, headers: ownerHeaders,
      payload: { requestId: 'budget-target', payload: { commit: headSha } } });
    expect(target.statusCode).toBe(201);
    const targetId = target.json().resourceId as string;
    const proposal = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-proposals`, headers: ownerHeaders,
      payload: { requestId: 'budget-proposal', expectedVersion: 2, payload: { reason: '准备审阅', targetId } } });
    expect(proposal.statusCode).toBe(201);
    const used = (await app.inject({ url: `/api/v1/projects/${projectId}/capacity`, headers: ownerHeaders })).json().records.used as number;
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const limited = await buildApp({ dataDir, port: 43220, ownerToken: 'owner-token', agentToken: testAgentToken, maxProjectRecordsBytes: used }); apps.push(limited);
    await limited.listen({ host: '127.0.0.1', port: 43220 });
    const login = await limited.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
    const owner = { ...headers, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const confirm = () => limited.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets/${targetId}/confirm`, headers: owner, payload: { requestId: 'budget-confirm' } });
    const resume = () => limited.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/continue`, headers: owner, payload: { requestId: 'budget-continue', expectedVersion: 3 } });
    expect((await confirm()).statusCode).toBe(413);
    expect((await confirm()).statusCode).toBe(413);
    expect((await resume()).statusCode).toBe(413);
    expect((await resume()).statusCode).toBe(413);
    const change = (await limited.inject({ url: `/api/v1/changes/${changeId}`, headers: owner })).json();
    expect(change.phase).toBe('Reviewing');
    expect(change.version).toBe(3);
    const targets = (await limited.inject({ url: `/api/v1/changes/${changeId}/acceptance-targets`, headers: owner })).json().targets as { id: string; status: string }[];
    expect(targets.find(item => item.id === targetId)?.status).toBe('proposed');
  }, 30000);
  it('does not accept historical formal evidence whose condition ID and number disagree', async () => {
    const { app, dataDir, workspaceId, changeId, ownerHeaders, headSha, specContent } = await setup();
    const baselineId = await freeze(app, changeId, workspaceId, ownerHeaders, 1, specContent);
    const criteria = (await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${baselineId}`, headers: ownerHeaders })).json().criteria as { id: string }[];
    const evidenceId = await formalEvidence(app, changeId, workspaceId, ownerHeaders, 'legacy-index', 1, criteria[0].id, baselineId, headSha);
    const target = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets`, headers: ownerHeaders, payload: { requestId: 'legacy-target', payload: { commit: headSha } } });
    const proposal = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-proposals`, headers: ownerHeaders, payload: { requestId: 'legacy-proposal', expectedVersion: 2, payload: { reason: '审阅', targetId: target.json().resourceId } } });
    expect(proposal.statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets/${target.json().resourceId}/confirm`, headers: ownerHeaders, payload: { requestId: 'legacy-target-confirm' } })).statusCode).toBe(200);
    const priorPreview = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: ownerHeaders,
      payload: { requestId: 'legacy-prior-preview', payload: { selections: [{ criterionId: criteria[0].id, mode: 'new', evidenceIds: [evidenceId] }] } } });
    expect(priorPreview.statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/confirm`, headers: ownerHeaders,
      payload: { requestId: 'legacy-prior-confirm', payload: { previewId: priorPreview.json().resourceId, complete: false } } })).statusCode).toBe(200);
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const legacyDb = new Database(join(dataDir, 'specmill.db'));
    try { legacyDb.prepare('UPDATE evidence_records SET criterion_index = 2 WHERE id = ?').run(evidenceId); } finally { legacyDb.close(); }
    const restarted = await buildApp({ dataDir, port: 43220, ownerToken: 'owner-token', agentToken: testAgentToken }); apps.push(restarted);
    await restarted.listen({ host: '127.0.0.1', port: 43220 });
    const login = await restarted.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
    const restartedOwner = { ...headers, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const rows = (await restarted.inject({ url: `/api/v1/changes/${changeId}/evidence`, headers: restartedOwner })).json().evidence as { id: string; formalEffective: boolean }[];
    expect(rows.find(row => row.id === evidenceId)?.formalEffective).toBe(false);
    const review = (await restarted.inject({ url: `/api/v1/changes/${changeId}/review`, headers: restartedOwner })).json() as { criteria: { decision: { valid: boolean } | null }[] };
    expect(review.criteria[0].decision?.valid).toBe(false);
    const preview = await restarted.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: restartedOwner,
      payload: { requestId: 'legacy-preview', payload: { selections: [{ criterionId: criteria[0].id, mode: 'new', evidenceIds: [evidenceId] }] } } });
    expect(preview.statusCode).toBe(409);
    expect(preview.json().code).toBe('EVIDENCE_NOT_QUALIFIED');
    const emptyPreview = await restarted.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: restartedOwner,
      payload: { requestId: 'legacy-empty-preview', payload: { selections: [] } } });
    expect(emptyPreview.statusCode).toBe(201);
    const final = await restarted.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/confirm`, headers: restartedOwner,
      payload: { requestId: 'legacy-final', payload: { previewId: emptyPreview.json().resourceId, complete: true } } });
    expect(final.statusCode).toBe(409);
    expect(final.json().code).toBe('EVIDENCE_NOT_QUALIFIED');
  }, 60000);
  it('does not let a waiver for a missing-evidence gap silently cover a later failure', async () => {
    const { app, dataDir, workspaceId, changeId, ownerHeaders, headSha, specContent } = await setup();
    const baselineId = await freeze(app, changeId, workspaceId, ownerHeaders, 1, specContent);
    const sessionResponse = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/writer-sessions`, headers: { ...agentHeaders, 'x-specmill-writer-token': 'a'.repeat(64) }, payload: { requestId: 'gap-session', expectedVersion: 2, payload: { workspaceId, expectedBindingVersion: 1, toolLabel: '审阅工具' } } });
    expect(sessionResponse.statusCode).toBe(201);
    const session = sessionResponse.json() as { resourceId: string; generation: number };
    const criteria = (await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${baselineId}`, headers: ownerHeaders })).json().criteria as { id: string }[];
    const target = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets`, headers: ownerHeaders,
      payload: { requestId: 'gap-target', payload: { commit: headSha } } });
    const targetId = target.json().resourceId as string;
    const proposal = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-proposals`, headers: ownerHeaders,
      payload: { requestId: 'gap-proposal', expectedVersion: 3, payload: { reason: '审阅缺口', targetId } } });
    expect(proposal.statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets/${targetId}/confirm`, headers: ownerHeaders, payload: { requestId: 'gap-target-confirm' } })).statusCode).toBe(200);
    const waiver = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/waive`, headers: ownerHeaders,
      payload: { requestId: 'gap-waiver', expectedVersion: 4, payload: { criterionId: criteria[1].id, reason: '接受当前缺少外部检查的风险', failureEvidenceIds: [] } } });
    expect(waiver.statusCode).toBe(200);
    const run = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/executions`, headers: ownerHeaders,
      payload: { requestId: 'gap-failed-run', workspaceId, payload: { method: '后续检查', result: 'failed', claimedCommit: headSha, claimedClean: true } } });
    expect(run.statusCode).toBe(201);
    const failure = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/evidence`, headers: ownerHeaders,
      payload: { requestId: 'gap-failed-evidence', payload: { executionId: run.json().resourceId, criterion: { kind: 'baseline', baselineId, criterionId: criteria[1].id }, criterionIndex: 2, result: 'failed', actualCommit: headSha } } });
    expect(failure.statusCode).toBe(201);
    const review = (await app.inject({ url: `/api/v1/changes/${changeId}/review`, headers: ownerHeaders })).json() as { criteria: { blockingFailures: { id: string }[] }[] };
    expect(review.criteria[1].blockingFailures.map(item => item.id)).toContain(failure.json().resourceId);
    const wrongFailure = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/waive`, headers: ownerHeaders,
      payload: { requestId: 'gap-wrong-failure', expectedVersion: waiver.json().recordVersion, payload: { criterionId: criteria[0].id, reason: '测试错误关联', failureEvidenceIds: [failure.json().resourceId] } } });
    expect(wrongFailure.statusCode).toBe(404);
    const otherWaiver = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/waive`, headers: ownerHeaders,
      payload: { requestId: 'gap-other-waiver', expectedVersion: waiver.json().recordVersion, payload: { criterionId: criteria[0].id, reason: '接受另一项缺口', failureEvidenceIds: [] } } });
    expect(otherWaiver.statusCode).toBe(200);
    const preview = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: ownerHeaders, payload: { requestId: 'gap-preview', payload: { selections: [] } } });
    expect(preview.statusCode).toBe(201);
    const final = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/confirm`, headers: ownerHeaders, payload: { requestId: 'gap-final', payload: { previewId: preview.json().resourceId, complete: true } } });
    expect(final.statusCode).toBe(409);
    expect(final.json().code).toBe('GATE_INCOMPLETE');
    const explicitWaiver = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/waive`, headers: ownerHeaders,
      payload: { requestId: 'gap-explicit-waiver', expectedVersion: otherWaiver.json().recordVersion, payload: { criterionId: criteria[1].id, reason: '接受已明确列出的失败风险', failureEvidenceIds: [failure.json().resourceId] } } });
    expect(explicitWaiver.statusCode).toBe(200);
    const inOriginalContext = (await app.inject({ url: `/api/v1/changes/${changeId}/review`, headers: ownerHeaders })).json();
    expect(inOriginalContext.criteria[1].blockingFailures).toHaveLength(0);
    expect(inOriginalContext.snapshot).toEqual(expect.objectContaining({ targetId }));
    const newTarget = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets`, headers: ownerHeaders, payload: { requestId: 'gap-new-target', payload: { commit: headSha } } });
    expect(newTarget.statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets/${newTarget.json().resourceId}/confirm`, headers: ownerHeaders, payload: { requestId: 'gap-new-target-confirm' } })).statusCode).toBe(200);
    const inNewContext = (await app.inject({ url: `/api/v1/changes/${changeId}/review`, headers: ownerHeaders })).json();
    expect(inNewContext.context.target.id).toBe(newTarget.json().resourceId);
    expect(inNewContext.criteria[1].blockingFailures.map((item: { id: string }) => item.id)).toContain(failure.json().resourceId);
    const staleContextPreview = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: ownerHeaders, payload: { requestId: 'gap-stale-context-preview', expectedSnapshot: inOriginalContext.snapshot, payload: { selections: [] } } });
    expect(staleContextPreview.statusCode).toBe(409);
    expect(staleContextPreview.json().code).toBe('REVIEW_CHANGED');
    const currentContextPreview = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: ownerHeaders, payload: { requestId: 'gap-current-context-preview', expectedSnapshot: inNewContext.snapshot, payload: { selections: [] } } });
    expect(currentContextPreview.statusCode).toBe(201);
    const changedEvidence = await formalEvidence(app, changeId, workspaceId, ownerHeaders, 'gap-new-evidence', 1, criteria[0].id, baselineId, headSha);
    expect(changedEvidence).toBeTruthy();
    const staleEvidencePreview = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: ownerHeaders, payload: { requestId: 'gap-stale-evidence-preview', expectedSnapshot: inNewContext.snapshot, payload: { selections: [] } } });
    expect(staleEvidencePreview.statusCode).toBe(409);
    expect(staleEvidencePreview.json().code).toBe('REVIEW_CHANGED');
    const reviewFile = join(dataDir, 'review-test.json');
    const selectionFile = join(dataDir, 'review-selection-test.json');
    await writeFile(join(dataDir, 'cli-token'), await encodeSecret(testAgentToken));
    const grantFile = join(dataDir, 'gap-grant');
    await writeFile(grantFile, await encodeSecret(JSON.stringify({ sessionId: session.resourceId, generation: session.generation, writerToken: 'a'.repeat(64) })));
    await writeFile(reviewFile, JSON.stringify(inNewContext));
    await writeFile(selectionFile, '[]');
    const cliArgs = ['--import', 'tsx', resolve('src/cli/main.ts'), 'review', 'preview', '--change', changeId, '--grant-file', grantFile, '--file', selectionFile, '--review-file', reviewFile, '--request-id', 'gap-cli-snapshot', '--data-dir', dataDir, '--server', 'http://127.0.0.1:43220', '--json'];
    const runCli = promisify(execFile);
    await expect(runCli(process.execPath, cliArgs, { timeout: 20000 })).rejects.toMatchObject({ code: 3, stderr: expect.stringContaining('REVIEW_CHANGED') });
    await writeFile(reviewFile, JSON.stringify((await app.inject({ url: `/api/v1/changes/${changeId}/review`, headers: ownerHeaders })).json()));
    const cliPreview = JSON.parse((await runCli(process.execPath, cliArgs, { timeout: 20000 })).stdout);
    expect(cliPreview.requestId).toBe('gap-cli-snapshot');
    expect(cliPreview.resourceId).toBeTruthy();
    const change = (await app.inject({ url: `/api/v1/changes/${changeId}`, headers: ownerHeaders })).json() as { version: number };
    const agent = { ...agentHeaders, 'x-specmill-writer-token': 'a'.repeat(64) };
    const body = { requestId: 'gap-agent-disposition', writerSessionId: session.resourceId, generation: session.generation, expectedVersion: change.version, payload: { rows: [{ criterionId: criteria[1].id, failureEvidenceId: failure.json().resourceId, outcome: 'not_applicable', reason: '核对上下文' }] } };
    const disposition = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/failure-dispositions/preview`, headers: agent, payload: body });
    expect(disposition.statusCode).toBe(201);
    const upload = await app.inject({ method: 'POST', url: `/api/v1/projects/${(await app.inject({ url: `/api/v1/changes/${changeId}`, headers: ownerHeaders })).json().projectId}/attachments?requestId=gap-race-attachment&filename=log.txt`, headers: { ...ownerHeaders, 'content-type': 'application/octet-stream' }, payload: Buffer.from('preview race') });
    expect(upload.statusCode).toBe(201);
    const passing = await formalEvidence(app, changeId, workspaceId, ownerHeaders, 'gap-race', 1, criteria[0].id, baselineId, headSha, [upload.json().resourceId]);
    let releaseCheck = () => {}; let reportCheck = () => {};
    const gate = new Promise<void>(resolve => { releaseCheck = resolve; });
    const started = new Promise<void>(resolve => { reportCheck = resolve; });
    const actual = attachmentStorage.checkAttachmentHealth;
    const spy = vi.spyOn(attachmentStorage, 'checkAttachmentHealth').mockImplementationOnce(async (...args) => { reportCheck(); await gate; return actual(...args); });
    let release: Awaited<ReturnType<typeof app.inject>>;
    try {
      const pending = app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: agent, payload: { requestId: 'gap-race-preview', writerSessionId: session.resourceId, generation: session.generation, payload: { selections: [{ criterionId: criteria[0].id, mode: 'new', evidenceIds: [passing] }] } } }).then(response => response);
      await started;
      release = await app.inject({ method: 'POST', url: `/api/v1/writer-sessions/${session.resourceId}/release`, headers: agent, payload: { requestId: 'gap-release', expectedVersion: change.version, generation: session.generation } });
      expect(release.statusCode).toBe(200);
      releaseCheck();
      expect((await pending).json().code).toBe('SESSION_EXPIRED');
    } finally { releaseCheck(); spy.mockRestore(); }
    expect((await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/failure-dispositions/preview`, headers: agent, payload: body })).json().code).toBe('SESSION_EXPIRED');
    await expect(runCli(process.execPath, cliArgs, { timeout: 20000 })).rejects.toMatchObject({ code: 3, stderr: expect.stringContaining('SESSION_EXPIRED') });
    const renewed = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/writer-sessions`, headers: agent, payload: { requestId: 'gap-renew', expectedVersion: release.json().recordVersion, payload: { workspaceId, expectedBindingVersion: 1, toolLabel: '新的审阅工具' } } });
    expect(renewed.statusCode).toBe(201);
    const newSession = renewed.json();
    const newPreview = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/failure-dispositions/preview`, headers: agent, payload: { ...body, requestId: 'gap-new-session-disposition', writerSessionId: newSession.resourceId, generation: newSession.generation, expectedVersion: newSession.recordVersion } });
    expect(newPreview.statusCode).toBe(201);
    const takeover = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/writer-sessions/takeover`, headers: ownerHeaders, payload: { requestId: 'gap-review-takeover', expectedVersion: newSession.recordVersion, payload: { writerSessionId: newSession.resourceId, expectedGeneration: newSession.generation, expectedCheckpointId: null, toolLabel: '用户审阅接管' } } });
    expect(takeover.statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/failure-dispositions/preview`, headers: agent, payload: { ...body, requestId: 'gap-new-session-disposition', writerSessionId: newSession.resourceId, generation: newSession.generation, expectedVersion: newSession.recordVersion } })).json().code).toBe('SESSION_EXPIRED');
  }, 60000);
  it('previews, confirms per criterion, rejects stale previews and completes the final acceptance', async () => {
    const { app, dataDir, projectId, workspaceId, changeId, ownerHeaders, headSha, specContent } = await setup();
    const baselineId = await freeze(app, changeId, workspaceId, ownerHeaders, 1, specContent);
    const criteria = (await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${baselineId}`, headers: ownerHeaders })).json().criteria as { id: string }[];
    const attachmentContent = Buffer.from('test evidence');
    const attachment = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=review-att&filename=log.txt`, headers: { ...ownerHeaders, 'content-type': 'application/octet-stream' }, payload: attachmentContent });
    expect(attachment.statusCode).toBe(201);
    const attachmentPath = join(dataDir, 'attachments', projectId, createHash('sha256').update(attachmentContent).digest('hex'));
    const evidence1 = await formalEvidence(app, changeId, workspaceId, ownerHeaders, 'rev-e1', 1, criteria[0].id, baselineId, headSha, [attachment.json().resourceId]);
    const evidence2 = await formalEvidence(app, changeId, workspaceId, ownerHeaders, 'rev-e2', 2, criteria[1].id, baselineId, headSha, [attachment.json().resourceId]);
    const target = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets`, headers: ownerHeaders,
      payload: { requestId: 'rev-target', payload: { commit: headSha } } });
    const targetId = target.json().resourceId as string;
    const proposal = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-proposals`, headers: ownerHeaders,
      payload: { requestId: 'rev-proposal', expectedVersion: 2, payload: { reason: '证据就绪', targetId } } });
    expect(proposal.statusCode).toBe(201);
    await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets/${targetId}/confirm`, headers: ownerHeaders, payload: { requestId: 'rev-confirm-target' } });
    // 未确认目标前预览被拒：先用一个未确认目标的场景验证 TARGET_REQUIRED
    // agent 可以生成预览；确认只能由用户完成
    const preview = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: ownerHeaders,
      payload: { requestId: 'rev-preview-1', payload: { selections: [
        { criterionId: criteria[0].id, mode: 'new', evidenceIds: [evidence1] },
        { criterionId: criteria[1].id, mode: 'new', evidenceIds: [evidence2] },
      ] } } });
    expect(preview.statusCode).toBe(201);
    const previewId = preview.json().resourceId as string;
    // 预览之后新增证据：整批拒绝，无半批结果
    await formalEvidence(app, changeId, workspaceId, ownerHeaders, 'rev-e3', 1, criteria[0].id, baselineId, headSha);
    const stale = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/confirm`, headers: ownerHeaders,
      payload: { requestId: 'rev-confirm-stale', payload: { previewId, complete: false } } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('PREVIEW_STALE');
    const decisionsAfterStale = (await app.inject({ url: `/api/v1/changes/${changeId}/review`, headers: ownerHeaders })).json().criteria as { decision: unknown }[];
    expect(decisionsAfterStale.every(item => item.decision === null)).toBe(true);
    // 重新预览并分批确认（不含最终验收）
    const preview2 = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: ownerHeaders,
      payload: { requestId: 'rev-preview-2', payload: { selections: [
        { criterionId: criteria[0].id, mode: 'new', evidenceIds: [evidence1] },
      ] } } });
    expect(preview2.statusCode).toBe(201);
    const agentConfirm = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/confirm`, headers: agentHeaders,
      payload: { requestId: 'rev-confirm-agent', payload: { previewId: preview2.json().resourceId, complete: false } } });
    expect(agentConfirm.statusCode).toBe(403);
    await rm(attachmentPath);
    const missingAttachment = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/confirm`, headers: ownerHeaders,
      payload: { requestId: 'rev-confirm-missing', payload: { previewId: preview2.json().resourceId, complete: false } } });
    expect(missingAttachment.statusCode).toBe(409);
    await writeFile(attachmentPath, attachmentContent);
    const confirmed = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/confirm`, headers: ownerHeaders,
      payload: { requestId: 'rev-confirm', payload: { previewId: preview2.json().resourceId, complete: false } } });
    expect(confirmed.statusCode).toBe(200);
    const conflictingReplay = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/confirm`, headers: ownerHeaders,
      payload: { requestId: 'rev-confirm', payload: { previewId: preview2.json().resourceId, complete: true } } });
    expect(conflictingReplay.statusCode).toBe(409);
    expect(conflictingReplay.json().code).toBe('REQUEST_ID_CONFLICT');
    const conflictingAction = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: ownerHeaders,
      payload: { requestId: 'rev-confirm', payload: { selections: [] } } });
    expect(conflictingAction.statusCode).toBe(409);
    expect(conflictingAction.json().code).toBe('REQUEST_ID_CONFLICT');
    let releaseReviewRead = () => {};
    let reportReviewRead = () => {};
    const readGate = new Promise<void>(resolveGate => { releaseReviewRead = resolveGate; });
    const readStarted = new Promise<void>(resolveStarted => { reportReviewRead = resolveStarted; });
    const actualHealthCheck = attachmentStorage.checkAttachmentHealth;
    const delayedRead = vi.spyOn(attachmentStorage, 'checkAttachmentHealth').mockImplementationOnce(async (...args) => { reportReviewRead(); await readGate; return actualHealthCheck(...args); });
    try {
      const pending = app.inject({ url: `/api/v1/changes/${changeId}/review`, headers: ownerHeaders }).then(response => response);
      await readStarted;
      await formalEvidence(app, changeId, workspaceId, ownerHeaders, 'rev-during-read', 1, criteria[0].id, baselineId, headSha);
      releaseReviewRead();
      const raced = await pending;
      expect(raced.statusCode).toBe(409);
      expect(raced.json().code).toBe('REVIEW_CHANGED');
    } finally { releaseReviewRead(); delayedRead.mockRestore(); }
    const previewSnapshot = (await app.inject({ url: `/api/v1/changes/${changeId}/review`, headers: ownerHeaders })).json().snapshot;
    let releasePreviewCheck = () => {};
    let reportPreviewCheck = () => {};
    const previewCheckGate = new Promise<void>(resolveGate => { releasePreviewCheck = resolveGate; });
    const previewCheckStarted = new Promise<void>(resolveStarted => { reportPreviewCheck = resolveStarted; });
    const delayedPreview = vi.spyOn(attachmentStorage, 'checkAttachmentHealth').mockImplementationOnce(async (...args) => { reportPreviewCheck(); await previewCheckGate; return actualHealthCheck(...args); });
    try {
      const pending = app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: ownerHeaders, payload: { requestId: 'rev-during-preview', expectedSnapshot: previewSnapshot, payload: { selections: [{ criterionId: criteria[0].id, mode: 'new', evidenceIds: [evidence1] }] } } }).then(response => response);
      await previewCheckStarted;
      await formalEvidence(app, changeId, workspaceId, ownerHeaders, 'rev-during-preview-evidence', 1, criteria[0].id, baselineId, headSha);
      releasePreviewCheck();
      const raced = await pending;
      expect(raced.statusCode).toBe(409);
      expect(raced.json().code).toBe('REVIEW_CHANGED');
    } finally { releasePreviewCheck(); delayedPreview.mockRestore(); }
    const healthCheck = vi.spyOn(attachmentStorage, 'checkAttachmentHealth');
    try {
      const current = (await app.inject({ url: `/api/v1/changes/${changeId}/review`, headers: ownerHeaders })).json();
      expect(current.criteria[0].decision.valid).toBe(true);
      expect(healthCheck).toHaveBeenCalledTimes(1);
      await writeFile(attachmentPath, 'corrupted evidence');
      const changed = (await app.inject({ url: `/api/v1/changes/${changeId}/review`, headers: ownerHeaders })).json();
      expect(changed.criteria[0].decision.valid).toBe(false);
      expect(healthCheck).toHaveBeenCalledTimes(2);
    } finally { healthCheck.mockRestore(); await writeFile(attachmentPath, attachmentContent); }
    const review1 = (await app.inject({ url: `/api/v1/changes/${changeId}/review`, headers: ownerHeaders })).json() as { criteria: { decision: { result: string } | null }[] };
    expect(review1.criteria[0].decision?.result).toBe('passed');
    expect(review1.criteria[1].decision).toBeNull();
    // 未选择完整集合时不能最终验收
    const partialPreview = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: ownerHeaders,
      payload: { requestId: 'rev-preview-3', payload: { selections: [{ criterionId: criteria[0].id, mode: 'new', evidenceIds: [evidence1] }] } } });
    expect(partialPreview.statusCode).toBe(201);
    const incomplete = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/confirm`, headers: ownerHeaders,
      payload: { requestId: 'rev-confirm-incomplete', payload: { previewId: partialPreview.json().resourceId, complete: true } } });
    expect(incomplete.statusCode).toBe(409);
    expect(incomplete.json().code).toBe('GATE_INCOMPLETE');
    const afterIncomplete = (await app.inject({ url: `/api/v1/changes/${changeId}/review`, headers: ownerHeaders })).json() as { criteria: { decision: { result: string } | null }[] };
    expect(afterIncomplete.criteria).toEqual(review1.criteria);
    expect((await app.inject({ url: '/api/v1/receipts/rev-confirm-incomplete', headers: ownerHeaders })).statusCode).toBe(404);
    const retryIncomplete = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/confirm`, headers: ownerHeaders,
      payload: { requestId: 'rev-confirm-incomplete', payload: { previewId: partialPreview.json().resourceId, complete: true } } });
    expect(retryIncomplete.statusCode).toBe(409);
    // 最终验收：全部条件 + 无未处置失败
    const finalSnapshot = (await app.inject({ url: `/api/v1/changes/${changeId}/review`, headers: ownerHeaders })).json().snapshot as Record<string, unknown>;
    const finalPreview = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: ownerHeaders,
      payload: { requestId: 'rev-preview-4', expectedSnapshot: finalSnapshot, payload: { selections: [{ criterionId: criteria[1].id, mode: 'new', evidenceIds: [evidence2] }] } } });
    expect(finalPreview.statusCode).toBe(201);
    const previewReplay = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: ownerHeaders,
      payload: { requestId: 'rev-preview-4', expectedSnapshot: Object.fromEntries(Object.entries(finalSnapshot).reverse()), payload: { selections: [{ criterionId: criteria[1].id, mode: 'new', evidenceIds: [evidence2] }] } } });
    expect(previewReplay.statusCode).toBe(201);
    expect(previewReplay.json().resourceId).toBe(finalPreview.json().resourceId);
    await rm(attachmentPath);
    const missingPrior = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/confirm`, headers: ownerHeaders,
      payload: { requestId: 'rev-confirm-missing-prior', payload: { previewId: finalPreview.json().resourceId, complete: true } } });
    expect(missingPrior.statusCode).toBe(409);
    await writeFile(attachmentPath, attachmentContent);
    const complete = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/confirm`, headers: ownerHeaders,
      payload: { requestId: 'rev-confirm-final', payload: { previewId: finalPreview.json().resourceId, complete: true } } });
    expect(complete.statusCode).toBe(200);
    const changeRow = (await app.inject({ url: `/api/v1/changes/${changeId}`, headers: ownerHeaders })).json() as { phase: string; activeSession: { status: string } | null };
    expect(changeRow.phase).toBe('Accepted');
    expect(changeRow.activeSession).toBeNull();
    // 已验收记录及其证据、附件和决定可在独立实例完整恢复。
    const exportStart = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/exports`, headers: ownerHeaders, payload: { requestId: 'review-export' } });
    expect(exportStart.statusCode).toBe(201);
    const exportId = exportStart.json().resourceId as string;
    expect((await app.inject({ url: `/api/v1/exports/${exportId}`, headers: ownerHeaders })).json().status).toBe('ready');
    const archive = await app.inject({ url: `/api/v1/exports/${exportId}/download`, headers: ownerHeaders });
    expect(archive.statusCode).toBe(200);
    const restoreDir = await mkdtemp(join(tmpdir(), 'specmill-review-restore-')); dirs.push(restoreDir);
    const restoredApp = await buildApp({ dataDir: restoreDir, port: 43221, ownerToken: 'owner-token', agentToken: testAgentToken }); apps.push(restoredApp);
    await restoredApp.listen({ host: '127.0.0.1', port: 43221 });
    const restoreBase = { host: '127.0.0.1:43221', origin: 'http://127.0.0.1:43221' };
    const login = await restoredApp.inject({ method: 'POST', url: '/api/v1/session', headers: restoreBase, payload: { token: 'owner-token' } });
    const restoreHeaders = { ...restoreBase, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1', 'content-type': 'application/octet-stream' };
    const badEntries = parseZip(archive.rawPayload, () => true);
    const badRecords = JSON.parse(badEntries.get('records.json')!.toString()) as { decisions: { evidence_ids_json: string }[] };
    badRecords.decisions[0].evidence_ids_json = JSON.stringify(['missing-evidence']);
    const badRecordsBytes = Buffer.from(JSON.stringify(badRecords));
    const badManifest = JSON.parse(badEntries.get('manifest.json')!.toString()) as { files: { path: string; sha256: string; size: number }[] };
    const recordFile = badManifest.files.find(file => file.path === 'records.json')!;
    recordFile.sha256 = createHash('sha256').update(badRecordsBytes).digest('hex'); recordFile.size = badRecordsBytes.length;
    badEntries.set('records.json', badRecordsBytes); badEntries.set('manifest.json', Buffer.from(JSON.stringify(badManifest)));
    const rejected = await restoredApp.inject({ method: 'POST', url: '/api/v1/restore?requestId=bad-review-restore', headers: restoreHeaders, payload: buildZip([...badEntries].map(([name, data]) => ({ name, data }))) });
    expect(rejected.statusCode).toBe(400);
    const previewEntries = parseZip(archive.rawPayload, () => true);
    const previewRecords = JSON.parse(previewEntries.get('records.json')!.toString()) as { reviewPreviews: { selections_json: string }[] };
    const selectionPreview = previewRecords.reviewPreviews.find(row => Array.isArray(JSON.parse(row.selections_json)))!;
    const selections = JSON.parse(selectionPreview.selections_json) as { evidenceIds: string[] }[];
    selections[0].evidenceIds = ['missing-evidence'];
    selectionPreview.selections_json = JSON.stringify(selections);
    const previewBytes = Buffer.from(JSON.stringify(previewRecords));
    const previewManifest = JSON.parse(previewEntries.get('manifest.json')!.toString()) as { files: { path: string; sha256: string; size: number }[] };
    const previewFile = previewManifest.files.find(file => file.path === 'records.json')!;
    previewFile.sha256 = createHash('sha256').update(previewBytes).digest('hex'); previewFile.size = previewBytes.length;
    previewEntries.set('records.json', previewBytes); previewEntries.set('manifest.json', Buffer.from(JSON.stringify(previewManifest)));
    const rejectedPreview = await restoredApp.inject({ method: 'POST', url: '/api/v1/restore?requestId=bad-preview-restore', headers: restoreHeaders, payload: buildZip([...previewEntries].map(([name, data]) => ({ name, data }))) });
    expect(rejectedPreview.statusCode).toBe(400);
    const restored = await restoredApp.inject({ method: 'POST', url: '/api/v1/restore?requestId=review-restore', headers: restoreHeaders, payload: archive.rawPayload });
    expect(restored.statusCode).toBe(201);
    const restoredReview = await restoredApp.inject({ url: `/api/v1/changes/${changeId}/review`, headers: restoreHeaders });
    expect(restoredReview.statusCode).toBe(200);
    expect(restoredReview.json().accepted).toBe(true);
    expect(restoredReview.json().criteria.map((item: { decision: { result: string } | null }) => item.decision?.result)).toEqual(['passed', 'passed']);
    const legacyEntries = parseZip(archive.rawPayload, () => true);
    const legacyRecords = JSON.parse(legacyEntries.get('records.json')!.toString()) as { acceptanceTargets: Record<string, unknown>[]; failureDispositions: Record<string, unknown>[] };
    for (const row of legacyRecords.acceptanceTargets) delete row.confirmation_order;
    for (const row of legacyRecords.failureDispositions) delete row.target_id;
    const legacyBytes = Buffer.from(JSON.stringify(legacyRecords));
    const legacyManifest = JSON.parse(legacyEntries.get('manifest.json')!.toString()) as { schemaVersion: number; files: { path: string; sha256: string; size: number }[] };
    legacyManifest.schemaVersion = 16;
    const legacyFile = legacyManifest.files.find(file => file.path === 'records.json')!;
    legacyFile.sha256 = createHash('sha256').update(legacyBytes).digest('hex'); legacyFile.size = legacyBytes.length;
    legacyEntries.set('records.json', legacyBytes); legacyEntries.set('manifest.json', Buffer.from(JSON.stringify(legacyManifest)));
    const legacyDir = await mkdtemp(join(tmpdir(), 'specmill-single-legacy-')); dirs.push(legacyDir);
    const legacyApp = await buildApp({ dataDir: legacyDir, port: 43222, ownerToken: 'owner-token', agentToken: testAgentToken }); apps.push(legacyApp);
    const legacyBase = { host: '127.0.0.1:43222', origin: 'http://127.0.0.1:43222' };
    const legacyLogin = await legacyApp.inject({ method: 'POST', url: '/api/v1/session', headers: legacyBase, payload: { token: 'owner-token' } });
    const legacyOwner = { ...legacyBase, cookie: legacyLogin.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const legacyRestored = await legacyApp.inject({ method: 'POST', url: '/api/v1/restore?requestId=single-legacy-restore', headers: { ...legacyOwner, 'content-type': 'application/octet-stream' }, payload: buildZip([...legacyEntries].map(([name, data]) => ({ name, data }))) });
    expect(legacyRestored.statusCode).toBe(201);
    const legacyReview = (await legacyApp.inject({ url: `/api/v1/changes/${changeId}/review`, headers: legacyOwner })).json();
    expect(legacyReview.accepted).toBe(true);
    expect(legacyReview.context.target.id).toBe(targetId);
    expect(legacyReview.context.targetOrderUncertain).toBe(false);
    // 已接受的变更不再接受写入；可由用户重新打开进入新周期
    const sessions = (await app.inject({ url: `/api/v1/changes/${changeId}/writer-sessions`, headers: agentHeaders })).json().sessions as { status: string }[];
    expect(sessions.every(item => item.status !== 'active')).toBe(true);
    const reopen = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/reopen`, headers: ownerHeaders,
      payload: { requestId: 'rev-reopen', expectedVersion: complete.json().recordVersion, payload: { baselineId, reason: '验收后发现新问题' } } });
    expect(reopen.statusCode).toBe(200);
    const reopened = (await app.inject({ url: `/api/v1/changes/${changeId}`, headers: ownerHeaders })).json() as { phase: string; cycle: number };
    expect(reopened.phase).toBe('Working');
    expect(reopened.cycle).toBe(2);
  }, 60000);

  it('blocks criteria with undisposed failures, supports waivers and evidence reuse with reason', async () => {
    const { app, workspaceId, changeId, ownerHeaders, headSha, specContent } = await setup();
    const baselineId = await freeze(app, changeId, workspaceId, ownerHeaders, 1, specContent);
    const criteria = (await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${baselineId}`, headers: ownerHeaders })).json().criteria as { id: string }[];
    const evidence1 = await formalEvidence(app, changeId, workspaceId, ownerHeaders, 'blk-e1', 1, criteria[0].id, baselineId, headSha);
    // 失败证据挂在条件二上，阻塞其确认
    const failedRun = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/executions`, headers: ownerHeaders,
      payload: { requestId: 'blk-failed-run', workspaceId, payload: { method: 'node --test', result: 'failed', claimedCommit: headSha, claimedClean: true, notes: '条件二的用例失败' } } });
    const failedEvidence = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/evidence`, headers: ownerHeaders,
      payload: { requestId: 'blk-failed-ev', payload: { executionId: failedRun.json().resourceId, criterion: { kind: 'baseline', baselineId, criterionId: criteria[1].id }, criterionIndex: 2, result: 'failed', actualCommit: headSha } } });
    expect(failedEvidence.statusCode).toBe(201);
    const target = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets`, headers: ownerHeaders,
      payload: { requestId: 'blk-target', payload: { commit: headSha } } });
    const targetId = target.json().resourceId as string;
    const proposal = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-proposals`, headers: ownerHeaders,
      payload: { requestId: 'blk-proposal', expectedVersion: 2, payload: { reason: '条件一就绪；条件二有失败', targetId } } });
    expect(proposal.statusCode).toBe(201);
    await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets/${targetId}/confirm`, headers: ownerHeaders, payload: { requestId: 'blk-confirm-target' } });
    // 被失败阻塞的条件不能进入预览
    const blocked = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: ownerHeaders,
      payload: { requestId: 'blk-preview-blocked', payload: { selections: [{ criterionId: criteria[1].id, mode: 'new', evidenceIds: [evidence1] }] } } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('BLOCKED_BY_FAILURE');
    // 条件一可确认（分批）
    const preview1 = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: ownerHeaders,
      payload: { requestId: 'blk-preview-1', payload: { selections: [{ criterionId: criteria[0].id, mode: 'new', evidenceIds: [evidence1] }] } } });
    expect(preview1.statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/confirm`, headers: ownerHeaders,
      payload: { requestId: 'blk-confirm-1', payload: { previewId: preview1.json().resourceId, complete: false } } })).statusCode).toBe(200);
    // 复用历史证据必须说明理由
    const reusePreview = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: ownerHeaders,
      payload: { requestId: 'blk-preview-reuse', payload: { selections: [{ criterionId: criteria[0].id, mode: 'reuse', evidenceIds: [evidence1] }] } } });
    expect(reusePreview.statusCode).toBe(400);
    expect(reusePreview.json().code).toBe('REUSE_REASON_REQUIRED');
    // 风险豁免：agent 不能豁免；用户豁免后条件二解除阻塞
    const agentWaive = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/waive`, headers: agentHeaders,
      payload: { requestId: 'blk-waive-agent', expectedVersion: 4, payload: { criterionId: criteria[1].id, reason: '工具越权' } } });
    expect(agentWaive.statusCode).toBe(403);
    const waiver = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/waive`, headers: ownerHeaders,
      payload: { requestId: 'blk-waive', expectedVersion: 4, payload: { criterionId: criteria[1].id, reason: `接受失败证据 ${failedEvidence.json().resourceId} 的风险：仅影响文档措辞`, failureEvidenceIds: [failedEvidence.json().resourceId] } } });
    expect(waiver.statusCode).toBe(200);
    // 豁免后可生成含条件二的预览并完成最终验收
    const emptyPreview = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: ownerHeaders,
      payload: { requestId: 'blk-preview-2', payload: { selections: [] } } });
    expect(emptyPreview.statusCode).toBe(201);
    const complete = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/confirm`, headers: ownerHeaders,
      payload: { requestId: 'blk-confirm-2', payload: { previewId: emptyPreview.json().resourceId, complete: true } } });
    expect(complete.statusCode).toBe(200);
    expect(((await app.inject({ url: `/api/v1/changes/${changeId}`, headers: ownerHeaders })).json() as { phase: string }).phase).toBe('Accepted');
  }, 60000);

  it('resolves failures through dispositions and reopens after acceptance', async () => {
    const { app, dataDir, projectId, workspaceId, changeId, ownerHeaders, headSha, specContent } = await setup();
    const baselineId = await freeze(app, changeId, workspaceId, ownerHeaders, 1, specContent);
    const criteria = (await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${baselineId}`, headers: ownerHeaders })).json().criteria as { id: string }[];
    const evidence1 = await formalEvidence(app, changeId, workspaceId, ownerHeaders, 'dsp-e1', 1, criteria[0].id, baselineId, headSha);
    const failedRun = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/executions`, headers: ownerHeaders,
      payload: { requestId: 'dsp-failed-run', workspaceId, payload: { method: 'node --test', result: 'failed', claimedCommit: headSha, claimedClean: true } } });
    const failedEvidence = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/evidence`, headers: ownerHeaders,
      payload: { requestId: 'dsp-failed-ev', payload: { executionId: failedRun.json().resourceId, criterion: { kind: 'baseline', baselineId, criterionId: criteria[1].id }, criterionIndex: 2, result: 'failed', actualCommit: headSha } } });
    const target = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets`, headers: ownerHeaders,
      payload: { requestId: 'dsp-target', payload: { commit: headSha } } });
    const targetId = target.json().resourceId as string;
    const proposal = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-proposals`, headers: ownerHeaders,
      payload: { requestId: 'dsp-proposal', expectedVersion: 2, payload: { reason: '条件一就绪；条件二失败待处置', targetId } } });
    expect(proposal.statusCode).toBe(201);
    const confirmedTarget = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets/${targetId}/confirm`, headers: ownerHeaders, payload: { requestId: 'dsp-confirm-target' } });
    expect(confirmedTarget.statusCode).toBe(200);
    // 补测证据：针对条件二的通过证据（版本与目标一致）
    const retestContent = Buffer.from('retest evidence');
    const retestAttachment = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/attachments?requestId=dsp-att&filename=retest.txt`, headers: { ...ownerHeaders, 'content-type': 'application/octet-stream' }, payload: retestContent });
    expect(retestAttachment.statusCode).toBe(201);
    const retestPath = join(dataDir, 'attachments', projectId, createHash('sha256').update(retestContent).digest('hex'));
    const retest = await formalEvidence(app, changeId, workspaceId, ownerHeaders, 'dsp-retest', 2, criteria[1].id, baselineId, headSha, [retestAttachment.json().resourceId]);
    // 处置预览：resolved 必须引用补测证据
    const emptyDisposition = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/failure-dispositions/preview`, headers: ownerHeaders,
      payload: { requestId: 'dsp-preview-empty', expectedVersion: 3, payload: { rows: [] } } });
    expect(emptyDisposition.statusCode).toBe(400);
    const missingSupport = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/failure-dispositions/preview`, headers: ownerHeaders,
      payload: { requestId: 'dsp-preview-nosupport', expectedVersion: 3, payload: { rows: [{ criterionId: criteria[1].id, failureEvidenceId: failedEvidence.json().resourceId, outcome: 'resolved', reason: '已修复' }] } } });
    expect(missingSupport.statusCode).toBe(400);
    const preview = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/failure-dispositions/preview`, headers: ownerHeaders,
      payload: { requestId: 'dsp-preview', expectedVersion: 3, payload: { rows: [{ criterionId: criteria[1].id, failureEvidenceId: failedEvidence.json().resourceId, outcome: 'resolved', supportingEvidenceIds: [retest], reason: '补测通过，失败已解决' }] } } });
    expect(preview.statusCode).toBe(201);
    const agentConfirm = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/failure-dispositions/confirm`, headers: agentHeaders,
      payload: { requestId: 'dsp-confirm-agent', payload: { previewId: preview.json().resourceId } } });
    expect(agentConfirm.statusCode).toBe(403);
    const wrongPreview = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/confirm`, headers: ownerHeaders,
      payload: { requestId: 'dsp-wrong-review', payload: { previewId: preview.json().resourceId, complete: true } } });
    expect(wrongPreview.statusCode).toBe(400);
    expect(wrongPreview.json().code).toBe('PREVIEW_KIND_MISMATCH');
    await rm(retestPath);
    const missingSupportAttachment = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/failure-dispositions/confirm`, headers: ownerHeaders,
      payload: { requestId: 'dsp-confirm-missing', payload: { previewId: preview.json().resourceId } } });
    expect(missingSupportAttachment.statusCode).toBe(409);
    await writeFile(retestPath, retestContent);
    const confirmed = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/failure-dispositions/confirm`, headers: { ...ownerHeaders, authorization: 'Bearer not-the-agent-token' },
      payload: { requestId: 'dsp-confirm', payload: { previewId: preview.json().resourceId } } });
    expect(confirmed.statusCode).toBe(200);
    const reviewAfterDisposition = (await app.inject({ url: `/api/v1/changes/${changeId}/review`, headers: ownerHeaders })).json();
    expect(reviewAfterDisposition.criteria[0].dispositions).toEqual([]);
    const history = reviewAfterDisposition.criteria[1].dispositions;
    expect(history).toEqual([expect.objectContaining({ id: confirmed.json().resourceId, cycle: 1, baselineId, failureEvidenceId: failedEvidence.json().resourceId, failureCommit: headSha, outcome: 'resolved', supportingEvidenceIds: [retest], reason: '补测通过，失败已解决', actor: 'user' })]);
    const healthCheck = vi.spyOn(attachmentStorage, 'checkAttachmentHealth');
    try {
      const historyOnly = await app.inject({ url: `/api/v1/changes/${changeId}/review/failure-dispositions`, headers: ownerHeaders });
      expect(historyOnly.statusCode).toBe(200);
      expect(historyOnly.json().criteria[1].dispositions).toEqual(history);
      expect(healthCheck).not.toHaveBeenCalled();
      expect((await app.inject({ url: `/api/v1/changes/${changeId}/review`, headers: ownerHeaders })).statusCode).toBe(200);
      expect(healthCheck).toHaveBeenCalled();
    } finally { healthCheck.mockRestore(); }
    // 处置后条件二解除阻塞，最终验收完成
    const finalReviewPreview = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: ownerHeaders,
      payload: { requestId: 'dsp-review-preview', payload: { selections: [
        { criterionId: criteria[0].id, mode: 'new', evidenceIds: [evidence1] },
        { criterionId: criteria[1].id, mode: 'new', evidenceIds: [retest] },
      ] } } });
    expect(finalReviewPreview.statusCode).toBe(201);
    const complete = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/confirm`, headers: ownerHeaders,
      payload: { requestId: 'dsp-confirm-final', payload: { previewId: finalReviewPreview.json().resourceId, complete: true } } });
    expect(complete.statusCode).toBe(200);
    // 处置不把失败改为通过；失败证据仍可追溯
    const rows = (await app.inject({ url: `/api/v1/changes/${changeId}/evidence`, headers: ownerHeaders })).json().evidence as { id: string; result: string }[];
    expect(rows.find(item => item.id === failedEvidence.json().resourceId)!.result).toBe('failed');
    const exportStart = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/exports`, headers: ownerHeaders, payload: { requestId: 'dsp-export' } });
    const operationId = exportStart.json().resourceId as string;
    expect((await app.inject({ url: `/api/v1/exports/${operationId}`, headers: ownerHeaders })).json().status).toBe('ready');
    const archive = await app.inject({ url: `/api/v1/exports/${operationId}/download`, headers: ownerHeaders });
    const restoreDir = await mkdtemp(join(tmpdir(), 'specmill-disposition-restore-')); dirs.push(restoreDir);
    const restoredApp = await buildApp({ dataDir: restoreDir, port: 43221, ownerToken: 'owner-token', agentToken: testAgentToken }); apps.push(restoredApp);
    await restoredApp.listen({ host: '127.0.0.1', port: 43221 });
    const restoreBase = { host: '127.0.0.1:43221', origin: 'http://127.0.0.1:43221' };
    const login = await restoredApp.inject({ method: 'POST', url: '/api/v1/session', headers: restoreBase, payload: { token: 'owner-token' } });
    const restoreHeaders = { ...restoreBase, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1', 'content-type': 'application/octet-stream' };
    const restored = await restoredApp.inject({ method: 'POST', url: '/api/v1/restore?requestId=dsp-restore', headers: restoreHeaders, payload: archive.rawPayload });
    expect(restored.statusCode).toBe(201);
    const restoredReview = (await restoredApp.inject({ url: `/api/v1/changes/${changeId}/review`, headers: restoreHeaders })).json();
    expect(restoredReview.accepted).toBe(true);
    expect(restoredReview.criteria[1].dispositions).toEqual(history);
    expect((await restoredApp.inject({ url: '/api/v1/receipts/dsp-confirm-target', headers: restoreHeaders })).json()).toEqual(confirmedTarget.json());
    for (const response of [retestAttachment, failedRun, failedEvidence, target, proposal, preview, confirmed, finalReviewPreview, complete]) {
      const receipt = response.json() as { requestId: string; resourceId: string; recordVersion: number; committedAt: string };
      const recoveredReceipt = await restoredApp.inject({ url: `/api/v1/receipts/${receipt.requestId}`, headers: restoreHeaders });
      expect(recoveredReceipt.statusCode).toBe(200);
      expect(recoveredReceipt.json()).toEqual({ requestId: receipt.requestId, resourceId: receipt.resourceId, recordVersion: receipt.recordVersion, committedAt: receipt.committedAt });
    }
    // 继续实现端点只对 Reviewing 有效
    const continueStale = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/continue`, headers: ownerHeaders,
      payload: { requestId: 'dsp-continue', expectedVersion: complete.json().recordVersion } });
    expect(continueStale.statusCode).toBe(409);
    const reopened = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/reopen`, headers: ownerHeaders, payload: { requestId: 'dsp-reopen', expectedVersion: complete.json().recordVersion, payload: { baselineId, reason: '调整验收条件' } } });
    expect(reopened.statusCode).toBe(200);
    const updated = await app.inject({ method: 'PATCH', url: `/api/v1/changes/${changeId}`, headers: ownerHeaders, payload: { requestId: 'dsp-new-criteria', expectedVersion: reopened.json().recordVersion, payload: { title: '审阅变更', goal: '', scope: '', nonGoals: '', criteria: ['新条件'] } } });
    expect(updated.statusCode).toBe(200);
    const newBaseline = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/baselines`, headers: ownerHeaders, payload: { requestId: 'dsp-new-baseline', expectedVersion: updated.json().recordVersion, payload: { workspaceId, expectedBindingVersion: 1, path: 'spec.md', expectedSha256: createHash('sha256').update(specContent).digest('hex'), selection: '# 验收规格', criterionLinks: [null], previousSourceItemId: null } } });
    expect(newBaseline.statusCode).toBe(201);
    const newReview = (await app.inject({ url: `/api/v1/changes/${changeId}/review`, headers: ownerHeaders })).json();
    expect(newReview.criteria[0].dispositions).toEqual([]);
    expect(newReview.retiredDispositions).toEqual([expect.objectContaining({ criterionId: criteria[1].id, criterionText: '文档齐全', failureEvidenceId: failedEvidence.json().resourceId, reason: '补测通过，失败已解决', baselineId })]);
    const retiredHistory = await app.inject({ url: `/api/v1/changes/${changeId}/review/failure-dispositions`, headers: ownerHeaders });
    expect(retiredHistory.statusCode).toBe(200);
    expect(retiredHistory.json().retiredDispositions).toEqual(newReview.retiredDispositions);
    expect((await app.inject({ url: `/api/v1/changes/${changeId}/review/failure-dispositions`, headers: { host: headers.host } })).statusCode).toBe(401);
    void evidence1;
  }, 60000);
});
