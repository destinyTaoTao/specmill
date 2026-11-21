import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { availableParallelism, cpus, platform, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// One service process, one WAL writer. Each round represents 100 client operations.
// Worker calls run at the owned ledger boundary, since Worker IPC is private.
const [time, rate, history, compiled = 'dist-server'] = process.argv.slice(2);
const [seconds, roundsPerSecond, historicalRuns] = [Number(time ?? 900), Number(rate ?? 10), Number(history ?? 10000)];
if (![seconds, roundsPerSecond, historicalRuns].every(Number.isSafeInteger) ||
    seconds < 1 || seconds > 3600 || roundsPerSecond < 1 || roundsPerSecond > 50 || historicalRuns < 0 || historicalRuns > 100000) {
  throw new Error('usage: node scripts/bench-team.mjs [seconds] [rounds/s] [historical runs] [compiled server directory]');
}
const { TeamLedger, TEAM_SPEC_HASH } = await import(pathToFileURL(resolve(compiled, 'server/team/ledger.js')));
const { PILOT_SPEC } = await import(pathToFileURL(resolve(compiled, 'server/pilot/sample.js')));
const { assemble } = await import(pathToFileURL(resolve(compiled, 'server/team/workspace.js')));
const directory = await mkdtemp(join(tmpdir(), 'specmill-team-bench-'));
const filename = join(directory, 'team.sqlite');
const ledger = new TeamLedger(filename);
const projects = [];
const queued = new Map();
const queueDelay = [];
const byProject = {};
const metrics = {};
const errors = {};
const loop = monitorEventLoopDelay({ resolution: 10 });
const content = { dates: 'order_date BETWEEN :start_date AND :end_date', paid: "status = 'paid'" };
let finishedRuns = 0;
let idleClaims = 0;
let transactionBusy = 0;
let maxQueued = 0;

function measure(name, fn) {
  const start = performance.now();
  try {
    const result = fn();
    (metrics[name] ??= []).push(performance.now() - start);
    return result;
  } catch (error) {
    if (error.code?.startsWith('SQLITE_BUSY')) transactionBusy++;
    const key = name + ':' + (error.code ?? error.message);
    errors[key] = (errors[key] ?? 0) + 1;
    throw error;
  }
}

function finish(claim) {
  let result;
  if (claim.task === 'integrate') {
    const { dates, paid } = claim.inputs;
    result = { kind: 'integration', integration: {
      commit: '3'.repeat(40), parents: [dates.commit, paid.commit], sql: assemble(dates.content, paid.content),
      checks: PILOT_SPEC.criteria.map(({ name, expected }) => ({ name, expected, actual: expected, passed: true })),
    } };
  } else {
    result = { kind: 'task', artifact: {
      task: claim.task, attemptId: claim.attemptId, generation: claim.generation,
      commit: (claim.task === 'dates' ? '1' : '2').repeat(40), content: content[claim.task],
    } };
  }
  if (!ledger.complete(claim, result)) throw new Error('Result was rejected');
}

function start(project) {
  const request = randomUUID();
  return ledger.start(project.dev.id, project.id, request, TEAM_SPEC_HASH).id;
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => +(sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0).toFixed(3);
  return { count: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), max: at(1),
    totalMs: +values.reduce((a, b) => a + b, 0).toFixed(3) };
}

try {
  for (let i = 0; i < 10; i++) {
    const { id } = ledger.createProject('Synthetic project ' + i);
    const dev = ledger.createMember('Synthetic developer ' + i);
    ledger.grant(id, dev.id, 'developer');
    projects.push({ id, dev, fixtures: [] });
  }
  for (let i = 0; i < historicalRuns; i++) {
    const project = projects[i % projects.length];
    const id = start(project);
    for (let task = 0; task < 3; task++) finish(ledger.claim());
    if (project.fixtures.length < 10) project.fixtures.push(id);
  }
  for (const project of projects) {
    for (let i = 0; i < 8; i++) {
      const id = start(project);
      queued.set(id, performance.now());
      if (!project.fixtures.length) project.fixtures.push(id);
    }
    byProject[project.id] = { claims: 0, completed: 0 };
  }
  maxQueued = queued.size;
  const initialBytes = (await stat(filename)).size;
  const begin = performance.now();
  loop.enable();
  let rounds = 0;
  let error;
  try {
    while (performance.now() - begin < seconds * 1000) {
      // Fastify's handlers synchronously invoke these same operations after parsing.
      // One round interleaves query clients and Worker clients on one event loop.
      for (const project of projects) {
        for (let i = 0; i < 7; i++) {
          const id = project.fixtures[(rounds + i) % project.fixtures.length];
          measure('query', () => {
            if (ledger.get(ledger.authenticate(project.dev.token), project.id, id).id !== id) throw new Error('Wrong scope');
          });
        }
        const claim = measure('claim', () => ledger.claim());
        if (!claim) { idleClaims++; continue; }
        byProject[claim.projectId].claims++;
        if (claim.task === 'dates') queueDelay.push(performance.now() - queued.get(claim.runId));
        if (!measure('leaseCheck', () => ledger.isActive(claim))) throw new Error('New claim has no lease');
        measure('submit', () => finish(claim));
        if (claim.task === 'integrate') {
          queued.delete(claim.runId);
          finishedRuns++;
          byProject[claim.projectId].completed++;
          const owner = projects.find(p => p.id === claim.projectId);
          const id = measure('refill', () => start(owner));
          queued.set(id, performance.now());
          maxQueued = Math.max(maxQueued, queued.size);
        }
      }
      rounds++;
      const remaining = begin + rounds * 1000 / roundsPerSecond - performance.now();
      await sleep(Math.max(1, remaining));
    }
  } catch (cause) {
    error = cause;
  }
  const elapsed = (performance.now() - begin) / 1000;
  loop.disable();
  const sizes = await Promise.all([filename, filename + '-wal'].map(path => stat(path).then(s => s.size)));
  const operations = Object.fromEntries(Object.entries(metrics).map(([name, times]) => [name, summarize(times)]));
  const count = ['query', 'claim', 'leaseCheck', 'submit'].reduce((sum, name) => sum + (metrics[name]?.length ?? 0), 0);
  console.log(JSON.stringify({
    machine: { platform: platform(), cpu: cpus()[0]?.model, effectiveCpu: availableParallelism(),
      totalMem: totalmem(), node: process.version },
    config: { seconds, roundsPerSecond, historicalRuns, clients: 100, projects: 10, initialRunsInFlight: 80 },
    cache: 'Warm process and SQLite connection after seeding, OS cache uncontrolled',
    elapsed, rounds, opsPerSecond: count / elapsed, runsPerSecond: finishedRuns / elapsed, operations,
    queueFirstClaimMs: summarize(queueDelay), maxRunsInFlight: maxQueued, idleClaims, transactionBusy, errors,
    eventLoopP99Ms: loop.percentile(99) / 1e6, initialBytes, finalDbBytes: sizes[0], finalWalBytes: sizes[1],
    projects: Object.values(byProject), modelCostUsd: 0,
  }, null, 2));
  if (error) throw error;
} finally {
  ledger.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
