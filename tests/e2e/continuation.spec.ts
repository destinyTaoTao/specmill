import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { rm } from './cleanup.js';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../src/server/app.js';

test('a saved change generates a fixed handoff and compares real files', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-handoff-data-'));
  const repoDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-handoff-repo-'));
  const init = spawnSync('git', ['-C', repoDir, 'init', '-q'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } });
  if (init.status !== 0) throw new Error(init.stderr);
  const app = await buildApp({ dataDir, port: 43233, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  try {
    await app.listen({ host: '127.0.0.1', port: 43233 });
    await page.goto('http://127.0.0.1:43233');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('项目名称').fill('续做项目');
    await page.getByRole('button', { name: '创建项目' }).click();
    await page.getByRole('button', { name: '打开 续做项目' }).click();
    await page.getByLabel('工作目录').fill(repoDir);
    await page.getByRole('button', { name: '登记工作区' }).click();
    await page.getByRole('button', { name: '观察工作区' }).click();
    await expect(page.getByText(/观察时间：/)).toBeVisible();
    const create = page.getByRole('form', { name: '新建变更' });
    await create.getByLabel('变更标题').fill('续做变更');
    await create.getByLabel('目标', { exact: true }).fill('完成续做核对');
    await create.getByRole('button', { name: '创建变更' }).click();
    await page.getByLabel('会话工作区').selectOption({ index: 1 });
    await page.getByRole('button', { name: '开始手动会话' }).click();
    await expect(page.getByText(/活跃：Web 手动 · 代次 1/)).toBeVisible();
    await page.getByRole('button', { name: '填写保存点' }).click();
    const checkpoint = page.getByRole('form', { name: '保存点' });
    await checkpoint.getByLabel('工作区观察').selectOption({ index: 1 });
    await checkpoint.getByLabel('已完成').fill('完成初始化');
    await checkpoint.getByLabel('已知失败').fill('无');
    await checkpoint.getByLabel('未验证').fill('交接渲染未验证');
    await checkpoint.getByLabel('阻塞项').fill('无');
    await checkpoint.getByLabel('下一步').fill('切换工具继续');
    await checkpoint.getByRole('button', { name: '保存进度' }).click();
    await expect(page.getByText('已确认保存进度。')).toBeVisible();
    // 生成固定交接并渲染确定性材料
    await page.getByRole('button', { name: '生成固定交接' }).click();
    await expect(page.getByText('交接文件已生成')).toBeVisible();
    await expect(page.getByText(/捕获版本 3/)).toBeVisible();
    await page.getByRole('button', { name: '读取固定交接' }).click();
    const material = page.locator('[aria-label="固定交接材料"]');
    await expect(material).toBeVisible();
    await expect(material).toContainText('完成续做核对');
    await expect(material).toContainText('切换工具继续');
    await expect(material).toContainText('续做须知');
    // 干净状态下核对：无未保存工作
    await page.getByLabel('续做核对工作区').selectOption({ index: 1 });
    await page.getByRole('button', { name: '对比最近保存点与当前文件' }).click();
    await expect(page.getByText('未检测到比最近保存点更新的文件状态')).toBeVisible();
    // 保存后新增源码改动：材料过时被识别，文件不被回滚
    await writeFile(join(repoDir, 'notes.txt'), '工具 A 保存之后的新工作\n');
    await page.getByRole('button', { name: '对比最近保存点与当前文件' }).click();
    await expect(page.getByText('检测到比最近保存点更新的文件状态')).toBeVisible();
    await expect(page.getByText('新增 ?? notes.txt')).toBeVisible();
    expect(await readFile(join(repoDir, 'notes.txt'), 'utf8')).toContain('工具 A 保存之后的新工作');
  } finally {
    await page.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  }
});
