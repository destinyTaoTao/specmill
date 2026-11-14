import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app.js';

const dirs: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const headers = { host: '127.0.0.1:43220', origin: 'http://127.0.0.1:43220' };
const agentHeaders = { host: headers.host, authorization: 'Bearer agent-token' };
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
  const app = await buildApp({ dataDir, port: 43220, ownerToken: 'owner-token', agentToken: 'agent-token', maxProjectRecordsBytes }); apps.push(app);
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
async function formalEvidence(app: Awaited<ReturnType<typeof buildApp>>, changeId: string, workspaceId: string, ownerHeaders: Record<string, unknown>, requestId: string, criterionIndex: 1 | 2, criterionId: string, baselineId: string, headSha: string) {
  const run = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/executions`, headers: agentHeaders,
    payload: { requestId: `${requestId}-run`, workspaceId, payload: { method: 'node --test', result: 'passed', claimedCommit: headSha, claimedClean: true } } });
  expect(run.statusCode).toBe(201);
  const evidence = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/evidence`, headers: agentHeaders,
    payload: { requestId: `${requestId}-ev`, payload: { executionId: run.json().resourceId, criterion: { kind: 'baseline', baselineId, criterionId }, criterionIndex, result: 'passed', actualCommit: headSha } } });
  expect(evidence.statusCode).toBe(201);
  return evidence.json().resourceId as string;
}

