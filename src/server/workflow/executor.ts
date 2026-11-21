import { fork, spawn, execFile, type ChildProcess } from 'node:child_process';
import { stat, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const agentTimeout = 90_000;
export type ExecutorId = 'codex' | 'pi';
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedUsd?: number;
}
export interface AgentEvidence { executor: ExecutorId; protocol: 1; durationMs: number; model?: string; usage?: AgentUsage }
interface AgentInput { bin: string; repo: string; prompt: string; executor?: ExecutorId; model?: string }
type AgentReply = { output: string; evidence: AgentEvidence } | { error: string };

export function isExecutor(value: unknown): value is ExecutorId {
  return value === 'codex' || value === 'pi';
}

export function isModel(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,39}\/[a-z0-9][a-z0-9._:/-]{0,79}$/i.test(value);
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
}

function parseJson(value: string) {
  try { return jsonObject(JSON.parse(value)); }
  catch { return undefined; }
}

function count(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
}

function readUsage(value: unknown): AgentUsage | undefined {
  if (!value || typeof value !== 'object') return;
  const raw = value as Record<string, unknown>;
  const inputTokens = count(raw.inputTokens);
  const outputTokens = count(raw.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return;
  const cacheReadTokens = count(raw.cacheReadTokens);
  const cacheWriteTokens = count(raw.cacheWriteTokens);
  const cost = raw.estimatedUsd;
  const estimatedUsd = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, estimatedUsd };
}

function validOutput(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= 4096;
}

export function readAgentEvidence(value: unknown): AgentEvidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const raw = value as Record<string, unknown>;
  const durationMs = count(raw.durationMs);
  if (!isExecutor(raw.executor) || raw.protocol !== 1 || durationMs === undefined) return;
  const evidence: AgentEvidence = { executor: raw.executor, protocol: 1, durationMs };
  if (isModel(raw.model)) evidence.model = raw.model;
  evidence.usage = readUsage(raw.usage);
  return evidence;
}

