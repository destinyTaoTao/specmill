import { expect, test, type Page } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { rm } from './cleanup.js';

async function issue(page: Page, name: string) {
  await page.getByLabel('成员名称').fill(name);
  await page.getByRole('button', { name: '签发成员凭据' }).click();
  await expect(page.getByText('请将此凭据交给 ' + name, { exact: false })).toBeVisible();
  const token = await page.getByLabel('新签发的成员凭据').innerText();
  await page.getByRole('button', { name: '隐藏凭据' }).click();
  return token;
}

async function grant(page: Page, name: string, role: string) {
  const member = page.getByLabel('授权成员');
  await member.selectOption({ label: await member.getByRole('option').filter({ hasText: name }).innerText() });
  await page.getByLabel('项目角色').selectOption(role);
  const receipt = page.waitForResponse(r => r.url().endsWith('/team/admin/grants') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '保存项目授权' }).click();
  expect((await receipt).ok()).toBeTruthy();
}

async function memberLogin(page: Page, url: string, token: string) {
  await page.goto(url);
  await page.getByLabel('个人成员凭据').fill(token);
  await page.getByRole('button', { name: '进入成员工作台' }).click();
}

test('具名开发与独立复核在两个浏览器会话查看同一冻结版本和验收回执', async ({ page: admin, browser }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-team-browser-'));
  const port = 43268;
  const app = await buildApp({ dataDir, port, ownerToken: 'team-admin-test', agentToken: 'other-agent',
    webDir: resolve('dist'), team: { agentBin: process.execPath, workerModule: new URL('../fixtures/team-worker.mjs', import.meta.url) } });
  const devContext = await browser.newContext();
  const reviewContext = await browser.newContext();
  try {
    await app.listen({ host: '127.0.0.1', port });
    const url = 'http://127.0.0.1:' + port + '/?team';
    await admin.goto(url);
    await admin.getByRole('button', { name: '管理员入口' }).click();
    await admin.getByLabel('管理员启动口令').fill('team-admin-test');
    await admin.getByRole('button', { name: '管理员登录' }).click();
    const devToken = await issue(admin, '林开发');
    const reviewToken = await issue(admin, '周复核');
    await admin.getByLabel('团队项目名称').fill('订单核对');
    await admin.getByRole('button', { name: '创建团队项目' }).click();
    await expect(admin.getByLabel('授权项目')).toContainText('订单核对');
    await grant(admin, '林开发', 'both');
    await grant(admin, '周复核', 'reviewer');
    const dev = await devContext.newPage();
    // Simulate a preview from a prior service revision while the live server verifies freezes.
    await dev.route('**/api/v1/team/projects', async route => {
      const response = await route.fetch();
      const directory = await response.json();
      await route.fulfill({ response, json: { ...directory, specHash: '0'.repeat(64),
        spec: { ...directory.spec, title: '旧版订单规格' } } });
    }, { times: 1 });
    await memberLogin(dev, url, devToken);
    await dev.getByText('新建订单筛选运行').click();
    const freeze = dev.getByRole('button', { name: '冻结并派工' });
    await expect(freeze).toBeDisabled();
    await expect(dev.getByText(/预期订单 ID/)).toHaveCount(3);
    await dev.getByLabel('我已核对冻结规格及预期结果').check();
    await expect(dev.getByText('旧版订单规格')).toBeVisible();
    await freeze.click();
    await expect(dev.getByRole('alert')).toContainText('重新核对');
    await expect(dev.getByText('旧版订单规格')).toHaveCount(0);
    await expect(freeze).toBeDisabled();
    await dev.getByLabel('我已核对冻结规格及预期结果').check();
    await dev.route('**/team/projects/*/runs', async route => {
      if (route.request().method() !== 'POST') { await route.fallback(); return; }
      expect((await route.fetch()).ok()).toBe(true);
      await route.abort('failed');
    });
    await freeze.click();
    await expect(dev.getByRole('alert')).toContainText('结果未知');
    await dev.unroute('**/team/projects/*/runs');
    await dev.getByRole('button', { name: '重试原请求' }).click();
    const devRun = dev.getByRole('region', { name: '运行详情' });
    await expect(devRun.getByRole('status')).toContainText('待独立复核');
    await expect(dev.getByRole('button', { name: /待独立复核/ })).toHaveCount(1);
    await expect(devRun).toContainText('你是本次实现责任人');
    await expect(devRun.getByRole('button', { name: '签署并归档' })).toHaveCount(0);
    const review = await reviewContext.newPage();
    await memberLogin(review, url, reviewToken);
    await expect(review.getByText('新建订单筛选运行')).toHaveCount(0);
    await review.getByRole('button', { name: /待独立复核/ }).click();
    const evidence = review.getByRole('region', { name: '集成证据' });
    await expect(evidence).toContainText('父提交');
    await expect(evidence).toContainText('paid-only · 通过 · 预期 [30]，实际 [30]');
    // Exercise the read-only evidence view for a failed integration before signing the live run.
    const detailsPath = '**/team/projects/*/runs/*';
    await review.route(detailsPath, async route => {
      const response = await route.fetch();
      const detail = await response.json();
      const integration = { ...detail.integration, checks: [{ name: 'paid-only', passed: false, expected: [30], actual: [] }] };
      await route.fulfill({ response, json: { ...detail, status: 'blocked', canAccept: false, integration } });
    });
    await review.getByRole('button', { name: '刷新运行' }).click();
    await expect(evidence).toContainText('paid-only · 失败 · 预期 [30]，实际 []');
    await expect(review.getByRole('button', { name: '签署并归档' })).toHaveCount(0);
    await review.unroute(detailsPath);
    await review.getByRole('button', { name: '刷新运行' }).click();
    await review.getByLabel('验收理由').fill('核对集成提交与三项条件。');
    await review.getByRole('checkbox').check();
    await review.route('**/runs/*/accept', async route => {
      expect((await route.fetch()).ok()).toBe(true);
      await route.abort('failed');
    }, { times: 1 });
    await review.getByRole('button', { name: '签署并归档' }).click();
    await expect(review.getByRole('alert')).toContainText('结果未知');
    await review.getByRole('button', { name: '重试原请求' }).click();
    await expect(review.getByRole('region', { name: '运行详情' })).toContainText('验收人 周复核');
    const download = review.waitForEvent('download');
    await review.getByRole('button', { name: '下载验收归档' }).click();
    const archive = await readFile((await (await download).path())!, 'utf8');
    expect(archive).toContain('核对集成提交与三项条件。');
    expect(archive).not.toContain(reviewToken);
    await grant(admin, '周复核', '');
    await expect(review.getByLabel('个人成员凭据')).toBeVisible();
    await expect(review.getByRole('region', { name: '集成证据' })).toHaveCount(0);
  } finally {
    await devContext.close();
    await reviewContext.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
