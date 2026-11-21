import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../src/server/app.js';
import type { PilotDetail } from '../../src/server/pilot/ledger.js';
import { rm } from './cleanup.js';

async function login(page: Page) {
  await page.getByLabel('本次登录口令').fill('test-owner');
  await page.getByRole('button', { name: '登录' }).click();
}

test('owner can replay a lost freeze receipt, return evidence, and archive the accepted attempt', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-pilot-web-'));
  const port = 43264;
  const app = await buildApp({
    dataDir, port, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist'),
    pilot: { agentBin: process.execPath, workerModule: new URL('../fixtures/pilot-worker.mjs', import.meta.url) },
  });
  try {
    await app.listen({ host: '127.0.0.1', port });
    await page.goto(`http://127.0.0.1:${port}`);
    await login(page);
    const panel = page.getByRole('region', { name: '团队工作流试点' });
    await panel.getByRole('button', { name: '新建订单筛选试运行' }).click();
    const freeze = panel.getByRole('button', { name: '冻结规格', exact: true });
    await expect(freeze).toBeDisabled();
    await panel.getByRole('checkbox').check();
    await page.route('**/api/v1/pilot/runs/*/decisions', async route => {
      expect((await route.fetch()).ok()).toBe(true);
      await route.abort('failed');
    }, { times: 1 });
    await freeze.click();
    await expect(panel.getByRole('alert')).toContainText('结果未知');
    await page.reload();
    await login(page);
    await panel.getByRole('button', { name: '重试原请求' }).click();
    await expect(panel.getByRole('status')).toContainText('待人工审阅');
    await expect(panel.getByText(/规格已在版本.*冻结/)).toBeVisible();
    const firstAttempt = panel.getByRole('region', { name: '执行尝试 1' });
    await expect(firstAttempt.locator('pre')).toContainText(/SELECT/i);
    await expect(firstAttempt.getByText('paid-only · 通过')).toBeVisible();

    await panel.getByLabel('审阅决定').selectOption('return');
    const returnButton = panel.getByRole('button', { name: '退回返工', exact: true });
    await expect(returnButton).toBeDisabled();
    await panel.getByLabel(/返工意见/).fill('请再次核对稳定排序');
    await panel.getByRole('checkbox').check();
    await returnButton.click();
    const secondAttempt = panel.getByRole('region', { name: '执行尝试 2' });
    await expect(secondAttempt.getByText('paid-only · 通过')).toBeVisible();
    await expect(secondAttempt).toContainText('请再次核对稳定排序');
    await expect(firstAttempt.locator('pre')).toBeVisible();
    const accept = panel.getByRole('button', { name: '验收归档', exact: true });
    await expect(accept).toBeDisabled();
    await panel.getByLabel('验收理由').fill('已核对第二次提交的 SQL 和三个条件');
    await panel.getByRole('checkbox').check();
    await accept.click();
    await expect(panel.getByRole('status')).toContainText('已验收归档');
    const downloadPromise = page.waitForEvent('download');
    await panel.getByRole('link', { name: /下载验收归档/ }).click();
    const download = await downloadPromise;
    const archive = JSON.parse(await readFile((await download.path())!, 'utf8')) as PilotDetail;
    expect(archive.status).toBe('archived');
    expect(archive.attempts).toHaveLength(2);
    expect(archive.events.filter(event => event.action === 'freeze')).toHaveLength(1);
    expect(archive.events.at(-1)).toMatchObject({ action: 'accept', reason: '已核对第二次提交的 SQL 和三个条件' });
  } finally {
    await page.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('default workbench keeps the pilot hidden', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-web-no-pilot-'));
  const port = 43265;
  const app = await buildApp({ dataDir, port, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  try {
    await app.listen({ host: '127.0.0.1', port });
    await page.goto(`http://127.0.0.1:${port}`);
    const listResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/pilot/runs'));
    await login(page);
    expect((await listResponse).status()).toBe(404);
    await expect(page.getByRole('region', { name: '团队工作流试点' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '创建项目' })).toBeVisible();
  } finally {
    await page.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
