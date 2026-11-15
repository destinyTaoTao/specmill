import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app.js';

const dirs: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// 近上限往返：预警区（≥80%）导出 → 同限实例恢复 → 再导出，逐字节比较记录投影。
describe('near-limit recovery round trip', () => {
  it('restores a warning-zone package under the same limit and re-exports identical records', async () => {
    const limit = 9000;
    const make = async (port: number, tag: string) => {
      const dataDir = await mkdtemp(join(tmpdir(), `specmill-nearlimit-${tag}-`)); dirs.push(dataDir);
      const repoDir = await mkdtemp(join(tmpdir(), `specmill-nearlimit-repo-${tag}-`)); dirs.push(repoDir);
      const git = (args: string[]) => {
        const result = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_AUTHOR_NAME: '测试', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: '测试', GIT_COMMITTER_EMAIL: 'test@example.com' } });
        if (result.status !== 0) throw new Error(result.stderr);
        return result.stdout;
      };
      git(['init', '-q']);
      await writeFile(join(repoDir, 'README.md'), '# 近上限样本\n');
      git(['add', 'README.md']);
      git(['commit', '-q', '-m', 'init']);
      const app = await buildApp({ dataDir, port, ownerToken: 'owner-token', agentToken: 'agent-token', maxProjectRecordsBytes: limit }); apps.push(app);
      await app.listen({ host: '127.0.0.1', port });
      const h = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
      const login = await app.inject({ method: 'POST', url: '/api/v1/session', headers: h, payload: { token: 'owner-token' } });
      const ownerHeaders = { ...h, cookie: login.headers['set-cookie'] as string, 'x-specmill-request': '1' };
      return { app, dataDir, repoDir, ownerHeaders, h, git };
    };
    const readZipEntries = (zip: Buffer): Map<string, Buffer> => {
      let eocdOffset = -1;
      for (let index = zip.length - 22; index >= 0; index--) {
        if (zip.readUInt32LE(index) === 0x06054b50) { eocdOffset = index; break; }
      }
      const entryCount = zip.readUInt16LE(eocdOffset + 10);
      const centralOffset = zip.readUInt32LE(eocdOffset + 16);
      const entries = new Map<string, Buffer>();
      let cursor = centralOffset;
      for (let index = 0; index < entryCount; index++) {
        const nameLength = zip.readUInt16LE(cursor + 28);
        const localOffset = zip.readUInt32LE(cursor + 42);
        const name = zip.slice(cursor + 46, cursor + 46 + nameLength).toString('utf8');
        const localNameLength = zip.readUInt16LE(localOffset + 26);
        const dataStart = localOffset + 30 + localNameLength;
        const size = zip.readUInt32LE(localOffset + 18);
        entries.set(name, zip.slice(dataStart, dataStart + size));
        cursor += 46 + nameLength;
      }
      return entries;
    };
    const source = await make(43215, 'src');
    const agentH = { ...source.h, authorization: 'Bearer agent-token' };
    const project = await (await source.app.inject({ method: 'POST', url: '/api/v1/projects', headers: source.ownerHeaders, payload: { name: '近上限项目', requestId: 'nearlimit-project' } })).json();
    // 填充到预警区：附件字节全额计入预算
    let used = 0;
    let warning = false;
    for (let round = 0; round < 20 && !warning; round++) {
      const upload = await source.app.inject({ method: 'POST', url: `/api/v1/projects/${project.resourceId}/attachments?requestId=nearlimit-att-${round}&filename=fill-${round}.bin`, headers: { ...agentH, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(512) });
      expect(upload.statusCode).toBe(201);
      const budget = (await source.app.inject({ url: `/api/v1/projects/${project.resourceId}/capacity`, headers: source.ownerHeaders })).json().records as { used: number; limit: number; warning: boolean };
      used = budget.used; warning = budget.warning;
    }
    expect(warning).toBe(true);
    expect(used).toBeLessThan(limit);
    // 预警区仍可完整导出
    const exportOp = await source.app.inject({ method: 'POST', url: `/api/v1/projects/${project.resourceId}/exports`, headers: agentH, payload: { requestId: 'nearlimit-export-1' } });
    expect(exportOp.statusCode).toBe(201);
    await source.app.inject({ url: `/api/v1/exports/${exportOp.json().resourceId}`, headers: source.ownerHeaders });
    const zip1 = (await source.app.inject({ url: `/api/v1/exports/${exportOp.json().resourceId}/download`, headers: source.ownerHeaders })).rawPayload!;
    const records1 = readZipEntries(zip1).get('records.json')!;
    // 同限实例恢复 → 用量一致 → 再导出，记录投影逐字节一致
    const target = await make(43214, 'dst');
    const restoreHeaders = { ...target.ownerHeaders, 'content-type': 'application/octet-stream' };
    const restored = await target.app.inject({ method: 'POST', url: `/api/v1/restore?requestId=nearlimit-restore`, headers: restoreHeaders, payload: zip1 });
    expect(restored.statusCode).toBe(201);
    const budgetAfter = (await target.app.inject({ url: `/api/v1/projects/${project.resourceId}/capacity`, headers: target.ownerHeaders })).json().records as { used: number; warning: boolean };
    expect(budgetAfter.used).toBe(used);
    expect(budgetAfter.warning).toBe(true);
    const targetAgentH = { host: target.h.host, origin: target.h.origin, authorization: 'Bearer agent-token' };
    const exportOp2 = await target.app.inject({ method: 'POST', url: `/api/v1/projects/${project.resourceId}/exports`, headers: targetAgentH, payload: { requestId: 'nearlimit-export-2' } });
    expect(exportOp2.statusCode).toBe(201);
    await target.app.inject({ url: `/api/v1/exports/${exportOp2.json().resourceId}`, headers: target.ownerHeaders });
    const zip2 = (await target.app.inject({ url: `/api/v1/exports/${exportOp2.json().resourceId}/download`, headers: target.ownerHeaders })).rawPayload!;
    const records2 = readZipEntries(zip2).get('records.json')!;
    expect(records2.equals(records1)).toBe(true);
    // 恢复后超限新增被拒，历史仍可读
    const overflow = await target.app.inject({ method: 'POST', url: `/api/v1/projects/${project.resourceId}/attachments?requestId=nearlimit-overflow&filename=overflow.bin`, headers: { ...targetAgentH, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(4096) });
    expect(overflow.statusCode).toBe(413);
    const list = await target.app.inject({ url: `/api/v1/projects/${project.resourceId}/attachments`, headers: target.ownerHeaders });
    expect(list.statusCode).toBe(200);
  }, 120000);
});
