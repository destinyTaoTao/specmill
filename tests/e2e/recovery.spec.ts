import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../src/server/app.js';

test('a restore request is visible to another tab before its response', async ({ page }, testInfo) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-restore-pending-'));
  const app = await buildApp({ dataDir, port: 43245, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  let release = () => {};
  let captured = () => {};
  let requestId = '';
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  const started = new Promise<void>(resolveStarted => { captured = resolveStarted; });
  try {
    await app.listen({ host: '127.0.0.1', port: 43245 });
    await page.goto('http://127.0.0.1:43245');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.route('**/api/v1/restore?*', async route => {
      requestId = new URL(route.request().url()).searchParams.get('requestId')!;
      captured(); await gate; await route.abort('failed');
    });
    await page.getByLabel('从恢复包恢复（.zip，仅恢复记录与附件，不含源码）').setInputFiles({ name: 'pending.zip', mimeType: 'application/zip', buffer: Buffer.from('isolated sample') });
    await started;
    const otherPage = await page.context().newPage();
    try {
      await otherPage.goto('http://127.0.0.1:43245');
      await expect(otherPage.getByRole('alert')).toContainText(`恢复请求 ${requestId.slice(0, 8)}`);
      await otherPage.setViewportSize({ width: 390, height: 844 });
      await otherPage.screenshot({ path: testInfo.outputPath('pending-restore-mobile.png'), fullPage: true });
      expect(await otherPage.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      release();
      await expect(page.getByRole('alert')).toContainText('恢复结果未知');
      await page.evaluate(() => {
        Storage.prototype.key = function () { throw new Error('storage read blocked'); };
        window.dispatchEvent(new StorageEvent('storage', { key: 'specmill:pending-restore:changed' }));
      });
      await expect(page.getByRole('alert')).toContainText('恢复结果未知');
      await expect(page.getByRole('status').filter({ hasText: '无法读取未决恢复提示' })).toBeVisible();
      await page.evaluate(() => { Storage.prototype.removeItem = function () { throw new Error('storage removal blocked'); }; });
      await page.getByRole('button', { name: '已核对，关闭 pending.zip 提示' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'pending.zip' })).toBeVisible();
      await expect(page.getByRole('alert').filter({ hasText: '无法清理浏览器中的未决提示' })).toBeVisible();
    } finally { release(); await otherPage.close(); }
  } finally {
    release(); await page.close(); await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('unavailable browser storage is disclosed before an uncertain restore', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-restore-no-storage-'));
  const app = await buildApp({ dataDir, port: 43246, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  try {
    await app.listen({ host: '127.0.0.1', port: 43246 });
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('specmill:pending-restore:')) throw new Error('storage blocked');
        return original.call(this, key, value);
      };
    });
    await page.route('**/api/v1/restore?*', route => route.abort('failed'));
    await page.goto('http://127.0.0.1:43246');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('从恢复包恢复（.zip，仅恢复记录与附件，不含源码）').setInputFiles({ name: 'pending.zip', mimeType: 'application/zip', buffer: Buffer.from('isolated sample') });
    await expect(page.getByRole('status').filter({ hasText: '提示无法跨页面保留' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('恢复结果未知');
    await expect(page.getByRole('alert')).toContainText('该提示可能无法跨页面保留');
  } finally {
    await page.close(); await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('unreadable restore pointers are reported at startup', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-restore-read-error-'));
  const app = await buildApp({ dataDir, port: 43247, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  try {
    await app.listen({ host: '127.0.0.1', port: 43247 });
    await page.addInitScript(() => {
      Object.defineProperty(Storage.prototype, 'length', { configurable: true, get() { throw new Error('storage read blocked'); } });
    });
    await page.goto('http://127.0.0.1:43247');
    await expect(page.getByRole('status').filter({ hasText: '无法读取未决恢复提示' })).toBeVisible();
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByLabel('项目名称')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: '无法读取未决恢复提示' })).toBeVisible();
  } finally {
    await page.close(); await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a delayed export list cannot hide a newly created export', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-export-race-'));
  const app = await buildApp({ dataDir, port: 43242, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  let release = () => {};
  let captured = () => {};
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  const ready = new Promise<void>(resolveReady => { captured = resolveReady; });
  try {
    await app.listen({ host: '127.0.0.1', port: 43242 });
    await page.goto('http://127.0.0.1:43242');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('项目名称').fill('导出并发');
    await page.getByRole('button', { name: '创建项目' }).click();
    await page.route('**/api/v1/projects/*/exports', async route => {
      if (route.request().method() === 'GET') {
        const old = await route.fetch(); captured(); await gate;
        await route.fulfill({ response: old, headers: { ...old.headers(), 'x-test-old-list': 'yes' } });
      } else await route.continue();
    });
    await page.getByRole('button', { name: '打开 导出并发' }).click();
    await ready;
    await page.getByRole('button', { name: '导出恢复包' }).click();
    await expect(page.getByRole('link', { name: '下载恢复包' })).toBeVisible();
    const oldResponse = page.waitForResponse(response => response.headers()['x-test-old-list'] === 'yes');
    release(); await oldResponse;
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(page.getByRole('link', { name: '下载恢复包' })).toBeVisible();
  } finally {
    release(); await page.close(); await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('the user can cancel an export while preparation is pending', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-export-cancel-'));
  const app = await buildApp({ dataDir, port: 43237, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  let releaseStatus: () => void = () => {};
  const statusGate = new Promise<void>(resolveGate => { releaseStatus = resolveGate; });
  try {
    await app.listen({ host: '127.0.0.1', port: 43237 });
    await page.goto('http://127.0.0.1:43237');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('项目名称').fill('导出测试');
    await page.getByRole('button', { name: '创建项目' }).click();
    await page.getByRole('button', { name: '打开 导出测试' }).click();
    await page.route('**/api/v1/exports/*', async route => {
      if (route.request().method() === 'GET') { await statusGate; await route.abort('failed'); }
      else await route.continue();
    });
    await page.getByRole('button', { name: '导出恢复包' }).click();
    await page.getByRole('button', { name: '取消导出' }).click();
    await expect(page.getByText('导出已取消。')).toBeVisible();
    const failedStatus = page.waitForEvent('requestfailed', request => request.url().includes('/api/v1/exports/'));
    releaseStatus(); await failedStatus;
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(page.getByRole('button', { name: '取消导出' })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    releaseStatus();
    await page.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('the user can refresh an export after its status response is lost', async ({ page }, testInfo) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-export-refresh-'));
  const app = await buildApp({ dataDir, port: 43238, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  try {
    await app.listen({ host: '127.0.0.1', port: 43238 });
    await page.goto('http://127.0.0.1:43238');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('项目名称').fill('状态核对');
    await page.getByRole('button', { name: '创建项目' }).click();
    await page.getByRole('button', { name: '打开 状态核对' }).click();
    let dropStatus = true;
    let starts = 0;
    await page.route('**/api/v1/projects/*/exports', async route => {
      if (route.request().method() === 'POST') starts++;
      await route.continue();
    });
    await page.route('**/api/v1/exports/*', async route => {
      if (route.request().method() === 'GET' && dropStatus) { dropStatus = false; await route.fetch(); await route.abort('failed'); }
      else await route.continue();
    });
    await page.getByRole('button', { name: '导出恢复包' }).click();
    await expect(page.getByText('导出已创建，但状态读取失败；请刷新导出状态。')).toBeVisible();
    await expect(page.getByRole('button', { name: '导出恢复包' })).toBeDisabled();
    await page.getByRole('button', { name: '刷新导出状态' }).click();
    await expect(page.getByRole('link', { name: '下载恢复包' })).toBeVisible();
    expect(starts).toBe(1);
    await page.setViewportSize({ width: 390, height: 844 });
    const exportSection = page.locator('section').filter({ has: page.getByRole('heading', { name: '导出恢复包' }) });
    await exportSection.screenshot({ path: testInfo.outputPath('export-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  } finally {
    await page.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

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
  let releaseList = () => {};
  let capturedList = () => {};
  const listGate = new Promise<void>(resolveGate => { releaseList = resolveGate; });
  const listCaptured = new Promise<void>(resolveReady => { capturedList = resolveReady; });
  try {
    await sourceApp.listen({ host: '127.0.0.1', port: 43236 });
    await page.goto('http://127.0.0.1:43236');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('项目名称').fill('恢复源项目');
    await page.getByRole('button', { name: '创建项目' }).click();
    await expect(page.getByRole('button', { name: '打开 恢复源项目' })).toBeVisible();
    await page.getByRole('button', { name: '打开 恢复源项目' }).click();
    await page.getByLabel('工作目录').fill(repoDir);
    await page.getByRole('button', { name: '登记工作区' }).click();
    await expect(page.getByText(/绑定版本 1/)).toBeVisible();
    await page.getByRole('button', { name: '返回项目列表' }).click();
    const cookie = ((await page.context().cookies(['http://127.0.0.1:43236'])).find(item => item.name === 'specmill_session'))!.value;
    const ownerHeaders = { 'content-type': 'application/json', origin: 'http://127.0.0.1:43236', cookie: `specmill_session=${cookie}`, 'x-specmill-request': '1' };
    const projectId = ((await (await fetch('http://127.0.0.1:43236/api/v1/projects', { headers: { origin: 'http://127.0.0.1:43236', cookie: `specmill_session=${cookie}` } })).json()).projects[0]).id as string;
    const exported = await (await fetch(`http://127.0.0.1:43236/api/v1/projects/${projectId}/exports`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ requestId: 'recovery-e2e-export' }) })).json();
    await fetch(`http://127.0.0.1:43236/api/v1/exports/${exported.resourceId}`, { headers: { origin: 'http://127.0.0.1:43236', cookie: `specmill_session=${cookie}` } });
    const zip = Buffer.from(await (await fetch(`http://127.0.0.1:43236/api/v1/exports/${exported.resourceId}/download`, { headers: { origin: 'http://127.0.0.1:43236', cookie: `specmill_session=${cookie}` } })).arrayBuffer());
    const secondProject = await (await fetch('http://127.0.0.1:43236/api/v1/projects', { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ name: '刷新失败源', requestId: 'second-source-project' }) })).json();
    const secondExport = await (await fetch(`http://127.0.0.1:43236/api/v1/projects/${secondProject.resourceId}/exports`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ requestId: 'second-source-export' }) })).json();
    const secondZip = Buffer.from(await (await fetch(`http://127.0.0.1:43236/api/v1/exports/${secondExport.resourceId}/download`, { headers: { origin: 'http://127.0.0.1:43236', cookie: `specmill_session=${cookie}` } })).arrayBuffer());
    const thirdProject = await (await fetch('http://127.0.0.1:43236/api/v1/projects', { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ name: '恢复响应丢失源', requestId: 'third-source-project' }) })).json();
    const thirdExport = await (await fetch(`http://127.0.0.1:43236/api/v1/projects/${thirdProject.resourceId}/exports`, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ requestId: 'third-source-export' }) })).json();
    const thirdZip = Buffer.from(await (await fetch(`http://127.0.0.1:43236/api/v1/exports/${thirdExport.resourceId}/download`, { headers: { origin: 'http://127.0.0.1:43236', cookie: `specmill_session=${cookie}` } })).arrayBuffer());
    await sourceApp.close();
    // 恢复实例：独立数据目录启动，用户在浏览器上传恢复包
    targetApp = await buildApp({ dataDir: dataDirB, port: 43236, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
    await targetApp.listen({ host: '127.0.0.1', port: 43236 });
    await page.goto('http://127.0.0.1:43236');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByLabel('项目名称')).toBeVisible();
    let delayFirstList = true;
    await page.route('**/api/v1/projects', async route => {
      if (route.request().method() === 'GET' && delayFirstList) {
        delayFirstList = false;
        const old = await route.fetch(); capturedList(); await listGate;
        await route.fulfill({ response: old, headers: { ...old.headers(), 'x-test-old-list': 'yes' } });
      } else await route.continue();
    });
    await page.getByLabel('从恢复包恢复（.zip，仅恢复记录与附件，不含源码）').setInputFiles({ name: 'export.zip', mimeType: 'application/zip', buffer: zip });
    await listCaptured;
    await page.getByLabel('项目名称').fill('并发新项目');
    await page.getByRole('button', { name: '创建项目' }).click();
    await expect(page.getByRole('button', { name: '打开 并发新项目' })).toBeVisible();
    const oldResponse = page.waitForResponse(response => response.headers()['x-test-old-list'] === 'yes');
    releaseList(); await oldResponse;
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(page.getByRole('button', { name: '打开 并发新项目' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: '项目记录与附件已恢复' })).toBeVisible();
    await expect(page.getByText('请打开项目重新绑定工作目录后再续做；恢复成功不代表源码已备份。')).toBeVisible();
    await expect(page.getByRole('button', { name: '打开 恢复源项目' })).toBeVisible();
    await expect(page.getByText(/需要重新绑定/)).toBeVisible();
    // 打开恢复的项目：历史可读；重新绑定源码目录后可继续
    await page.getByRole('button', { name: '打开 恢复源项目' }).click();
    await page.getByRole('button', { name: '更换绑定' }).click();
    await expect(page.getByText(/绑定版本 2/)).toBeVisible();
    await page.getByRole('button', { name: '返回项目列表' }).click();
    await page.route('**/api/v1/projects', async route => {
      if (route.request().method() === 'GET') await route.fulfill({ status: 503, body: 'unavailable' });
      else await route.fallback();
    }, { times: 1 });
    await page.getByLabel('从恢复包恢复（.zip，仅恢复记录与附件，不含源码）').setInputFiles({ name: 'second.zip', mimeType: 'application/zip', buffer: secondZip });
    await expect(page.getByRole('status').filter({ hasText: '项目记录与附件已恢复' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveText('项目已恢复，但列表刷新失败；请刷新页面。');
    await page.reload();
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByRole('button', { name: '打开 刷新失败源' })).toBeVisible();
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('specmill:pending-restore:')))).toHaveLength(0);
    await page.getByLabel('从恢复包恢复（.zip，仅恢复记录与附件，不含源码）').setInputFiles({ name: 'invalid.zip', mimeType: 'application/zip', buffer: Buffer.from('invalid') });
    await expect(page.getByRole('alert')).toContainText('ZIP');
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('specmill:pending-restore:')))).toHaveLength(0);
    const uncertainRequestIds: string[] = [];
    await page.route('**/api/v1/restore?*', async route => { uncertainRequestIds.push(new URL(route.request().url()).searchParams.get('requestId')!); await route.fetch(); await route.abort('failed'); }, { times: 1 });
    await page.getByLabel('从恢复包恢复（.zip，仅恢复记录与附件，不含源码）').setInputFiles({ name: 'third.zip', mimeType: 'application/zip', buffer: thirdZip });
    await expect(page.getByRole('alert')).toContainText('恢复结果未知');
    await expect(page.getByRole('button', { name: '打开 恢复响应丢失源' })).toBeVisible();
    await page.getByLabel('项目名称').fill('其他工作');
    await page.getByRole('button', { name: '创建项目' }).click();
    await expect(page.getByRole('button', { name: '打开 其他工作' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('恢复结果未知');
    await page.getByRole('button', { name: '打开 其他工作' }).click();
    await page.getByRole('button', { name: '返回项目列表' }).click();
    await expect(page.getByRole('alert')).toContainText('恢复结果未知');
    await page.route('**/api/v1/restore?*', route => { uncertainRequestIds.push(new URL(route.request().url()).searchParams.get('requestId')!); return route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"服务不可用"}' }); }, { times: 1 });
    await page.route('**/api/v1/projects', route => route.fulfill({ status: 503, body: 'unavailable' }), { times: 1 });
    await page.getByLabel('从恢复包恢复（.zip，仅恢复记录与附件，不含源码）').setInputFiles({ name: 'fourth.zip', mimeType: 'application/zip', buffer: Buffer.from('not sent to service') });
    await expect(page.getByRole('alert').filter({ hasText: 'fourth.zip' })).toContainText('恢复结果未知，项目列表刷新失败');
    expect(uncertainRequestIds).toHaveLength(2);
    expect(uncertainRequestIds[0]).not.toBe(uncertainRequestIds[1]);
    const stored = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('specmill:pending-restore:')));
    expect(stored).toHaveLength(2);
    expect(JSON.stringify(stored)).not.toContain('third.zip');
    expect(JSON.stringify(stored)).not.toContain('fourth.zip');
    await expect(page.getByRole('alert').filter({ hasText: 'third.zip' })).toContainText('恢复结果未知');
    await page.getByRole('button', { name: '查询 third.zip 回执' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'third.zip' })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: '已确认项目记录与附件恢复' })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'fourth.zip' })).toBeVisible();
    await page.getByRole('button', { name: '查询 fourth.zip 回执' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'fourth.zip' })).toContainText('尚未找到恢复回执；操作可能仍在进行');
    await page.reload();
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByRole('alert')).toContainText('恢复结果未知');
    const label = `恢复请求 ${uncertainRequestIds[1].slice(0, 8)}`;
    await expect(page.getByRole('alert')).toContainText(label);
    const otherPage = await page.context().newPage();
    try {
      await otherPage.goto('http://127.0.0.1:43236');
      await expect(otherPage.getByRole('alert')).toContainText(label);
      await page.getByRole('button', { name: `已核对，关闭 ${label} 提示` }).click();
      await expect(otherPage.getByRole('alert')).toHaveCount(0);
    } finally { await otherPage.close(); }
  } finally {
    releaseList();
    await page.close();
    await sourceApp.close().catch(() => {});
    if (targetApp) await targetApp.close().catch(() => {});
    await rm(dataDirA, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
    await rm(dataDirB, { recursive: true, force: true });
  }
});
