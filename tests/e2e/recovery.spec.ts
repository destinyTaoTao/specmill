import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../src/server/app.js';

test('the user restores a package in the browser, rebinds the workspace and continues', async ({ page }) => {
  const dataDirA = await mkdtemp(join(tmpdir(), 'specmill-e2e-recovery-a-'));
  const repoDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-recovery-repo-'));
  const dataDirB = await mkdtemp(join(tmpdir(), 'specmill-e2e-recovery-b-'));
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_AUTHOR_NAME: '测试', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: '测试', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', env: gitEnv });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  git(['init', '-q']);
  await writeFile(join(repoDir, 'README.md'), '# 恢复样本\n');
  git(['add', 'README.md']);
  git(['commit', '-q', '-m', 'init']);
  // 源实例：建项目并导出（浏览器完成登录与创建，CLI 风格 fetch 完成导出）
  const sourceApp = await buildApp({ dataDir: dataDirA, port: 43236, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  let targetApp: Awaited<ReturnType<typeof buildApp>> | null = null;
  try {
    await sourceApp.listen({ host: '127.0.0.1', port: 43236 });
    await page.goto('http://127.0.0.1:43236');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('项目名称').fill('恢复源项目');
    await page.getByRole('button', { name: '创建项目' }).click();
    await expect(page.getByText('打开 恢复源项目')).toBeVisible();
    const cookie = ((await page.context().cookies(['http://127.0.0.1:43236'])).find(item => item.name === 'specmill_session'))!.value;
    const ownerHeaders = { 'content-type': 'application/json', origin: 'http://127.0.0.1:43236', cookie: `specmill_session=${cookie}`, 'x-specmill-request': '1' };
    const projectId = ((await (await fetch('http://127.0.0.1:43236/api/v1/projects', { headers: { origin: 'http://127.0.0.1:43236', cookie: `specmill_session=${cookie}` } })).json()).projects[0]).id as string;
    const exported = await (await fetch(`http://127.0.0.1:43236/api/v1/projects/${projectId}/exports`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ requestId: 'recovery-e2e-export' }) })).json();
    await fetch(`http://127.0.0.1:43236/api/v1/exports/${exported.resourceId}`, { headers: { origin: 'http://127.0.0.1:43236', cookie: `specmill_session=${cookie}` } });
    const zip = Buffer.from(await (await fetch(`http://127.0.0.1:43236/api/v1/exports/${exported.resourceId}/download`, { headers: { origin: 'http://127.0.0.1:43236', cookie: `specmill_session=${cookie}` } })).arrayBuffer());
    await sourceApp.close();
    // 恢复实例：独立数据目录启动，用户在浏览器上传恢复包
    targetApp = await buildApp({ dataDir: dataDirB, port: 43236, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
    await targetApp.listen({ host: '127.0.0.1', port: 43236 });
    await page.goto('http://127.0.0.1:43236');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('从恢复包恢复（.zip，仅恢复记录与附件，不含源码）').setInputFiles({ name: 'export.zip', mimeType: 'application/zip', buffer: zip });
    await expect(page.getByText('项目记录与附件已恢复')).toBeVisible();
    await expect(page.getByText('请打开项目重新绑定工作目录后再续做；恢复成功不代表源码已备份。')).toBeVisible();
    await expect(page.getByText('打开 恢复源项目')).toBeVisible();
    // 打开恢复的项目：历史可读；重新绑定源码目录后可继续
    await page.getByRole('button', { name: '打开 恢复源项目' }).click();
    await page.getByLabel('工作目录').fill(repoDir);
    await page.getByRole('button', { name: '登记工作区' }).click();
    await expect(page.getByText(/绑定版本 1/)).toBeVisible();
  } finally {
    await page.close();
    await sourceApp.close().catch(() => {});
    if (targetApp) await targetApp.close().catch(() => {});
    await rm(dataDirA, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
    await rm(dataDirB, { recursive: true, force: true });
  }
});
