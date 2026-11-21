// Deterministic IPC peer for supervisor and browser tests; never selected by the CLI.
import { access, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

process.once('message', async ({ root, spec, attemptId }) => {
  const crash = join(root, 'crash-next-worker');
  if (await access(crash).then(() => true, () => false)) {
    await rm(crash);
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  if (await access(join(root, 'hold-worker')).then(() => true, () => false)) {
    await writeFile(join(root, 'worker-started'), attemptId);
    process.once('disconnect', () => process.exit(0));
    setInterval(() => {}, 2000);
    return;
  }
  const result = {
    commit: '1'.repeat(40),
    sql: "SELECT id FROM orders WHERE status = 'paid' AND order_date BETWEEN :start_date AND :end_date ORDER BY id ASC;",
    error: null,
    checks: spec.criteria.map(({ name, expected }) => ({ name, expected, actual: expected, passed: true })),
  };
  process.send(result, () => process.disconnect());
});
