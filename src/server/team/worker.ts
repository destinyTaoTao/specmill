import { askAgent, isNativeAgent } from '../pilot/worker.js';
import type { TeamClaim, TeamResult } from './contracts.js';
import { commitTask, createTeamWorkspace, integrateTasks, validScope } from './workspace.js';

type TeamJob = TeamClaim & { root: string; agentBin: string };
const prompts = {
  dates: 'Write only the SQLite WHERE predicate for an inclusive ISO business-date range. Column order_date is TEXT. ' +
    'Use :start_date and :end_date in simple comparisons joined by AND, or BETWEEN. Omit WHERE, parentheses and the semicolon.',
  paid: 'Write only the SQLite WHERE predicate selecting paid orders. Column status is TEXT and the paid literal is \'paid\'. ' +
    'Use a simple comparison. Omit WHERE, parentheses and the semicolon.',
};

async function work(job: TeamJob, signal: AbortSignal): Promise<TeamResult> {
  if (!validScope(job) || !['dates', 'paid', 'integrate'].includes(job.task)) {
    return { kind: 'failure', error: 'Worker 收到无效的团队任务。' };
  }
  if (job.task === 'integrate') {
    if (!job.inputs?.dates || !job.inputs.paid) return { kind: 'failure', error: '缺少已领取的任务产物。' };
    const workspace = await createTeamWorkspace(job.root, job);
    return { kind: 'integration', integration: await integrateTasks(workspace, job, job.inputs) };
  }
  if (!await isNativeAgent(job.agentBin)) return { kind: 'failure', error: '需要 Codex 原生可执行文件的绝对路径。' };
  const workspace = await createTeamWorkspace(job.root, job);
  const reply = await askAgent({ bin: job.agentBin, repo: workspace.repo, prompt: prompts[job.task] }, signal);
  if ('error' in reply) return { kind: 'failure', error: reply.error };
  if (signal.aborted) return { kind: 'failure', error: 'Worker 已中断。' };
  return { kind: 'task', artifact: await commitTask(workspace, { ...job, task: job.task }, reply.output) };
}

if (process.send) {
  const abort = new AbortController();
  process.once('disconnect', () => abort.abort());
  process.once('message', async value => {
    const result = await work(value as TeamJob, abort.signal)
      .catch((): TeamResult => ({ kind: 'failure', error: '无法验证团队任务的产物或生成固定提交。' }));
    if (process.connected) process.send!(result, () => { if (process.connected) process.disconnect(); });
  });
}
