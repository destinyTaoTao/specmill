import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildApp } from '../../src/server/app.js';

test('user logs in and sees a saved project after restart', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-'));
  const options = { dataDir, port: 43219, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') };
  let app = await buildApp(options);
  try {
    await app.listen({ host: '127.0.0.1', port: options.port });
    await page.goto('http://127.0.0.1:43219');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('项目名称').fill('浏览器测试项目');
    await page.getByRole('button', { name: '创建项目' }).click();
    await expect(page.getByText('浏览器测试项目', { exact: true })).toBeVisible();
    await app.close();
    app = await buildApp(options);
    await app.listen({ host: '127.0.0.1', port: options.port });
    await page.reload();
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByText('浏览器测试项目', { exact: true })).toBeVisible();
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('user sees the reason for a rejected project and keeps the input', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-'));
  const app = await buildApp({ dataDir, port: 43220, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  try {
    await app.listen({ host: '127.0.0.1', port: 43220 });
    await page.goto('http://127.0.0.1:43220');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('项目名称').fill('   ');
    await page.getByRole('button', { name: '创建项目' }).click();
    await expect(page.getByRole('alert')).toContainText('项目名称不能为空');
    await expect(page.getByLabel('项目名称')).toHaveValue('   ');
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a saved project is not presented as unsaved when the list refresh fails', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-'));
  const app = await buildApp({ dataDir, port: 43221, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  try {
    await app.listen({ host: '127.0.0.1', port: 43221 });
    await page.goto('http://127.0.0.1:43221');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByLabel('项目名称')).toBeVisible();
    let failNextRead = false;
    await page.route('**/api/v1/projects', async route => {
      if (route.request().method() === 'POST') { failNextRead = true; await route.continue(); return; }
      if (failNextRead) { failNextRead = false; await route.fulfill({ status: 503, body: 'unavailable' }); return; }
      await route.continue();
    });
    await page.getByLabel('项目名称').fill('已保存项目');
    await page.getByRole('button', { name: '创建项目' }).click();
    await expect(page.getByRole('alert')).toContainText('项目已保存，但列表刷新失败');
    await expect(page.getByLabel('项目名称')).toHaveValue('');
    const projects = await page.evaluate(async () => (await (await fetch('/api/v1/projects')).json()).projects);
    expect(projects.filter((project: { name: string }) => project.name === '已保存项目')).toHaveLength(1);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('project input cannot change while a create request is in flight', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-'));
  const app = await buildApp({ dataDir, port: 43224, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  let releaseRequest = () => {};
  const pending = new Promise<void>(resolveRequest => { releaseRequest = resolveRequest; });
  try {
    await app.listen({ host: '127.0.0.1', port: 43224 });
    await page.goto('http://127.0.0.1:43224');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByLabel('项目名称')).toBeVisible();
    await page.route('**/api/v1/projects', async route => {
      if (route.request().method() === 'POST') await pending;
      await route.continue();
    });
    await page.getByLabel('项目名称').fill('正在保存');
    await page.getByRole('button', { name: '创建项目' }).click();
    await expect(page.getByLabel('项目名称')).toBeDisabled({ timeout: 1000 });
    releaseRequest();
    await expect(page.getByText('正在保存', { exact: true })).toBeVisible();
  } finally {
    releaseRequest();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('retry after a lost create response does not create a duplicate', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-'));
  const app = await buildApp({ dataDir, port: 43222, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  try {
    await app.listen({ host: '127.0.0.1', port: 43222 });
    await page.goto('http://127.0.0.1:43222');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByLabel('项目名称')).toBeVisible();
    let loseResponse = true;
    await page.route('**/api/v1/projects', async route => {
      if (route.request().method() === 'POST' && loseResponse) {
        loseResponse = false;
        await route.fetch();
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    await page.getByLabel('项目名称').fill('丢失响应项目');
    await page.getByRole('button', { name: '创建项目' }).click();
    await expect(page.getByRole('alert')).toContainText('结果未知');
    await expect(page.getByLabel('项目名称')).toHaveValue('丢失响应项目');
    await page.getByRole('button', { name: '创建项目' }).click();
    await expect(page.getByText('丢失响应项目', { exact: true })).toHaveCount(1);
    const projects = await page.evaluate(async () => (await (await fetch('/api/v1/projects')).json()).projects);
    expect(projects.filter((project: { name: string }) => project.name === '丢失响应项目')).toHaveLength(1);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('user binds a Git workspace and observes uncommitted files', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-'));
  const repoDir = await mkdtemp(join(tmpdir(), 'specmill-中文 仓库-'));
  const init = spawnSync('git', ['-C', repoDir, 'init', '-q'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } });
  if (init.status !== 0) throw new Error(init.stderr);
  await writeFile(join(repoDir, 'unfinished.txt'), 'unfinished');
  const app = await buildApp({ dataDir, port: 43223, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  try {
    await app.listen({ host: '127.0.0.1', port: 43223 });
    await page.goto('http://127.0.0.1:43223');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('项目名称').fill('工作区浏览测试');
    await page.getByRole('button', { name: '创建项目' }).click();
    await page.getByRole('button', { name: '打开 工作区浏览测试' }).click();
    await page.getByLabel('工作目录').fill(repoDir);
    await page.getByRole('button', { name: '登记工作区' }).click();
    await page.getByLabel('未跟踪文件（每行一个相对路径）').fill('unfinished.txt');
    await page.getByRole('button', { name: '观察工作区' }).click();
    await expect(page.getByText('尚无提交', { exact: true })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'unfinished.txt' })).toBeVisible();
    await expect(page.getByText(/9b569cd062350ef2/)).toBeVisible();
    await expect(page.getByText(/忽略文件未覆盖/)).toBeVisible();
    await writeFile(join(repoDir, 'unfinished.txt'), 'changed');
    await page.getByRole('button', { name: '观察工作区' }).click();
    const history = page.getByLabel('查看历史观察');
    await expect(history.locator('option')).toHaveCount(2);
    await history.selectOption({ index: 1 });
    await expect(page.getByText(/9b569cd062350ef2/)).toBeVisible();
    await expect(page.getByText(/观察路径：/)).toBeVisible();
    await page.getByRole('button', { name: '返回项目列表' }).click();
    await page.getByRole('button', { name: '打开 工作区浏览测试' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: 'unfinished.txt' })).toBeVisible();
    await expect(page.getByLabel('查看历史观察').locator('option')).toHaveCount(2);
    await page.getByLabel('查看历史观察').selectOption({ index: 1 });
    await expect(page.getByText(/9b569cd062350ef2/)).toBeVisible();
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('user confirms a moved repository when no commit can establish its identity', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-'));
  const repoParent = await mkdtemp(join(tmpdir(), 'specmill-move-'));
  const repoDir = join(repoParent, 'original');
  const movedDir = join(repoParent, 'moved');
  await mkdir(repoDir);
  const init = spawnSync('git', ['-C', repoDir, 'init', '-q'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } });
  if (init.status !== 0) throw new Error(init.stderr);
  const app = await buildApp({ dataDir, port: 43225, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  try {
    await app.listen({ host: '127.0.0.1', port: 43225 });
    await page.goto('http://127.0.0.1:43225');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('项目名称').fill('移动仓库测试');
    await page.getByRole('button', { name: '创建项目' }).click();
    await page.getByRole('button', { name: '打开 移动仓库测试' }).click();
    await page.getByLabel('工作目录').fill(repoDir);
    await page.getByRole('button', { name: '登记工作区' }).click();
    await expect(page.getByLabel('更换工作目录')).toBeVisible();
    if (dirname(resolve(repoDir)) !== resolve(repoParent) || dirname(resolve(movedDir)) !== resolve(repoParent)) throw new Error('Invalid test move target');
    await rename(repoDir, movedDir);
    await page.getByLabel('更换工作目录').fill(movedDir);
    await page.getByRole('button', { name: '更换绑定' }).click();
    await expect(page.getByRole('alert')).toContainText('没有可核对的历史提交');
    let loseConfirmation = true;
    await page.route('**/api/v1/projects/*/workspaces', async route => {
      if (route.request().method() === 'POST' && loseConfirmation) {
        loseConfirmation = false;
        await route.fetch();
        await route.abort('failed');
        return;
      }
      await route.continue();
    });
    await page.getByRole('button', { name: '确认仍要绑定' }).click();
    await expect(page.getByRole('alert')).toContainText('结果未知');
    await expect(page.getByRole('button', { name: '确认仍要绑定' })).toBeVisible({ timeout: 1000 });
    await page.getByRole('button', { name: '确认仍要绑定' }).click();
    await expect(page.getByText(/绑定版本 2/)).toBeVisible();
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(repoParent, { recursive: true, force: true });
  }
});

test('user creates, edits, cancels and reopens a change draft', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-'));
  const app = await buildApp({ dataDir, port: 43226, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  try {
    await app.listen({ host: '127.0.0.1', port: 43226 });
    await page.goto('http://127.0.0.1:43226');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('项目名称').fill('草案页面测试');
    await page.getByRole('button', { name: '创建项目' }).click();
    await page.getByRole('button', { name: '打开 草案页面测试' }).click();
    const create = page.getByRole('form', { name: '新建变更' });
    await create.getByLabel('变更标题').fill('续做草案');
    await create.getByLabel('目标', { exact: true }).fill('保留目标');
    await create.getByLabel('范围', { exact: true }).fill('个人项目');
    await create.getByLabel('非目标').fill('多人审批');
    await create.getByLabel('验收条件（每行一项）').fill('可以读取保存点');
    await create.getByRole('button', { name: '创建变更' }).click();
    await page.getByRole('button', { name: '编辑 续做草案' }).click();
    const edit = page.getByRole('form', { name: '编辑变更' });
    await edit.getByRole('textbox', { name: '目标', exact: true }).fill('更新的目标');
    await edit.getByRole('button', { name: '保存草案' }).click();
    await expect(page.getByRole('button', { name: '编辑 续做草案' })).toBeVisible();
    await expect(page.getByText('更新的目标', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '取消变更 续做草案' }).click();
    await page.getByLabel('取消原因').fill('暂缓');
    await page.getByRole('button', { name: '确认取消' }).click();
    await expect(page.getByText(/已取消 · 版本 3/)).toBeVisible();
    await page.getByText('状态历史').click();
    await expect(page.getByText(/原因：暂缓/)).toBeVisible();
    await page.getByRole('button', { name: '重新打开 续做草案' }).click();
    await expect(page.getByText(/草案 · 周期 2/)).toBeVisible();
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('user previews Markdown and freezes a baseline', async ({ page }) => {
  test.setTimeout(60000);
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-'));
  const repoDir = await mkdtemp(join(tmpdir(), 'specmill-spec-e2e-'));
  const init = spawnSync('git', ['-C', repoDir, 'init', '-q'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } });
  if (init.status !== 0) throw new Error(init.stderr);
  await writeFile(join(repoDir, 'spec.md'), '# 目标\r\n允许续做。\r\n<script>window.specmillInjected = true</script>');
  const app = await buildApp({ dataDir, port: 43227, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  try {
    await app.listen({ host: '127.0.0.1', port: 43227 });
    await page.goto('http://127.0.0.1:43227');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('项目名称').fill('冻结基线测试');
    await page.getByRole('button', { name: '创建项目' }).click();
    await page.getByRole('button', { name: '打开 冻结基线测试' }).click();
    await page.getByLabel('工作目录').fill(repoDir);
    await page.getByRole('button', { name: '登记工作区' }).click();
    const create = page.getByRole('form', { name: '新建变更' });
    await create.getByLabel('变更标题').fill('规格变更');
    await create.getByLabel('验收条件（每行一项）').fill('可保存进度');
    await create.getByRole('button', { name: '创建变更' }).click();
    await expect(page.getByRole('button', { name: '规格 规格变更' })).toBeVisible({ timeout: 1000 });
    await page.getByRole('button', { name: '规格 规格变更' }).click();
    await page.getByLabel('规格工作区').selectOption({ index: 1 });
    await page.getByLabel('Markdown 相对路径').fill('spec.md');
    await page.getByRole('button', { name: '预览规格' }).click();
    await expect(page.locator('pre').filter({ hasText: 'window.specmillInjected' })).toBeVisible();
    expect(await page.evaluate(() => Object.prototype.hasOwnProperty.call(window, 'specmillInjected'))).toBe(false);
    await page.getByLabel('选定的规格摘录').fill('# 目标\n允许续做。');
    await page.getByRole('button', { name: '确认规格基线' }).click();
    await expect(page.getByText(/开发中 · 周期 1/)).toBeVisible();
    await expect(page.locator('pre').filter({ hasText: '允许续做。' })).toBeVisible();
    await expect(page.getByText(/来源尚未提交/)).toBeVisible();
    await writeFile(join(repoDir, 'spec.md'), '# 新来源');
    await page.getByRole('button', { name: '规格 规格变更' }).click();
    await page.getByRole('button', { name: '规格 规格变更' }).click();
    await expect(page.getByText(/来源已变化/)).toBeVisible();
    await expect(page.locator('pre').filter({ hasText: '允许续做。' })).toBeVisible();
    await page.getByLabel('规格工作区').selectOption({ index: 1 });
    await page.getByLabel('Markdown 相对路径').fill('spec.md');
    await page.getByRole('button', { name: '预览规格' }).click();
    await page.getByLabel('规格条目关联').selectOption({ index: 1 });
    await expect(page.getByText('与当前基线比较')).toBeVisible();
    await page.getByRole('button', { name: '确认规格基线' }).click();
    await expect(page.getByText(/版本 3/)).toBeVisible();
    await page.getByLabel('查看历史基线').selectOption({ index: 1 });
    await expect(page.locator('pre').filter({ hasText: '允许续做。' })).toBeVisible();
    await page.getByRole('button', { name: '取消变更 规格变更' }).click();
    await page.getByLabel('取消原因').fill('暂缓');
    await page.getByRole('button', { name: '确认取消' }).click();
    const reopen = page.getByRole('button', { name: '重新打开 规格变更' });
    await expect(reopen).toBeDisabled();
    await page.getByLabel('确认继续采用已有规格基线').check();
    await reopen.click();
    await expect(page.getByText(/开发中 · 周期 2/)).toBeVisible();
  } finally {
    await page.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('an older draft form cannot overwrite a refreshed version', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-'));
  const app = await buildApp({ dataDir, port: 43228, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  try {
    await app.listen({ host: '127.0.0.1', port: 43228 });
    await page.goto('http://127.0.0.1:43228');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('项目名称').fill('并发草案');
    await page.getByRole('button', { name: '创建项目' }).click();
    await page.getByRole('button', { name: '打开 并发草案' }).click();
    const create = page.getByRole('form', { name: '新建变更' });
    await create.getByLabel('变更标题').fill('待编辑');
    await create.getByLabel('范围', { exact: true }).fill('旧范围');
    await create.getByRole('button', { name: '创建变更' }).click();
    await page.getByRole('button', { name: '编辑 待编辑' }).click();
    const edit = page.getByRole('form', { name: '编辑变更' });
    await edit.getByLabel('目标', { exact: true }).fill('本页未保存的目标');
    const response = await page.evaluate(async () => {
      const projects = await (await fetch('/api/v1/projects')).json();
      const changes = await (await fetch(`/api/v1/projects/${projects.projects[0].id}/changes`)).json();
      return (await fetch(`/api/v1/changes/${changes.changes[0].id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify({ requestId: 'another-view-update', expectedVersion: 1, payload: { title: '待编辑', goal: '', scope: '新范围', nonGoals: '', criteria: [] } }) })).status;
    });
    expect(response).toBe(200);
    await create.getByLabel('变更标题').fill('触发刷新');
    await create.getByRole('button', { name: '创建变更' }).click();
    await expect(page.getByText(/草案 · 周期 1 · 版本 2/)).toBeVisible();
    await edit.getByRole('button', { name: '保存草案' }).click();
    await expect(page.getByRole('alert')).toContainText('变更已更新');
    await expect(page.locator('form[aria-label="编辑变更"] textarea').first()).toHaveValue('本页未保存的目标');
    const saved = await page.evaluate(async () => {
      const projects = await (await fetch('/api/v1/projects')).json();
      const changes = await (await fetch(`/api/v1/projects/${projects.projects[0].id}/changes`)).json();
      return changes.changes.find((change: { title: string }) => change.title === '待编辑').scope;
    });
    expect(saved).toBe('新范围');
  } finally {
    await page.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
