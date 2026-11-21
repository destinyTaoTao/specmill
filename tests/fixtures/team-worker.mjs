import { tsImport } from 'tsx/esm/api';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

// Replace only model inference. The fixture still creates the same Git evidence as a real coding attempt.
process.once('message', async claim => {
  try {
    const { createTeamWorkspace, commitTask, integrateTasks } = await tsImport('../../src/server/team/workspace.ts', import.meta.url);
    const workspace = await createTeamWorkspace(claim.root, claim);
    const content = claim.task === 'dates' ? 'order_date BETWEEN :start_date AND :end_date' : "status = 'paid'";
    const result = claim.task === 'integrate'
      ? { kind: 'integration', integration: await integrateTasks(workspace, claim, claim.inputs) }
      : { kind: 'task', artifact: await commitTask(workspace, claim, content) };
    if (result.kind === 'integration' && await access(join(claim.root, 'wrong-target')).then(() => true, () => false)) {
      result.integration.commit = '0'.repeat(40);
    }
    process.send(result, () => process.disconnect());
  } catch {
    process.send({ kind: 'failure', error: '测试 Worker 未生成 Git 证据。' }, () => process.disconnect());
  }
});
