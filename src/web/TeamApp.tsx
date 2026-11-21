import { useEffect, useRef, useState } from 'react';
import type { TeamDetail, TeamMember, TeamProject, TeamSummary } from '../server/team/contracts.js';
import { ApiError } from './api';
import { roles, TeamAdminPanel, teamRequest, teamUrl } from './TeamAdminPanel';

const states = { queued: '等待领取', running: '执行中', review: '待独立复核', archived: '已验收归档', blocked: '执行受阻' };
const tasks = { dates: '日期范围', paid: '付款状态', integrate: '集成验证' };
type Directory = { member: TeamMember; spec: TeamDetail['spec']; specHash: string; projects: TeamProject[] };
type Session = Directory & { token: string };
type Command = { path: string; body: { requestId: string; specHash?: string; version?: number; commit?: string; reason?: string } };

function Criteria({ spec }: { spec: TeamDetail['spec'] }) {
  return <><h4>{spec.title}</h4><p>模板修订 {spec.templateRevision}</p><p>{spec.research.scope}</p><p>{spec.research.finding}</p><p>{spec.queryContract}</p><ul>{spec.criteria.map(check => <li key={check.name}>
    {check.description} 预期订单 ID <code>{JSON.stringify(check.expected)}</code>
  </li>)}</ul></>;
}

function Evidence({ run }: { run: TeamDetail }) {
  return <>
    <p>实现责任人 {run.implementer.name} · {run.implementer.id}</p>
    <details><summary>已冻结规格 · 版本 {run.frozenBaseline.version}</summary>
      <p>{run.frozenBaseline.frozenAt} · {run.frozenBaseline.specSha256}</p><Criteria spec={run.spec} /></details>
    <h4>任务与执行尝试</h4>
    <ul>{run.tasks.map(t => <li key={t.task}>{tasks[t.task]} · {t.responsible.name} · {t.status} · 代次 {t.generation}</li>)}</ul>
    {run.attempts.map(a => <details key={a.id}><summary>{tasks[a.task]} · 第 {a.generation} 次 · {a.status}</summary>
      <p>尝试 {a.id} · {a.startedAt} 至 {a.finishedAt ?? '执行中'}</p>
      {a.reason && <p>{a.reason}</p>}
      {a.result?.kind === 'failure' && <p>{a.result.error}</p>}
      {a.result?.kind === 'task' && <><p>任务提交 {a.result.artifact.commit}</p><pre>{a.result.artifact.content}</pre></>}
    </details>)}
    {run.integration && <section aria-label="集成证据"><h4>集成证据</h4>
      <p>集成提交 <code>{run.integration.commit}</code></p><p>父提交</p><ul>{run.integration.parents.map(p => <li key={p}><code>{p}</code></li>)}</ul>
      <pre>{run.integration.sql}</pre><ul>{run.integration.checks.map(check => <li key={check.name}>
        {check.name} · {check.passed ? '通过' : '失败'} · 预期 {JSON.stringify(check.expected)}，实际 {JSON.stringify(check.actual)}
      </li>)}</ul></section>}
    <details><summary>审计记录（{run.events.length}）</summary><ol>{run.events.map((event, i) => <li key={i}>
      {event.at} · {event.action} · {event.actor} · {event.reason}
      {event.requestId && <p>请求 {event.requestId}</p>}{event.attemptId && <p>尝试 {event.attemptId}</p>}
    </li>)}</ol></details>
    {run.decision && <p>验收人 {run.decision.reviewer.name} · {run.decision.reviewer.id} · {run.decision.at}<br />
      签署版本 {run.decision.version} · {run.decision.commit}<br />{run.decision.reason}</p>}
  </>;
}

