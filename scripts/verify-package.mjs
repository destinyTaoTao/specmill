#!/usr/bin/env node
// 本地安装包验证（K17）：npm pack → 内容检查 → 隔离目录安装 tgz →
// 从安装产物启动服务 → 浏览器外完成登录/项目/会话/保存/交接最小闭环。
// 报告安装是否需要网络（优先离线缓存，失败回退在线）。
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const report = [];
const log = (line) => { report.push(line); console.log(line); };

const workDir = await mkdtemp(join(tmpdir(), 'specmill-verify-'));
const installDir = await mkdtemp(join(tmpdir(), 'specmill-verify-install-'));
const dataDir = await mkdtemp(join(tmpdir(), 'specmill-verify-data-'));
const repoDir = await mkdtemp(join(tmpdir(), 'specmill-verify-repo-'));
const port = 43244;
let server = null;
let tgzPath = '';

function runGit(args) {
  const result = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_AUTHOR_NAME: '验证', GIT_AUTHOR_EMAIL: 'verify@example.com', GIT_COMMITTER_NAME: '验证', GIT_COMMITTER_EMAIL: 'verify@example.com' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

try {
  // 1. 打包
  const tgzName = execFileSync('npm', ['pack', '--json'], { cwd: projectRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  const packed = JSON.parse(tgzName)[0];
  tgzPath = resolve(projectRoot, packed.filename);
  log(`打包完成：${packed.filename}（${packed.size} 字节，入口数 ${packed.entryCount}）`);
  const names = packed.files.map(file => file.path);
  // 2. 内容检查：必需产物在；个人数据与开发产物不在
  const required = ['package.json', 'README.md', 'dist/index.html', 'dist-server/server/main.js', 'dist-cli/cli/main.js'];
  for (const item of required) if (!names.includes(item)) throw new Error(`安装包缺少必需文件：${item}`);
  const forbiddenPatterns = [/^tests\//, /^src\//, /^scripts\//, /^docs\//, /\.db$/, /^attachments\//, /cli-token/, /^playwright\.config/, /^tsconfig/];
  const forbidden = names.filter(name => forbiddenPatterns.some(pattern => pattern.test(name)));
  if (forbidden.length > 0) throw new Error(`安装包含不应打包的内容：${forbidden.join('、')}`);
  log(`内容检查通过：${required.length} 项必需资源在位，无个人数据／测试产物／源码。`);

  // 3. 隔离安装（先尝试离线缓存，回退在线；记录网络需求）
  let networkNeeded = false;
  const install = (offline) => {
    // Windows 上 npm 是 .cmd，需要 shell；路径加引号避免空格问题。
    const command = ['npm', 'install', '--no-audit', '--no-fund', '--loglevel=error', ...(offline ? ['--prefer-offline'] : []), `"${tgzPath}"`].join(' ');
    return spawnSync(command, { cwd: installDir, encoding: 'utf8', timeout: 240000, shell: process.platform === 'win32' });
  };
  let installResult = install(true);
  if (installResult.status !== 0) {
    log('离线优先安装失败，回退在线安装（安装依赖需要网络）。');
    networkNeeded = true;
    installResult = install(false);
  }
  if (installResult.status !== 0) throw new Error(`隔离安装失败：${String(installResult.stderr || installResult.stdout || installResult.error).slice(0, 2000)}`);
  log(`隔离安装完成${networkNeeded ? '（需要网络下载依赖）' : '（离线缓存可用，无需网络）'}。`);

  const packageDir = join(installDir, 'node_modules', 'specmill');
  const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  if (!packageJson.bin || !packageJson.bin.specmill) throw new Error('安装产物缺少 specmill 可执行入口声明。');
  log(`安装产物入口：specmill → ${packageJson.bin.specmill}；specmill-cli → ${packageJson.bin['specmill-cli']}`);

  // 4. 准备最小 Git 仓库（供会话/观察/保存使用）
  runGit(['init', '-q']);
  await writeFile(join(repoDir, 'README.md'), '# 安装验证样本\n');
  runGit(['add', 'README.md']);
  runGit(['commit', '-q', '-m', 'init']);

  // 5. 从安装产物启动服务（任意工作目录，验证静态页面相对包根解析）
  server = spawn(process.execPath, [join(packageDir, packageJson.bin.specmill), '--data-dir', dataDir, '--port', String(port)], { cwd: installDir, stdio: ['ignore', 'pipe', 'pipe'] });
  let boot = '';
  const tokenWait = new Promise((resolveToken, rejectToken) => {
    const timer = setTimeout(() => rejectToken(new Error('服务启动超时')), 30000);
    server.stdout.on('data', chunk => {
      boot += String(chunk);
      const match = /本次登录口令：([0-9a-f]{64})/.exec(boot);
      if (match) { clearTimeout(timer); resolveToken(match[1]); }
    });
    server.once('exit', () => { clearTimeout(timer); rejectToken(new Error('服务进程提前退出')); });
  });
  const ownerToken = await tokenWait;
  log('安装产物启动成功：一次性登录口令已生成。');

  // 6. HTTP 最小闭环：登录 → 项目 → 工作区 → 变更
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/v1/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token: ownerToken }) });
  if (login.status !== 200) throw new Error('登录失败');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const owner = { 'content-type': 'application/json', origin: base, cookie, 'x-specmill-request': '1' };
  const post = async (path, payload) => (await (await fetch(`${base}${path}`, { method: 'POST', headers: owner, body: JSON.stringify(payload) })).json());
  const project = await post('/api/v1/projects', { name: '安装验证项目', requestId: 'verify-project' });
  const workspace = await post(`/api/v1/projects/${project.resourceId}/workspaces`, { requestId: 'verify-workspace', expectedVersion: null, payload: { workspaceId: null, path: repoDir } });
  const change = await post(`/api/v1/projects/${project.resourceId}/changes`, { requestId: 'verify-change', expectedVersion: null, payload: { title: '安装验证变更', goal: '', scope: '', nonGoals: '', criteria: ['安装包可运行'] } });
  log('HTTP 闭环通过：登录、项目、工作区、变更创建成功（原生 SQLite 可用）。');

  // 7. CLI 最小闭环：会话 → 观察 → 保存点 → 交接 → 释放
  const cli = (args) => {
    const result = spawnSync(process.execPath, [join(packageDir, packageJson.bin['specmill-cli']), ...args, '--data-dir', dataDir, '--server', base, '--json'], { encoding: 'utf8', timeout: 60000 });
    if (result.status !== 0) throw new Error(`CLI ${args.join(' ')} 失败：${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const grantFile = join(dataDir, 'verify-grant.json');
  const session = cli(['session', 'start', '--change', change.resourceId, '--workspace', workspace.resourceId, '--binding-version', '1', '--version', '1', '--tool', '安装验证工具', '--request-id', 'verify-session', '--grant-file', grantFile]);
  const observation = cli(['workspace', 'observe', '--workspace', workspace.resourceId, '--binding-version', '1', '--request-id', 'verify-observe', '--grant-file', grantFile]);
  const checkpointBody = join(workDir, 'verify-checkpoint.json');
  await writeFile(checkpointBody, JSON.stringify({ done: '安装包内完成保存', failures: '无', unverified: '无', blockers: '无', nextSteps: '验证交接' }), 'utf8');
  cli(['checkpoint', 'save', '--change', change.resourceId, '--version', '2', '--request-id', 'verify-checkpoint', '--observation', observation.resourceId, '--grant-file', grantFile, '--file', checkpointBody]);
  const handoff = cli(['handoff', 'create', '--change', change.resourceId, '--request-id', 'verify-handoff']);
  cli(['session', 'release', '--grant-file', grantFile, '--version', '3', '--request-id', 'verify-release']);
  log(`CLI 闭环通过：会话 ${session.resourceId.slice(0, 8)}…、观察、保存点、交接快照 ${handoff.resourceId.slice(0, 8)}…、释放全部成功。`);

  // 8. 静态页面从安装产物可访问
  const page = await fetch(`${base}/`);
  const html = await page.text();
  if (page.status !== 200 || !html.includes('id="root"')) throw new Error('安装产物静态页面不可用');
  log('静态页面从安装产物可访问。');
  log('安装包验证全部通过。');
  process.exitCode = 0;
} catch (error) {
  log(`验证失败：${error.message}`);
  process.exitCode = 1;
} finally {
  if (server) {
    server.kill();
    await new Promise(resolveExit => server.once('exit', () => resolveExit()));
  }
  await rm(installDir, { recursive: true, force: true }).catch(() => {});
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await rm(dataDir + '.lock', { recursive: true, force: true }).catch(() => {});
  await rm(repoDir, { recursive: true, force: true }).catch(() => {});
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
  await rm(tgzPath, { force: true }).catch(() => {});
}
