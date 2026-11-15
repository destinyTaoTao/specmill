import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { stat } from 'node:fs/promises';

type WorkspaceRow = { projectId: string; path: string; needsBinding: number };
type DirectoryStatus = 'present' | 'missing' | 'unknown';
// Leave headroom in Node's default four-thread pool for attachments and recovery.
const maxDirectoryChecks = 2;
let directoryChecks = 0;

async function directoryStatus(path: string): Promise<DirectoryStatus> {
  if (directoryChecks >= maxDirectoryChecks) return 'unknown';
  directoryChecks++;
  const check = stat(path).then(info => info.isDirectory() ? 'present' as const : 'missing' as const)
    .catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing' as const : 'unknown' as const)
    .finally(() => { directoryChecks--; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      check,
      new Promise<'unknown'>(resolve => { timer = setTimeout(() => resolve('unknown'), 1000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function registerProjectOverviews(app: FastifyInstance, db: Database.Database) {
  app.get('/api/v1/project-overviews', async () => {
    const snapshot = db.transaction(() => ({
      projects: db.prepare('SELECT id FROM projects ORDER BY created_at, id').all() as { id: string }[],
      workspaces: db.prepare('SELECT w.project_id AS projectId, w.path, CASE WHEN r.project_id IS NULL OR r.common_key != w.common_key THEN 1 ELSE 0 END AS needsBinding FROM workspaces w LEFT JOIN project_repositories r ON r.project_id = w.project_id ORDER BY w.created_at, w.id').all() as WorkspaceRow[],
      counts: db.prepare("SELECT project_id AS projectId, COUNT(*) AS count FROM changes WHERE phase IN ('Draft', 'Working', 'Reviewing') GROUP BY project_id").all() as { projectId: string; count: number }[],
    }))();
    const statuses: DirectoryStatus[] = new Array(snapshot.workspaces.length).fill('unknown');
    let next = 0;
    const deadline = Date.now() + 1000;
    await Promise.all(Array.from({ length: Math.min(maxDirectoryChecks, snapshot.workspaces.length) }, async () => {
      while (next < snapshot.workspaces.length && Date.now() < deadline) {
        const index = next++;
        statuses[index] = await directoryStatus(snapshot.workspaces[index].path);
      }
    }));
    const byProject = new Map(snapshot.projects.map(project => [project.id, { projectId: project.id, activeChanges: 0, workspaces: [] as { path: string; needsBinding: boolean; directoryStatus: DirectoryStatus }[] }]));
    for (const row of snapshot.counts) { const overview = byProject.get(row.projectId); if (overview) overview.activeChanges = row.count; }
    snapshot.workspaces.forEach((row, index) => byProject.get(row.projectId)?.workspaces.push({ path: row.path, needsBinding: row.needsBinding === 1, directoryStatus: statuses[index] }));
    return { projects: [...byProject.values()] };
  });
}
