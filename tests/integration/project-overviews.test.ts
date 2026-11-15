import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';

const { statMock } = vi.hoisted(() => ({ statMock: vi.fn() }));
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>(), stat: statMock }));
import { registerProjectOverviews } from '../../src/server/features/project-overviews.js';

describe('project overview directory checks', () => {
  it('bounds stuck checks across requests and reports unknown until they finish', async () => {
    const db = new Database(':memory:');
    const app = Fastify();
    const release: Array<() => void> = [];
    try {
      db.exec(`CREATE TABLE projects (id TEXT, created_at TEXT);
        CREATE TABLE workspaces (project_id TEXT, path TEXT, common_key TEXT, created_at TEXT, id TEXT);
        CREATE TABLE project_repositories (project_id TEXT, common_key TEXT);
        CREATE TABLE changes (project_id TEXT, phase TEXT);
        INSERT INTO projects VALUES ('p', '1');
        INSERT INTO project_repositories VALUES ('p', 'repo');
        INSERT INTO workspaces VALUES ('p', 'one', 'repo', '1', '1'), ('p', 'two', 'repo', '2', '2'), ('p', 'three', 'repo', '3', '3'), ('p', 'four', 'repo', '4', '4'), ('p', 'five', 'repo', '5', '5');`);
      statMock.mockImplementation(() => new Promise(resolve => { release.push(() => resolve({ isDirectory: () => true })); }));
      registerProjectOverviews(app, db);
      const first = await app.inject({ method: 'GET', url: '/api/v1/project-overviews' });
      expect(first.statusCode).toBe(200);
      expect(first.json().projects[0].workspaces.map((item: { directoryStatus: string }) => item.directoryStatus)).toEqual(Array(5).fill('unknown'));
      expect(statMock).toHaveBeenCalledTimes(2);
      const second = await app.inject({ method: 'GET', url: '/api/v1/project-overviews' });
      expect(second.json().projects[0].workspaces.every((item: { directoryStatus: string }) => item.directoryStatus === 'unknown')).toBe(true);
      expect(statMock).toHaveBeenCalledTimes(2);
      release.forEach(done => done());
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      statMock.mockResolvedValue({ isDirectory: () => true });
      const third = await app.inject({ method: 'GET', url: '/api/v1/project-overviews' });
      expect(third.json().projects[0].workspaces.every((item: { directoryStatus: string }) => item.directoryStatus === 'present')).toBe(true);
    } finally {
      release.forEach(done => done());
      await app.close(); db.close(); vi.clearAllMocks();
    }
  });
});
