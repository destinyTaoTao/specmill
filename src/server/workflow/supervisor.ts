import { fork, type ChildProcess } from 'node:child_process';
import type { ExecutorId } from './executor.js';

interface Queue<C, R> {
  claim(): C | null;
  complete(claim: C, result: R): boolean;
  interrupt(claim: C, reason: string): boolean;
  recover(): void;
  isActive?(claim: C): boolean;
}

interface Slot<C> {
  claim: C;
  child: ChildProcess;
  done: Promise<void>;
  stop(reason: string): void;
}

// The service owns the database. A child can answer only on its own IPC channel.
export class WorkflowSupervisor<C extends { attemptId: string }, R> {
  private slots = new Map<string, Slot<C>>();
  private interruptions = new Map<C, string>();
  private timer?: NodeJS.Timeout;
  private stopping = false;

  constructor(private queue: Queue<C, R>, private capacity: number, private root: string, private agentBin: string,
    private module: URL, private reportError: () => void,
    private verify?: (claim: C, result: R) => Promise<R>,
    private executor?: { executor: ExecutorId; model?: string }) {}

  start() {
    this.queue.recover();
    this.wake();
  }

  wake(delay = 0) {
    if (this.stopping || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        this.flushInterruptions();
        while (this.slots.size < this.capacity) {
          const claim = this.queue.claim();
          if (!claim) break;
          try { this.dispatch(claim); }
          catch (err) {
            this.interruptions.set(claim, 'Worker 无法启动。');
            throw err;
          }
        }
      } catch {
        this.reportError();
        this.wake(2000);
      }
    }, delay);
  }

  stopInvalid(isActive: (claim: C) => boolean) {
    for (const slot of this.slots.values()) {
      if (!isActive(slot.claim)) slot.stop('本次尝试的授权已经失效。');
    }
  }

  private flushInterruptions() {
    for (const [claim, reason] of this.interruptions) {
      this.queue.interrupt(claim, reason);
      this.interruptions.delete(claim);
    }
  }

  private dispatch(claim: C) {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'SystemRoot', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
      'TEMP', 'TMP', 'TMPDIR', 'CODEX_HOME', 'LANG', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    if (this.executor?.executor === 'pi' && this.executor.model?.startsWith('deepseek/') && process.env.DEEPSEEK_API_KEY) {
      env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
    }
    const child = fork(this.module, [], { cwd: this.root, execArgv: [], env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let settled = false;
    let received = false;
    let validation: Promise<void> = Promise.resolve();
    let stopped = false;
    let reason = 'Worker 中断，未收到有效的执行结果。';
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (why: string) => {
      if (stopped) return;
      stopped = true;
      reason = why;
      if (child.connected) child.disconnect();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
    };
    const deadline = setTimeout(() => stop('Worker 超过运行时限。'), 180_000);
    const done = new Promise<void>(resolve => {
      let exiting = false;
      const finish = async () => {
        if (exiting) return;
        exiting = true;
        // The IPC peer may exit while the service verifies Git objects in a fresh directory.
        await validation;
        this.slots.delete(claim.attemptId);
        clearTimeout(deadline);
        clearTimeout(killTimer);
        if (!settled) this.interruptions.set(claim, reason);
        this.wake();
        resolve();
      };
      // Windows may emit exit without close after a parent-initiated disconnect.
      // A failed spawn can emit close without exit.
      child.once('exit', finish);
      child.once('close', finish);
    });
    this.slots.set(claim.attemptId, { child, claim, done, stop });
    child.on('error', () => stop('Worker 通信失败。'));
    child.on('message', value => {
      if (received || stopped || this.stopping) return;
      received = true;
      validation = (async () => {
        try {
          const result = this.verify ? await this.verify(claim, value as R) : value as R;
          if (stopped || this.stopping) return;
          settled = this.queue.complete(claim, result);
          const active = this.queue.isActive?.bind(this.queue);
          if (active) this.stopInvalid(other => other.attemptId === claim.attemptId || active(other));
        } catch { this.reportError(); }
      })();
    });
    child.send({ ...claim, root: this.root, agentBin: this.agentBin, ...this.executor }, error => {
      if (error && this.slots.has(claim.attemptId)) stop('Worker 未能领取任务。');
    });
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    const slots = [...this.slots.values()];
    for (const slot of slots) slot.stop('服务停止，中断本次 Worker。');
    await Promise.all(slots.map(s => s.done));
    this.flushInterruptions();
  }
}
