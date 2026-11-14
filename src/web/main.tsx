import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, readJson, responseError } from './api';
import { ChangeDrafts } from './ChangeDrafts';
import './styles.css';

type Project = { id: string; name: string; createdAt: string };
type Workspace = { id: string; path: string; version: number };
type Capacity = { records: { used: number; limit: number; warning: boolean } };
type Observation = { id: string; path: string; bindingVersion: number; createdAt: string; head: string | null; branch: string | null; dirty: boolean; stable: boolean; trackedDiffSha256: string | null; files: { path: string; status: string; sha256?: string }[]; limitations: string[] };

function WorkspaceCard({ workspace, projectId, onChanged }: { workspace: Workspace; projectId: string; onChanged: () => Promise<void> }) {
  const [selectedFiles, setSelectedFiles] = useState('');
  const [observation, setObservation] = useState<Observation | null>(null);
  const [history, setHistory] = useState<Observation[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rebindPath, setRebindPath] = useState(workspace.path);
  const [needsReload, setNeedsReload] = useState(false);
  const [confirmUnverified, setConfirmUnverified] = useState(false);
  const observationSequence = useRef(0);
  const observeRequest = useRef(crypto.randomUUID());
  const bindRequest = useRef(crypto.randomUUID());
  useEffect(() => {
    let active = true;
    const sequence = observationSequence.current;
    void fetch(`/api/v1/workspaces/${workspace.id}/observations`)
      .then(response => readJson<{ observations: Observation[] }>(response, '读取历史观察失败。'))
      .then(result => { if (active && sequence === observationSequence.current) { setHistory(result.observations); setObservation(result.observations[0] ?? null); } })
      .catch(() => { if (active) setError('读取历史观察失败，请返回后重试。'); });
    return () => { active = false; };
  }, [workspace.id, workspace.version]);
  async function observe(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const receipt = await readJson<{ resourceId: string }>(await fetch(`/api/v1/workspaces/${workspace.id}/observations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' },
        body: JSON.stringify({ requestId: observeRequest.current, expectedBindingVersion: workspace.version, selectedUntracked: selectedFiles.split(/\r?\n/).filter(Boolean) }),
      }), '观察失败，请检查工作区。');
      observeRequest.current = crypto.randomUUID();
      try {
        const value = await readJson<Observation>(await fetch(`/api/v1/workspaces/${workspace.id}/observations/${receipt.resourceId}`), '观察已保存，但读取结果失败。');
        observationSequence.current++;
        setHistory(previous => [value, ...previous.filter(item => item.id !== value.id)]);
        setObservation(value);
        await onChanged();
      } catch { setError('观察已保存，但读取或刷新失败；请返回后重试。'); }
    } catch (err) { setError(err instanceof ApiError ? err.message : '观察结果未知，可用原内容重试。'); } finally { setBusy(false); }
  }
  async function rebind(confirm = false) {
    setBusy(true); setError('');
    try {
      await readJson(await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/workspaces`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' },
        body: JSON.stringify({ requestId: bindRequest.current, expectedVersion: workspace.version, payload: { workspaceId: workspace.id, path: rebindPath, confirmUnverified: confirm } }),
      }), '更换工作目录失败。');
      bindRequest.current = crypto.randomUUID();
      setConfirmUnverified(false);
      setObservation(null);
      try { await onChanged(); } catch { setNeedsReload(true); setError('绑定已保存，但刷新失败；请返回后重新打开项目。'); }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REPOSITORY_UNVERIFIED') {
        if (!confirm) bindRequest.current = crypto.randomUUID();
        setConfirmUnverified(true);
      }
      setError(err instanceof ApiError ? err.message : '绑定结果未知，可用原内容重试。');
    } finally { setBusy(false); }
  }
  return <section><h3>工作区</h3><p>{workspace.path}（绑定版本 {workspace.version}）</p>
    {error && <p role="alert">{error}</p>}
    <form onSubmit={observe}><label>未跟踪文件（每行一个相对路径）<textarea disabled={busy || needsReload} value={selectedFiles} onChange={event => { setSelectedFiles(event.target.value); observeRequest.current = crypto.randomUUID(); }} /></label>
      <button disabled={busy || needsReload}>观察工作区</button></form>
    {observation && <div><label>查看历史观察<select value={observation.id} onChange={event => setObservation(history.find(item => item.id === event.target.value) ?? null)}>{history.map(item => <option key={item.id} value={item.id}>{item.createdAt} · 绑定版本 {item.bindingVersion}</option>)}</select></label>
      <p>观察路径：{observation.path}</p><p>观察时间：{observation.createdAt}；绑定版本 {observation.bindingVersion}{observation.bindingVersion !== workspace.version && '（历史绑定，需重新观察）'}</p><p>HEAD：{observation.head ?? <span>尚无提交</span>}</p><p>分支：{observation.branch ?? '未关联分支'}</p>
      <p>{observation.dirty ? '检测到未提交修改' : '未检测到未提交修改（不代表全面覆盖）'}；{observation.stable ? '观察期间未检测到变化' : '观察不稳定，请重新核对'}</p>
      {observation.trackedDiffSha256 && <p>已跟踪差异摘要：{observation.trackedDiffSha256}</p>}
      <ul>{observation.files.map(file => <li key={`${file.status}-${file.path}`}><span>{file.path}</span>（{file.status}）{file.sha256 && <span>　{file.sha256}</span>}</li>)}</ul>
      <ul>{observation.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
    <form onSubmit={event => { event.preventDefault(); void rebind(); }}><label>更换工作目录<input disabled={busy || needsReload} value={rebindPath} onChange={event => { setRebindPath(event.target.value); setConfirmUnverified(false); bindRequest.current = crypto.randomUUID(); }} required /></label><button disabled={busy || needsReload || confirmUnverified}>更换绑定</button></form>
    {confirmUnverified && <button disabled={busy} onClick={() => { void rebind(true); }}>确认仍要绑定</button>}
  </section>;
}

function ProjectDetails({ project, onBack }: { project: Project; onBack: () => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  async function refresh() {
    const [list, budget] = await Promise.all([
      readJson<{ workspaces: Workspace[] }>(await fetch(`/api/v1/projects/${project.id}/workspaces`), '读取工作区失败。'),
      readJson<Capacity>(await fetch(`/api/v1/projects/${project.id}/capacity`), '读取容量失败。'),
    ]);
    setWorkspaces(list.workspaces); setCapacity(budget);
  }
  useEffect(() => { void refresh().catch(() => setError('读取项目详情失败，请返回后重试。')); }, [project.id]);
  async function bind(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await readJson(await fetch(`/api/v1/projects/${project.id}/workspaces`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' },
        body: JSON.stringify({ requestId: requestId.current, expectedVersion: null, payload: { workspaceId: null, path } }),
      }), '登记工作区失败。');
      setPath(''); requestId.current = crypto.randomUUID();
      try { await refresh(); } catch { setError('工作区已登记，但列表刷新失败；请返回项目列表后重试。'); }
    } catch (err) { setError(err instanceof ApiError ? err.message : '结果未知，可使用原内容重试。'); } finally { setBusy(false); }
  }
  return <><button onClick={onBack}>返回项目列表</button><h2>{project.name}</h2>
    {capacity && <p>记录容量：{capacity.records.used} / {capacity.records.limit} 字节{capacity.records.warning && '（接近上限）'}</p>}
    {error && <p role="alert">{error}</p>}
    <form onSubmit={bind}><label>工作目录<input disabled={busy} value={path} onChange={event => { setPath(event.target.value); requestId.current = crypto.randomUUID(); }} required /></label><button disabled={busy}>登记工作区</button></form>
    {workspaces.map(workspace => <WorkspaceCard key={workspace.id} workspace={workspace} projectId={project.id} onChanged={refresh} />)}
    <ChangeDrafts projectId={project.id} workspaces={workspaces} onChanged={refresh} />
  </>;
}
function App() {
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const requestId = useRef(crypto.randomUUID());
  async function load() {
    const response = await fetch('/api/v1/projects');
    if (!response.ok) throw await responseError(response, '读取项目失败，请检查服务状态。');
    setProjects((await response.json()).projects);
  }
  async function login(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      if (!response.ok) throw await responseError(response, '登录失败，请检查启动终端中的口令。');
      setToken(''); await load();
    } catch (err) { setError(err instanceof Error ? err.message : '登录失败'); } finally { setBusy(false); }
  }
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify({ name, requestId: requestId.current }) });
      if (!response.ok) {
        const error = await responseError(response, '保存失败，请检查项目名称及服务状态。');
        if (response.status >= 500) error.message += '结果可能未知，可使用原内容重试。';
        throw error;
      }
      setName(''); requestId.current = crypto.randomUUID();
      try { await load(); } catch { setError('项目已保存，但列表刷新失败；请刷新页面。'); }
    } catch (err) { setError(err instanceof ApiError ? err.message : '结果未知或保存失败，可使用原内容重试。'); } finally { setBusy(false); }
  }
  return <main><h1>SpecMill</h1><p>个人开发续做工作台</p>
    {error && <p role="alert">{error}</p>}
    {projects === null ? <form onSubmit={login}><label>本次登录口令<input disabled={busy} type="password" value={token} onChange={e => setToken(e.target.value)} required /></label><p>口令显示在启动服务的终端中。</p><button disabled={busy}>登录</button></form>
      : selectedProject ? <ProjectDetails project={selectedProject} onBack={() => setSelectedProject(null)} />
      : <><h2>项目</h2><form onSubmit={create}><label>项目名称<input disabled={busy} value={name} maxLength={200} onChange={e => { setName(e.target.value); requestId.current = crypto.randomUUID(); }} required /></label><button disabled={busy}>创建项目</button></form>
        {projects.length === 0 ? <p>尚无项目，请先创建。</p> : <ul>{projects.map(project => <li key={project.id}><span>{project.name}</span> <button onClick={() => setSelectedProject(project)}>打开 {project.name}</button></li>)}</ul>}</>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