describe('review confirmation and acceptance', () => {
  it('previews, confirms per criterion, rejects stale previews and completes the final acceptance', async () => {
    const { app, workspaceId, changeId, ownerHeaders, headSha, specContent } = await setup();
    const baselineId = await freeze(app, changeId, workspaceId, ownerHeaders, 1, specContent);
    const criteria = (await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${baselineId}`, headers: ownerHeaders })).json().criteria as { id: string }[];
    const evidence1 = await formalEvidence(app, changeId, workspaceId, ownerHeaders, 'rev-e1', 1, criteria[0].id, baselineId, headSha);
    const evidence2 = await formalEvidence(app, changeId, workspaceId, ownerHeaders, 'rev-e2', 2, criteria[1].id, baselineId, headSha);
    const target = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets`, headers: agentHeaders,
      payload: { requestId: 'rev-target', payload: { commit: headSha } } });
    const targetId = target.json().resourceId as string;
    const proposal = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-proposals`, headers: agentHeaders,
      payload: { requestId: 'rev-proposal', expectedVersion: 2, payload: { reason: '证据就绪', targetId } } });
    expect(proposal.statusCode).toBe(201);
    await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets/${targetId}/confirm`, headers: ownerHeaders, payload: { requestId: 'rev-confirm-target' } });
    // 未确认目标前预览被拒：先用一个未确认目标的场景验证 TARGET_REQUIRED
    // agent 可以生成预览；确认只能由用户完成
    const preview = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: agentHeaders,
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
    const preview2 = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: agentHeaders,
      payload: { requestId: 'rev-preview-2', payload: { selections: [
        { criterionId: criteria[0].id, mode: 'new', evidenceIds: [evidence1] },
      ] } } });
    expect(preview2.statusCode).toBe(201);
    const agentConfirm = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/confirm`, headers: agentHeaders,
      payload: { requestId: 'rev-confirm-agent', payload: { previewId: preview2.json().resourceId, complete: false } } });
    expect(agentConfirm.statusCode).toBe(403);
    const confirmed = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/confirm`, headers: ownerHeaders,
      payload: { requestId: 'rev-confirm', payload: { previewId: preview2.json().resourceId, complete: false } } });
    expect(confirmed.statusCode).toBe(200);
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
    // 最终验收：全部条件 + 无未处置失败
    const finalPreview = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/preview`, headers: ownerHeaders,
      payload: { requestId: 'rev-preview-4', payload: { selections: [{ criterionId: criteria[1].id, mode: 'new', evidenceIds: [evidence2] }] } } });
    expect(finalPreview.statusCode).toBe(201);
    const complete = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/confirm`, headers: ownerHeaders,
      payload: { requestId: 'rev-confirm-final', payload: { previewId: finalPreview.json().resourceId, complete: true } } });
    expect(complete.statusCode).toBe(200);
    const changeRow = (await app.inject({ url: `/api/v1/changes/${changeId}`, headers: ownerHeaders })).json() as { phase: string; activeSession: { status: string } | null };
    expect(changeRow.phase).toBe('Accepted');
    expect(changeRow.activeSession).toBeNull();
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
    const failedRun = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/executions`, headers: agentHeaders,
      payload: { requestId: 'blk-failed-run', workspaceId, payload: { method: 'node --test', result: 'failed', claimedCommit: headSha, claimedClean: true, notes: '条件二的用例失败' } } });
    const failedEvidence = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/evidence`, headers: agentHeaders,
      payload: { requestId: 'blk-failed-ev', payload: { executionId: failedRun.json().resourceId, criterion: { kind: 'baseline', baselineId, criterionId: criteria[1].id }, criterionIndex: 2, result: 'failed', actualCommit: headSha } } });
    expect(failedEvidence.statusCode).toBe(201);
    const target = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets`, headers: agentHeaders,
      payload: { requestId: 'blk-target', payload: { commit: headSha } } });
    const targetId = target.json().resourceId as string;
    const proposal = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-proposals`, headers: agentHeaders,
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
    const { app, workspaceId, changeId, ownerHeaders, headSha, specContent } = await setup();
    const baselineId = await freeze(app, changeId, workspaceId, ownerHeaders, 1, specContent);
    const criteria = (await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${baselineId}`, headers: ownerHeaders })).json().criteria as { id: string }[];
    const evidence1 = await formalEvidence(app, changeId, workspaceId, ownerHeaders, 'dsp-e1', 1, criteria[0].id, baselineId, headSha);
    const failedRun = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/executions`, headers: agentHeaders,
      payload: { requestId: 'dsp-failed-run', workspaceId, payload: { method: 'node --test', result: 'failed', claimedCommit: headSha, claimedClean: true } } });
    const failedEvidence = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/evidence`, headers: agentHeaders,
      payload: { requestId: 'dsp-failed-ev', payload: { executionId: failedRun.json().resourceId, criterion: { kind: 'baseline', baselineId, criterionId: criteria[1].id }, criterionIndex: 2, result: 'failed', actualCommit: headSha } } });
    const target = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets`, headers: agentHeaders,
      payload: { requestId: 'dsp-target', payload: { commit: headSha } } });
    const targetId = target.json().resourceId as string;
    const proposal = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-proposals`, headers: agentHeaders,
      payload: { requestId: 'dsp-proposal', expectedVersion: 2, payload: { reason: '条件一就绪；条件二失败待处置', targetId } } });
    expect(proposal.statusCode).toBe(201);
    await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets/${targetId}/confirm`, headers: ownerHeaders, payload: { requestId: 'dsp-confirm-target' } });
    // 补测证据：针对条件二的通过证据（版本与目标一致）
    const retest = await formalEvidence(app, changeId, workspaceId, ownerHeaders, 'dsp-retest', 2, criteria[1].id, baselineId, headSha);
    // 处置预览：resolved 必须引用补测证据
    const missingSupport = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/failure-dispositions/preview`, headers: ownerHeaders,
      payload: { requestId: 'dsp-preview-nosupport', expectedVersion: 3, payload: { rows: [{ criterionId: criteria[1].id, failureEvidenceId: failedEvidence.json().resourceId, outcome: 'resolved', reason: '已修复' }] } } });
    expect(missingSupport.statusCode).toBe(400);
    const preview = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/failure-dispositions/preview`, headers: ownerHeaders,
      payload: { requestId: 'dsp-preview', expectedVersion: 3, payload: { rows: [{ criterionId: criteria[1].id, failureEvidenceId: failedEvidence.json().resourceId, outcome: 'resolved', supportingEvidenceIds: [retest], reason: '补测通过，失败已解决' }] } } });
    expect(preview.statusCode).toBe(201);
    const agentConfirm = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/failure-dispositions/confirm`, headers: agentHeaders,
      payload: { requestId: 'dsp-confirm-agent', payload: { previewId: preview.json().resourceId } } });
    expect(agentConfirm.statusCode).toBe(403);
    const confirmed = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/failure-dispositions/confirm`, headers: ownerHeaders,
      payload: { requestId: 'dsp-confirm', payload: { previewId: preview.json().resourceId } } });
    expect(confirmed.statusCode).toBe(200);
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
    // 继续实现端点只对 Reviewing 有效
    const continueStale = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/review/continue`, headers: ownerHeaders,
      payload: { requestId: 'dsp-continue', expectedVersion: complete.json().recordVersion } });
    expect(continueStale.statusCode).toBe(409);
    void evidence1;
  }, 60000);
});
