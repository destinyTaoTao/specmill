import { afterEach, describe, expect, it } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { buildApp } from '../../src/server/app.js';
import { encodeSecret } from '../../src/shared/credentials.js';

const runFile = promisify(execFile);
const dirs: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const headers = { host: '127.0.0.1:43226', origin: 'http://127.0.0.1:43226' };
const agentHeaders = { host: headers.host, authorization: 'Bearer agent-token' };
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup(maxProjectRecordsBytes?: number) {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-evidence-data-')); dirs.push(dataDir);
  const repoDir = await mkdtemp(join(tmpdir(), 'specmill-evidence-repo-')); dirs.push(repoDir);
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_AUTHOR_NAME: '测试', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: '测试', GIT_COMMITTER_EMAIL: 'test@example.com' } });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  git(['init', '-q']);
  await writeFile(join(repoDir, 'README.md'), '# 证据样本\n');
  const specContent = '# 验收规格\n\n- 条件一：测试通过\n- 条件二：文档齐全\n';
  await writeFile(join(repoDir, 'spec.md'), specContent);
  git(['add', 'README.md', 'spec.md']);
  git(['commit', '-q', '-m', 'init']);
  const headSha = git(['rev-parse', 'HEAD']).trim();
  const app = await buildApp({ dataDir, port: 43226, ownerToken: 'owner-token', agentToken: 'agent-token', maxProjectRecordsBytes }); apps.push(app);
  await app.listen({ host: '127.0.0.1', port: 43226 });
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } });
  const ownerHeaders = { ...headers, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
  const project = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: ownerHeaders, payload: { name: '证据项目', requestId: 'ev-project' } });
  const projectId = project.json().resourceId as string;
  const workspace = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/workspaces`, headers: ownerHeaders,
    payload: { requestId: 'ev-workspace', expectedVersion: null, payload: { workspaceId: null, path: repoDir } } });
  const workspaceId = workspace.json().resourceId as string;
  const change = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
    payload: { requestId: 'ev-change', expectedVersion: null, payload: { title: '证据变更', goal: '验证证据流程', scope: '', nonGoals: '', criteria: ['测试全部通过', '文档齐全'] } } });
  const changeId = change.json().resourceId as string;
  const specSha = createHash('sha256').update(specContent, 'utf8').digest('hex');
  return { app, dataDir, repoDir, projectId, workspaceId, changeId, ownerHeaders, git, headSha, specSha, specContent };
}
async function startSession(app: Awaited<ReturnType<typeof buildApp>>, changeId: string, workspaceId: string, requestId: string, expectedVersion: number) {
  const started = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/writer-sessions`, headers: { ...agentHeaders, 'x-specmill-writer-token': 'a'.repeat(64) },
    payload: { requestId, expectedVersion, payload: { workspaceId, expectedBindingVersion: 1, toolLabel: '证据工具' } } });
  expect(started.statusCode).toBe(201);
  return started.json() as { resourceId: string; generation: number };
}

