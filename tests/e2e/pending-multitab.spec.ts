import { test, expect, type Page } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { rm } from './cleanup.js';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../src/server/app.js';

const pendingId = async (target: Page) => {
  const text = await target.getByText(/待确认请求：/).textContent({ timeout: 8000 }).catch(error => { console.log('PENDING-ID-FAIL', Date.now(), error.message.split('\n')[0]); return ''; });
  return /待确认请求：([0-9a-f-]+)。/.exec(text ?? '')?.[1] ?? '';
};
const storedPointers = (target: Page) => target.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('specmill:pending-checkpoint-request:')));
const sessionRecords = (target: Page) => target.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('specmill:pending-checkpoint:')));
const expectSingleKeyEnding = (keys: string[], id: string) => { expect(keys.length).toBe(1); expect(keys[0].endsWith(id)).toBe(true); };

test('pending checkpoints stay isolated across tabs of one change', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-multitab-'));
  const repoDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-repo-'));
  const init = spawnSync('git', ['-C', repoDir, 'init', '-q'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } });
  if (init.status !== 0) throw new Error(init.stderr);
  const app = await buildApp({ dataDir, port: 43231, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  const context = page.context();
  const second = await context.newPage();
  try {
    await app.listen({ host: '127.0.0.1', port: 43231 });
    // 第一个标签页：登录并准备项目、工作区、变更与活跃会话。
    await page.goto('http://127.0.0.1:43231');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('项目名称').fill('多标签项目');
    await page.getByRole('button', { name: '创建项目' }).click();
    await page.getByRole('button', { name: '打开 多标签项目' }).click();
    await page.getByLabel('工作目录').fill(repoDir);
    await page.getByRole('button', { name: '登记工作区' }).click();
    await page.getByRole('button', { name: '观察工作区' }).click();
    await expect(page.getByText(/观察时间：/)).toBeVisible();
    const create = page.getByRole('form', { name: '新建变更' });
    await create.getByLabel('变更标题').fill('双标签续做');
    await create.getByLabel('目标', { exact: true }).fill('验证多标签隔离');
    await create.getByRole('button', { name: '创建变更' }).click();
    await page.getByLabel('会话工作区').selectOption({ index: 1 });
    await page.getByRole('button', { name: '开始手动会话' }).click();
    await expect(page.getByText(/活跃：Web 手动 · 代次 1/)).toBeVisible();
    await page.getByRole('button', { name: '填写保存点' }).click();
    const checkpoint = page.getByRole('form', { name: '保存点' });
    await checkpoint.getByLabel('工作区观察').selectOption({ index: 1 });
    await checkpoint.getByLabel('已完成').fill('第一个标签的进度');
    await checkpoint.getByLabel('已知失败').fill('无');
    await checkpoint.getByLabel('未验证').fill('双标签恢复未验证');
    await checkpoint.getByLabel('阻塞项').fill('无');
    await checkpoint.getByLabel('下一步').fill('验证第二个标签');
    // 第二个标签页：同一浏览器上下文共享站点存储，打开同一项目。
    await second.goto('http://127.0.0.1:43231');
    await second.getByLabel('本次登录口令').fill('test-owner');
    await second.getByRole('button', { name: '登录' }).click();
    await second.getByRole('button', { name: '打开 多标签项目' }).click();
    await expect(second.getByText(/活跃：Web 手动 · 代次 1/)).toBeVisible();
    await second.getByRole('button', { name: '填写保存点' }).click();
    const secondCheckpoint = second.getByRole('form', { name: '保存点' });
    await secondCheckpoint.getByLabel('工作区观察').selectOption({ index: 1 });
    await secondCheckpoint.getByLabel('已完成').fill('第二个标签的进度');
    await secondCheckpoint.getByLabel('已知失败').fill('无');
    await secondCheckpoint.getByLabel('未验证').fill('无');
    await secondCheckpoint.getByLabel('阻塞项').fill('无');
    await secondCheckpoint.getByLabel('下一步').fill('刷新后恢复');
    // 两个标签的保存都丢失响应，各自留下未决请求。
    await context.route('**/api/v1/changes/*/checkpoints', async route => {
      if (route.request().method() === 'POST') { await route.fetch(); await route.abort('failed'); }
      else await route.continue();
    });
    await checkpoint.getByRole('button', { name: '保存进度' }).click();
    await expect(page.getByRole('alert')).toContainText('保存结果未知');
    const firstId = await pendingId(page);
    expect(firstId).not.toBe('');
    await secondCheckpoint.getByRole('button', { name: '保存进度' }).click();
    await expect(second.getByRole('alert')).toContainText('保存结果未知');
    const secondId = await pendingId(second);
    expect(secondId).not.toBe('');
    expect(secondId).not.toBe(firstId);
    // 每个标签的正文只在自己的会话存储里，localStorage 只保留各自的请求标识指针。
    expectSingleKeyEnding(await sessionRecords(page), firstId);
    expectSingleKeyEnding(await sessionRecords(second), secondId);
    const pointers = await storedPointers(page);
    expect(pointers.length).toBe(2);
    expect(pointers.some(key => key.endsWith(firstId))).toBe(true);
    expect(pointers.some(key => key.endsWith(secondId))).toBe(true);
    // 第一个标签的未决请求没有被第二个标签覆盖。
    await expect(page.getByText(`待确认请求：${firstId}。`)).toBeVisible();
    await context.unroute('**/api/v1/changes/*/checkpoints');
    // 第一个标签按原请求重试成功，只清理自身记录；另一标签的指针保留并恢复出来。
    await page.getByRole('button', { name: '按原请求重试' }).click();
    await expect(page.getByText('已确认保存进度；浏览器中还有另一条未决请求，请继续核对。')).toBeVisible();
    await expect(page.getByText(`待确认请求：${secondId}。`)).toBeVisible();
    expectSingleKeyEnding(await storedPointers(page), secondId);
    expect(await sessionRecords(page)).toHaveLength(0);
    expectSingleKeyEnding(await sessionRecords(second), secondId);
    // 第二个标签刷新后从自己的会话存储恢复正文，查询回执后按新版本重新保存。
    await second.reload();
    await second.getByLabel('本次登录口令').fill('test-owner');
    await second.getByRole('button', { name: '登录' }).click();
    await second.getByRole('button', { name: '打开 多标签项目' }).click();
    await expect(second.getByText(`待确认请求：${secondId}。`)).toBeVisible();
    await expect(secondCheckpoint.getByLabel('已完成')).toHaveValue('第二个标签的进度');
    await second.getByRole('button', { name: '查询保存回执' }).click();
    await expect(second.getByText('目前没有找到回执')).toBeVisible();
    await second.getByRole('button', { name: '确认原请求已结束并重新核对' }).click();
    await expect(second.getByText('请确认原请求已结束，核对后再使用新版本保存。')).toBeVisible();
    await second.getByRole('button', { name: '已核对，使用当前会话与版本' }).click();
    await secondCheckpoint.getByRole('button', { name: '保存进度' }).click();
    await expect(second.getByText('已确认保存进度。')).toBeVisible();
    await expect(second.getByText('保存点历史（2）')).toBeVisible();
    expect(await storedPointers(second)).toHaveLength(0);
    expect(await sessionRecords(second)).toHaveLength(0);
  } finally {
    await second.close();
    await page.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  }
});