function agentEnvironment(executor: ExecutorId, model?: string) {
  const env: NodeJS.ProcessEnv = {};
  const providerKeys = executor === 'codex' ? ['CODEX_HOME', 'OPENAI_API_KEY'] : [];
  if (executor === 'pi' && model?.startsWith('deepseek/')) providerKeys.push('DEEPSEEK_API_KEY');
  for (const key of ['PATH', 'SystemRoot', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'TEMP', 'TMP', 'TMPDIR', 'LANG', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', ...providerKeys]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function stopAgent(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
  } else if (process.env.SystemRoot && child.exitCode === null && child.signalCode === null) {
    await new Promise<void>(resolve => execFile(join(process.env.SystemRoot!, 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, () => resolve()));
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function readPiResult(events: (Record<string, unknown> | undefined)[], evidence: AgentEvidence, expectedModel?: string): AgentReply {
  const end = events.find(event => event?.type === 'agent_end');
  const messages = Array.isArray(end?.messages) ? end.messages.map(jsonObject) : [];
  const reply = messages.reverse().find(message => message?.role === 'assistant');
  const parts = Array.isArray(reply?.content) ? reply.content.map(jsonObject) : [];
  if (reply?.stopReason !== 'stop' || !parts.every(part =>
    part?.type === 'thinking' || (part?.type === 'text' && typeof part.text === 'string'))) {
    return { error: 'Pi CLI 未返回有效的最终输出。' };
  }
  const output = parts.filter(part => part?.type === 'text').map(part => part?.text).join('');
  if (!validOutput(output)) return { error: 'Agent 最终输出为空或超过大小限制。' };
  if (typeof reply.provider === 'string' && typeof reply.model === 'string') {
    const model = reply.provider + '/' + reply.model;
    if (isModel(model)) evidence.model = model;
  }
  if (evidence.model !== expectedModel) return { error: 'Pi 实际模型与配置标识不符。' };
  const raw = jsonObject(reply.usage);
  evidence.usage = readUsage({ inputTokens: raw?.input, outputTokens: raw?.output, cacheReadTokens: raw?.cacheRead,
    cacheWriteTokens: raw?.cacheWrite, estimatedUsd: jsonObject(raw?.cost)?.total });
  return { output, evidence };
}

async function runAgent(input: AgentInput, signal: AbortSignal): Promise<AgentReply> {
  const executor = input.executor ?? 'codex';
  if (!isExecutor(executor) || !await isExecutorEntry(executor, input.bin) ||
      (executor === 'pi' && !isModel(input.model))) return { error: '执行器、入口文件或模型无效。' };
  const started = performance.now();
  const tempRoot = await realpath(tmpdir());
  const scratch = await mkdtemp(join(tempRoot, 'specmill-pilot-agent-'));
  try {
    const finalMessage = join(scratch, 'result.txt');
    const disabled = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'multi_agent', 'multi_agent_v2',
      'browser_use', 'computer_use', 'in_app_browser', 'view_image', 'image_generation', 'skill_search', 'memories'];
    const codexArgs = ['exec', '--json', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
      ...disabled.flatMap(name => ['--disable', name]), '--enable', 'skip_host_skill_discovery',
      '-c', 'mcp_servers={}', '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"', '-c', 'approval_policy="never"',
      '--output-last-message', finalMessage, '-'];
    const piArgs = [input.bin, '--print', '--mode', 'json', '--model', input.model ?? '',
      '--no-session', '--no-tools', '--no-extensions', '--no-mcp', '--no-skills', '--no-context-files',
      '--no-prompt-templates', '--no-themes', '--no-approve', '--offline'];
    if (signal.aborted) return { error: 'Agent 已中断。' };
    const child = spawn(executor === 'codex' ? input.bin : process.execPath, executor === 'codex' ? codexArgs : piArgs, {
      cwd: input.repo, env: agentEnvironment(executor, input.model), shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      child.stdout.destroy();
      void stopAgent(child);
    };
    const deadline = AbortSignal.timeout(agentTimeout);
    const end = AbortSignal.any([signal, deadline]);
    end.addEventListener('abort', stop, { once: true });
    const chunks: Buffer[] = [];
    // Pi streams token and reasoning deltas as JSON events before the bounded final answer.
    const maxTransportBytes = executor === 'pi' ? 1024 * 1024 : 65536;
    let bytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= maxTransportBytes) chunks.push(chunk);
      else stop();
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    child.stdin.on('error', () => { /* Startup failures can close stdin before the exec error. */ });
    child.stdin.end(input.prompt);
    let status: number | null;
    try { status = await exited; } finally { end.removeEventListener('abort', stop); }
    if (deadline.aborted) return { error: 'Agent 超过 90 秒运行时限。' };
    if (bytes > maxTransportBytes) return { error: 'Agent CLI 事件流超过大小限制。' };
    if (signal.aborted) return { error: 'Agent 已中断。' };
    if (status !== 0) {
      const cli = executor === 'codex' ? 'Codex' : 'Pi';
      return { error: cli + ' CLI 执行失败，请核对本机登录、网络和运行配置。' };
    }
    const events = Buffer.concat(chunks).toString('utf8').split('\n').reverse().map(parseJson);
    const evidence: AgentEvidence = { executor, protocol: 1, durationMs: Math.round(performance.now() - started) };
    if (executor === 'pi') return readPiResult(events, evidence, input.model);
    const event = events.find(event => event?.type === 'turn.completed');
    if (event?.usage && typeof event.usage === 'object') {
      const raw = event.usage as Record<string, unknown>;
      evidence.usage = readUsage({ inputTokens: raw.input_tokens, outputTokens: raw.output_tokens,
        cacheReadTokens: raw.cached_input_tokens });
    }
    const file = await open(finalMessage, 'r');
    try {
      const meta = await file.stat();
      if (!meta.isFile() || meta.size < 1 || meta.size > 4096) return { error: 'Agent 最终输出为空或超过大小限制。' };
      const buffer = Buffer.alloc(4097);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== meta.size) return { error: 'Agent 最终输出不完整。' };
      const output = buffer.toString('utf8', 0, bytesRead);
      return validOutput(output) ? { output, evidence } : { error: 'Agent 最终输出为空或超过大小限制。' };
    } finally { await file.close(); }
  } finally {
    const actual = await realpath(scratch);
    if (actual === scratch && dirname(actual) === tempRoot) await rm(actual, { recursive: true, force: true });
  }
}

// This extra process owns the native CLI. An OS-level kill of the Worker closes
// its IPC pipe and still gives the guard a chance to reap the CLI and its children.
export function askAgent(input: AgentInput, signal: AbortSignal): Promise<AgentReply> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve({ error: 'Worker 已中断。' });
    const guard = fork(new URL(import.meta.url), ['--agent-guard'], {
      env: agentEnvironment(input.executor ?? 'codex', input.model),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: process.execArgv,
    });
    const disconnect = () => { if (guard.connected) guard.disconnect(); };
    signal.addEventListener('abort', disconnect, { once: true });
    let reply: AgentReply = { error: 'Agent 执行进程意外结束。' };
    guard.once('message', value => { reply = value as AgentReply; });
    guard.once('error', disconnect);
    // Windows can emit only exit after a parent-initiated IPC disconnect,
    // while a failed spawn can emit only close.
    const complete = () => {
      guard.off('exit', complete);
      guard.off('close', complete);
      signal.removeEventListener('abort', disconnect);
      resolve(signal.aborted ? { error: 'Agent 已中断。' } : reply);
    };
    guard.once('exit', complete);
    guard.once('close', complete);
    guard.send(input, error => { if (error) disconnect(); });
  });
}

export async function isNativeAgent(bin: string) {
  return typeof bin === 'string' && isAbsolute(bin) &&
    (process.platform !== 'win32' || bin.toLowerCase().endsWith('.exe')) && (await stat(bin).catch(() => null))?.isFile();
}

export async function isExecutorEntry(executor: ExecutorId, file: string) {
  if (executor === 'codex') return isNativeAgent(file);
  return typeof file === 'string' && isAbsolute(file) && /\.[cm]?js$/i.test(file) &&
    (await stat(file).catch(() => null))?.isFile();
}

if (process.send && process.argv[2] === '--agent-guard' && process.argv[1] &&
    pathToFileURL(process.argv[1]).href === import.meta.url) {
  const abort = new AbortController();
  process.once('disconnect', () => abort.abort());
  process.once('message', async value => {
    const result = await runAgent(value as AgentInput, abort.signal)
      .catch((): AgentReply => ({ error: '无法启动 Agent 或读取最终输出。' }));
    if (process.connected) process.send!(result, () => { if (process.connected) process.disconnect(); });
  });
}
