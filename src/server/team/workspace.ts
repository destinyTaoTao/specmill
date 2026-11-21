import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkPilotSql, createPilotRepo, PILOT_SPEC, runSampleGit, runSampleGitWithInput } from '../pilot/sample.js';
import type { TaskArtifact, TeamClaim, TeamIntegration } from './contracts.js';

const fixedCommitter = 'SpecMill Pilot <pilot@example.invalid> 946684800 +0000';
const importRef = 'refs/specmill/import';
const sampleRef = 'refs/heads/sample';
const zeroObjectId = '0'.repeat(40);
const objectId = /^[a-f0-9]{40}$/;
const identifier = /^[a-zA-Z0-9_-]{1,80}$/;
const dateParameter = ':(?:start_date|end_date)';
const comparison = `order_date *(?:<=|>=|<>|=|<|>) *${dateParameter}`;
const between = `order_date +between +${dateParameter} +and +${dateParameter}`;
const status = "status *(?:=|<>) *'(?:paid|pending|cancelled)'";
const predicateGrammar = {
  dates: new RegExp(`^(?:${comparison}(?: +and +${comparison})?|${between})$`, 'i'),
  paid: new RegExp(`^${status}(?: +and +${status})?$`, 'i'),
};

export type CodeTask = TaskArtifact['task'];
type Scope = Pick<TeamClaim, 'projectId' | 'runId' | 'attemptId' | 'generation'>;
type CodeScope = Scope & { task: CodeTask };

export function validScope(scope: Scope) {
  return [scope.projectId, scope.runId, scope.attemptId].every(id => typeof id === 'string' && identifier.test(id)) &&
    Number.isSafeInteger(scope.generation) && scope.generation >= 1;
}

export function extractPredicate(task: CodeTask, output: string): string {
  if (typeof output !== 'string' || Buffer.byteLength(output) > 512 || !/^[\x20-\x7e\t\r\n]+$/.test(output)) {
    throw new Error('谓词超出固定合成样例范围。');
  }
  const value = output.trim();
  const unwrapped = /^```(?:sql)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(value)?.[1]
    ?? /^`([^`\r\n]+)`$/.exec(value)?.[1] ?? value;
  const predicate = unwrapped.trim().replace(/;$/, '').trimEnd().replace(/\s+/g, ' ');
  if (!predicateGrammar[task].test(predicate) ||
      (predicate.match(/:\w+/g) ?? []).some(key => key !== ':start_date' && key !== ':end_date')) {
    throw new Error('谓词超出固定合成样例范围。');
  }
  return predicate;
}

function git(repo: string, ...args: string[]) {
  return runSampleGit(repo, ['--no-replace-objects', ...args]);
}

type SampleFile = 'spec.json' | 'dates.sql' | 'paid.sql' | 'orders.sql';
type Commit = { message: string; parents: string[]; files: Partial<Record<SampleFile, string>> };
const spec = JSON.stringify(PILOT_SPEC) + '\n';
const frozenCommit: Commit = { message: PILOT_SPEC.templateRevision, parents: [], files: { 'spec.json': spec } };

function importData(bytes: string) {
  return `data ${Buffer.byteLength(bytes)}\n${bytes}`;
}

async function importCommits(repo: string, commits: Commit[], ref = importRef) {
  const stream = commits.flatMap(({ message, parents, files }, index) => [
    `commit ${ref}`, `mark :${index + 1}`, `committer ${fixedCommitter}`, importData(message + '\n'),
    ...parents.map((parent, i) => `${i === 0 ? 'from' : 'merge'} ${parent}`),
    ...Object.entries(files).flatMap(([name, bytes]) => [`M 100644 inline ${name}`, importData(bytes)]), '',
  ]);
  stream.push(...commits.map((_, i) => `get-mark :${i + 1}`));
  // Finish materializing objects without advancing HEAD. The caller still checks the old SHA.
  if (ref === importRef) stream.push(`reset ${ref}`, `from ${zeroObjectId}`, '');
  stream.push('done', '');
  const args = ['--no-replace-objects', '-c', 'fastimport.unpackLimit=0', 'fast-import', '--quiet', '--done'];
  const output = await runSampleGitWithInput(repo, args, stream.join('\n'));
  const ids = output.toString('utf8').trimEnd().split('\n');
  if (ids.length !== commits.length || ids.some(id => !objectId.test(id))) throw new Error('无效的提交标识。');
  return ids;
}

export async function createTeamWorkspace(root: string, scope: Scope) {
  if (!validScope(scope)) throw new Error('无效的团队任务作用域。');
  // Every delivery, including a duplicate or stale one, gets a new private repository.
  const repo = await createPilotRepo({ root, attemptId: scope.attemptId });
  await writeFile(join(repo, 'spec.json'), spec, { flag: 'wx', mode: 0o600 });
  const [base] = await importCommits(repo, [frozenCommit], sampleRef);
  await git(repo, 'read-tree', base);
  return { repo, base };
}

type Workspace = Awaited<ReturnType<typeof createTeamWorkspace>>;

function taskCommit(base: string, scope: CodeScope, bytes: string): Commit {
  const { projectId, runId, task, attemptId, generation } = scope;
  return {
    message: `SpecMill ${projectId}/${runId}/${task}/${attemptId}/${generation}`,
    parents: [base],
    files: { [`${task}.sql`]: bytes },
  };
}

export async function commitTask(workspace: Workspace, scope: CodeScope, output: string): Promise<TaskArtifact> {
  const { repo, base } = workspace;
  if (!validScope(scope) || !objectId.test(base)) throw new Error('无效的任务尝试。');
  const content = extractPredicate(scope.task, output);
  const filename = scope.task + '.sql';
  await writeFile(join(repo, filename), content + '\n', { flag: 'wx', mode: 0o600 });
  const [commit] = await importCommits(repo, [taskCommit(base, scope, content + '\n')]);
  await git(repo, 'read-tree', commit);
  await git(repo, 'update-ref', 'HEAD', commit, base);
  const bytes = await git(repo, 'cat-file', 'blob', commit + ':' + filename);
  if (bytes !== content + '\n') throw new Error('任务提交与谓词不符。');
  return { task: scope.task, attemptId: scope.attemptId, generation: scope.generation, commit, content };
}

export function assemble(dates: string, paid: string) {
  return `SELECT id FROM orders WHERE ${dates} AND ${paid} ORDER BY id ASC;\n`;
}

function readBatch(output: Buffer, types: ('commit' | 'blob')[]) {
  let offset = 0;
  const objects = types.map(type => {
    const newline = output.indexOf(10, offset);
    const header = newline < 0 ? null : /^([a-f0-9]{40}) (commit|blob) (\d+)$/.exec(output.toString('utf8', offset, newline));
    if (!header || header[2] !== type) throw new Error('Git 对象缺失或类型不符。');
    const length = Number(header[3]);
    const start = newline + 1;
    const end = start + length;
    if (!Number.isSafeInteger(length) || output[end] !== 10) throw new Error('Git 对象的字节边界无效。');
    offset = end + 1;
    return { id: header[1], bytes: output.subarray(start, end) };
  });
  if (offset !== output.length) throw new Error('Git 返回了意外的对象。');
  return objects;
}

export async function readIntegration(repo: string, commit: string, inputs: NonNullable<TeamClaim['inputs']>): Promise<TeamIntegration> {
  if (!objectId.test(commit)) throw new Error('集成提交标识无效。');
  const objects = [commit, commit + '^1', commit + '^2', commit + ':dates.sql', commit + ':paid.sql', commit + ':orders.sql'];
  const output = await runSampleGitWithInput(repo, ['--no-replace-objects', 'cat-file', '--batch'], objects.join('\n') + '\n');
  const [merge, datesParent, paidParent, datesFile, paidFile, ordersFile] = readBatch(output, ['commit', 'commit', 'commit', 'blob', 'blob', 'blob']);
  const [headers] = merge.bytes.toString('utf8').split('\n\n', 1);
  const parents = headers.split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7));
  if (merge.id !== commit || parents.length !== 2 || parents[0] !== datesParent.id || parents[1] !== paidParent.id ||
      datesParent.id !== inputs.dates.commit || paidParent.id !== inputs.paid.commit) {
    throw new Error('集成提交的父提交与已领取的任务不符。');
  }
  const dates = inputs.dates.content + '\n';
  const paid = inputs.paid.content + '\n';
  const sql = ordersFile.bytes.toString('utf8');
  if (!datesFile.bytes.equals(Buffer.from(dates)) || !paidFile.bytes.equals(Buffer.from(paid)) ||
      sql !== assemble(extractPredicate('dates', dates), extractPredicate('paid', paid))) {
    throw new Error('集成提交内的文件与任务产物不符。');
  }
  return { commit, parents, sql, checks: checkPilotSql(sql) };
}