function SignOff({ run, send, locked }: { run: TeamDetail; send: (reason: string) => void; locked: boolean }) {
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  return <form onSubmit={e => { e.preventDefault(); if (confirmed && reason.trim() && !locked) send(reason.trim()); }}>
    <label>验收理由<textarea required maxLength={1000} value={reason} disabled={locked} onChange={e => { setReason(e.target.value); setConfirmed(false); }} /></label>
    <label><input type="checkbox" disabled={locked} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
      我已核对版本 {run.version} 的集成提交与逐项证据</label>
    <button disabled={locked || !confirmed || !reason.trim()}>签署并归档</button>
  </form>;
}

function ProjectRuns({ session, project, refreshDirectory, onDenied }: { session: Session; project: TeamProject; refreshDirectory: () => Promise<void>; onDenied: (message: string) => void }) {
  const base = teamUrl + '/projects/' + encodeURIComponent(project.id) + '/runs';
  const [runs, setRuns] = useState<TeamSummary[] | null>(null);
  const [run, setRun] = useState<TeamDetail | null>(null);
  const [selected, select] = useState('');
  const [confirmedHash, confirmHash] = useState<string | null>(null);
  const [revision, refresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Command | null>(null);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function denied(err: unknown) {
    if (err instanceof ApiError && [401, 403, 404].includes(err.status ?? 0)) {
      onDenied(err.message);
      return true;
    }
    return false;
  }
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const list = await teamRequest<{ runs: TeamSummary[] }>(base, undefined, session.token);
        const detail = selected ? await teamRequest<TeamDetail>(base + '/' + selected, undefined, session.token) : null;
        if (live) { setRuns(list.runs); setRun(detail); setReadError(''); }
      } catch (err) {
        if (live && !denied(err)) { setReadError('读取失败，请刷新以核对当前版本。'); setRun(null); }
      } finally { if (live) timer = setTimeout(() => void load(), 2000); }
    }
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [base, selected, session.token, revision]);
  async function send(command: Command) {
    setBusy(true); setError('');
    try {
      const receipt = await teamRequest<{ id: string }>(command.path, command.body, session.token);
      if (!mounted.current) return;
      setPending(null); confirmHash(null); select(receipt.id); refresh(r => r + 1);
    } catch (err) {
      if (!mounted.current || denied(err)) return;
      if (err instanceof ApiError && (err.status ?? 500) < 500 && err.status !== 408) {
        setPending(null); setError(err.message); refresh(r => r + 1);
        if (err.status === 409 && command.body.specHash) {
          confirmHash(null);
          await refreshDirectory();
        }
      } else { setPending(command); setError('操作结果未知，请重试原请求，核对服务回执。'); }
    } finally { if (mounted.current) setBusy(false); }
  }
  async function download(id: string) {
    setBusy(true); setError('');
    try {
      const archive = await teamRequest<unknown>(base + '/' + id + '/archive', undefined, session.token);
      if (!mounted.current) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'specmill-team-' + id + '.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { if (mounted.current && !denied(err)) setError('归档下载失败，请重试。'); }
    finally { if (mounted.current) setBusy(false); }
  }
  const locked = busy || pending !== null;
  const detail = run?.id === selected ? run : null;
  return <section><h3>{project.name} · {roles[project.role]}</h3>
    {error && <p role="alert">{error}</p>}{readError && <p role="alert">{readError}</p>}
    {pending && <button disabled={busy} onClick={() => void send(pending)}>重试原请求</button>}
    {project.role !== 'reviewer' && <details><summary>新建订单筛选运行</summary>
      <Criteria spec={session.spec} /><p>规格 SHA-256 <code>{session.specHash}</code></p><p>冻结后，{session.member.name} 将承担日期和付款状态两项实现责任。</p>
      <label><input type="checkbox" disabled={locked} checked={confirmedHash === session.specHash} onChange={e => confirmHash(e.target.checked ? session.specHash : null)} />我已核对冻结规格及预期结果</label>
      <button disabled={locked || !confirmedHash || confirmedHash !== session.specHash} onClick={() => void send({ path: base, body: { requestId: crypto.randomUUID(), specHash: session.specHash } })}>冻结并派工</button>
    </details>}
    <h4>项目运行</h4>
    <button disabled={busy} onClick={() => refresh(r => r + 1)}>刷新运行</button>
    {runs === null ? <p>正在读取项目运行。</p> : !runs.length && <p>暂无运行记录。</p>}
    <ul>{runs?.map(r => <li key={r.id}><button disabled={locked} onClick={() => select(r.id)}>{r.id} · {states[r.status]}</button></li>)}</ul>
    {detail && <section aria-label="运行详情"><h3>运行详情</h3><p role="status">{states[detail.status]} · 版本 {detail.version}</p>
      <Evidence run={detail} />
      {detail.status === 'review' && (detail.implementer.id === session.member.id ? <p>你是本次实现责任人，请由另一名获授权成员验收。</p>
        : project.role === 'developer' ? <p>本项目需要具有复核权限的成员验收。</p>
        : detail.canAccept && detail.integration ? <SignOff key={detail.id + detail.version} run={detail} locked={locked}
          send={reason => void send({ path: base + '/' + detail.id + '/accept', body: {
            requestId: crypto.randomUUID(), version: detail.version, commit: detail.integration!.commit, reason,
          } })} /> : <p>当前证据尚未满足验收条件。</p>)}
      {detail.status === 'archived' && <button disabled={locked} onClick={() => void download(detail.id)}>下载验收归档</button>}
    </section>}
  </section>;
}

