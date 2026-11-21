import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

const criteria = [
  { name: 'inclusive-date-range', description: '包含开始日和结束日，排除范围外的订单。', expected: [10, 20] },
  { name: 'paid-only', description: '日期范围内仅返回已付款订单。', expected: [30] },
  { name: 'stable-id-order', description: '返回的订单 ID 按数值升序排列。', expected: [2, 5, 9] },
];
for (const criterion of criteria) {
  Object.freeze(criterion.expected);
  Object.freeze(criterion);
}
export const PILOT_SPEC = Object.freeze({
  templateRevision: 'orders-v1.1',
  title: '导出指定日期范围内的已付款订单',
  research: Object.freeze({
    source: 'SpecMill 内置的合成订单样例，覆盖日期边界、付款状态和乱序订单 ID。',
    finding: '订单日期已按业务日存为 YYYY-MM-DD。开始日和结束日都计入查询，日期比较无需转换时区。',
    scope: '从 orders 单表返回已付款订单 ID，按数值升序排列。范围仅含 SQL 查询，文件导出、权限判断和真实订单接入另行设计。',
  }),
  queryContract: 'SQLite table orders(id INTEGER, order_date TEXT, status TEXT). Dates are ISO YYYY-MM-DD business dates. ' +
    'Return only id. Use named parameters :start_date and :end_date and literal status \'paid\'. ' +
    'Use SELECT id FROM orders, simple comparisons joined by AND (or BETWEEN for dates), then ORDER BY id ASC.',
  criteria: Object.freeze(criteria),
});

export interface PilotResult {
  commit: string | null;
  sql: string;
  checks: { name: string; expected: number[]; actual: number[]; passed: boolean }[];
  error: string | null;
}

export interface PilotJob {
  runId: string;
  attemptId: string;
  root: string;
  agentBin: string;
  previousSql: string | null;
  reason: string | null;
  spec: typeof PILOT_SPEC;
}

export function pilotFailure(error: string): PilotResult {
  return { commit: null, sql: '', checks: [], error };
}

const dateParam = ':(?:start_date|end_date)';
const datePredicate = `order_date\\s*(?:(?:<=|>=|<>|=|<|>)\\s*${dateParam}|\\s+between\\s+${dateParam}\\s+and\\s+${dateParam})`;
const predicate = `(?:${datePredicate}|status\\s*(?:=|<>)\\s*'(?:paid|pending|cancelled)')`;
const allowedQuery = new RegExp(
  `^select\\s+id\\s+from\\s+orders(?:\\s+where\\s+${predicate}(?:\\s+and\\s+${predicate}){0,3})?(?:\\s+order\\s+by\\s+id(?:\\s+(?:asc|desc))?)?\\s*;?$`, 'i',
);

export function extractPilotSql(output: string): string | null {
  if (Buffer.byteLength(output) > 4096) return null;
  const value = output.trim();
  const sql = (/^```(?:sql)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(value)?.[1] ?? value).trim();
  if (!/^[\x20-\x7e\t\r\n]+$/.test(sql) || !allowedQuery.test(sql.replace(/\s+/g, ' '))) return null;
  // SQLite named parameters are case-sensitive even though SQL keywords are not.
  if ((sql.match(/:\w+/g) ?? []).some(key => key !== ':start_date' && key !== ':end_date')) return null;
  return sql + '\n';
}

type Order = [number, string, string];
const cases: Order[][] = [
  [[3, '2026-01-09', 'paid'], [10, '2026-01-10', 'paid'], [20, '2026-01-12', 'paid'], [40, '2026-01-13', 'paid']],
  [[25, '2026-01-11', 'pending'], [30, '2026-01-11', 'paid'], [35, '2026-01-11', 'cancelled'], [37, '2026-01-11', 'refunded']],
  [[9, '2026-01-11', 'paid'], [2, '2026-01-11', 'paid'], [5, '2026-01-11', 'paid']],
];

export function checkPilotSql(sql: string): PilotResult['checks'] {
  if (!extractPilotSql(sql)) throw new Error('SQL 超出固定样例的查询范围。');
  return cases.map((rows, index) => {
    const db = new Database(':memory:');
    try {
      db.exec('PRAGMA temp_store=MEMORY; CREATE TABLE orders(id INTEGER, order_date TEXT, status TEXT)');
      const insert = db.prepare('INSERT INTO orders VALUES (?,?,?)');
      for (const row of rows) insert.run(...row);
      db.pragma('query_only=ON');
      const statement = db.prepare(sql);
      const params = { start_date: '2026-01-10', end_date: '2026-01-12' };
      const actual = statement.pluck().all(...(sql.includes(':') ? [params] : [])) as number[];
      const { name, expected } = PILOT_SPEC.criteria[index];
      return { name, expected: [...expected], actual, passed: actual.length === expected.length && actual.every((id, i) => id === expected[i]) };
    } finally { db.close(); }
  });
}

const runFile = promisify(execFile);
const gitNull = process.platform === 'win32' ? 'NUL' : '/dev/null';
export async function runSampleGit(repo: string, args: string[], commitDate?: string) {
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitNull, GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', HOME: repo, XDG_CONFIG_HOME: repo,
    ...(commitDate ? { GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate } : {}),
  };
  return (await runFile('git', [
    '-c', 'core.hooksPath=' + gitNull, '-c', 'commit.gpgSign=false', '-c', 'core.autocrlf=false',
    '-c', 'user.name=SpecMill Pilot', '-c', 'user.email=pilot@example.invalid', ...args,
  ], { cwd: repo, env, windowsHide: true, timeout: 8000, maxBuffer: 16384 })).stdout;
}

function git(repo: string, ...args: string[]) {
  return runSampleGit(repo, args);
}

export async function createPilotRepo(job: Pick<PilotJob, 'root' | 'attemptId'>) {
  if (!isAbsolute(job.root) || !/^[a-zA-Z0-9_-]{1,80}$/.test(job.attemptId)) throw new Error('样例工作目录无效。');
  await mkdir(job.root, { recursive: true, mode: 0o700 });
  const root = await realpath(job.root);
  const repo = await mkdtemp(join(root, `attempt-${job.attemptId}-`));
  await git(repo, 'init', '--quiet', '--template=', '--initial-branch=sample', '--object-format=sha1');
  return repo;
}

export async function commitPilotSql(repo: string, attemptId: string, output: string): Promise<PilotResult> {
  const sql = extractPilotSql(output);
  if (sql === null) return pilotFailure('Agent 输出超出固定样例的 SQL 范围。');
  try {
    await writeFile(join(repo, 'orders.sql'), sql, { flag: 'wx', mode: 0o600 });
    await git(repo, 'add', '--', 'orders.sql');
    await git(repo, 'commit', '--quiet', '--no-gpg-sign', '-m', 'Implement sample order query ' + attemptId);
    const commit = (await git(repo, 'rev-parse', '--verify', 'HEAD^{commit}')).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error();
    const committedSql = await git(repo, 'cat-file', 'blob', commit + ':orders.sql');
    if (committedSql !== sql) throw new Error();
    return { commit, sql: committedSql, checks: checkPilotSql(committedSql), error: null };
  } catch {
    return pilotFailure('无法提交或验证本次合成样例。');
  }
}
