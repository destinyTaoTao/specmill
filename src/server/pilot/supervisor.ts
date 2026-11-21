import { WorkflowSupervisor } from '../workflow/supervisor.js';
import type { PilotLedger } from './ledger.js';
import type { PilotResult } from './sample.js';

type Claim = NonNullable<ReturnType<PilotLedger['claim']>>;

export class PilotSupervisor extends WorkflowSupervisor<Claim, PilotResult> {
  constructor(ledger: PilotLedger, root: string, agentBin: string,
    module = new URL('./worker.js', import.meta.url), reportError: () => void) {
    super({
      claim: () => ledger.claim(), recover: () => ledger.recover(),
      complete: (claim, result) => ledger.finish(claim.attemptId, result),
      interrupt: (claim, reason) => ledger.interrupt(claim.attemptId, reason),
    }, 1, root, agentBin, module, reportError);
  }
}
