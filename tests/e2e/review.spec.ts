import { test, expect } from '@playwright/test';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../src/server/app.js';
import Database from 'better-sqlite3';
import { rm } from './cleanup.js';

test('the user rechecks an ambiguous historical target after migration', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-legacy-data-'));
  const repoDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-legacy-repo-'));
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_AUTHOR_NAME: '测试', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: '测试', GIT_COMMITTER_EMAIL: 'test@example.com' } });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  git(['init', '-q']);
  const spec = '# 历史规格\n\n- 条件一\n';
  await writeFile(join(repoDir, 'spec.md'), spec);
  git(['add', 'spec.md']); git(['commit', '-q', '-m', 'init']);
  const head = git(['rev-parse', 'HEAD']).trim();
  const options = { dataDir, port: 43235, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') };
  let app = await buildApp(options);
  try {
    await app.listen({ host: '127.0.0.1', port: options.port });
    const headers = { host: '127.0.0.1:43235', origin: 'http://127.0.0.1:43235' };
    const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers, payload: { token: 'test-owner' } });
    const owner = { ...headers, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: owner, payload });
    const project = await post('/api/v1/projects', { name: '历史目标项目', requestId: 'legacy-ui-project' });
    const projectId = project.json().resourceId as string;
    const workspace = await post(`/api/v1/projects/${projectId}/workspaces`, { requestId: 'legacy-ui-workspace', expectedVersion: null, payload: { workspaceId: null, path: repoDir } });
    const workspaceId = workspace.json().resourceId as string;
    const change = await post(`/api/v1/projects/${projectId}/changes`, { requestId: 'legacy-ui-change', expectedVersion: null, payload: { title: '历史目标变更', goal: '', scope: '', nonGoals: '', criteria: ['条件一'] } });
    const changeId = change.json().resourceId as string;
    const baseline = await post(`/api/v1/changes/${changeId}/baselines`, { requestId: 'legacy-ui-baseline', expectedVersion: 1, payload: { workspaceId, expectedBindingVersion: 1, path: 'spec.md', expectedSha256: createHash('sha256').update(spec).digest('hex'), selection: '# 历史规格', criterionLinks: [null], previousSourceItemId: null } });
    expect(baseline.statusCode).toBe(201);
    const targets: string[] = [];
    for (let index = 0; index < 2; index++) {
      const target = await post(`/api/v1/changes/${changeId}/acceptance-targets`, { requestId: `legacy-ui-target-${index}`, payload: { commit: head, notes: `历史目标 ${index}` } });
      expect(target.statusCode).toBe(201); targets.push(target.json().resourceId);
    }
    const proposal = await post(`/api/v1/changes/${changeId}/acceptance-proposals`, { requestId: 'legacy-ui-proposal', expectedVersion: 2, payload: { reason: '审阅', targetId: targets[0] } });
    expect(proposal.statusCode).toBe(201);
    for (const [index, id] of targets.entries()) expect((await post(`/api/v1/changes/${changeId}/acceptance-targets/${id}/confirm`, { requestId: `legacy-ui-confirm-${index}` })).statusCode).toBe(200);
    await app.close();
    const db = new Database(join(dataDir, 'specmill.db'));
    try { db.exec('DROP TABLE restore_receipts; ALTER TABLE failure_dispositions DROP COLUMN target_id; DROP INDEX target_confirmation_order; ALTER TABLE acceptance_targets DROP COLUMN confirmation_order; PRAGMA user_version = 16'); } finally { db.close(); }
    app = await buildApp(options);
    await app.listen({ host: '127.0.0.1', port: options.port });
    await page.goto('http://127.0.0.1:43235');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByRole('button', { name: '打开 历史目标项目' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '历史实现目标的确认顺序无法确定' })).toBeVisible();
    await page.getByText('实现目标候选（2）').click();
    const chosen = page.getByRole('listitem').filter({ hasText: '历史目标 0' });
    const requestIds: string[] = [];
    let loseResponse = true;
    await page.route('**/acceptance-targets', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      requestIds.push((route.request().postDataJSON() as { requestId: string }).requestId);
      if (loseResponse) { loseResponse = false; await route.fetch(); await route.abort('failed'); }
      else await route.continue();
    });
    await chosen.getByRole('button', { name: '重新生成此目标候选' }).click();
    await expect(page.getByText('生成候选的结果未知，请重试原目标。')).toBeVisible();
    await chosen.getByRole('button', { name: '重试生成此目标候选' }).click();
    await expect(page.getByText('已生成新的目标候选，请核对工作区和提交后确认。')).toBeVisible();
    expect(requestIds).toHaveLength(2); expect(requestIds[0]).toBe(requestIds[1]);
    await page.unroute('**/acceptance-targets');
    await expect(page.getByText('实现目标候选（3）')).toBeVisible();
    const newTarget = page.getByRole('listitem').filter({ hasText: '候选，待用户确认' });
    await newTarget.getByRole('button', { name: '确认此实现目标' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '历史实现目标的确认顺序无法确定' })).toHaveCount(0);
    const read = await app.inject({ url: `/api/v1/changes/${changeId}/review`, headers: { host: headers.host, authorization: 'Bearer test-agent' } });
    expect(read.statusCode).toBe(200);
    expect(targets).not.toContain(read.json().context.target.id);
  } finally {
    await page.close(); await app.close(); await rm(dataDir, { recursive: true, force: true }); await rm(repoDir, { recursive: true, force: true });
  }
});

