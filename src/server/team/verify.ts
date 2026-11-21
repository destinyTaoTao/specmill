import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { TeamClaim, TeamIntegration } from './contracts.js';
import { createTeamWorkspace, integrateTasks, validScope } from './workspace.js';

export async function verifyIntegration(claim: TeamClaim, result: TeamIntegration): Promise<boolean> {
  try {
    if (!validScope(claim) || claim.task !== 'integrate' || !claim.inputs?.dates || !claim.inputs.paid) return false;
    const base = await realpath(tmpdir());
    const scratch = await mkdtemp(join(base, 'specmill-team-proof-'));
    try {
      const workspace = await createTeamWorkspace(scratch, claim);
      const reproduced = await integrateTasks(workspace, claim, claim.inputs);
      return isDeepStrictEqual(result, reproduced);
    } finally {
      const actual = await realpath(scratch);
      if (actual !== scratch || dirname(actual) !== base) throw new Error('复核目录绑定已改变。');
      await rm(actual, { recursive: true, force: true, maxRetries: 3 });
    }
  } catch {
    return false;
  }
}
