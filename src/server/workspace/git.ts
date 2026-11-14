import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

export function pathKey(path: string) {
  const value = normalize(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function gitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

async function runGit(directory: string, args: string[], maxBuffer = 1024 * 1024) {
  const base = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'core.quotepath=false', '-C', directory];
  const options = { env: gitEnvironment(), timeout: 15000, maxBuffer, windowsHide: true };
  // Only metadata commands are run against the user's Git configuration.
  const result = await runFile('git', [...base, ...args], options);
  return result.stdout;
}

export async function identifyWorkspace(path: string) {
  const directory = await realpath(path);
  const root = await realpath((await runGit(directory, ['rev-parse', '--show-toplevel'])).trim());
  const commonDir = await realpath((await runGit(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  return { path: root, pathKey: pathKey(root), commonDir, commonKey: pathKey(commonDir) };
}

async function fileDigest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export class ObservationTempInsideWorkspace extends Error {}

async function withIsolatedGit<T>(root: string, commonDir: string, head: string | null, callback: (run: (args: string[], maxBuffer?: number) => Promise<string>) => Promise<T>) {
  const tempRoot = await realpath(tmpdir());
  const relativeTemp = relative(pathKey(root), pathKey(tempRoot));
  if (relativeTemp === '' || (relativeTemp !== '..' && !relativeTemp.startsWith(`..${sep}`) && !isAbsolute(relativeTemp))) throw new ObservationTempInsideWorkspace();
  const temporary = await mkdtemp(join(tempRoot, 'specmill-observe-'));
  const actualTemporary = await realpath(temporary);
  if (pathKey(dirname(actualTemporary)) !== pathKey(tempRoot) || !basename(actualTemporary).startsWith('specmill-observe-')) throw new Error('Invalid temporary directory');
  try {
    await mkdir(join(temporary, 'objects'), { recursive: true });
    await mkdir(join(temporary, 'objects', 'info'), { recursive: true });
    await mkdir(join(temporary, 'refs', 'heads'), { recursive: true });
    await mkdir(join(temporary, 'info'), { recursive: true });
    const objectFormat = (await runGit(root, ['rev-parse', '--show-object-format'])).trim();
    if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new Error('Unsupported Git object format');
    const ignoreCase = process.platform === 'win32' ? '\tignorecase = true\n' : '';
    const config = objectFormat === 'sha256' ? `[core]\n\trepositoryformatversion = 1\n\tbare = false\n${ignoreCase}[extensions]\n\tobjectformat = sha256\n` : `[core]\n\trepositoryformatversion = 0\n\tbare = false\n${ignoreCase}`;
    await writeFile(join(temporary, 'config'), config);
    await writeFile(join(temporary, 'HEAD'), head ? `${head}\n` : 'ref: refs/heads/unborn\n');
    await writeFile(join(temporary, 'objects', 'info', 'alternates'), `${join(commonDir, 'objects').replaceAll('\\', '/')}\n`);
    const gitDir = await realpath((await runGit(root, ['rev-parse', '--absolute-git-dir'])).trim());
    const excluded = [gitDir, commonDir].map(directory => relative(root, directory)).filter(path => path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
    if (excluded.includes('')) throw new Error('Git directory is the workspace root');
    const pathspec = ['--', '.', ...[...new Set(excluded)].map(path => `:(exclude,${process.platform === 'win32' ? 'icase,' : ''}literal)${path.replaceAll('\\', '/')}`)];
    const indexPath = (await runGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
    let indexDigest: string | null = null;
    let copiedIndexDigest: string | null = null;
    try {
      const indexStat = await stat(indexPath);
      if (indexStat.size > 50 * 1024 * 1024) throw new Error('Git index exceeds observation limit');
      indexDigest = await fileDigest(indexPath);
      await copyFile(indexPath, join(temporary, 'index'));
      copiedIndexDigest = await fileDigest(join(temporary, 'index'));
      for (const name of await readdir(dirname(indexPath))) {
        if (/^sharedindex\.[0-9a-f]+$/i.test(name)) await copyFile(join(dirname(indexPath), name), join(temporary, name));
      }
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    try { await copyFile(join(commonDir, 'info', 'exclude'), join(temporary, 'info', 'exclude')); }
    catch (error) { if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error; }
    const env = { ...gitEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
    const run = async (args: string[], maxBuffer = 1024 * 1024) => {
      const command = args[0] === 'status' || args[0] === 'diff' ? [...args, ...pathspec] : args;
      const result = await runFile('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'core.quotepath=false', `--git-dir=${temporary}`, `--work-tree=${root}`, ...command], { env, timeout: 15000, maxBuffer, windowsHide: true });
      return result.stdout;
    };
    const result = await callback(run);
    let finalIndexDigest: string | null = null;
    try { finalIndexDigest = await fileDigest(indexPath); }
    catch (error) { if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error; }
    return { result, indexStable: indexDigest === copiedIndexDigest && indexDigest === finalIndexDigest };
  } finally {
    const verified = await realpath(temporary);
    if (pathKey(dirname(verified)) !== pathKey(tempRoot) || !basename(verified).startsWith('specmill-observe-')) throw new Error('Invalid temporary cleanup path');
    await rm(verified, { recursive: true, force: true });
  }
}

type ObservedFile = { path: string; status: string; originalPath?: string; sha256?: string };
const maxFileBytes = 20 * 1024 * 1024;

async function hashSelectedFile(root: string, path: string): Promise<string> {
  const candidate = resolve(root, path);
  const actual = await realpath(candidate);
  const within = relative(root, actual);
  if (within === '' || within === '..' || within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(within)) throw new Error('outside workspace');
  const link = await lstat(candidate);
  if (!link.isFile() || link.isSymbolicLink() || link.size > maxFileBytes) throw new Error('uncovered file');
  const before = await stat(actual);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(actual)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxFileBytes) throw new Error('file too large');
    hash.update(bytes);
  }
  const after = await stat(actual);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || size !== after.size) throw new Error('file changed');
  return hash.digest('hex');
}

async function gitHead(root: string) {
  try { return (await runGit(root, ['rev-parse', '--verify', 'HEAD'])).trim(); }
  catch (failure) {
    // Only an absent branch ref proves an unborn repository. Timeouts, damaged
    // metadata and permission errors must not be presented as an empty HEAD.
    try {
      const ref = (await runGit(root, ['symbolic-ref', '--quiet', 'HEAD'])).trim();
      try { await runGit(root, ['show-ref', '--verify', '--quiet', ref]); }
      catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1 && !('signal' in error && error.signal)) return null;
      }
    } catch { /* original failure remains authoritative */ }
    throw failure;
  }
}

export async function observeWorkspace(root: string, commonDir: string, selectedUntracked: string[]) {
  const limitations: string[] = ['忽略文件未覆盖；摘要不能恢复源码或证明运行环境一致。', '为避免执行项目脚本，外部过滤器及原 Git 配置未用于观察；文件状态可能与正常 Git 结果不同。', '子模块及其提交变更未覆盖；标记为 assume-unchanged 或 skip-worktree 的文件可能未覆盖。'];
  const head = await gitHead(root);
  let branch: string | null = null;
  try { branch = (await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim(); } catch { /* detached HEAD */ }
  const isolated = await withIsolatedGit(root, commonDir, head, async run => {
  const status = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], 8 * 1024 * 1024);
  const entries = status.split('\0');
  const files: ObservedFile[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (files.length >= 10000) { limitations.push('变更文件超过 10000 项，观察不完整。'); break; }
    const state = entry.slice(0, 2);
    const file: ObservedFile = { path: entry.slice(3), status: state };
    if (/[RC]/.test(state)) file.originalPath = entries[++i];
    files.push(file);
  }
  const selected = new Set(selectedUntracked);
  let stable = true;
  for (const file of files) {
    if (file.status !== '??') continue;
    if (!selected.has(file.path)) { limitations.push(`未跟踪文件未采集摘要：${file.path}`); continue; }
    try { file.sha256 = await hashSelectedFile(root, file.path); }
    catch { stable = false; limitations.push(`未跟踪文件不可读、超限或采集期间变化：${file.path}`); }
  }
  for (const path of selected) {
    if (!files.some(file => file.status === '??' && file.path === path)) limitations.push(`所选文件不在本次未跟踪列表：${path}`);
  }
  let trackedDiffSha256: string | null = null;
  const readDiff = async () => {
    const unstaged = await run(['diff', '--no-ext-diff', '--no-textconv', '--binary', '--no-color', '--ignore-submodules=all'], maxFileBytes);
    const staged = await run(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', '--no-color', '--ignore-submodules=all'], maxFileBytes);
    return createHash('sha256').update(unstaged).update('\0').update(staged).digest('hex');
  };
  try { trackedDiffSha256 = await readDiff(); }
  catch { limitations.push('已跟踪差异无法读取或超过摘要限制。'); }
  const finalStatus = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'], 8 * 1024 * 1024);
  const finalHead = await gitHead(root);
  for (const file of files) {
    if (!file.sha256) continue;
    try {
      if (file.sha256 !== await hashSelectedFile(root, file.path)) { stable = false; limitations.push(`未跟踪文件在观察期间变化：${file.path}`); }
    } catch { stable = false; limitations.push(`未跟踪文件无法再次核对：${file.path}`); }
  }
  if (trackedDiffSha256 !== null) {
    try { if (trackedDiffSha256 !== await readDiff()) stable = false; }
    catch { stable = false; limitations.push('再次核对已跟踪差异失败。'); }
  }
  if (status !== finalStatus || head !== finalHead) stable = false;
  if (!stable) limitations.push('工作区在采集期间发生变化或无法稳定核对，请重新观察。');
  return { head, branch, dirty: status.length > 0, files, trackedDiffSha256, stable, limitations };
  });
  if (!isolated.indexStable) { isolated.result.stable = false; isolated.result.limitations.push('Git 索引在观察期间发生变化，请重新观察。'); }
  return isolated.result;
}

export async function containsCommits(root: string, commonDir: string, commits: string[]) {
  if (commits.some(commit => !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit))) return false;
  const head = await gitHead(root);
  const check = await withIsolatedGit(root, commonDir, head, async run => {
    for (const commit of commits) {
      try { await run(['cat-file', '-e', `${commit}^{commit}`]); } catch { return false; }
    }
    return true;
  });
  return check.result;
}

export async function committedSource(root: string, commonDir: string, path: string, sha256: string) {
  let head: string | null;
  try { head = await gitHead(root); } catch { return { head: null, committed: null }; }
  if (head === null) return { head: null, committed: false };
  try {
    const normalized = path.replaceAll('\\', '/');
    const result = await withIsolatedGit(root, commonDir, head, async run => {
      const entry = await run(['ls-tree', '-r', '-z', '--full-tree', head, '--', `:(literal)${normalized}`]);
      if (!entry) return false;
      const blob = await run(['cat-file', 'blob', `${head}:${normalized}`], 2 * 1024 * 1024 + 1);
      // A byte difference can be caused solely by CRLF conversion or filters.
      // Those are intentionally not run in this isolated inspection.
      return createHash('sha256').update(blob, 'utf8').digest('hex') === sha256 ? true : null;
    });
    return { head, committed: result.result };
  } catch { return { head, committed: null }; }
}
