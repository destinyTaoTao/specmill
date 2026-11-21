import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkPilotSql, createPilotRepo, PILOT_SPEC, runSampleGit } from '../pilot/sample.js';
import type { TaskArtifact, TeamClaim, TeamIntegration } from './contracts.js';

const fixedGitDate = '2000-01-01T00:00:00Z';
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
  return runSampleGit(repo, args, fixedGitDate);
}

export async function createTeamWorkspace(root: string, scope: Scope) {
  if (!validScope(scope)) throw new Error('无效的团队任务作用域。');
  // Every delivery, including a duplicate or stale one, gets a new private repository.
  const repo = await createPilotRepo({ root, attemptId: scope.attemptId });
  await writeFile(join(repo, 'spec.json'), JSON.stringify(PILOT_SPEC) + '\n', { flag: 'wx', mode: 0o600 });
  await git(repo, 'add', '--', 'spec.json');
  await git(repo, 'commit', '--quiet', '-m', PILOT_SPEC.templateRevision);
  const base = (await git(repo, 'rev-parse', '--verify', 'HEAD^{commit}')).trim();
  if (!objectId.test(base)) throw new Error('无效的样例基线。');
  return { repo, base };
}

type Workspace = Awaited<ReturnType<typeof createTeamWorkspace>>;

async function commitTree(repo: string, parents: string[], message: string) {
  const tree = (await git(repo, 'write-tree')).trim();
  const sha = (await git(repo, 'commit-tree', tree, ...parents.flatMap(id => ['-p', id]), '-m', message)).trim();
  if (!objectId.test(sha)) throw new Error('无效的提交标识。');
  return sha;
}

async function writeTaskObject({ repo, base }: Workspace, scope: CodeScope, content: string) {
  // Rebuild the task tree from its frozen base, even if the other task has already been staged.
  await git(repo, 'read-tree', base);
  const filename = scope.task + '.sql';
  await writeFile(join(repo, filename), content + '\n', { flag: 'wx', mode: 0o600 });
  await git(repo, 'add', '--', filename);
  const { projectId, runId, task, attemptId, generation } = scope;
  return commitTree(repo, [base], `SpecMill ${projectId}/${runId}/${task}/${attemptId}/${generation}`);
}

export async function commitTask(workspace: Workspace, scope: CodeScope, output: string): Promise<TaskArtifact> {
  if (!validScope(scope)) throw new Error('无效的任务尝试。');
  const content = extractPredicate(scope.task, output);
  const commit = await writeTaskObject(workspace, scope, content);
  await git(workspace.repo, 'update-ref', 'HEAD', commit, workspace.base);
  const bytes = await git(workspace.repo, 'cat-file', 'blob', commit + ':' + scope.task + '.sql');
  if (bytes !== content + '\n') throw new Error('任务提交与谓词不符。');
  return { task: scope.task, attemptId: scope.attemptId, generation: scope.generation, commit, content };
}

export function assemble(dates: string, paid: string) {
  return `SELECT id FROM orders WHERE ${dates} AND ${paid} ORDER BY id ASC;\n`;
}

export async function readIntegration(repo: string, commit: string, inputs: NonNullable<TeamClaim['inputs']>): Promise<TeamIntegration> {
  if (!objectId.test(commit)) throw new Error('集成提交标识无效。');
  const ancestry = (await git(repo, 'rev-list', '--parents', '-n', '1', commit)).trim().split(' ');
  if (ancestry.length !== 3 || ancestry[0] !== commit || ancestry[1] !== inputs.dates.commit || ancestry[2] !== inputs.paid.commit) {
    throw new Error('集成提交的父提交与已领取的任务不符。');
  }
  const [dates, paid, sql] = await Promise.all(['dates.sql', 'paid.sql', 'orders.sql'].map(
    filename => git(repo, 'cat-file', 'blob', commit + ':' + filename)));
  if (dates !== inputs.dates.content + '\n' || paid !== inputs.paid.content + '\n' ||
      sql !== assemble(extractPredicate('dates', dates), extractPredicate('paid', paid))) {
    throw new Error('集成提交内的文件与任务产物不符。');
  }
  return { commit, parents: ancestry.slice(1), sql, checks: checkPilotSql(sql) };
}

export async function integrateTasks(workspace: Workspace, scope: Scope, inputs: NonNullable<TeamClaim['inputs']>) {
  if (!validScope(scope)) throw new Error('无效的集成尝试。');
  const { repo, base } = workspace;
  // The artifact carries all bytes and provenance needed to reconstruct the exact original
  // Git object without following paths or refs supplied by another process or an old host.
  for (const task of ['dates', 'paid'] as const) {
    const artifact = inputs[task];
    const provenance = { projectId: scope.projectId, runId: scope.runId, attemptId: artifact.attemptId, generation: artifact.generation, task };
    if (task !== artifact.task || !validScope(provenance) || !objectId.test(artifact.commit) ||
        extractPredicate(task, artifact.content) !== artifact.content ||
        await writeTaskObject(workspace, provenance, artifact.content) !== artifact.commit) {
      throw new Error('任务产物无法重建为已领取的提交。');
    }
  }
  const sql = assemble(inputs.dates.content, inputs.paid.content);
  await writeFile(join(repo, 'orders.sql'), sql, { flag: 'wx', mode: 0o600 });
  await git(repo, 'add', '--', 'dates.sql', 'paid.sql', 'orders.sql');
  const commit = await commitTree(repo, [inputs.dates.commit, inputs.paid.commit],
    `Integrate ${scope.projectId}/${scope.runId}/${scope.attemptId}/${scope.generation}`);
  await git(repo, 'update-ref', 'HEAD', commit, base);
  return readIntegration(repo, commit, inputs);
}
