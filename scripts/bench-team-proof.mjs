import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const [baseline, count = '30', candidate = 'dist-server'] = process.argv.slice(2);
const repetitions = Number(count);
if (!baseline || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100) {
  throw new Error('usage: node scripts/bench-team-proof.mjs baseline-build [repetitions] [candidate-build]');
}

const builds = await Promise.all([baseline, candidate].map(async build => {
  const load = file => import(pathToFileURL(resolve(build, 'server/team', file)).href);
  const [workspace, proof] = await Promise.all([load('workspace.js'), load('verify.js')]);
  return { name: build, ...workspace, ...proof, integrationMs: [], verificationMs: [] };
}));

function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = p => +sorted[Math.ceil(p * sorted.length) - 1].toFixed(2);
  return { p50: percentile(.50), p95: percentile(.95), p99: percentile(.99), max: percentile(1) };
}

const temp = await realpath(tmpdir());
const root = await mkdtemp(join(temp, 'specmill-proof-bench-'));
try {
  const scope = { projectId: 'synthetic-project', runId: 'synthetic-run', generation: 1 };
  const source = builds[0];
  async function code(task, predicate) {
    const claim = { ...scope, task, attemptId: 'code-' + task };
    return source.commitTask(await source.createTeamWorkspace(root, claim), claim, predicate);
  }
  const dates = await code('dates', 'order_date BETWEEN :start_date AND :end_date');
  const paid = await code('paid', "status = 'paid'");
  for (let i = 0; i < repetitions; i++) {
    const claim = { ...scope, task: 'integrate', attemptId: 'merge-' + i, inputs: { dates, paid } };
    // Alternate the order to distribute short-term cache and host effects.
    const pair = i % 2 ? [...builds].reverse() : builds;
    const evidence = [];
    for (const build of pair) {
      const start = performance.now();
      const workspace = await build.createTeamWorkspace(root, claim);
      const result = await build.integrateTasks(workspace, claim, claim.inputs);
      const verifyAt = performance.now();
      assert(await build.verifyIntegration(claim, result), 'Independent Git proof rejected');
      build.integrationMs.push(verifyAt - start);
      build.verificationMs.push(performance.now() - verifyAt);
      assert(result.checks.every(check => check.passed), 'Frozen fixtures failed');
      evidence.push(result);
    }
    assert.deepEqual(evidence[0], evidence[1], 'Git target or frozen evidence changed');
  }
  console.log(JSON.stringify({ repetitions, node: process.version,
    effectiveCpu: availableParallelism(), builds: builds.map(b => ({
      build: b.name, integrationMs: summary(b.integrationMs), verificationMs: summary(b.verificationMs),
    })), proofMismatches: 0 }, null, 2));
} finally {
  const actual = await realpath(root);
  if (actual === root && dirname(actual) === temp) await rm(actual, { recursive: true, force: true, maxRetries: 3 });
}
