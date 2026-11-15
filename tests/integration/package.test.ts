import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const runFile = promisify(execFile);

describe('local package verification (K17)', () => {
  it('reports a startup failure and cleans temporary data when the port is occupied', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'specmill-package-port-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'specmill-package-temp-'));
    const occupied = createServer();
    try {
      await mkdir(join(fixture, 'scripts'));
      for (const name of ['package.json', 'README.md', 'dist', 'dist-server', 'dist-cli', 'scripts/verify-package.mjs']) await cp(resolve(name), join(fixture, name), { recursive: true });
      await new Promise<void>((resolveListen, reject) => occupied.once('error', reject).listen(43244, '127.0.0.1', resolveListen));
      let failure: { code?: number; stdout?: string; killed?: boolean } | undefined;
      try { await runFile(process.execPath, [join(fixture, 'scripts/verify-package.mjs')], { timeout: 120000, env: { ...process.env, TEMP: tempRoot, TMP: tempRoot } }); }
      catch (error) { failure = error as typeof failure; }
      expect(failure?.killed).not.toBe(true);
      expect(failure?.code).toBe(1);
      expect(failure?.stdout).toContain('验证失败：服务进程提前退出');
      expect((await readdir(tempRoot)).filter(name => name.startsWith('specmill-verify-'))).toEqual([]);
    } finally {
      if (occupied.listening) await new Promise<void>((resolveClose, reject) => occupied.close(error => error ? reject(error) : resolveClose()));
      await rm(fixture, { recursive: true, force: true });
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 150000);
  it('packs, installs into an isolated directory and completes the minimal loop from installed artifacts', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'specmill-package-fixture-'));
    try {
      await mkdir(join(fixture, 'scripts'));
      for (const name of ['package.json', 'README.md', 'dist', 'dist-server', 'dist-cli', 'scripts/verify-package.mjs']) {
        await cp(resolve(name), join(fixture, name), { recursive: true });
      }
      const packageJson = JSON.parse(await readFile(join(fixture, 'package.json'), 'utf8')) as { name: string; version: string };
      const existingArchive = join(fixture, `${packageJson.name}-${packageJson.version}.tgz`);
      await writeFile(existingArchive, 'existing user archive');
      const tempRoot = join(fixture, 'temp');
      await mkdir(tempRoot);
      const packageBefore = await readFile(join(fixture, 'package.json'), 'utf8');
      const { stdout } = await runFile(process.execPath, [join(fixture, 'scripts/verify-package.mjs')], { timeout: 420000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, TEMP: tempRoot, TMP: tempRoot } });
      expect(await readFile(join(fixture, 'package.json'), 'utf8')).toBe(packageBefore);
      await expect(readdir(join(fixture, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(existingArchive, 'utf8')).toBe('existing user archive');
      expect(stdout).toContain('内容检查通过');
      expect(stdout).toContain('隔离安装完成');
      expect(stdout).toContain('安装产物启动成功');
      expect(stdout).toContain('HTTP 闭环通过');
      expect(stdout).toContain('安装产物项目摘要检查通过');
      expect(stdout).toContain('CLI 闭环通过');
      expect(stdout).toContain('CLI 目标候选工作区选择与查询通过');
      expect(stdout).toContain('静态页面从安装产物可访问');
      expect(stdout).toContain('安装包验证全部通过');
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }, 450000);
});