describe('execution evidence and acceptance targets', () => {
  it('records runs and evidence with separated claims, gates formality and confirms the target as user only', async () => {
    const { app, repoDir, workspaceId, changeId, ownerHeaders, headSha, specContent } = await setup();
    // 工具先取得写会话并保存一次进度，保持流程真实
    const session = await startSession(app, changeId, workspaceId, 'ev-start', 1);
    // 工具声明测试时干净并指向完整 commit；上传时的本地观察由服务另行记录
    const run = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/executions`, headers: agentHeaders,
      payload: { requestId: 'ev-run', workspaceId, payload: { method: 'node --test tests/', result: 'passed', exitStatus: 'exit 0', claimedCommit: headSha, claimedClean: true, notes: '全部样本通过' } } });
    expect(run.statusCode).toBe(201);
    const runId = run.json().resourceId as string;
    const replay = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/executions`, headers: agentHeaders,
      payload: { requestId: 'ev-run', workspaceId, payload: { method: 'node --test tests/', result: 'passed', exitStatus: 'exit 0', claimedCommit: headSha, claimedClean: true, notes: '全部样本通过' } } });
    expect(replay.json().resourceId).toBe(runId);
    const runRows = (await app.inject({ url: `/api/v1/changes/${changeId}/executions`, headers: ownerHeaders })).json().executions as { id: string; uploadContext: { dirty: boolean; stable: boolean }; claimedClean: boolean | null; commitVerified: boolean | null }[];
    expect(runRows[0].claimedClean).toBe(true);
    expect(runRows[0].commitVerified).toBe(true);
    expect(runRows[0].uploadContext).toEqual(expect.objectContaining({ dirty: false, stable: true }));
    // 冻结基线（含稳定条件 ID），版本推进到 Working
    const frozen = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/baselines`, headers: ownerHeaders,
      payload: { requestId: 'ev-baseline', expectedVersion: 2, payload: { workspaceId, expectedBindingVersion: 1, path: 'spec.md', expectedSha256: createHash('sha256').update(specContent, 'utf8').digest('hex'), selection: '# 验收规格', criterionLinks: [null, null], previousSourceItemId: null } } });
    expect(frozen.statusCode).toBe(201);
    const baselineId = frozen.json().resourceId as string;
    const baseline = (await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${baselineId}`, headers: ownerHeaders })).json() as { criteria: { id: string; text: string }[] };
    expect(baseline.criteria).toHaveLength(2);
    // 正式资格：基线条件 + 干净 + commit 核对 + 版本一致
    const formalEvidence = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/evidence`, headers: agentHeaders,
      payload: { requestId: 'ev-evidence-formal', payload: { executionId: runId, criterion: { kind: 'baseline', baselineId, criterionId: baseline.criteria[0].id }, criterionIndex: 1, result: 'passed', actualCommit: headSha, notes: '条件一由该执行覆盖' } } });
    expect(formalEvidence.statusCode).toBe(201);
    // 草案条件仅作参考
    const draftEvidence = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/evidence`, headers: agentHeaders,
      payload: { requestId: 'ev-evidence-draft', payload: { executionId: runId, criterion: { kind: 'draft', revisionId: (await app.inject({ url: `/api/v1/changes/${changeId}`, headers: ownerHeaders })).json().draft.revisionId }, criterionIndex: 2, result: 'passed', actualCommit: headSha } } });
    expect(draftEvidence.statusCode).toBe(201);
    // 版本不一致 → 不具备正式资格
    const mismatched = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/evidence`, headers: agentHeaders,
      payload: { requestId: 'ev-evidence-mismatch', payload: { executionId: runId, criterion: { kind: 'baseline', baselineId, criterionId: baseline.criteria[1].id }, criterionIndex: 2, result: 'passed', actualCommit: 'f'.repeat(40) } } });
    expect(mismatched.statusCode).toBe(201);
    const evidenceRows = (await app.inject({ url: `/api/v1/changes/${changeId}/evidence`, headers: ownerHeaders })).json().evidence as { id: string; formal: boolean; criterionText: string | null; criterionIndex: number }[];
    expect(evidenceRows.find(item => item.id === formalEvidence.json().resourceId)!.formal).toBe(true);
    expect(evidenceRows.find(item => item.id === draftEvidence.json().resourceId)!.formal).toBe(false);
    expect(evidenceRows.find(item => item.id === mismatched.json().resourceId)!.formal).toBe(false);
    expect(evidenceRows[0].criterionText).toBe('测试全部通过');
    // 缺字段与越界条件被拒绝；未提交执行不能先被证据引用
    const outOfRange = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/evidence`, headers: agentHeaders,
      payload: { requestId: 'ev-evidence-range', payload: { executionId: runId, criterion: { kind: 'baseline', baselineId, criterionId: baseline.criteria[0].id }, criterionIndex: 9, result: 'passed' } } });
    expect(outOfRange.statusCode).toBe(400);
    const missingExecution = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/evidence`, headers: agentHeaders,
      payload: { requestId: 'ev-evidence-missing', payload: { executionId: 'not-an-execution', criterion: { kind: 'baseline', baselineId, criterionId: baseline.criteria[0].id }, criterionIndex: 1, result: 'passed' } } });
    expect(missingExecution.statusCode).toBe(404);
    const badCommitRun = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/executions`, headers: agentHeaders,
      payload: { requestId: 'ev-run-abbrev', workspaceId, payload: { method: 'node --test', result: 'passed', claimedCommit: 'abc123' } } });
    expect(badCommitRun.statusCode).toBe(400);
    // dirty 执行保存为参考，不具备正式资格
    await writeFile(join(repoDir, 'notes.md'), '验证期间产生的未提交说明\n');
    const dirtyRun = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/executions`, headers: agentHeaders,
      payload: { requestId: 'ev-run-dirty', workspaceId, payload: { method: 'node --test tests/', result: 'failed', claimedClean: false, notes: 'dirty 状态下复测' } } });
    expect(dirtyRun.statusCode).toBe(201);
    const dirtyEvidence = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/evidence`, headers: agentHeaders,
      payload: { requestId: 'ev-evidence-dirty', payload: { executionId: dirtyRun.json().resourceId, criterion: { kind: 'baseline', baselineId, criterionId: baseline.criteria[0].id }, criterionIndex: 1, result: 'failed' } } });
    expect(dirtyEvidence.statusCode).toBe(201);
    const dirtyRows = (await app.inject({ url: `/api/v1/changes/${changeId}/evidence`, headers: ownerHeaders })).json().evidence as { id: string; formal: boolean }[];
    expect(dirtyRows.find(item => item.id === dirtyEvidence.json().resourceId)!.formal).toBe(false);
    // 实现目标候选：缩写 commit 拒绝，完整 commit 核对通过
    const abbreviated = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets`, headers: agentHeaders,
      payload: { requestId: 'ev-target-abbrev', payload: { commit: headSha.slice(0, 12) } } });
    expect(abbreviated.statusCode).toBe(400);
    const target = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets`, headers: agentHeaders,
      payload: { requestId: 'ev-target', payload: { commit: headSha, notes: '本地可核对的完整提交' } } });
    expect(target.statusCode).toBe(201);
    const targetId = target.json().resourceId as string;
    // 引用不存在的证据或目标的建议在提交阶段即被拒
    const badEvidenceRef = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-proposals`, headers: agentHeaders,
      payload: { requestId: 'ev-proposal-bad-ref', expectedVersion: 3, payload: { reason: '引用缺失', evidenceIds: ['missing-evidence'] } } });
    expect(badEvidenceRef.statusCode).toBe(404);
    // 验收建议使变更进入审阅；版本不符被拒
    const staleProposal = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-proposals`, headers: agentHeaders,
      payload: { requestId: 'ev-proposal-stale', expectedVersion: 99, payload: { reason: '建议进入验收', targetId } } });
    expect(staleProposal.statusCode).toBe(409);
    const proposal = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-proposals`, headers: agentHeaders,
      payload: { requestId: 'ev-proposal', expectedVersion: 3, payload: { reason: '候选目标与证据已就绪；条件二待补证据', targetId, evidenceIds: [formalEvidence.json().resourceId] } } });
    expect(proposal.statusCode).toBe(201);
    const changeRow = (await app.inject({ url: `/api/v1/changes/${changeId}`, headers: ownerHeaders })).json() as { phase: string; version: number };
    expect(changeRow.phase).toBe('Reviewing');
    expect(changeRow.version).toBe(4);
    // 审阅阶段保存进度被明确拒绝
    const frozenCheckpoint = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/checkpoints`, headers: { ...agentHeaders, 'x-specmill-writer-token': 'a'.repeat(64) },
      payload: { requestId: 'ev-checkpoint-frozen', expectedVersion: 4, writerSessionId: session.resourceId, generation: session.generation, payload: { observationId: 'unused', done: 'x', failures: '无', unverified: '无', blockers: '无', nextSteps: '无' } } });
    expect(frozenCheckpoint.statusCode).toBe(409);
    expect(frozenCheckpoint.json().code).toBe('CHANGE_NOT_WRITABLE');
    // agent 不能确认目标
    const agentConfirm = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets/${targetId}/confirm`, headers: agentHeaders, payload: { requestId: 'ev-confirm-agent' } });
    expect(agentConfirm.statusCode).toBe(403);
    // 用户确认目标；重复确认被拒
    const confirmed = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets/${targetId}/confirm`, headers: ownerHeaders, payload: { requestId: 'ev-confirm' } });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().status).toBe('confirmed');
    const again = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/acceptance-targets/${targetId}/confirm`, headers: ownerHeaders, payload: { requestId: 'ev-confirm-2' } });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('TARGET_ALREADY_CONFIRMED');
  }, 30000);

  it('counts evidence toward capacity while existing records stay readable', async () => {
    const { app, projectId, workspaceId, changeId, ownerHeaders } = await setup(6000);
    const capacity = async () => (await app.inject({ url: `/api/v1/projects/${projectId}/capacity`, headers: ownerHeaders })).json().records as { used: number; limit: number };
    const remaining = async () => { const budget = await capacity(); return budget.limit - budget.used; };
    const before = await capacity();
    const probe = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/executions`, headers: agentHeaders,
      payload: { requestId: 'ev-budget-run', workspaceId, payload: { method: 'node --test', result: 'passed' } } });
    expect(probe.statusCode).toBe(201);
    const perRun = (await capacity()).used - before.used;
    expect(perRun).toBeGreaterThan(0);
    // 校准填充到剩余不足一次执行的开销：先测一次最小变更的增量，再精确补齐
    const probeFill = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
      payload: { requestId: 'ev-budget-fill-0', expectedVersion: null, payload: { title: '填充', goal: '', scope: '', nonGoals: '', criteria: [] } } });
    expect(probeFill.statusCode).toBe(201);
    const perFill = (await capacity()).used - before.used - perRun;
    const gap = await remaining();
    await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/changes`, headers: ownerHeaders,
      payload: { requestId: 'ev-budget-fill', expectedVersion: null, payload: { title: '填充', goal: 'x'.repeat(Math.max(0, Math.floor((gap - 200 - perFill) / 2))), scope: '', nonGoals: '', criteria: [] } } });
    expect(await remaining()).toBeLessThan(400);
    const rejected = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/executions`, headers: agentHeaders,
      payload: { requestId: 'ev-budget-run-2', workspaceId, payload: { method: 'node --test', result: 'passed' } } });
    expect(rejected.statusCode).toBe(413);
    expect(rejected.json().code).toBe('PROJECT_CAPACITY_EXCEEDED');
    expect((await app.inject({ url: `/api/v1/changes/${changeId}/executions`, headers: ownerHeaders })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/v1/changes/${changeId}/evidence`, headers: ownerHeaders })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/v1/changes/${changeId}/acceptance-targets`, headers: ownerHeaders })).statusCode).toBe(200);
  }, 30000);

  it('exposes the evidence flows through the CLI', async () => {
    const { app, dataDir, workspaceId, changeId, headSha, specContent } = await setup();
    await writeFile(join(dataDir, 'cli-token'), await encodeSecret('agent-token'), { mode: 0o600 });
    const cli = (...args: string[]) => runFile(process.execPath, ['--import', 'tsx', resolve('src/cli/main.ts'), ...args, '--data-dir', dataDir, '--server', 'http://127.0.0.1:43226', '--json'], { timeout: 30000 });
    const run = JSON.parse((await cli('run', 'add', '--change', changeId, '--workspace', workspaceId, '--method', 'node --test tests/', '--result', 'passed', '--claimed-commit', headSha, '--claimed-clean', 'true', '--request-id', 'cli-run')).stdout);
    expect(run.resourceId).toBeTruthy();
    const frozen = await app.inject({ method: 'POST', url: `/api/v1/changes/${changeId}/baselines`, headers: await ownerHeadersVia(app),
      payload: { requestId: 'cli-baseline', expectedVersion: 1, payload: { workspaceId, expectedBindingVersion: 1, path: 'spec.md', expectedSha256: createHash('sha256').update(specContent, 'utf8').digest('hex'), selection: '# 验收规格', criterionLinks: [null, null], previousSourceItemId: null } } });
    expect(frozen.statusCode).toBe(201);
    const baselineCriteria = (await app.inject({ url: `/api/v1/changes/${changeId}/baselines/${frozen.json().resourceId}`, headers: await ownerHeadersVia(app) })).json().criteria as { id: string }[];
    const evidence = JSON.parse((await cli('evidence', 'add', '--change', changeId, '--execution', run.resourceId, '--criterion-baseline', frozen.json().resourceId, '--criterion-id', baselineCriteria[0].id, '--criterion-index', '1', '--result', 'passed', '--actual-commit', headSha, '--request-id', 'cli-evidence')).stdout);
    expect(evidence.resourceId).toBeTruthy();
    const target = JSON.parse((await cli('target', 'add', '--change', changeId, '--commit', headSha, '--request-id', 'cli-target')).stdout);
    expect(target.resourceId).toBeTruthy();
    const proposal = JSON.parse((await cli('proposal', 'submit', '--change', changeId, '--version', '2', '--target', target.resourceId, '--reason', 'CLI 建议进入审阅', '--evidence', evidence.resourceId, '--request-id', 'cli-proposal')).stdout);
    expect(proposal.resourceId).toBeTruthy();
    const listed = JSON.parse((await cli('evidence', 'list', '--change', changeId)).stdout);
    expect(listed.evidence).toHaveLength(1);
    expect(listed.evidence[0].formal).toBe(true);
  }, 60000);
});

function ownerHeadersVia(app: Awaited<ReturnType<typeof buildApp>>) {
  return app.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'owner-token' } }).then(login => ({ ...headers, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' }));
}
