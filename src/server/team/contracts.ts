import type { PILOT_SPEC, PilotResult } from '../pilot/sample.js';
import type { AgentEvidence } from '../workflow/executor.js';

export type Role = 'developer' | 'reviewer' | 'both';
export type Task = 'dates' | 'paid' | 'integrate';
export interface TeamMember { id: string; name: string }
export interface TeamProject { id: string; name: string; role: Role }
export interface TeamAdmin {
  members: TeamMember[];
  projects: {id: string; name: string}[];
  grants: {memberId: string; projectId: string; role: Role}[];
}
export interface TaskArtifact {
  task: 'dates' | 'paid';
  attemptId: string;
  generation: number;
  commit: string;
  content: string;
  agent?: AgentEvidence;
}
export interface TeamIntegration {
  commit: string;
  parents: string[];
  sql: string;
  checks: PilotResult['checks'];
}
export type TeamResult = { kind: 'task'; artifact: TaskArtifact }
  | { kind: 'integration'; integration: TeamIntegration }
  | { kind: 'failure'; error: string };
export interface TeamClaim {
  projectId: string;
  runId: string;
  task: Task;
  attemptId: string;
  generation: number;
  inputs?: {dates: TaskArtifact; paid: TaskArtifact};
}
export interface TeamSummary {
  id: string;
  projectId: string;
  version: number;
  status: 'queued' | 'running' | 'review' | 'blocked' | 'archived';
  implementer: TeamMember;
  createdAt: string;
  updatedAt: string;
}
export interface TeamAttempt {
  id: string;
  task: Task;
  generation: number;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'finished' | 'interrupted';
  reason: string;
  result: TeamResult | null;
}
export interface TeamEvent {
  version: number | null;
  at: string;
  actor: string;
  action: string;
  reason: string;
  requestId: string | null;
  attemptId: string | null;
}
export interface TeamDetail extends TeamSummary {
  spec: typeof PILOT_SPEC;
  frozenBaseline: {version: 1; frozenAt: string; specSha256: string};
  tasks: {task: Task; responsible: TeamMember; status: 'queued'|'waiting'|'running'|'finished'|'blocked'; generation: number}[];
  attempts: TeamAttempt[];
  integration: TeamIntegration | null;
  events: TeamEvent[];
  canAccept: boolean;
  decision: {reviewer: TeamMember; reason: string; version: number; commit: string; at: string} | null;
}
