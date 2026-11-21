import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { buildApp } from '../dist-server/server/app.js';

const [workers = 2, perProject = 3, port = 43139, seconds = 0] = process.argv.slice(2, 6).map(Number);
const archivePath = process.argv[6];
if (!Number.isInteger(perProject) || perProject < 1 || perProject > 16) throw new Error('Runs/project must be 1–16');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be 1024–65535');
if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) throw new Error('Duration must be 0–3600 seconds');
const origin = 'http://127.0.0.1:' + port;
const directory = await mkdtemp(join(tmpdir(), 'specmill-workflow-bench-'));
const app = await buildApp({ dataDir: directory, port, ownerToken: 'synthetic-owner', agentToken: 'synthetic-unused',
  team: { agentBin: process.execPath, workers, workerModule: new URL('./fixtures/team-worker.mjs', import.meta.url) } });
const repos = [];
const observations = { query: [], accept: [], queue: [], code: [], integrate: [], endToEnd: [] };
const users = [];
const archives = [];
let stopped = false;
let readers = [];
const errors = [];

function summary(samples) {
  const values = [...samples].sort((a, b) => a - b);
  const percentile = p => +(values[Math.ceil(values.length * p) - 1] ?? 0).toFixed(2);
  return { count: samples.length, p50: percentile(.50), p95: percentile(.95), p99: percentile(.99), max: percentile(1) };
}

async function call(path, expected, auth = {}, payload, observation) {
  const start = performance.now();
  const response = await fetch(origin + '/api/v1' + path, { method: payload ? 'POST' : 'GET',
    body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(5000),
    headers: { origin, 'x-specmill-request': '1', ...(payload ? { 'Content-Type': 'application/json' } : {}), ...auth } });
  const data = await response.json();
  if (response.status !== expected) throw new Error(path + ': ' + response.status);
  if (observation && !stopped) observations[observation].push(performance.now() - start);
  return { data, headers: response.headers };
}

async function submit({ author, list, specHash }) {
  const { id } = (await call(list, 201, author, { requestId: randomUUID(), specHash })).data;
  return list + '/' + id;
}

try {
  await app.listen({ host: '127.0.0.1', port });
  const login = await call('/session', 200, {}, { token: 'synthetic-owner' });
  const owner = { cookie: String(login.headers.get('set-cookie')).split(';')[0] };
  for (let i = 0; i < 10; i++) {
    const { id: projectId } = (await call('/team/admin/projects', 201, owner, { name: 'Synthetic project ' + i })).data;
    const developer = (await call('/team/admin/members', 201, owner, { name: 'Synthetic developer ' + i })).data;
    const reviewer = (await call('/team/admin/members', 201, owner, { name: 'Synthetic reviewer ' + i })).data;
    for (const [member, role] of [[developer, 'developer'], [reviewer, 'reviewer']]) {
      await call('/team/admin/grants', 200, owner, { projectId, memberId: member.id, role });
    }
    const author = { authorization: 'Bearer ' + developer.token };
    const approver = { authorization: 'Bearer ' + reviewer.token };
    const { specHash } = (await call('/team/projects', 200, author)).data;
    users.push({ author, approver, projectId, developerId: developer.id, reviewerId: reviewer.id,
      list: '/team/projects/' + projectId + '/runs', specHash });
  }
  const start = performance.now();
  for (let round = 0; round < perProject; round++) {
    for (const user of users) repos.push({ ...user, path: await submit(user) });
  }
  // Each client issues at most one in-flight request. Stagger reads to model polling.
  readers = Array.from({ length: 100 }, async (_, n) => {
    await sleep(n * 2);
    while (!stopped) {
      const run = repos[n % repos.length];
      try { await call(run.path, 200, run.author, undefined, 'query'); }
      catch (error) { errors.push(error.message); return; }
      await sleep(200);
    }
  });
  const pending = new Set(repos);
  const commits = new Set();
  const stopSubmitting = start + seconds * 1000;
  const deadline = stopSubmitting + 300000;
  while (pending.size && performance.now() < deadline) {
    for (const run of pending) {
      const detail = (await call(run.path, 200, run.approver)).data;
      if (detail.status === 'blocked') throw new Error('Workflow blocked: ' + JSON.stringify(detail.attempts));
      if (detail.status !== 'review') continue;
      const created = Date.parse(detail.createdAt);
      observations.queue.push(Math.min(...detail.attempts.map(a => Date.parse(a.startedAt))) - created);
      for (const attempt of detail.attempts) {
        const duration = Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt);
        observations[attempt.task === 'integrate' ? 'integrate' : 'code'].push(duration);
      }
      const commit = detail.integration.commit;
      if (detail.attempts.length !== 3 || commits.has(commit) || !detail.integration.checks.every(c => c.passed)) {
        throw new Error('Expected independent and unique integration evidence');
      }
      commits.add(commit);
      const accept = { version: detail.version, commit, reason: 'Synthetic benchmark', requestId: randomUUID() };
      await call(run.path + '/accept', 200, run.approver, accept, 'accept');
      const archive = (await call(run.path + '/archive', 200, run.approver)).data;
      if (archive.status !== 'archived' || archive.id !== detail.id || archive.projectId !== run.projectId ||
          archive.implementer?.id !== run.developerId || archive.decision?.reviewer?.id !== run.reviewerId ||
          archive.decision.commit !== commit || archive.decision.version !== accept.version ||
          archive.frozenBaseline?.specSha256 !== run.specHash ||
          !isDeepStrictEqual(archive.frozenBaseline, detail.frozenBaseline) ||
          !isDeepStrictEqual(archive.spec, detail.spec) ||
          !isDeepStrictEqual(archive.integration, detail.integration) ||
          !isDeepStrictEqual(archive.attempts, detail.attempts)) throw new Error('Archive evidence lost or changed');
      if (archivePath) archives.push(archive);
      observations.endToEnd.push(Date.parse(archive.decision.at) - created);
      if (performance.now() < stopSubmitting) run.path = await submit(run);
      else pending.delete(run);
    }
    if (pending.size) await sleep(200);
  }
  const elapsed = (performance.now() - start) / 1000;
  stopped = true;
  await Promise.all(readers);
  console.log(JSON.stringify({
    machine: { platform: process.platform, cpu: cpus()[0]?.model, effectiveCpu: availableParallelism(),
      totalMem: totalmem(), node: process.version },
    config: { workers, perProject, projects: users.length, clients: readers.length, seconds, cache: 'Fresh DB; OS cache uncontrolled' },
    elapsed, archived: commits.size, pending: pending.size, runsPerSecond: commits.size / elapsed,
    peakRunsInFlight: repos.length, queriesPerSecond: observations.query.length / elapsed,
    ms: Object.fromEntries(Object.entries(observations).map(([key, value]) => [key, summary(value)])), errors,
    modelCostUsd: 0,
  }, null, 2));
  if (pending.size || errors.length) process.exitCode = 1;
} finally {
  stopped = true;
  await Promise.all(readers);
  try {
    // Keep each already-verified archive even if a later sample fails.
    if (archivePath && archives.length) {
      await writeFile(archivePath, JSON.stringify(archives, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}
