import type { FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import type { WriterAuthorization } from './writer-sessions.js';

export type WriterGrant = { writerSessionId?: string; generation?: number };
export type WriterGuardError = 'SESSION_EXPIRED' | 'FORBIDDEN' | 'WORKSPACE_CHANGED';

export function createWriterGuard(db: Database.Database, isOwner: (request: FastifyRequest) => boolean, authorizeWriter: WriterAuthorization) {
  return (request: FastifyRequest, grant: WriterGrant, scope: { changeId?: string; projectId?: string; workspaceId?: string }): WriterGuardError | null => {
    if (isOwner(request)) return null;
    const session = authorizeWriter(request, grant.writerSessionId ?? '', grant.generation ?? 0, scope.changeId);
    if (typeof session === 'string') return session;
    if (scope.workspaceId !== undefined && session.workspaceId !== scope.workspaceId) return 'WORKSPACE_CHANGED';
    const binding = db.prepare('SELECT w.version, w.project_id AS projectId FROM workspaces w JOIN project_repositories p ON p.project_id = w.project_id AND p.common_key = w.common_key JOIN changes c ON c.id = ? AND c.project_id = w.project_id WHERE w.id = ?').get(session.changeId, session.workspaceId) as { version: number; projectId: string } | undefined;
    if (!binding || binding.version !== session.bindingVersion || (scope.projectId !== undefined && binding.projectId !== scope.projectId)) return 'WORKSPACE_CHANGED';
    return null;
  };
}

export function writerGrantMessage(code: WriterGuardError) {
  return code === 'FORBIDDEN' ? '没有此写会话的授权。' : code === 'WORKSPACE_CHANGED' ? '写会话的工作区或项目绑定已变化。' : '写会话已失效，请重新获取授权。';
}

export function writerCommand(isOwner: boolean, grant: WriterGrant, command: unknown[]) {
  return isOwner ? command : [...command, 'writer', grant.writerSessionId, grant.generation];
}
