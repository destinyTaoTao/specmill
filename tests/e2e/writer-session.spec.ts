import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../src/server/app.js';

test('a user starts and releases a manual writer session', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-session-'));
  const repoDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-repo-'));
  const init = spawnSync('git', ['-C', repoDir, 'init', '-q'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } });
  if (init.status !== 0) throw new Error(init.stderr);
  const app = await buildApp({ dataDir, port: 43230, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  try {
    await app.listen({ host: '127.0.0.1', port: 43230 });
    await page.goto('http://127.0.0.1:43230');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('项目名称').fill('会话页面');
    await page.getByRole('button', { name: '创建项目' }).click();
    await page.getByRole('button', { name: '打开 会话页面' }).click();
    await page.getByLabel('工作目录').fill(repoDir);
    await page.getByRole('button', { name: '登记工作区' }).click();
    await page.getByRole('button', { name: '观察工作区' }).click();
    await expect(page.getByText(/观察时间：/)).toBeVisible();
    const create = page.getByRole('form', { name: '新建变更' });
    await create.getByLabel('变更标题').fill('需要续做');
    await create.getByLabel('目标', { exact: true }).fill('完成一次续做');
    await create.getByRole('button', { name: '创建变更' }).click();
    await expect(page.getByText('当前没有活跃写会话。')).toBeVisible();
    await page.getByLabel('会话工作区').selectOption({ index: 1 });
    await page.getByRole('button', { name: '开始手动会话' }).click();
    await expect(page.getByText(/活跃：Web 手动 · 代次 1/)).toBeVisible();
    await page.getByRole('button', { name: '填写保存点' }).click();
    const checkpoint = page.getByRole('form', { name: '保存点' });
    await checkpoint.getByLabel('工作区观察').selectOption({ index: 1 });
    await checkpoint.getByLabel('已完成').fill('已经完成一部分');
    await checkpoint.getByLabel('已知失败').fill('测试暂时失败');
    await checkpoint.getByLabel('未验证').fill('恢复未验证');
    await checkpoint.getByLabel('阻塞项').fill('无');
    await checkpoint.getByLabel('下一步').fill('继续排查');
    await page.route('**/api/v1/changes/*/checkpoints', async route => {
      if (route.request().method() === 'POST') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'SERVICE_UNAVAILABLE', message: '模拟保存失败', requestId: 'test-error' }) });
      else await route.continue();
    });
    await checkpoint.getByRole('button', { name: '保存进度' }).click();
    await expect(page.getByRole('alert')).toContainText('保存结果未知');
    await expect(checkpoint.getByLabel('下一步')).toHaveValue('继续排查');
    await page.unroute('**/api/v1/changes/*/checkpoints');
    await checkpoint.getByRole('button', { name: '按原请求重试' }).click();
    await page.getByText('保存点历史（1）').click();
    await expect(page.getByText('失败：测试暂时失败')).toBeVisible();
    await page.getByRole('button', { name: '填写保存点' }).click();
    await checkpoint.getByLabel('工作区观察').selectOption({ index: 1 });
    await checkpoint.getByLabel('已完成').fill('保存后响应丢失');
    await checkpoint.getByLabel('已知失败').fill('无');
    await checkpoint.getByLabel('未验证').fill('无');
    await checkpoint.getByLabel('阻塞项').fill('无');
    await checkpoint.getByLabel('下一步').fill('查询回执');
    await page.route('**/api/v1/changes/*/checkpoints', async route => {
      if (route.request().method() === 'POST') { await route.fetch(); await route.abort('failed'); }
      else await route.continue();
    });
    await checkpoint.getByRole('button', { name: '保存进度' }).click();
    await expect(page.getByRole('alert')).toContainText('保存结果未知');
    await page.unroute('**/api/v1/changes/*/checkpoints');
    await page.reload();
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByRole('button', { name: '打开 会话页面' }).click();
    await expect(page.getByText(/待确认请求/)).toBeVisible();
    await page.getByRole('button', { name: '查询保存回执' }).click();
    await expect(page.getByText('已确认保存进度。')).toBeVisible();
    await expect(page.getByText('保存点历史（2）')).toBeVisible();
    await page.getByRole('button', { name: '结束手动会话' }).click();
    await expect(page.getByText('当前没有活跃写会话。')).toBeVisible();
    const ids = await page.evaluate(async () => {
      const projects = await (await fetch('/api/v1/projects')).json();
      const projectId = projects.projects[0].id as string;
      const changes = await (await fetch(`/api/v1/projects/${projectId}/changes`)).json();
      const workspaces = await (await fetch(`/api/v1/projects/${projectId}/workspaces`)).json();
      return { changeId: changes.changes[0].id as string, version: changes.changes[0].version as number, workspaceId: workspaces.workspaces[0].id as string };
    });
    const agentSession = await app.inject({ method: 'POST', url: `/api/v1/changes/${ids.changeId}/writer-sessions`, headers: { host: '127.0.0.1:43230', authorization: 'Bearer test-agent', 'x-specmill-writer-token': 'b'.repeat(64) },
      payload: { requestId: 'e2e-agent-session', expectedVersion: ids.version, payload: { workspaceId: ids.workspaceId, expectedBindingVersion: 1, toolLabel: '失联工具' } } });
    expect(agentSession.statusCode).toBe(201);
    await page.getByRole('button', { name: '刷新会话状态' }).click();
    await expect(page.getByText(/活跃：失联工具/)).toBeVisible();
    await page.getByRole('button', { name: '查看保存点并接管' }).click();
    await expect(page.getByRole('heading', { name: '接管前核对' }).locator('..').getByText('已完成：保存后响应丢失')).toBeVisible();
    await page.getByLabel('已核对最后保存点并确认接管').check();
    await page.getByRole('button', { name: '确认接管', exact: true }).click();
    await expect(page.getByText(/活跃：Web 接管/)).toBeVisible();
    const staleRelease = await app.inject({ method: 'POST', url: `/api/v1/writer-sessions/${agentSession.json().resourceId}/release`, headers: { host: '127.0.0.1:43230', authorization: 'Bearer test-agent', 'x-specmill-writer-token': 'b'.repeat(64) },
      payload: { requestId: 'e2e-stale-release', expectedVersion: ids.version + 2, generation: agentSession.json().generation } });
    expect(staleRelease.statusCode).toBe(409);
    await page.getByRole('button', { name: '结束手动会话' }).click();
    await expect(page.getByText('当前没有活跃写会话。')).toBeVisible();
  } finally {
    await page.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  }
});
