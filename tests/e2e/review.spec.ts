import { test, expect } from '@playwright/test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { rm } from './cleanup.js';

test('the user completes the frozen-version acceptance through the review workspace', async ({ page }) => {
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
  const specContent = '# 验收规格\n\n- 条件一：功能通过\n- 条件二：文档齐全\n';
  await writeFile(join(repoDir, 'spec.md'), specContent);
  git(['add', 'README.md', 'spec.md']);
  git(['commit', '-q', '-m', 'init']);
  const headSha = git(['rev-parse', 'HEAD']).trim();
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
    const create = page.getByRole('form', { name: '新建变更' });
    await create.getByLabel('变更标题').fill('审阅变更');
    await create.getByLabel('目标', { exact: true }).fill('完成冻结版本验收');
    await create.getByLabel('验收条件（每行一项）').fill('条件一：功能通过\n条件二：文档齐全');
    await create.getByRole('button', { name: '创建变更' }).click();
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
    const run = await (await post(`/api/v1/changes/${changeId}/executions`, { requestId: 'e2e-review-run', workspaceId, payload: { method: 'node --test', result: 'passed', claimedCommit: headSha, claimedClean: true } }, 'a'.repeat(64))).json();
    const baselineId = (await (await fetch(`http://127.0.0.1:43234/api/v1/changes/${changeId}/baselines`, { headers: { origin: 'http://127.0.0.1:43234', cookie: `specmill_session=${cookie}` } })).json()).baselines[0].id as string;
    const criteria = (await (await fetch(`http://127.0.0.1:43234/api/v1/changes/${changeId}/baselines/${baselineId}`, { headers: { origin: 'http://127.0.0.1:43234', cookie: `specmill_session=${cookie}` } })).json()).criteria as { id: string }[];
    const evidence1 = await (await post(`/api/v1/changes/${changeId}/evidence`, { requestId: 'e2e-review-ev1', payload: { executionId: run.resourceId, criterion: { kind: 'baseline', baselineId, criterionId: criteria[0].id }, criterionIndex: 1, result: 'passed', actualCommit: headSha } }, 'a'.repeat(64))).json();
    const evidence2 = await (await post(`/api/v1/changes/${changeId}/evidence`, { requestId: 'e2e-review-ev2', payload: { executionId: run.resourceId, criterion: { kind: 'baseline', baselineId, criterionId: criteria[1].id }, criterionIndex: 2, result: 'passed', actualCommit: headSha } }, 'a'.repeat(64))).json();
    void evidence1;
    void evidence2;
    const target = await (await post(`/api/v1/changes/${changeId}/acceptance-targets`, { requestId: 'e2e-review-target', payload: { commit: headSha } }, 'a'.repeat(64))).json();
    const proposal = await (await post(`/api/v1/changes/${changeId}/acceptance-proposals`, { requestId: 'e2e-review-proposal', expectedVersion: 2, payload: { reason: '证据与目标就绪', targetId: target.resourceId } }, 'a'.repeat(64))).json();
    expect(proposal.resourceId).toBeTruthy();
    // 浏览器外的提交需要刷新页面才能看到最新状态
    await page.getByRole('button', { name: '返回项目列表' }).click();
    await page.getByRole('button', { name: '打开 审阅项目' }).click();
    await expect(page.getByText(/审阅中 · 周期 1/)).toBeVisible();
    // 用户确认实现目标
    await page.getByText('实现目标候选（1）').click();
    await page.getByRole('button', { name: '确认此实现目标' }).click();
    await expect(page.getByText('已确认实现目标（完整 commit 及仓库身份）。')).toBeVisible();
    // 预览两条件的确认（默认已选中合格证据）并完成最终验收
    await page.getByRole('button', { name: '生成确认预览' }).click();
    await expect(page.getByText('确认预览已生成')).toBeVisible();
    await page.getByRole('button', { name: /完成最终验收/ }).click();
    await expect(page.getByText('已完成冻结版本验收。')).toBeVisible();
    await expect(page.getByText(/已验收 · 周期 1/)).toBeVisible();
    // 已验收的变更不可再保存进度
    await expect(page.getByText('该变更已完成冻结版本验收；后续问题请重新打开或建立新变更。')).toBeVisible();
    // 重新打开进入新周期
    await page.getByRole('button', { name: '重新打开 审阅变更' }).click();
    await page.getByLabel('重新打开原因').fill('验收后发现新的改进点');
    await page.getByRole('button', { name: '确认重新打开' }).click();
    await expect(page.getByText(/开发中 · 周期 2/)).toBeVisible();
  } finally {
    await page.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  }
});
