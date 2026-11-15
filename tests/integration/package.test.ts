import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

describe('local package verification (K17)', () => {
  it('packs, installs into an isolated directory and completes the minimal loop from installed artifacts', async () => {
    // 打包脚本会清理自身产物；npm pack 生成的 tgz 由脚本使用后留在项目根，
    // 这里随后删除，避免污染工作区。
    const { stdout } = await runFile(process.execPath, [resolve('scripts/verify-package.mjs')], { timeout: 420000, maxBuffer: 16 * 1024 * 1024 });
    expect(stdout).toContain('内容检查通过');
    expect(stdout).toContain('隔离安装完成');
    expect(stdout).toContain('安装产物启动成功');
    expect(stdout).toContain('HTTP 闭环通过');
    expect(stdout).toContain('CLI 闭环通过');
    expect(stdout).toContain('静态页面从安装产物可访问');
    expect(stdout).toContain('安装包验证全部通过');
  }, 450000);
});