test('the user completes the frozen-version acceptance through the review workspace', async ({ page }, testInfo) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-review-data-'));
  const repoDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-review-repo-'));
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_AUTHOR_NAME: '测试', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: '测试', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', env: gitEnv });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  git(['init', '-q']);
  await writeFile(join(repoDir, 'README.md'), '# 审阅样本\n');
  const specContent = '# 验收规格\n\n- 条件一：功能通过\n- 条件二：文档齐全\n- 条件三：外部检查\n';
  await writeFile(join(repoDir, 'spec.md'), specContent);
  git(['add', 'README.md', 'spec.md']);
  git(['commit', '-q', '-m', 'init']);
  const historicalSha = git(['rev-parse', 'HEAD']).trim();
  const app = await buildApp({ dataDir, port: 43234, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  try {
    await app.listen({ host: '127.0.0.1', port: 43234 });
    await page.goto('http://127.0.0.1:43234');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('项目名称').fill('审阅项目');
    await page.getByRole('button', { name: '创建项目' }).click();
    await page.getByRole('button', { name: '打开 审阅项目' }).click();
    await page.getByLabel('工作目录').fill(repoDir);
    await page.getByRole('button', { name: '登记工作区' }).click();
    await page.getByRole('button', { name: '观察工作区' }).click();
    await expect(page.getByText(/观察路径/)).toBeVisible();
    const create = page.getByRole('form', { name: '新建变更' });
    await create.getByLabel('变更标题').fill('审阅变更');
    await create.getByLabel('目标', { exact: true }).fill('完成冻结版本验收');
    await create.getByLabel('验收条件（每行一项）').fill('条件一：功能通过\n条件二：文档齐全\n条件三：外部检查');
    let releaseExecutions = () => {};
    let reportExecutions = () => {};
    const executionsGate = new Promise<void>(resolveGate => { releaseExecutions = resolveGate; });
    const executionsCaptured = new Promise<void>(resolveCaptured => { reportExecutions = resolveCaptured; });
    let evidenceRequested = false;
    await page.route('**/executions', async route => { reportExecutions(); await executionsGate; await route.fulfill({ status: 503, json: { message: '模拟读取失败' } }); });
    await page.route('**/evidence', async route => { evidenceRequested = true; await route.continue(); });
    try {
      await create.getByRole('button', { name: '创建变更' }).click();
      await executionsCaptured;
      await expect.poll(() => evidenceRequested, { timeout: 3000 }).toBe(true);
    } finally {
      releaseExecutions();
      await page.unroute('**/executions');
      await page.unroute('**/evidence');
    }
    await expect(page.getByRole('alert').filter({ hasText: '读取证据与验收数据失败' })).toBeVisible();
    await page.getByRole('button', { name: '重试读取证据与验收' }).click();
    await expect(page.getByText('执行记录（0）')).toBeVisible();
    // 响应丢失后，同一文件必须使用原请求标识重试，不能误报上传失败或重复登记。
    let dropUpload = true;
    const uploadRequests: string[] = [];
    await page.route('**/attachments?*', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      uploadRequests.push(new URL(route.request().url()).searchParams.get('requestId')!);
      if (dropUpload) { dropUpload = false; await route.fetch(); await route.abort('failed'); }
      else await route.continue();
    });
    const fileInput = page.getByLabel(/上传受管理附件/);
    await fileInput.setInputFiles({ name: 'response-lost.txt', mimeType: 'text/plain', buffer: Buffer.from('上传响应丢失样本') });
    await expect(page.getByText('附件上传结果未知，请重试原文件。')).toBeVisible();
    await expect(fileInput).toBeDisabled();
    await page.getByRole('button', { name: '重试上传原文件' }).click();
    await expect(page.getByText(/附件已上传/)).toBeVisible();
    expect(uploadRequests).toHaveLength(2);
    expect(uploadRequests[1]).toBe(uploadRequests[0]);
    await page.unroute('**/attachments?*');
    // 用户冻结基线（规格预览 → 选择摘录 → 确认）
    await page.getByRole('button', { name: '规格 审阅变更' }).click();
    await page.getByLabel('规格工作区').selectOption({ index: 1 });
    await page.getByLabel('Markdown 相对路径').fill('spec.md');
    await page.getByRole('button', { name: '预览规格' }).click();
    await page.getByLabel('选定的规格摘录').fill('# 验收规格');
    await page.getByRole('button', { name: '确认规格基线' }).click();
    await expect(page.getByText(/开发中 · 周期 1/)).toBeVisible();
    // 工具经服务提交两份正式证据与目标候选（浏览器外完成，模拟 CLI）
    const cookie = ((await page.context().cookies(['http://127.0.0.1:43234'])).find(item => item.name === 'specmill_session'))!.value;
    const ownerHeaders = { 'content-type': 'application/json', origin: 'http://127.0.0.1:43234', cookie: `specmill_session=${cookie}`, 'x-specmill-request': '1' };
    const projectId = (await (await fetch('http://127.0.0.1:43234/api/v1/projects', { headers: ownerHeaders })).json()).projects[0].id as string;
    const workspaceId = (await (await fetch(`http://127.0.0.1:43234/api/v1/projects/${projectId}/workspaces`, { headers: { origin: 'http://127.0.0.1:43234', cookie: `specmill_session=${cookie}` } })).json()).workspaces[0].id as string;
    const changeId = (await (await fetch(`http://127.0.0.1:43234/api/v1/projects/${projectId}/changes`, { headers: { origin: 'http://127.0.0.1:43234', cookie: `specmill_session=${cookie}` } })).json()).changes[0].id as string;
    const post = async (path: string, payload: unknown, writerToken?: string) => fetch(`http://127.0.0.1:43234${path}`, { method: 'POST', headers: { ...ownerHeaders, ...(writerToken ? { 'x-specmill-writer-token': writerToken } : {}) }, body: JSON.stringify(payload) });
    const baselineId = (await (await fetch(`http://127.0.0.1:43234/api/v1/changes/${changeId}/baselines`, { headers: { origin: 'http://127.0.0.1:43234', cookie: `specmill_session=${cookie}` } })).json()).baselines[0].id as string;
    const criteria = (await (await fetch(`http://127.0.0.1:43234/api/v1/changes/${changeId}/baselines/${baselineId}`, { headers: { origin: 'http://127.0.0.1:43234', cookie: `specmill_session=${cookie}` } })).json()).criteria as { id: string }[];
    const historicalRun = await (await post(`/api/v1/changes/${changeId}/executions`, { requestId: 'e2e-review-old-run', workspaceId, payload: { method: '历史版本检查', result: 'passed', claimedCommit: historicalSha, claimedClean: true } }, 'a'.repeat(64))).json();
    const evidence2 = await (await post(`/api/v1/changes/${changeId}/evidence`, { requestId: 'e2e-review-ev2', payload: { executionId: historicalRun.resourceId, criterion: { kind: 'baseline', baselineId, criterionId: criteria[1].id }, criterionIndex: 2, result: 'passed', actualCommit: historicalSha } }, 'a'.repeat(64))).json();
    await writeFile(join(repoDir, 'README.md'), '# 审阅样本\n\n新实现目标\n');
    git(['add', 'README.md']);
    git(['commit', '-q', '-m', 'new target']);
    const headSha = git(['rev-parse', 'HEAD']).trim();
    expect(headSha).not.toBe(historicalSha);
    const run = await (await post(`/api/v1/changes/${changeId}/executions`, { requestId: 'e2e-review-run', workspaceId, payload: { method: 'node --test', result: 'passed', claimedCommit: headSha, claimedClean: true } }, 'a'.repeat(64))).json();
    const attachmentBytes = Buffer.from('验收记录');
    const uploaded = await (await fetch(`http://127.0.0.1:43234/api/v1/projects/${projectId}/attachments?requestId=e2e-review-attachment&filename=review.txt`, { method: 'POST', headers: { ...ownerHeaders, 'content-type': 'application/octet-stream' }, body: attachmentBytes })).json();
    const evidence1 = await (await post(`/api/v1/changes/${changeId}/evidence`, { requestId: 'e2e-review-ev1', payload: { executionId: run.resourceId, criterion: { kind: 'baseline', baselineId, criterionId: criteria[0].id }, criterionIndex: 1, result: 'passed', actualCommit: headSha, attachmentIds: [uploaded.resourceId] } }, 'a'.repeat(64))).json();
    const replacement = await (await post(`/api/v1/changes/${changeId}/evidence`, { requestId: 'e2e-review-replacement', payload: { executionId: run.resourceId, criterion: { kind: 'baseline', baselineId, criterionId: criteria[0].id }, criterionIndex: 1, result: 'passed', actualCommit: headSha } }, 'a'.repeat(64))).json();
    const failedRun = await (await post(`/api/v1/changes/${changeId}/executions`, { requestId: 'e2e-review-failed-run', workspaceId, payload: { method: '检查失败样本', result: 'failed', claimedCommit: headSha, claimedClean: true } }, 'a'.repeat(64))).json();
    const failure = await (await post(`/api/v1/changes/${changeId}/evidence`, { requestId: 'e2e-review-failed', payload: { executionId: failedRun.resourceId, criterion: { kind: 'baseline', baselineId, criterionId: criteria[1].id }, criterionIndex: 2, result: 'failed', actualCommit: headSha } }, 'a'.repeat(64))).json();
    expect(failure.resourceId).toBeTruthy();
    void evidence1;
    void evidence2;
    const target = await (await post(`/api/v1/changes/${changeId}/acceptance-targets`, { requestId: 'e2e-review-target', payload: { commit: headSha } }, 'a'.repeat(64))).json();
    const proposal = await (await post(`/api/v1/changes/${changeId}/acceptance-proposals`, { requestId: 'e2e-review-proposal', expectedVersion: 2, payload: { reason: '证据与目标就绪', targetId: target.resourceId } }, 'a'.repeat(64))).json();
    expect(proposal.resourceId).toBeTruthy();
    const alternateTarget = await post(`/api/v1/changes/${changeId}/acceptance-targets`, { requestId: 'e2e-alternate-target', payload: { commit: headSha, notes: '备选实现目标' } });
    expect(alternateTarget.status).toBe(201);
    // 浏览器外的提交需要刷新页面才能看到最新状态
    await page.getByRole('button', { name: '返回项目列表' }).click();
    await page.getByRole('button', { name: '打开 审阅项目' }).click();
    await expect(page.getByText(/审阅中 · 周期 1/)).toBeVisible();
    await expect(page.getByText('历史工具记录可能早于写会话校验；请核对记录来源与实际结果。')).toBeVisible();
    await expect(page.getByText('失败处置仅适用于确认时的目标；更换目标后需要重新处置。')).toBeVisible();
    // 用户确认实现目标
    await page.getByText('实现目标候选（2）').click();
    const targetList = page.locator('details').filter({ has: page.getByText('实现目标候选（2）') });
    const originalTarget = targetList.getByRole('listitem').filter({ hasNotText: '备选实现目标' });
    const alternateTargetRow = targetList.getByRole('listitem').filter({ hasText: '备选实现目标' });
    await expect(originalTarget.getByText('引用工作区目前登记的目录：', { exact: false })).toContainText(await realpath(repoDir));
    await expect(originalTarget.getByText('引用工作区目前登记的目录：', { exact: false })).toContainText(workspaceId);
    let releaseOldTargets = () => {};
    let reportOldTargets = () => {};
    const oldTargetsGate = new Promise<void>(resolveGate => { releaseOldTargets = resolveGate; });
    const oldTargetsCaptured = new Promise<void>(resolveCaptured => { reportOldTargets = resolveCaptured; });
    let holdOldTargets = true;
    await page.route('**/acceptance-targets', async route => {
      if (route.request().method() === 'GET' && holdOldTargets) {
        holdOldTargets = false;
        const response = await route.fetch();
        reportOldTargets();
        await oldTargetsGate;
        await route.fulfill({ response });
      } else await route.continue();
    });
    await fileInput.setInputFiles({ name: 'delayed-read.txt', mimeType: 'text/plain', buffer: Buffer.from('延迟读取样本') });
    await oldTargetsCaptured;
    const rebound = await post(`/api/v1/projects/${projectId}/workspaces`, { requestId: 'e2e-rebind-before-target-confirm', expectedVersion: 1, payload: { workspaceId, path: repoDir } });
    expect(rebound.status).toBe(200);
    await originalTarget.getByRole('button', { name: '确认此实现目标' }).click();
    await expect(page.getByRole('alert').filter({ hasText: '工作区绑定已变化，请重新读取目标后核对' })).toBeVisible();
    await expect(originalTarget.getByText('引用工作区目前登记的目录：', { exact: false })).toContainText('绑定版本 2');
    releaseOldTargets();
    await expect(fileInput).toBeEnabled();
    await expect(originalTarget.getByText('引用工作区目前登记的目录：', { exact: false })).toContainText('绑定版本 2');
    await page.unroute('**/acceptance-targets');
    let dropTargetConfirm = true;
    let failTargetRefresh = false;
    const confirmationIds: string[] = [];
    await page.route('**/acceptance-targets', async route => {
      if (route.request().method() === 'GET' && failTargetRefresh) {
        failTargetRefresh = false;
        await route.fulfill({ status: 503, json: { message: '模拟刷新失败' } });
      } else await route.continue();
    });
    await page.route('**/acceptance-targets/*/confirm', async route => {
      confirmationIds.push((route.request().postDataJSON() as { requestId: string }).requestId);
      if (dropTargetConfirm) { dropTargetConfirm = false; await route.fetch(); await route.abort('failed'); }
      else { failTargetRefresh = true; await route.continue(); }
    });
    await originalTarget.getByRole('button', { name: '确认此实现目标' }).click();
    await expect(page.getByText('目标确认结果未知，请重试原目标。')).toBeVisible();
    await expect(alternateTargetRow.getByRole('button', { name: '确认此实现目标' })).toBeDisabled();
    await originalTarget.getByRole('button', { name: '重试确认此目标' }).click();
    await expect(page.getByText('已确认实现目标（完整 commit 及仓库身份）。')).toBeVisible();
    await expect(page.getByText('目标已确认，但刷新失败；请返回后重新打开项目。')).toBeVisible();
    await expect(alternateTargetRow.getByRole('button', { name: '确认此实现目标' })).toBeDisabled();
    expect(confirmationIds).toHaveLength(2);
    expect(confirmationIds[1]).toBe(confirmationIds[0]);
    await page.unroute('**/acceptance-targets/*/confirm');
    await page.unroute('**/acceptance-targets');
    const missingEvidence = page.getByRole('listitem').filter({ hasText: '条件三：外部检查' });
    await missingEvidence.getByRole('button', { name: '风险豁免' }).click({ timeout: 5000 });
    await missingEvidence.getByLabel('豁免理由与影响').fill('外部服务不可用，接受本次检查缺口');
    let dropWaiver = true;
    await page.route('**/review/waive', async route => {
      if (dropWaiver) { dropWaiver = false; await route.fetch(); await route.abort('failed'); }
      else await route.continue();
    });
    await missingEvidence.getByRole('button', { name: '确认豁免' }).click();
    await expect(page.getByText('豁免结果未知，请使用原内容重试确认。')).toBeVisible();
    await expect(missingEvidence.getByLabel('豁免理由与影响')).toBeDisabled();
    await expect(page.getByRole('button', { name: '继续实现（回到开发阶段）' })).toBeDisabled();
    await missingEvidence.getByRole('button', { name: '确认豁免' }).click();
    await expect(page.getByText('已记录风险豁免。')).toBeVisible();
    const laterRun = await (await post(`/api/v1/changes/${changeId}/executions`, { requestId: 'e2e-later-failed-run', workspaceId, payload: { method: '后续外部检查', result: 'failed', claimedCommit: headSha, claimedClean: true } }, 'a'.repeat(64))).json();
    const laterFailure = await (await post(`/api/v1/changes/${changeId}/evidence`, { requestId: 'e2e-later-failed', payload: { executionId: laterRun.resourceId, criterion: { kind: 'baseline', baselineId, criterionId: criteria[2].id }, criterionIndex: 3, result: 'failed', actualCommit: headSha } }, 'a'.repeat(64))).json();
    expect(laterFailure.resourceId).toBeTruthy();
    await page.getByRole('button', { name: '返回项目列表' }).click();
    await page.getByRole('button', { name: '打开 审阅项目' }).click();
    await expect(missingEvidence.getByText('该条件仍有 1 项未处置失败，阻止最终验收。')).toBeVisible();
    await missingEvidence.getByRole('button', { name: '风险豁免' }).click();
    await missingEvidence.getByLabel('豁免理由与影响').fill('接受这次明确列出的外部检查失败');
    await missingEvidence.getByRole('button', { name: '确认豁免' }).click();
    await expect(page.getByText('已记录风险豁免。')).toBeVisible();
    await page.getByRole('button', { name: '处置失败' }).click();
    await page.getByLabel('处置方式').selectOption('not_applicable');
    await page.getByLabel('理由或依据').fill('该失败不适用于本次冻结目标');
    let releaseOldDisposition = () => {};
    let reportOldDisposition = () => {};
    const dispositionGate = new Promise<void>(resolveGate => { releaseOldDisposition = resolveGate; });
    const oldDispositionCaptured = new Promise<void>(resolveCaptured => { reportOldDisposition = resolveCaptured; });
    await page.route('**/review/failure-dispositions/preview', async route => {
      const response = await route.fetch();
      reportOldDisposition();
      await dispositionGate;
      await route.fulfill({ response });
    });
    try {
      await page.getByRole('button', { name: '预览处置' }).click();
      await oldDispositionCaptured;
      const reread = page.waitForResponse(response => response.url().endsWith(`/changes/${changeId}/review`) && response.request().method() === 'GET');
      await page.evaluate(() => window.dispatchEvent(new Event('specmill:review-refresh')));
      await reread;
      releaseOldDisposition();
      await expect(page.getByText('审阅状态已更新，请重新生成处置预览。')).toBeVisible();
      await expect(page.getByRole('region', { name: '失败处置预览' })).toHaveCount(0);
    } finally {
      releaseOldDisposition();
      await page.unroute('**/review/failure-dispositions/preview');
    }
    await page.getByRole('button', { name: '预览处置' }).click();
    const dispositionPreview = page.getByRole('region', { name: '失败处置预览' });
    await expect(dispositionPreview.getByText(failure.resourceId, { exact: false })).toBeVisible();
    await expect(dispositionPreview.getByText('该失败不适用于本次冻结目标', { exact: false })).toBeVisible();
    let dropConfirmation = true;
    await page.route('**/review/failure-dispositions/confirm', async route => {
      if (dropConfirmation) {
        dropConfirmation = false;
        await route.fetch();
        await route.abort('failed');
      } else await route.continue();
    });
    await dispositionPreview.getByRole('button', { name: '确认处置' }).click();
    await expect(page.getByText('处置结果未知，请使用同一预览重试确认。')).toBeVisible();
    await expect(page.getByLabel('理由或依据')).toBeDisabled();
    await expect(page.getByRole('button', { name: '继续实现（回到开发阶段）' })).toBeDisabled();
    await dispositionPreview.getByRole('button', { name: '确认处置' }).click();
    await expect(page.getByRole('status').filter({ hasText: '失败处置已记录。' })).toBeVisible();
    const dispositionHistory = page.locator('details').filter({ has: page.getByText('失败处置历史（1）') });
    await dispositionHistory.locator('summary').click();
    await expect(dispositionHistory.getByText(failure.resourceId, { exact: false })).toBeVisible();
    await expect(dispositionHistory.getByText('该失败不适用于本次冻结目标', { exact: false })).toBeVisible();
    await expect(dispositionHistory.getByText('处置只适用于记录的目标；旧记录未保存目标时须重新处置。')).toBeVisible();
    await dispositionHistory.screenshot({ path: testInfo.outputPath('disposition-history.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await dispositionHistory.screenshot({ path: testInfo.outputPath('disposition-history-mobile.png') });
    await page.setViewportSize({ width: 1280, height: 720 });
    // 用户明确选择证据；预览列明每项和冻结版本。
    const choices = page.getByLabel('选择证据');
    await expect(choices.nth(0)).toHaveValue('');
    await expect(choices.nth(1)).toHaveValue('');
    await choices.nth(0).selectOption(evidence1.resourceId);
    const firstMode = page.getByLabel('确认模式').first();
    await firstMode.selectOption('reuse');
    await page.getByRole('textbox', { name: '复用理由' }).fill('用户明确选择复用');
    const refreshedReview = page.waitForResponse(response => response.url().endsWith(`/changes/${changeId}/review`) && response.request().method() === 'GET');
    await page.evaluate(() => window.dispatchEvent(new Event('specmill:review-refresh')));
    await refreshedReview;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(firstMode).toHaveValue('reuse');
    await expect(page.getByRole('textbox', { name: '复用理由' })).toHaveValue('用户明确选择复用');
    let releaseFailedRead = () => {};
    let reportFailedRead = () => {};
    const failedReadGate = new Promise<void>(resolveGate => { releaseFailedRead = resolveGate; });
    const failedReadStarted = new Promise<void>(resolveStarted => { reportFailedRead = resolveStarted; });
    await page.route(/\/api\/v1\/changes\/[^/]+\/review$/, async route => {
      reportFailedRead();
      await failedReadGate;
      await route.fulfill({ status: 503, json: { message: '模拟审阅读取失败' } });
    });
    try {
      await page.evaluate(() => window.dispatchEvent(new Event('specmill:review-refresh')));
      await failedReadStarted;
      await expect(page.getByRole('button', { name: '生成确认预览' })).toBeDisabled();
      releaseFailedRead();
      await expect(page.getByText('读取审阅状态失败，请重试。')).toBeVisible();
      await expect(page.getByRole('button', { name: '生成确认预览' })).toBeDisabled();
    } finally {
      releaseFailedRead();
      await page.unroute(/\/api\/v1\/changes\/[^/]+\/review$/);
    }
    await page.getByRole('button', { name: '重试读取审阅状态' }).click();
    await expect(page.getByText('读取审阅状态失败，请重试。')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '生成确认预览' })).toBeEnabled();
    await expect(firstMode).toHaveValue('reuse');
    await expect(page.getByRole('textbox', { name: '复用理由' })).toHaveValue('用户明确选择复用');
    await firstMode.selectOption('new');
    await choices.nth(1).focus();
    await page.keyboard.press('ArrowDown');
    await expect(choices.nth(1)).toHaveValue(evidence2.resourceId);
    const reuseMode = page.getByLabel('确认模式').nth(1);
    await reuseMode.focus();
    await expect(reuseMode).toHaveValue('reuse');
    await page.keyboard.press('Home');
    await expect(reuseMode).toHaveValue('new');
    await expect(page.getByText('所选证据的验证版本与当前目标不一致；如需继续使用，请切换复用模式并说明理由。')).toBeVisible();
    await page.keyboard.press('End');
    await expect(reuseMode).toHaveValue('reuse');
    await expect(page.getByText('所选证据的验证版本与当前目标不一致；如需继续使用，请切换复用模式并说明理由。')).toHaveCount(0);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('textbox', { name: '复用理由' })).toBeFocused();
    await page.keyboard.insertText('已核对该证据适用于当前验收');
    const previewButton = page.getByRole('button', { name: '生成确认预览' });
    await firstMode.selectOption('reuse');
    await page.getByRole('textbox', { name: '复用理由' }).first().fill('跨标签核对样本');
    const externalTarget = await post(`/api/v1/changes/${changeId}/acceptance-targets`, { requestId: 'e2e-external-target', payload: { commit: historicalSha } });
    expect(externalTarget.status).toBe(201);
    const externalTargetId = (await externalTarget.json()).resourceId as string;
    expect((await post(`/api/v1/changes/${changeId}/acceptance-targets/${externalTargetId}/confirm`, { requestId: 'e2e-external-confirm' })).status).toBe(200);
    const externalView = await (await fetch(`http://127.0.0.1:43234/api/v1/changes/${changeId}/review`, { headers: ownerHeaders })).json();
    expect(externalView.context.target.id).toBe(externalTargetId);
    await previewButton.click();
    await expect(page.getByText('审阅状态已变化，请重新读取后生成预览。')).toBeVisible();
    await expect(page.getByRole('region', { name: '验收确认预览' })).toHaveCount(0);
    await expect(previewButton).toBeDisabled();
    const restoredTarget = await post(`/api/v1/changes/${changeId}/acceptance-targets`, { requestId: 'e2e-return-target', payload: { commit: headSha } });
    expect(restoredTarget.status).toBe(201);
    const restoredTargetId = (await restoredTarget.json()).resourceId as string;
    expect((await post(`/api/v1/changes/${changeId}/acceptance-targets/${restoredTargetId}/confirm`, { requestId: 'e2e-return-confirm' })).status).toBe(200);
    await page.getByRole('button', { name: '重试读取审阅状态' }).click();
    await expect(previewButton).toBeEnabled();
    await expect(firstMode).toHaveValue('reuse');
    await firstMode.selectOption('new');
    const secondCriterion = page.getByRole('listitem').filter({ hasText: '条件二：文档齐全' }).filter({ has: page.getByRole('button', { name: '处置失败' }) });
    await expect(secondCriterion.getByText(/被未处置失败阻塞/)).toBeVisible();
    await secondCriterion.getByRole('button', { name: '处置失败' }).click();
    await page.getByLabel('处置方式').selectOption('not_applicable');
    await page.getByLabel('理由或依据').fill('已重新核对当前目标下的失败');
    await page.getByRole('button', { name: '预览处置' }).click();
    await page.getByRole('region', { name: '失败处置预览' }).getByRole('button', { name: '确认处置' }).click();
    await expect(page.getByRole('status').filter({ hasText: '失败处置已记录。' })).toBeVisible();
    await missingEvidence.getByRole('button', { name: '风险豁免' }).click();
    await missingEvidence.getByLabel('豁免理由与影响').fill('接受新目标下已明确列出的外部检查失败');
    await missingEvidence.getByRole('button', { name: '确认豁免' }).click();
    await expect(page.getByText('已记录风险豁免。')).toBeVisible();
    let releaseOldPreview = () => {};
    let reportOldPreview = () => {};
    const previewGate = new Promise<void>(resolveGate => { releaseOldPreview = resolveGate; });
    const oldPreviewCaptured = new Promise<void>(resolveCaptured => { reportOldPreview = resolveCaptured; });
    await page.route('**/review/preview', async route => {
      const response = await route.fetch();
      reportOldPreview();
      await previewGate;
      await route.fulfill({ response });
    });
    try {
      await previewButton.click();
      await oldPreviewCaptured;
      const reread = page.waitForResponse(response => response.url().endsWith(`/changes/${changeId}/review`) && response.request().method() === 'GET');
      await page.evaluate(() => window.dispatchEvent(new Event('specmill:review-refresh')));
      await reread;
      releaseOldPreview();
      await expect(page.getByText('审阅状态已更新，请重新生成预览。')).toBeVisible();
      await expect(page.getByRole('region', { name: '验收确认预览' })).toHaveCount(0);
    } finally {
      releaseOldPreview();
      await page.unroute('**/review/preview');
    }
    await previewButton.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('确认预览已生成')).toBeVisible();
    const preview = page.getByRole('region', { name: '验收确认预览' });
    await expect(preview.getByText('条件一：功能通过')).toBeVisible();
    await expect(preview.getByText('条件二：文档齐全')).toBeVisible();
    await expect(preview.getByText('复用理由：已核对该证据适用于当前验收', { exact: false })).toBeVisible();
    await expect(preview.getByText(`验证版本 ${historicalSha}`, { exact: false })).toBeVisible();
    await expect(preview.getByText(`冻结提交：${headSha}`, { exact: false })).toBeVisible();
    await expect(preview.getByText('最近工作区观察：', { exact: false })).toContainText(await realpath(repoDir));
    await preview.screenshot({ path: testInfo.outputPath('review-preview.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(element => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === 'visible').map(element => `${element.tagName}.${element.className} ${element.clientWidth}/${element.scrollWidth}`).slice(-12));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), JSON.stringify(overflow)).toBe(true);
    await preview.screenshot({ path: testInfo.outputPath('review-preview-mobile.png') });
    await page.setViewportSize({ width: 1280, height: 720 });
    await choices.nth(1).selectOption('');
    await expect(page.getByRole('button', { name: /完成最终验收/ })).toHaveCount(0);
    await page.getByRole('button', { name: '生成确认预览' }).click();
    await expect(preview.getByText('本次不确认：未选择')).toBeVisible();
    let dropReviewConfirm = true;
    const reviewConfirmCommands: { requestId: string; payload: { previewId: string; complete: boolean } }[] = [];
    await page.route('**/review/confirm', async route => {
      reviewConfirmCommands.push(route.request().postDataJSON());
      if (dropReviewConfirm) { dropReviewConfirm = false; await route.fetch(); await route.abort('failed'); }
      else await route.continue();
    });
    await page.getByRole('button', { name: '仅确认所选条件' }).click();
    await expect(page.getByText('确认结果未知，请重试原确认。')).toBeVisible();
    await expect(page.getByRole('button', { name: /完成最终验收/ })).toBeDisabled();
    await expect(choices.first()).toBeDisabled();
    await page.getByRole('button', { name: '重试确认所选条件' }).click();
    await expect(page.getByText('已确认所选条件。')).toBeVisible();
    expect(reviewConfirmCommands).toHaveLength(2);
    expect(reviewConfirmCommands[1]).toEqual(reviewConfirmCommands[0]);
    await page.unroute('**/review/confirm');
    await writeFile(join(dataDir, 'attachments', projectId, createHash('sha256').update(attachmentBytes).digest('hex')), '损坏的附件');
    await page.getByRole('button', { name: '返回项目列表' }).click();
    await page.getByRole('button', { name: '打开 审阅项目' }).click();
    await expect(page.getByText(/已有决定的依据不可用，需重新确认/)).toBeVisible();
    await choices.nth(0).selectOption(replacement.resourceId);
    await page.getByRole('button', { name: '生成确认预览' }).click();
    await page.getByRole('button', { name: '仅确认所选条件' }).click();
    await expect(page.getByText('已确认所选条件。')).toBeVisible();
    await expect(choices).toHaveCount(1);
    await choices.first().selectOption(evidence2.resourceId);
    await page.getByRole('textbox', { name: '复用理由' }).fill('已重新核对历史证据适用性');
    await page.getByRole('button', { name: '生成确认预览' }).click();
    await expect(preview.getByText('本次不确认：已有确认决定')).toBeVisible();
    await page.getByRole('button', { name: '仅确认所选条件' }).click();
    await expect(choices).toHaveCount(0);
    // 两项已经独立确认，空选择仍可生成预览并完成最终验收。
    await page.getByRole('button', { name: '生成确认预览' }).click();
    await expect(page.getByText('确认预览已生成（选中 0 项）', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: /完成最终验收/ }).click();
    await expect(page.getByRole('status').filter({ hasText: '已完成冻结版本验收。' })).toBeVisible();
    await expect(page.getByText('该变更已完成冻结版本验收，含 1 项风险豁免；后续问题请重新打开或建立新变更。')).toBeVisible();
    await expect(page.getByText(/已验收 · 周期 1/)).toBeVisible();
    const review = await (await fetch(`http://127.0.0.1:43234/api/v1/changes/${changeId}/review`, { headers: ownerHeaders })).json() as { criteria: { criterionId: string; decision: { result: string; reason: string; evidenceIds: string[] } | null }[] };
    expect(review.criteria.find(item => item.criterionId === criteria[1].id)?.decision).toEqual(expect.objectContaining({ result: 'passed', reason: '复用历史证据：已重新核对历史证据适用性', evidenceIds: [evidence2.resourceId] }));
    // 已验收的变更不可再保存进度
    // 重新打开进入新周期
    await page.getByRole('button', { name: '重新打开 审阅变更' }).click();
    await page.getByLabel('重新打开原因').fill('验收后发现新的改进点');
    await page.getByRole('button', { name: '确认重新打开' }).click();
    await expect(page.getByText(/开发中 · 周期 2/)).toBeVisible();
    const nextProposal = page.getByRole('form', { name: '提交验收建议' });
    await nextProposal.getByLabel('理由与缺口说明').fill('重新检查第二周期');
    await nextProposal.getByRole('button', { name: '提交验收建议' }).click();
    await expect(page.getByText(/审阅中 · 周期 2/)).toBeVisible();
    let dropContinue = true;
    const continueCommands: { requestId: string; expectedVersion: number }[] = [];
    await page.route('**/review/continue', async route => {
      continueCommands.push(route.request().postDataJSON());
      if (dropContinue) { dropContinue = false; await route.fetch(); await route.abort('failed'); }
      else await route.continue();
    });
    await page.getByRole('button', { name: '继续实现（回到开发阶段）' }).click();
    await expect(page.getByText('继续实现结果未知，请重试原操作。')).toBeVisible();
    await expect(page.getByRole('button', { name: '生成确认预览' })).toBeDisabled();
    await page.getByRole('button', { name: '重试继续实现' }).click();
    await expect(page.getByText(/开发中 · 周期 2/)).toBeVisible();
    expect(continueCommands).toHaveLength(2);
    expect(continueCommands[1]).toEqual(continueCommands[0]);
    const latest = await (await fetch(`http://127.0.0.1:43234/api/v1/changes/${changeId}`, { headers: ownerHeaders })).json();
    const updated = await fetch(`http://127.0.0.1:43234/api/v1/changes/${changeId}`, { method: 'PATCH', headers: ownerHeaders, body: JSON.stringify({ requestId: 'e2e-retire-criteria', expectedVersion: latest.version, payload: { title: '审阅变更', goal: '完成冻结版本验收', scope: '', nonGoals: '', criteria: ['新验收条件'] } }) });
    expect(updated.status).toBe(200);
    const updatedReceipt = await updated.json();
    const adopted = await post(`/api/v1/changes/${changeId}/baselines`, { requestId: 'e2e-retire-baseline', expectedVersion: updatedReceipt.recordVersion, payload: { workspaceId, expectedBindingVersion: 2, path: 'spec.md', expectedSha256: createHash('sha256').update(specContent).digest('hex'), selection: '# 验收规格', criterionLinks: [null], previousSourceItemId: null } });
    expect(adopted.status).toBe(201);
    await page.getByRole('button', { name: '返回项目列表' }).click();
    let releaseOld = () => {};
    let reportOldCaptured = () => {};
    let reportOldDelivered = () => {};
    const oldGate = new Promise<void>(resolveGate => { releaseOld = resolveGate; });
    const oldCaptured = new Promise<void>(resolveCaptured => { reportOldCaptured = resolveCaptured; });
    const oldDelivered = new Promise<void>(resolveDelivered => { reportOldDelivered = resolveDelivered; });
    let firstHistory = true;
    await page.route('**/review/failure-dispositions', async route => {
      if (!firstHistory) { await route.continue(); return; }
      firstHistory = false;
      const response = await route.fetch();
      const body = await response.json();
      body.retiredDispositions = [];
      reportOldCaptured();
      await oldGate;
      await route.fulfill({ response, json: body });
      reportOldDelivered();
    });
    await page.getByRole('button', { name: '打开 审阅项目' }).click();
    await expect(page.getByText(/开发中 · 周期 2/)).toBeVisible();
    const workingHistory = page.locator('details').filter({ has: page.getByText('已不在当前条件中的失败处置（2）') });
    await oldCaptured;
    await page.evaluate(() => window.dispatchEvent(new Event('specmill:review-refresh')));
    await expect(workingHistory).toBeVisible();
    releaseOld();
    await oldDelivered;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(workingHistory).toBeVisible();
    await page.unroute('**/review/failure-dispositions');
    await workingHistory.locator('summary').click();
    await expect(workingHistory.getByText(failure.resourceId, { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /完成最终验收/ })).toHaveCount(0);
    const adoptedReceipt = await adopted.json();
    const nextReview = await post(`/api/v1/changes/${changeId}/acceptance-proposals`, { requestId: 'e2e-retire-proposal', expectedVersion: adoptedReceipt.recordVersion, payload: { reason: '核对新条件' } });
    expect(nextReview.status).toBe(201);
    await page.getByRole('button', { name: '返回项目列表' }).click();
    let releaseOldReview = () => {};
    let reportOldReviewCaptured = () => {};
    let reportOldReviewDelivered = () => {};
    const reviewGate = new Promise<void>(resolveGate => { releaseOldReview = resolveGate; });
    const oldReviewCaptured = new Promise<void>(resolveCaptured => { reportOldReviewCaptured = resolveCaptured; });
    const oldReviewDelivered = new Promise<void>(resolveDelivered => { reportOldReviewDelivered = resolveDelivered; });
    let firstReview = true;
    await page.route(/\/api\/v1\/changes\/[^/]+\/review$/, async route => {
      if (!firstReview) { await route.continue(); return; }
      firstReview = false;
      const response = await route.fetch();
      const body = await response.json();
      body.criteria = [];
      reportOldReviewCaptured();
      await reviewGate;
      await route.fulfill({ response, json: body });
      reportOldReviewDelivered();
    });
    await page.getByRole('button', { name: '打开 审阅项目' }).click();
    await oldReviewCaptured;
    await page.evaluate(() => window.dispatchEvent(new Event('specmill:review-refresh')));
    const freshCriterion = page.getByText('条件 1：新验收条件', { exact: false });
    await expect(freshCriterion).toBeVisible();
    releaseOldReview();
    await oldReviewDelivered;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(freshCriterion).toBeVisible();
    await page.unroute(/\/api\/v1\/changes\/[^/]+\/review$/);
    const retiredHistory = page.locator('details').filter({ has: page.getByText('已不在当前条件中的失败处置（2）') });
    await retiredHistory.locator('summary').click();
    await expect(retiredHistory.getByText('条件二：文档齐全', { exact: false }).first()).toBeVisible();
    await expect(retiredHistory.getByText(failure.resourceId, { exact: false }).first()).toBeVisible();
    await expect(retiredHistory.getByText('该失败不适用于本次冻结目标', { exact: false })).toBeVisible();
  } finally {
    await page.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  }
});