function MemberPanel() {
  const [session, setSession] = useState<Session | null>(null);
  const [projectId, setProjectId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const loginSequence = useRef(0);
  function clear(message = '') {
    loginSequence.current++;
    setSession(null); setProjectId(''); setError(message); setBusy(false);
  }
  async function login(token: string) {
    const sequence = ++loginSequence.current;
    setBusy(true); setError('');
    try {
      const result = await teamRequest<Directory>(teamUrl + '/projects', undefined, token);
      if (sequence !== loginSequence.current) return;
      setSession({ ...result, token }); setProjectId(current => result.projects.some(p => p.id === current) ? current : result.projects[0]?.id ?? '');
    } catch (err) { if (sequence === loginSequence.current) clear(err instanceof ApiError ? err.message : '无法读取团队项目，请重试。'); }
    finally { if (sequence === loginSequence.current) setBusy(false); }
  }
  const project = session?.projects.find(p => p.id === projectId);
  return <section><h2>成员工作台</h2>
    {error && <p role="alert">{error}</p>}
    {session ? <><p>当前成员 {session.member.name} · {session.member.id}</p>
      <button disabled={busy} onClick={() => clear()}>退出成员身份</button>
      <button disabled={busy} onClick={() => void login(session.token)}>刷新项目授权</button>
      {!session.projects.length ? <p>当前成员尚无项目授权。</p> :
        <label>我的项目<select value={projectId} onChange={e => setProjectId(e.target.value)}>
          {session.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
      {project && <ProjectRuns key={project.id + project.role} session={session} project={project} refreshDirectory={() => login(session.token)} onDenied={clear} />}
    </> : <form onSubmit={e => { e.preventDefault(); const form = e.currentTarget; const token = String(new FormData(form).get('token') ?? '').trim(); form.reset(); if (token) void login(token); }}>
      <label>个人成员凭据<input required name="token" type="password" autoComplete="off" disabled={busy} /></label><button disabled={busy}>进入成员工作台</button>
    </form>}
  </section>;
}

export function TeamApp() {
  const [admin, setAdmin] = useState(false);
  return <main><header className="app-header"><h1>SpecMill</h1><p>团队工作流</p></header>
    <nav className="project-nav" aria-label="团队身份"><button aria-pressed={!admin} onClick={() => setAdmin(false)}>成员入口</button>
      <button aria-pressed={admin} onClick={() => setAdmin(true)}>管理员入口</button><a href="/">个人工作台</a></nav>
    {admin ? <TeamAdminPanel /> : <MemberPanel />}
  </main>;
}