test('a closed tab leaves only a request pointer for receipt verification', async ({ page }) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-pointer-'));
  const repoDir = await mkdtemp(join(tmpdir(), 'specmill-e2e-repo-'));
  const init = spawnSync('git', ['-C', repoDir, 'init', '-q'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' } });
  if (init.status !== 0) throw new Error(init.stderr);
  const app = await buildApp({ dataDir, port: 43232, ownerToken: 'test-owner', agentToken: 'test-agent', webDir: resolve('dist') });
  const context = page.context();
  try {
    await app.listen({ host: '127.0.0.1', port: 43232 });
    await page.goto('http://127.0.0.1:43232');
    await page.getByLabel('本次登录口令').fill('test-owner');
    await page.getByRole('button', { name: '登录' }).click();
    await page.getByLabel('项目名称').fill('指针项目');
    await page.getByRole('button', { name: '创建项目' }).click();
    await page.getByRole('button', { name: '打开 指针项目' }).click();
    await page.getByLabel('工作目录').fill(repoDir);
    await page.getByRole('button', { name: '登记工作区' }).click();
    await page.getByRole('button', { name: '观察工作区' }).click();
    await expect(page.getByText(/观察时间：/)).toBeVisible();
    const create = page.getByRole('form', { name: '新建变更' });
    await create.getByLabel('变更标题').fill('关闭标签续做');
    await create.getByLabel('目标', { exact: true }).fill('验证指针核对');
    await create.getByRole('button', { name: '创建变更' }).click();
    await page.getByLabel('会话工作区').selectOption({ index: 1 });
    await page.getByRole('button', { name: '开始手动会话' }).click();
    await expect(page.getByText(/活跃：Web 手动 · 代次 1/)).toBeVisible();
    await page.getByRole('button', { name: '填写保存点' }).click();
    const checkpoint = page.getByRole('form', { name: '保存点' });
    await checkpoint.getByLabel('工作区观察').selectOption({ index: 1 });
    await checkpoint.getByLabel('已完成').fill('已保存一部分');
    await checkpoint.getByLabel('已知失败').fill('无');
    await checkpoint.getByLabel('未验证').fill('指针恢复未验证');
    await checkpoint.getByLabel('阻塞项').fill('无');
    await checkpoint.getByLabel('下一步').fill('关闭标签后核对');
    await page.route('**/api/v1/changes/*/checkpoints', async route => {
      if (route.request().method() === 'POST') { await route.fetch(); await route.abort('failed'); }
      else await route.continue();
    });
    await checkpoint.getByRole('button', { name: '保存进度' }).click();
    await expect(page.getByRole('alert')).toContainText('保存结果未知');
    const firstId = await pendingId(page);
    expect(firstId).not.toBe('');
    expectSingleKeyEnding(await sessionRecords(page), firstId);
    expectSingleKeyEnding(await storedPointers(page), firstId);
    // 关闭标签页：会话存储中的正文随之清除，新标签页只能看到请求标识指针。
    await page.close();
    const reopened = await context.newPage();
    await reopened.goto('http://127.0.0.1:43232');
    await reopened.getByLabel('本次登录口令').fill('test-owner');
    await reopened.getByRole('button', { name: '登录' }).click();
    await reopened.getByRole('button', { name: '打开 指针项目' }).click();
    await expect(reopened.getByText('该请求的正文未保留')).toBeVisible();
    console.log('T1 pointer-card-ok', Date.now());
    expect(await pendingId(reopened)).toBe(firstId);
    await expect(reopened.getByRole('button', { name: '按原请求重试' })).toHaveCount(0);
    // 原请求已在服务端提交，通过回执核对成功。
    await reopened.getByRole('button', { name: '查询保存回执' }).click();
    console.log('T2 receipt-click-ok', Date.now());
    await expect(reopened.getByText('已确认保存进度。')).toBeVisible();
    await expect(reopened.getByText('保存点历史（1）')).toBeVisible();
    expect(await storedPointers(reopened)).toHaveLength(0);
  } finally {
    // 先关闭所有页面：未关闭的标签页会以 keep-alive 连接阻塞 app.close()。
    await context.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  }
});
