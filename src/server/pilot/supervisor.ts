import { fork, type ChildProcess } from 'node:child_process';
import type { PilotLedger } from './ledger.js';
import type { PilotResult } from './sample.js';

// One supervisor per locked local data directory. Only the service opens the ledger.
export class PilotSupervisor {
  private child?: ChildProcess;
  private timer?: NodeJS.Timeout;
  private deadline?: NodeJS.Timeout;
  private killTimer?: NodeJS.Timeout;
  private stopping = false;
  private reconcile = false;
  private finished: Promise<void> = Promise.resolve();

  constructor(private ledger: PilotLedger, private root: string, private agentBin: string,
    private module = new URL('./worker.js', import.meta.url), private reportError: () => void) {}

  start() {
    this.ledger.recover();
    this.wake();
  }

  wake(delay = 0) {
    if (this.stopping || this.child || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        if (this.reconcile) this.ledger.recover();
        this.reconcile = false;
        const claim = this.ledger.claim();
        if (claim) this.dispatch(claim);
      } catch {
        this.reconcile = true;
        this.reportError();
        this.wake(2000);
      }
    }, delay);
  }

  private dispatch(claim: NonNullable<ReturnType<PilotLedger['claim']>>) {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'SystemRoot', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
      'TEMP', 'TMP', 'TMPDIR', 'CODEX_HOME', 'LANG', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = fork(this.module, [], { cwd: this.root, execArgv: [], env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    this.child = child;
    let recorded = false;
    let interrupted = false;
    let message = 'Worker 中断，未收到有效的执行结果。';
    this.deadline = setTimeout(() => {
      interrupted = true;
      message = 'Worker 超过运行时限。';
      this.terminate(child);
    }, 180_000);
    child.on('error', () => { this.terminate(child); });
    child.on('message', value => {
      if (recorded || interrupted || this.stopping) return;
      try { recorded = this.ledger.finish(claim.attemptId, value as PilotResult); }
      catch { this.reportError(); }
    });
    this.finished = new Promise<void>(resolve => {
      const complete = () => {
        if (this.child !== child) return;
        clearTimeout(this.deadline);
        clearTimeout(this.killTimer);
        this.killTimer = undefined;
        this.child = undefined;
        if (!recorded) {
          try { this.ledger.interrupt(claim.attemptId, this.stopping ? '服务停止，中断本次 Worker。' : message); }
          catch { this.reconcile = true; this.reportError(); }
        }
        this.wake(this.reconcile ? 2000 : 0);
        resolve();
      };
      // On Windows a parent-initiated IPC disconnect can emit exit without close.
      // A failed spawn, in turn, may emit close without exit.
      child.once('exit', complete);
      child.once('close', complete);
    });
    child.send({ ...claim, root: this.root, agentBin: this.agentBin }, error => {
      if (error && this.child === child) this.terminate(child);
    });
  }

  private terminate(child: ChildProcess) {
    if (this.child !== child || this.killTimer) return;
    if (child.connected) child.disconnect();
    this.killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    clearTimeout(this.deadline);
    if (this.child) this.terminate(this.child);
    await this.finished;
  }
}
