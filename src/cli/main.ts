#!/usr/bin/env node
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { decodeSecret, encodeSecret } from '../shared/credentials.js';

class CliError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode: number, readonly details: Record<string, unknown> = {}) { super(message); }
}
type Grant = { requestId: string; sessionId?: string; generation?: number; writerToken: string };
class InputTooLarge extends Error {}
let pendingInputFile: string | undefined;
async function boundedInput(source: AsyncIterable<unknown>, limit = 1024 * 1024) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of source) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (size > limit) throw new InputTooLarge();
    chunks.push(bytes);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

async function main() {
  const args = process.argv.slice(2);
  const [group, action, ...rest] = args;
  const flags = new Map<string, string>();
  let json = false;
  let stdin = false;
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (key === '--json') { json = true; continue; }
    if (key === '--stdin') { if (stdin) throw new CliError('INVALID_ARGUMENT', '参数重复。', 2); stdin = true; continue; }
    if (!key.startsWith('--') || !rest[i + 1] || rest[i + 1].startsWith('--') || flags.has(key)) throw new CliError('INVALID_ARGUMENT', '参数无效或重复。', 2);
    flags.set(key, rest[++i]);
  }
  const required = (key: string) => {
    const value = flags.get(key);
    if (!value) throw new CliError('INVALID_ARGUMENT', `缺少参数 ${key}。`, 2);
    return value;
  };
  const number = (key: string) => {
    const raw = required(key);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) throw new CliError('INVALID_ARGUMENT', `${key} 必须是正整数。`, 2);
    return value;
  };
  let server: URL;
  try { server = new URL(flags.get('--server') ?? 'http://127.0.0.1:43127'); }
  catch { throw new CliError('INVALID_SERVER', '服务地址无效。', 2); }
  if (server.protocol !== 'http:' || server.hostname !== '127.0.0.1' || server.username || server.password || server.pathname !== '/' || server.search || server.hash) throw new CliError('INVALID_SERVER', 'CLI 只连接本机 127.0.0.1 服务。', 2);
  const allowedCommon = ['--server', '--data-dir'];
  const allowed = group === 'project' && action === 'list' ? []
    : group === 'workspace' && action === 'list' ? ['--project']
      : group === 'workspace' && action === 'observe' ? ['--workspace', '--binding-version', '--grant-file', '--request-id', '--untracked-file']
      : group === 'change' && action === 'list' ? ['--project']
        : group === 'change' && action === 'show' ? ['--change']
          : group === 'checkpoint' && action === 'list' ? ['--change']
            : group === 'checkpoint' && action === 'save' ? ['--change', '--grant-file', '--version', '--observation', '--request-id', '--file', '--pending-file']
              : group === 'receipt' && action === 'show' ? ['--request-id']
          : group === 'handoff' && action === 'create' ? ['--change', '--request-id']
            : group === 'handoff' && action === 'show' ? ['--change', '--snapshot', '--file']
          : group === 'run' && action === 'add' ? ['--change', '--workspace', '--method', '--result', '--exit-status', '--claimed-commit', '--claimed-clean', '--notes', '--request-id']
            : group === 'run' && action === 'list' ? ['--change']
          : group === 'evidence' && action === 'add' ? ['--change', '--execution', '--criterion-baseline', '--criterion-id', '--criterion-revision', '--criterion-index', '--result', '--actual-commit', '--notes', '--attachment', '--request-id']
            : group === 'evidence' && action === 'list' ? ['--change']
          : group === 'target' && action === 'add' ? ['--change', '--commit', '--notes', '--request-id']
            : group === 'target' && action === 'list' ? ['--change']
          : group === 'proposal' && action === 'submit' ? ['--change', '--version', '--target', '--reason', '--evidence', '--request-id']
            : group === 'proposal' && action === 'list' ? ['--change']
          : group === 'attachment' && action === 'add' ? ['--project', '--file', '--filename', '--content-type', '--request-id']
            : group === 'attachment' && action === 'list' ? ['--project']
          : group === 'review' && action === 'show' ? ['--change']
            : group === 'review' && action === 'preview' ? ['--change', '--file', '--request-id']
              : group === 'review' && action === 'disposition-preview' ? ['--change', '--file', '--request-id']
          : group === 'export' && action === 'start' ? ['--project', '--request-id']
            : group === 'export' && action === 'status' ? ['--operation']
              : group === 'export' && action === 'list' ? ['--project']
          : group === 'session' && action === 'start' ? ['--change', '--workspace', '--binding-version', '--version', '--tool', '--request-id', '--grant-file']
            : group === 'session' && action === 'release' ? ['--grant-file', '--version', '--request-id'] : null;
  if (!allowed || [...flags.keys()].some(key => !allowedCommon.includes(key) && !allowed.includes(key))) throw new CliError('INVALID_ARGUMENT', '命令或参数无效。', 2);
  const optionalFlags = ['--untracked-file', '--file', '--pending-file'];
  const optionalFor: Record<string, string[]> = { 'run add': ['--exit-status', '--claimed-commit', '--claimed-clean', '--notes'], 'evidence add': ['--actual-commit', '--notes', '--attachment', '--criterion-baseline', '--criterion-revision'], 'target add': ['--notes'], 'proposal submit': ['--target', '--evidence'], 'attachment add': ['--filename', '--content-type'] };
  const optionalHere = optionalFor[`${group} ${action}`] ?? [];
  for (const key of allowed.filter(key => !optionalFlags.includes(key) && !optionalHere.includes(key) && !(group === 'handoff' && action === 'show' && (key === '--change' || key === '--snapshot')))) required(key);
  if (group === 'handoff' && action === 'show') {
    if (Number(flags.has('--change')) + Number(flags.has('--snapshot')) !== 1) throw new CliError('INVALID_ARGUMENT', '请指定 --change 或 --snapshot 其中之一。', 2);
    if (!flags.has('--snapshot') && flags.has('--file')) throw new CliError('INVALID_ARGUMENT', '--file 只能与 --snapshot 搭配。', 2);
  }
  if (group === 'checkpoint' && action === 'save') {
    if (Number(stdin) + Number(flags.has('--file')) + Number(flags.has('--pending-file')) !== 1) throw new CliError('INVALID_ARGUMENT', '请指定 --file、--stdin 或 --pending-file 其中之一。', 2);
  } else if (stdin) throw new CliError('INVALID_ARGUMENT', '此命令不支持 --stdin。', 2);
  if (flags.has('--version')) number('--version');
  if (flags.has('--binding-version')) number('--binding-version');
  if (flags.has('--criterion-index')) number('--criterion-index');
  if (flags.has('--result') && !['passed', 'failed', 'unknown'].includes(flags.get('--result')!)) throw new CliError('INVALID_ARGUMENT', '--result 只能是 passed、failed 或 unknown。', 2);
  if (flags.has('--claimed-clean') && !['true', 'false'].includes(flags.get('--claimed-clean')!)) throw new CliError('INVALID_ARGUMENT', '--claimed-clean 只能是 true 或 false。', 2);
  const dataDir = resolve(flags.get('--data-dir') ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'SpecMill'));
  let agentToken: string;
  try { agentToken = await decodeSecret((await readFile(join(dataDir, 'cli-token'), 'utf8')).trim()); }
  catch { throw new CliError('SERVICE_UNAVAILABLE', '无法读取 CLI 凭据，请先启动本机服务并检查数据目录。', 6); }
  if (!agentToken) throw new CliError('SERVICE_UNAVAILABLE', 'CLI 凭据为空，请重启本机服务。', 6);
  async function request(path: string, body?: unknown, writerToken?: string) {
    let response: Response;
    try {
      response = await fetch(new URL(path, server), { method: body === undefined ? 'GET' : 'POST', redirect: 'error', headers: { Authorization: `Bearer ${agentToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(writerToken ? { 'X-SpecMill-Writer-Token': writerToken } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    } catch { throw new CliError('SERVICE_UNAVAILABLE', '无法连接本机服务；写入结果可能未知，请使用原请求标识重试。', 6); }
    const value = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      const exitCode = response.status === 401 || response.status === 403 ? 4 : response.status === 409 ? 3 : response.status === 422 ? 5 : response.status === 400 || response.status === 413 ? 2 : 6;
      const details = Object.fromEntries(['requestId', 'currentVersion', 'dimension', 'used', 'requestedIncrement', 'limit'].filter(key => value?.[key] !== undefined).map(key => [key, value?.[key]]));
      throw new CliError(typeof value?.code === 'string' ? value.code : 'SERVICE_ERROR', typeof value?.message === 'string' ? value.message : '本机服务请求失败。', exitCode, details);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('INVALID_RESPONSE', '服务响应不完整；写入结果可能未知，请使用原请求标识重试。', 6);
    return value;
  }
  async function requestRaw(path: string, content: Buffer) {
    let response: Response;
    try {
      response = await fetch(new URL(path, server), { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/octet-stream', 'Content-Length': String(content.length) }, body: new Uint8Array(content), signal: AbortSignal.timeout(60000) });
    } catch { throw new CliError('SERVICE_UNAVAILABLE', '无法连接本机服务；上传结果可能未知，请使用原请求标识重试。', 6); }
    const value = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      const exitCode = response.status === 401 || response.status === 403 ? 4 : response.status === 409 ? 3 : response.status === 422 ? 5 : response.status === 400 || response.status === 413 ? 2 : 6;
      const details = Object.fromEntries(['requestId', 'dimension', 'used', 'requestedIncrement', 'limit'].filter(key => value?.[key] !== undefined).map(key => [key, value?.[key]]));
      throw new CliError(typeof value?.code === 'string' ? value.code : 'SERVICE_ERROR', typeof value?.message === 'string' ? value.message : '本机服务请求失败。', exitCode, details);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('INVALID_RESPONSE', '服务响应不完整；上传结果可能未知，请使用原请求标识重试。', 6);
    return value;
  }
  async function readGrant() {
    let grant: Grant;
    try { grant = JSON.parse(await decodeSecret(await readFile(resolve(required('--grant-file')), 'utf8'))) as Grant; }
    catch { throw new CliError('GRANT_FILE_ERROR', '无法读取写会话授权文件。', 6); }
    if (typeof grant.sessionId !== 'string' || typeof grant.generation !== 'number' || typeof grant.writerToken !== 'string') throw new CliError('GRANT_FILE_ERROR', '写会话授权文件无效。', 2);
    return grant as Grant & { sessionId: string; generation: number };
  }
  let result: Record<string, unknown>;
  let rawMarkdown: string | undefined;
  if (group === 'project' && action === 'list') {
    result = await request('/api/v1/projects');
  } else if (group === 'workspace' && action === 'list') {
    result = await request(`/api/v1/projects/${encodeURIComponent(required('--project'))}/workspaces`);
  } else if (group === 'workspace' && action === 'observe') {
    const grant = await readGrant();
    let selectedUntracked: string[] = [];
    if (flags.has('--untracked-file')) {
      try { selectedUntracked = (await boundedInput(createReadStream(resolve(required('--untracked-file'))))).split(/\r?\n/).filter(Boolean); }
      catch { throw new CliError('INPUT_ERROR', '无法读取未跟踪文件列表。', 6); }
    }
    result = await request(`/api/v1/workspaces/${encodeURIComponent(required('--workspace'))}/observations`, { requestId: required('--request-id'), expectedBindingVersion: number('--binding-version'), selectedUntracked, writerSessionId: grant.sessionId, generation: grant.generation }, grant.writerToken);
  } else if (group === 'change' && action === 'list') {
    result = await request(`/api/v1/projects/${encodeURIComponent(required('--project'))}/changes`);
  } else if (group === 'change' && action === 'show') {
    result = await request(`/api/v1/changes/${encodeURIComponent(required('--change'))}`);
  } else if (group === 'checkpoint' && action === 'list') {
    result = await request(`/api/v1/changes/${encodeURIComponent(required('--change'))}/checkpoints`);
  } else if (group === 'receipt' && action === 'show') {
    result = await request(`/api/v1/receipts/${encodeURIComponent(required('--request-id'))}`);
  } else if (group === 'checkpoint' && action === 'save') {
    const grant = await readGrant();
    let input: string;
    try {
      if (flags.has('--pending-file')) {
        pendingInputFile = resolve(required('--pending-file'));
        input = await decodeSecret(await boundedInput(createReadStream(pendingInputFile), 4 * 1024 * 1024));
      }
      else input = await boundedInput(stdin ? process.stdin : createReadStream(resolve(required('--file'))));
      if (Buffer.byteLength(input, 'utf8') > 1024 * 1024) throw new InputTooLarge();
    } catch (error) {
      if (error instanceof InputTooLarge || error instanceof TypeError) throw new CliError('INPUT_ERROR', '正文超过 1 MiB 或不是有效 UTF-8。', 2);
      throw new CliError('INPUT_ERROR', '无法读取保存点正文。', 6);
    }
    if (stdin) {
      try {
        const staging = join(dataDir, 'staging');
        await mkdir(staging, { recursive: true, mode: 0o700 });
        const temporaryInput = join(staging, `checkpoint-input-${randomUUID()}.enc`);
        await writeFile(temporaryInput, await encodeSecret(input), { flag: 'wx', mode: 0o600 });
        pendingInputFile = temporaryInput;
      } catch { throw new CliError('INPUT_ERROR', '无法保护标准输入正文，尚未提交。', 6); }
    }
    let content: unknown;
    try { content = JSON.parse(input) as unknown; } catch { throw new CliError('INVALID_ARGUMENT', '保存点正文不是有效 JSON。', 2); }
    if (!content || typeof content !== 'object' || Array.isArray(content)) throw new CliError('INVALID_ARGUMENT', '保存点正文必须是 JSON 对象。', 2);
    if ('observationId' in content) throw new CliError('INVALID_ARGUMENT', '正文不能包含 observationId，请通过 --observation 指定。', 2);
    result = await request(`/api/v1/changes/${encodeURIComponent(required('--change'))}/checkpoints`, { requestId: required('--request-id'), expectedVersion: number('--version'), writerSessionId: grant.sessionId, generation: grant.generation, payload: { ...content, observationId: required('--observation') } }, grant.writerToken);
  } else if (group === 'handoff' && action === 'create') {
    result = await request(`/api/v1/changes/${encodeURIComponent(required('--change'))}/handoffs`, { requestId: required('--request-id') });
  } else if (group === 'handoff' && action === 'show') {
    if (flags.has('--change')) {
      result = await request(`/api/v1/changes/${encodeURIComponent(flags.get('--change')!)}/handoffs`);
    } else {
      const rendered = await request(`/api/v1/handoffs/${encodeURIComponent(flags.get('--snapshot')!)}/render`) as { snapshotId?: string; markdown?: string; sha256?: string };
      if (typeof rendered.markdown !== 'string' || typeof rendered.snapshotId !== 'string' || typeof rendered.sha256 !== 'string') throw new CliError('INVALID_RESPONSE', '交接材料响应不完整。', 6);
      if (flags.has('--file')) {
        const target = resolve(flags.get('--file')!);
        // 不覆盖未知现有文件：输出失败不影响已保存的快照，可换路径重试。
        try { await writeFile(target, rendered.markdown, { flag: 'wx' }); }
        catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') throw new CliError('OUTPUT_FILE_EXISTS', '目标文件已存在，不会覆盖；请改用新的输出路径。', 6);
          throw new CliError('OUTPUT_WRITE_FAILED', '无法写出交接材料文件；快照不受影响，可重试。', 6);
        }
        result = { snapshotId: rendered.snapshotId, file: target, sha256: rendered.sha256 };
      } else if (json) {
        result = { snapshotId: rendered.snapshotId, sha256: rendered.sha256, markdown: rendered.markdown };
      } else {
        result = { snapshotId: rendered.snapshotId, sha256: rendered.sha256, markdown: rendered.markdown };
        rawMarkdown = rendered.markdown;
      }
    }
  } else if (group === 'run' && action === 'add') {
    result = await request(`/api/v1/changes/${encodeURIComponent(required('--change'))}/executions`, { requestId: required('--request-id'), workspaceId: required('--workspace'), payload: {
      method: required('--method'), result: required('--result') as 'passed' | 'failed' | 'unknown',
      exitStatus: flags.get('--exit-status'), claimedCommit: flags.get('--claimed-commit'),
      claimedClean: flags.has('--claimed-clean') ? flags.get('--claimed-clean') === 'true' : undefined, notes: flags.get('--notes'),
    } });
  } else if (group === 'run' && action === 'list') {
    result = await request(`/api/v1/changes/${encodeURIComponent(required('--change'))}/executions`);
  } else if (group === 'evidence' && action === 'add') {
    if (Number(flags.has('--criterion-baseline')) + Number(flags.has('--criterion-revision')) !== 1) throw new CliError('INVALID_ARGUMENT', '请指定 --criterion-baseline 或 --criterion-revision 其中之一。', 2);
    if (flags.has('--criterion-baseline') && !flags.has('--criterion-id')) throw new CliError('INVALID_ARGUMENT', '基线条件需要 --criterion-id 指向稳定条件标识。', 2);
    result = await request(`/api/v1/changes/${encodeURIComponent(required('--change'))}/evidence`, { requestId: required('--request-id'), payload: {
      executionId: required('--execution'),
      criterion: flags.has('--criterion-baseline') ? { kind: 'baseline', baselineId: flags.get('--criterion-baseline')!, criterionId: required('--criterion-id') } : { kind: 'draft', revisionId: flags.get('--criterion-revision')! },
      criterionIndex: number('--criterion-index'), result: required('--result') as 'passed' | 'failed',
      actualCommit: flags.get('--actual-commit'), notes: flags.get('--notes'),
      attachmentIds: flags.get('--attachment')?.split(',').map(item => item.trim()).filter(Boolean),
    } });
  } else if (group === 'evidence' && action === 'list') {
    result = await request(`/api/v1/changes/${encodeURIComponent(required('--change'))}/evidence`);
  } else if (group === 'target' && action === 'add') {
    result = await request(`/api/v1/changes/${encodeURIComponent(required('--change'))}/acceptance-targets`, { requestId: required('--request-id'), payload: { commit: required('--commit'), notes: flags.get('--notes') } });
  } else if (group === 'target' && action === 'list') {
    result = await request(`/api/v1/changes/${encodeURIComponent(required('--change'))}/acceptance-targets`);
  } else if (group === 'proposal' && action === 'submit') {
    result = await request(`/api/v1/changes/${encodeURIComponent(required('--change'))}/acceptance-proposals`, { requestId: required('--request-id'), expectedVersion: number('--version'), payload: {
      reason: required('--reason'), targetId: flags.get('--target'), evidenceIds: flags.get('--evidence')?.split(',').map(item => item.trim()).filter(Boolean),
    } });
  } else if (group === 'proposal' && action === 'list') {
    result = await request(`/api/v1/changes/${encodeURIComponent(required('--change'))}/acceptance-proposals`);
  } else if (group === 'attachment' && action === 'add') {
    let content: Buffer;
    try { content = await readFile(resolve(required('--file'))); }
    catch { throw new CliError('INPUT_ERROR', '无法读取附件文件。', 6); }
    if (content.length === 0) throw new CliError('INPUT_ERROR', '附件内容为空。', 2);
    if (content.length > 5 * 1024 * 1024) throw new CliError('INPUT_ERROR', '单个附件不能超过 5 MiB。', 2);
    const query = new URLSearchParams({ requestId: required('--request-id'), filename: flags.get('--filename') ?? resolve(required('--file')).split(/[\\/]/).pop()! });
    if (flags.has('--content-type')) query.set('contentType', flags.get('--content-type')!);
    result = await requestRaw(`/api/v1/projects/${encodeURIComponent(required('--project'))}/attachments?${query.toString()}`, content);
  } else if (group === 'attachment' && action === 'list') {
    result = await request(`/api/v1/projects/${encodeURIComponent(required('--project'))}/attachments`);
  } else if (group === 'review' && action === 'show') {
    result = await request(`/api/v1/changes/${encodeURIComponent(required('--change'))}/review`);
  } else if (group === 'review' && action === 'preview') {
    let selections: unknown;
    try { selections = JSON.parse(await boundedInput(createReadStream(resolve(required('--file'))))); }
    catch { throw new CliError('INPUT_ERROR', '无法读取选择文件。', 6); }
    result = await request(`/api/v1/changes/${encodeURIComponent(required('--change'))}/review/preview`, { requestId: required('--request-id'), payload: { selections } });
  } else if (group === 'review' && action === 'disposition-preview') {
    let rows: unknown;
    try { rows = JSON.parse(await boundedInput(createReadStream(resolve(required('--file'))))); }
    catch { throw new CliError('INPUT_ERROR', '无法读取处置行文件。', 6); }
    const version = number('--version');
    result = await request(`/api/v1/changes/${encodeURIComponent(required('--change'))}/review/failure-dispositions/preview`, { requestId: required('--request-id'), expectedVersion: version, payload: { rows } });
  } else if (group === 'export' && action === 'start') {
    result = await request(`/api/v1/projects/${encodeURIComponent(required('--project'))}/exports`, { requestId: required('--request-id') });
  } else if (group === 'export' && action === 'status') {
    result = await request(`/api/v1/exports/${encodeURIComponent(required('--operation'))}`);
  } else if (group === 'export' && action === 'list') {
    result = await request(`/api/v1/projects/${encodeURIComponent(required('--project'))}/exports`);
  } else if (group === 'session' && action === 'start') {
    const changeId = required('--change');
    const requestId = required('--request-id');
    const grantFile = resolve(required('--grant-file'));
    const body = { requestId, expectedVersion: number('--version'), payload: { workspaceId: required('--workspace'), expectedBindingVersion: number('--binding-version'), toolLabel: required('--tool') } };
    let existing: Grant | undefined;
    try { existing = JSON.parse(await decodeSecret(await readFile(grantFile, 'utf8'))) as Grant; }
    catch (error) { if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw new CliError('GRANT_FILE_ERROR', '无法读取已有授权文件。', 6); }
    if (existing && (existing.requestId !== requestId || !/^[0-9a-f]{64}$/.test(existing.writerToken))) throw new CliError('GRANT_FILE_EXISTS', '授权文件已存在或无效，请使用新的文件路径。', 2);
    if (!existing) {
      existing = { requestId, writerToken: randomBytes(32).toString('hex') };
      try { await writeFile(grantFile, await encodeSecret(JSON.stringify(existing)), { flag: 'wx', mode: 0o600 }); }
      catch { throw new CliError('GRANT_FILE_ERROR', '无法创建授权文件，尚未申请会话。', 6); }
    }
    const response = await request(`/api/v1/changes/${encodeURIComponent(changeId)}/writer-sessions`, body, existing.writerToken);
    if (typeof response.requestId !== 'string' || typeof response.resourceId !== 'string' || typeof response.recordVersion !== 'number' || typeof response.committedAt !== 'string' || typeof response.generation !== 'number' || typeof response.active !== 'boolean') throw new CliError('INVALID_RESPONSE', '服务响应缺少回执；请使用原请求标识和授权文件重试。', 6);
    if (!response.active) throw new CliError('SESSION_EXPIRED', '会话已失效，不能重新使用原授权。', 3);
    if ((existing.sessionId && existing.sessionId !== response.resourceId) || (existing.generation && existing.generation !== response.generation)) throw new CliError('GRANT_FILE_EXISTS', '授权文件内容不匹配，请检查原请求。', 2);
    const grant: Grant = { requestId, sessionId: response.resourceId, generation: response.generation, writerToken: existing.writerToken };
    const temporary = `${grantFile}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, await encodeSecret(JSON.stringify(grant)), { flag: 'wx', mode: 0o600 }); await rename(temporary, grantFile); }
    catch { await rm(temporary, { force: true }).catch(() => {}); throw new CliError('GRANT_FILE_ERROR', '会话可能已创建，请用原请求标识和授权文件重试。', 6); }
    result = { ...response, grantFile };
  } else if (group === 'session' && action === 'release') {
    const grant = await readGrant();
    result = await request(`/api/v1/writer-sessions/${encodeURIComponent(grant.sessionId)}/release`, { requestId: required('--request-id'), expectedVersion: number('--version'), generation: grant.generation }, grant.writerToken);
  } else throw new CliError('INVALID_ARGUMENT', '命令无效。', 2);
  if ((group === 'session' && action === 'release') || (group === 'workspace' && action === 'observe') || (group === 'checkpoint' && action === 'save') || (group === 'handoff' && action === 'create') || (group === 'run' && action === 'add') || (group === 'evidence' && action === 'add') || (group === 'target' && action === 'add') || (group === 'proposal' && action === 'submit') || (group === 'attachment' && action === 'add')) {
    if (typeof result.requestId !== 'string' || typeof result.resourceId !== 'string' || typeof result.recordVersion !== 'number' || typeof result.committedAt !== 'string') throw new CliError('INVALID_RESPONSE', '服务响应缺少回执；写入结果可能未知，请使用原请求标识重试。', 6);
  }
  if (pendingInputFile && stdin) {
    try { await rm(pendingInputFile); pendingInputFile = undefined; }
    catch { /* retained encrypted input is still usable if cleanup fails */ }
  }
  if (pendingInputFile) result = { ...result, retainedInputFile: pendingInputFile };
  if (rawMarkdown !== undefined && !json) process.stdout.write(`${rawMarkdown.endsWith('\n') ? rawMarkdown : `${rawMarkdown}\n`}`);
  else process.stdout.write(`${json ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const failure = error instanceof CliError ? error : new CliError('SERVICE_UNAVAILABLE', '本机服务或文件不可用。', 6);
  process.stderr.write(`${JSON.stringify({ code: failure.code, message: failure.message, ...failure.details, ...(pendingInputFile ? { pendingInputFile } : {}) })}\n`);
  process.exitCode = failure.exitCode;
});