type IntegrationInputs = NonNullable<TeamClaim['inputs']>;

async function reconstructIntegration(repo: string, scope: Scope, inputs: IntegrationInputs, base?: string) {
  if (!validScope(scope) || (base !== undefined && !objectId.test(base))) throw new Error('无效的集成尝试。');
  const prefix = base === undefined ? [frozenCommit] : [];
  const firstTaskMark = prefix.length + 1;
  // The artifact carries all bytes and provenance needed to reconstruct the exact original
  // Git object without following paths or refs supplied by another process or an old host.
  const tasks = (['dates', 'paid'] as const).map(task => {
    const artifact = inputs[task];
    const provenance = { projectId: scope.projectId, runId: scope.runId, attemptId: artifact.attemptId, generation: artifact.generation, task };
    if (task !== artifact.task || !validScope(provenance) || !objectId.test(artifact.commit) ||
        extractPredicate(task, artifact.content) !== artifact.content) {
      throw new Error('任务产物无法重建为已领取的提交。');
    }
    return taskCommit(base ?? ':1', provenance, artifact.content + '\n');
  });
  const sql = assemble(inputs.dates.content, inputs.paid.content);
  const files = { 'dates.sql': inputs.dates.content + '\n', 'paid.sql': inputs.paid.content + '\n', 'orders.sql': sql };
  const ids = await importCommits(repo, [...prefix, ...tasks, {
    message: `Integrate ${scope.projectId}/${scope.runId}/${scope.attemptId}/${scope.generation}`,
    parents: [`:${firstTaskMark}`, `:${firstTaskMark + 1}`],
    files,
  }]);
  const [dates, paid, commit] = ids.slice(prefix.length);
  if (dates !== inputs.dates.commit || paid !== inputs.paid.commit) throw new Error('任务产物无法重建为已领取的提交。');
  return { commit, files };
}

export async function integrateTasks({ repo, base }: Workspace, scope: Scope, inputs: IntegrationInputs) {
  const { commit, files } = await reconstructIntegration(repo, scope, inputs, base);
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(join(repo, name), bytes, { flag: 'wx', mode: 0o600 });
  }
  await git(repo, 'read-tree', commit);
  await git(repo, 'update-ref', 'HEAD', commit, base);
  return readIntegration(repo, commit, inputs);
}

export async function replayIntegration(root: string, scope: Scope, inputs: IntegrationInputs) {
  const repo = await createPilotRepo({ root, attemptId: scope.attemptId });
  // The service owns this fresh repository and reads the proof by SHA, so it only needs objects.
  const { commit } = await reconstructIntegration(repo, scope, inputs);
  return readIntegration(repo, commit, inputs);
}
