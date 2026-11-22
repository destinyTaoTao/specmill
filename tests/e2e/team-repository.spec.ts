import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { PILOT_SPEC } from '../../src/server/pilot/sample.js';
import type { RepositoryEvidence, RepositorySpec, TeamDetail } from '../../src/server/team/contracts.js';

test('仓库规格限定于获授权项目，复核操作绑定到当前版本及提交', async ({ page, browser }) => {
  const server = await createServer({ server: { host: '127.0.0.1', port: 43270, strictPort: true }, logLevel: 'error' });
  const reviewContext = await browser.newContext();
  try {
    await server.listen();
    const url = 'http://127.0.0.1:43270/?team';
    const developer = { id: 'developer', name: '林开发' };
    const reviewer = { id: 'reviewer', name: '周复核' };
    const projectId = 'repository-project';
    const project = { id: projectId, name: '团队仓库', role: 'both' };
    const sample = { id: 'sample-project', name: '订单样例', role: 'both' };
    const spec: RepositorySpec = { kind: 'repository-v1', title: '更新项目指引', requirement: '向发布指引加入复核步骤。',
      baseCommit: 'a'.repeat(40), path: 'docs/releases.md', checks: [
        { name: 'review-instructions', text: '请完成复核', present: true },
        { name: 'remove-obsolete', text: '跳过复核', present: false },
      ] };
    const specHash = 'b'.repeat(64);
    const time = '2026-11-22T00:00:00.000Z';
    const first: RepositoryEvidence = { commit: 'c'.repeat(40), parent: spec.baseCommit, path: spec.path, content: '跳过复核\n',
      contentSha256: 'd'.repeat(64), checks: spec.checks.map(check => ({ name: check.name, passed: false })) };
    const second: RepositoryEvidence = { ...first, commit: 'e'.repeat(40), content: '请完成复核\n', contentSha256: 'f'.repeat(64),
      checks: first.checks.map(check => ({ ...check, passed: true })) };
    const failed: TeamDetail = { id: 'run-1', projectId, version: 3, status: 'review', implementer: developer, createdAt: time, updatedAt: time,
      spec, frozenBaseline: { version: 1, frozenAt: time, specSha256: specHash },
      tasks: [{ task: 'repository', responsible: developer, status: 'finished', generation: 1 }],
      attempts: [{ id: 'attempt-1', task: 'repository', generation: 1, status: 'finished', startedAt: time, finishedAt: time, reason: '',
        repositoryArtifact: 'repository-attempt-1', result: { kind: 'repository', evidence: first } }],
      integration: null, repositoryEvidence: first, canAccept: false, canReturn: true, returns: [], events: [], decision: null };
    let run: TeamDetail | null = null;
    await page.route('**/api/v1/team/projects', route => route.fulfill({ json: {
      member: developer, projects: [{ ...project, repository: { spec, specHash } }, sample], spec: PILOT_SPEC, specHash: '0'.repeat(64),
    } }));
    await page.route(`**/team/projects/${projectId}/runs`, route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { runs: run ? [run] : [] } });
      expect(route.request().postDataJSON()).toMatchObject({ requestId: expect.any(String), specHash });
      run = { ...failed, canReturn: false };
      return route.fulfill({ status: 201, json: { id: run.id } });
    });
    await page.route('**/team/projects/sample-project/runs', route => route.fulfill({ json: { runs: [] } }));
    await page.route(`**/team/projects/${projectId}/runs/run-1`, route => route.fulfill({ json: run }));
    await page.goto(url);
    await page.getByLabel('个人成员凭据').fill('dev-token');
    await page.getByRole('button', { name: '进入成员工作台' }).click();
    await page.getByLabel('我的项目').selectOption(sample.id);
    await page.getByText('新建订单筛选运行').click();
    await expect(page.getByRole('heading', { name: PILOT_SPEC.title })).toBeVisible();
    await page.getByLabel('我的项目').selectOption(projectId);
    await page.getByText('新建仓库变更运行').click();
    await expect(page.getByText(spec.baseCommit, { exact: true })).toBeVisible();
    await expect(page.getByText(spec.path, { exact: true })).toBeVisible();
    await expect(page.getByText(/review-instructions · 预期包含文本/)).toContainText('请完成复核');
    await expect(page.getByText(/remove-obsolete · 预期不包含文本/)).toContainText('跳过复核');
    const freeze = page.getByRole('button', { name: '冻结并派工' });
    await expect(freeze).toBeDisabled();
    await page.getByLabel('我已核对冻结规格及预期结果').check();
    await freeze.click();
    const devEvidence = page.getByRole('region', { name: '仓库证据' });
    await expect(devEvidence).toContainText('review-instructions · 失败');
    await expect(devEvidence).toContainText(first.commit);
    await expect(page.getByRole('button', { name: '退回重新执行' })).toHaveCount(0);

    const review = await reviewContext.newPage();
    let reviewRun = failed;
    await review.route('**/api/v1/team/projects', route => route.fulfill({ json: { member: reviewer,
      projects: [{ ...project, role: 'reviewer', repository: { spec, specHash } }], spec: PILOT_SPEC, specHash: '0'.repeat(64),
    } }));
    await review.route(`**/team/projects/${projectId}/runs`, route => route.fulfill({ json: { runs: [reviewRun] } }));
    await review.route(`**/team/projects/${projectId}/runs/run-1`, route => route.fulfill({ json: reviewRun }));
    const reason = '补齐复核指引并删除过时说明。';
    const receipt = { id: failed.id };
    let firstPayload: unknown;
    await review.route('**/runs/run-1/return', async route => {
      const submitted = route.request().postDataJSON();
      if (firstPayload) {
        expect(submitted).toEqual(firstPayload);
        await route.fulfill({ json: receipt });
        return;
      }
      expect(submitted).toEqual({ requestId: expect.any(String), version: failed.version, commit: first.commit, reason });
      firstPayload = submitted;
      reviewRun = { ...failed, version: 6, repositoryEvidence: second, canAccept: true,
        tasks: [{ ...failed.tasks[0], generation: 2 }],
        attempts: [...failed.attempts, { ...failed.attempts[0], id: 'attempt-2', generation: 2,
          repositoryArtifact: 'repository-attempt-2', result: { kind: 'repository', evidence: second } }],
        returns: [{ reviewer, version: failed.version, commit: first.commit, at: time, reason }] };
      await route.abort('failed');
    });
    await review.route('**/runs/run-1/accept', route => {
      const approvedReason = '复核完成，两个条件均通过。';
      expect(route.request().postDataJSON()).toEqual({ requestId: expect.any(String), version: 6, commit: second.commit, reason: approvedReason });
      reviewRun = { ...reviewRun, status: 'archived', version: 7, canAccept: false, canReturn: false,
        decision: { reviewer, version: 6, commit: second.commit, at: time, reason: approvedReason } };
      return route.fulfill({ json: receipt });
    });
    await review.route('**/runs/run-1/archive', route => route.fulfill({ json: reviewRun }));
    await review.goto(url);
    await review.getByLabel('个人成员凭据').fill('review-token');
    await review.getByRole('button', { name: '进入成员工作台' }).click();
    await review.getByRole('button', { name: /待独立复核/ }).click();
    const evidence = review.getByRole('region', { name: '仓库证据' });
    await expect(evidence).toContainText('remove-obsolete · 失败');
    const approve = review.getByRole('button', { name: '签署并归档' });
    await expect(approve).toHaveCount(0);
    const sendBack = review.getByRole('button', { name: '退回重新执行' });
    const rationale = review.getByLabel('复核理由');
    await expect(sendBack).toBeDisabled();
    await rationale.fill(reason);
    await review.getByLabel('我已核对版本 3 的变更提交与逐项证据').check();
    await sendBack.click();
    await expect(review.getByRole('alert')).toContainText('结果未知');
    await review.getByRole('button', { name: '重试原请求' }).click();
    await expect(evidence).toContainText(second.commit);
    await expect(evidence).toContainText('review-instructions · 通过');
    await expect(rationale).toHaveValue('');
    await expect(approve).toBeDisabled();
    await review.getByText('退回记录（1）').click();
    await expect(review.getByText(/退回人 周复核/)).toContainText(reason);
    await review.getByText(/仓库变更 · 第 1 次/).click();
    await expect(review.getByText(first.content.trim(), { exact: true })).toBeVisible();
    await rationale.fill('复核完成，两个条件均通过。');
    await review.getByLabel('我已核对版本 6 的变更提交与逐项证据').check();
    await approve.click();
    await expect(review.getByRole('region', { name: '运行详情' })).toContainText('验收人 周复核');
    const [download] = await Promise.all([
      review.waitForEvent('download'),
      review.getByRole('button', { name: '下载验收归档 JSON' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('specmill-team-run-1.json');
    const saved = JSON.parse(await readFile(await download.path(), 'utf8')) as TeamDetail;
    expect(saved.returns?.[0].commit).toBe(first.commit);
    expect(saved.decision?.commit).toBe(second.commit);
    expect(saved.attempts.map(a => a.repositoryArtifact)).toEqual(['repository-attempt-1', 'repository-attempt-2']);
  } finally {
    await reviewContext.close();
    await server.close();
  }
});
