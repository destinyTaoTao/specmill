import { createTeamWorkspace, commitTask, integrateTasks } from '../../dist-server/server/team/workspace.js';

process.once('message', async claim => {
  let result;
  try {
    const workspace = await createTeamWorkspace(claim.root, claim);
    const content = claim.task === 'dates' ? 'order_date BETWEEN :start_date AND :end_date' : "status = 'paid'";
    result = claim.task === 'integrate'
      ? { kind: 'integration', integration: await integrateTasks(workspace, claim, claim.inputs) }
      : { kind: 'task', artifact: await commitTask(workspace, claim, content) };
  } catch {
    result = { kind: 'failure', error: '确定性 Worker 无法生成合成证据。' };
  }
  if (process.connected) process.send(result, () => { if (process.connected) process.disconnect(); });
});
