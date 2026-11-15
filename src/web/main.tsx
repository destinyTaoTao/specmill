import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, readJson, responseError } from './api';
import { ChangeDrafts } from './ChangeDrafts';
import './styles.css';

type Project = { id: string; name: string; createdAt: string };
type ProjectOverview = { projectId: string; activeChanges: number; workspaces: { path: string; needsBinding: boolean; directoryStatus: 'present' | 'missing' | 'unknown' }[] };
type RestoreWarning = { id: string; filename: string; message: string; persisted: boolean };
const restorePointerPrefix = 'specmill:pending-restore:';
const restoreReadError = '无法读取未决恢复提示，请检查浏览器站点存储。';
function readRestorePointers(): RestoreWarning[] | null {
  try {
    const pointers: RestoreWarning[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(restorePointerPrefix)) continue;
      const id = key.slice(restorePointerPrefix.length);
      if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
      pointers.push({ id, filename: `恢复请求 ${id.slice(0, 8)}`, persisted: true, message: '恢复结果未知或仍在进行，请核对项目记录；不要仅凭名称判断。' });
    }
    return pointers;
  } catch { return null; }
}
function writeRestorePointer(id: string): boolean {
  try { localStorage.setItem(restorePointerPrefix + id, new Date().toISOString()); return true; } catch { return false; }
}
function removeRestorePointer(id: string): boolean {
  try { localStorage.removeItem(restorePointerPrefix + id); return true; } catch { return false; }
}
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
  return <section><h4>已登记工作区</h4><p>{workspace.path}（绑定版本 {workspace.version}）</p>
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

type ExportOperation = { id: string; status: string; sha256: string | null; size: number | null; error: string | null; createdAt: string; finishedAt: string | null };

function ExportSection({ projectId }: { projectId: string }) {
  const [exports, setExports] = useState<ExportOperation[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestId = useRef(crypto.randomUUID());
  const listSequence = useRef(0);
  const statusSequence = useRef(0);
  const reload = async () => {
    const sequence = ++listSequence.current;
    const result = await readJson<{ exports: ExportOperation[] }>(await fetch(`/api/v1/projects/${projectId}/exports`), '读取导出记录失败。');
    if (sequence === listSequence.current) setExports(result.exports);
  };
  useEffect(() => { let live = true; const sequence = listSequence.current + 1; void reload().catch(() => { if (live && sequence === listSequence.current) setError('读取导出记录失败。'); }); return () => { live = false; listSequence.current++; statusSequence.current++; }; }, [projectId]);
  async function startExport() {
    setBusy(true); setError(''); setNotice('');
    try {
      const receipt = await readJson<{ resourceId: string; status: string; createdAt?: string }>(await fetch(`/api/v1/projects/${projectId}/exports`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify({ requestId: requestId.current }) }), '导出失败。');
      requestId.current = crypto.randomUUID();
      listSequence.current++;
      setExports(previous => [{ id: receipt.resourceId, status: receipt.status, sha256: null, size: null, error: null, createdAt: receipt.createdAt ?? '', finishedAt: null }, ...(previous ?? []).filter(item => item.id !== receipt.resourceId)]);
      await refreshExport(receipt.resourceId);
    } catch (err) { setError(err instanceof ApiError ? err.message : '导出结果未知，可重试。'); } finally { setBusy(false); }
  }
  async function refreshExport(id: string) {
    const sequence = ++statusSequence.current;
    setRefreshing(id); setError('');
    try {
      const result = await readJson<ExportOperation>(await fetch(`/api/v1/exports/${id}`), '读取导出状态失败。');
      if (sequence !== statusSequence.current) return;
      setExports(previous => (previous ?? []).map(item => item.id === result.id ? result : item));
      setNotice(result.status === 'ready' ? '恢复包已生成，可下载。' : result.status === 'failed' ? `导出失败：${result.error ?? ''}` : result.status === 'canceled' ? '导出已取消。' : '导出进行中，请稍后查看状态。');
    } catch { if (sequence === statusSequence.current) setError('导出已创建，但状态读取失败；请刷新导出状态。'); } finally { setRefreshing(previous => previous === id ? null : previous); }
  }
  async function cancelExport(id: string) {
    setError('');
    try {
      await readJson(await fetch(`/api/v1/exports/${id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify({ requestId: crypto.randomUUID() }) }), '取消导出失败。');
      statusSequence.current++;
      setExports(previous => (previous ?? []).map(item => item.id === id ? { ...item, status: 'canceled' } : item));
      setNotice('导出已取消。');
    } catch (err) { setError(err instanceof ApiError ? err.message : '取消结果未知，请刷新状态。'); }
  }
  return <section id="project-export"><h3>导出恢复包</h3>{error && <p role="alert">{error}</p>}<p role="status">{notice}</p>
    <p>包含工作台记录和受管理附件，不包含源码或开发环境。</p>
    <button disabled={busy || (exports?.some(item => item.status === 'preparing') ?? false)} onClick={() => { void startExport(); }}>导出恢复包</button>
    {exports === null ? <p>正在读取导出记录。</p> : exports.length === 0 ? <p>尚无导出记录。</p> : <ul>{exports.map(item => <li key={item.id}><p>操作 {item.id.slice(0, 8)}… · {item.status === 'ready' ? '已就绪' : item.status === 'failed' ? `失败：${item.error ?? ''}` : item.status === 'preparing' ? '正在准备' : '已取消'} · {item.createdAt}</p>{item.status === 'preparing' && <><button disabled={busy || refreshing !== null} onClick={() => { void refreshExport(item.id); }}>刷新导出状态</button><button onClick={() => { void cancelExport(item.id); }}>取消导出</button></>}{item.status === 'ready' && <p><a href={`/api/v1/exports/${item.id}/download`}>下载恢复包</a>（{item.size} 字节）</p>}</li>)}</ul>}
  </section>;
}

function ProjectDetails({ project, onBack }: { project: Project; onBack: () => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const refreshSequence = useRef(0);
  async function refresh() {
    const sequence = ++refreshSequence.current;
    try {
      const [list, budget] = await Promise.all([
        fetch(`/api/v1/projects/${project.id}/workspaces`).then(response => readJson<{ workspaces: Workspace[] }>(response, '读取工作区失败。')),
        fetch(`/api/v1/projects/${project.id}/capacity`).then(response => readJson<Capacity>(response, '读取容量失败。')),
      ]);
      if (sequence === refreshSequence.current) { setWorkspaces(list.workspaces); setCapacity(budget); }
    } catch (error) {
      if (sequence === refreshSequence.current) throw error;
    }
  }
  useEffect(() => { let live = true; void refresh().catch(() => { if (live) setError('读取项目详情失败，请返回后重试。'); }); return () => { live = false; refreshSequence.current++; }; }, [project.id]);
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
    <nav className="project-nav" aria-label="项目内容"><a href="#project-workspaces">工作区</a><a href="#project-changes">变更</a><a href="#project-export">导出恢复包</a></nav>
    {error && <p role="alert">{error}</p>}
    <section id="project-workspaces"><h3>工作区</h3><form onSubmit={bind}><label>工作目录<input disabled={busy} value={path} onChange={event => { setPath(event.target.value); requestId.current = crypto.randomUUID(); }} required /></label><button disabled={busy}>登记工作区</button></form>
      {workspaces.map(workspace => <WorkspaceCard key={workspace.id} workspace={workspace} projectId={project.id} onChanged={refresh} />)}
    </section>
    <ChangeDrafts projectId={project.id} workspaces={workspaces} onChanged={refresh} />
    <ExportSection projectId={project.id} />
  </>;
}
function App() {
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [overviews, setOverviews] = useState<ProjectOverview[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [checkingRestoreId, setCheckingRestoreId] = useState<string | null>(null);
  const [restoreNotice, setRestoreNotice] = useState('');
  const [initialRestorePointers] = useState(readRestorePointers);
  const [restoreWarnings, setRestoreWarnings] = useState<RestoreWarning[]>(() => initialRestorePointers ?? []);
  const [restoreStorageNotice, setRestoreStorageNotice] = useState(() => initialRestorePointers === null ? restoreReadError : '');
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const restoreId = useRef(crypto.randomUUID());
  const loadSequence = useRef(0);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null) {
        setRestoreWarnings(previous => previous.map(item => ({ ...item, persisted: false, message: `${item.message} 浏览器存储已清空，该提示无法跨页面保留。` })));
        setRestoreStorageNotice('浏览器存储已清空；现有未决提示无法跨页面保留，请先核对。');
        return;
      }
      if (event.key !== null && !event.key.startsWith(restorePointerPrefix)) return;
      const pointers = readRestorePointers();
      if (pointers === null) { setRestoreStorageNotice(restoreReadError); return; }
      setRestoreStorageNotice(previous => previous === restoreReadError ? '' : previous);
      setRestoreWarnings(previous => [...previous.filter(item => !item.persisted), ...pointers.map(item => previous.find(old => old.id === item.id) ?? item)]);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  async function load() {
    const sequence = ++loadSequence.current;
    try {
      const response = await fetch('/api/v1/projects');
      if (!response.ok) throw await responseError(response, '读取项目失败，请检查服务状态。');
      const result = await response.json();
      const summary = await fetch('/api/v1/project-overviews').then(response => response.ok ? response.json() as Promise<{ projects: ProjectOverview[] }> : null).catch(() => null);
      if (sequence === loadSequence.current) { setProjects(result.projects); setOverviews(summary?.projects ?? null); }
    } catch (error) {
      if (sequence === loadSequence.current) throw error;
    }
  }
  async function restorePackage(file: File) {
    setRestoring(true); setError(''); setRestoreNotice('');
    const currentRequestId = restoreId.current;
    const persisted = writeRestorePointer(currentRequestId);
    setRestoreStorageNotice(readRestorePointers() === null ? restoreReadError : persisted ? '' : '浏览器存储不可用；本次恢复如结果未知，提示无法跨页面保留。');
    try {
      const result = await readJson<{ restoredProjectId: string; sourceBindingRequired: boolean }>(await fetch(`/api/v1/restore?requestId=${encodeURIComponent(currentRequestId)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-SpecMill-Request': '1' }, body: file }), '恢复失败。');
      restoreId.current = crypto.randomUUID();
      if (persisted && !removeRestorePointer(currentRequestId)) setError('项目已恢复，但无法清理浏览器中的未决提示。');
      else setRestoreWarnings(previous => previous.filter(item => item.id !== currentRequestId));
      setRestoreStorageNotice(readRestorePointers() === null ? restoreReadError : '');
      try { await load(); } catch { setError('项目已恢复，但列表刷新失败；请刷新页面。'); }
      setRestoreNotice(`项目记录与附件已恢复（${result.restoredProjectId.slice(0, 8)}…）。源码目录未随包恢复：${result.sourceBindingRequired ? '请打开项目重新绑定工作目录后再续做；恢复成功不代表源码已备份。' : ''}`);
    } catch (err) {
      const uncertain = !(err instanceof ApiError) || err.status === undefined || err.status >= 500 || err.status === 408 || err.status === 429;
      if (!uncertain && err instanceof ApiError) {
        if (persisted && !removeRestorePointer(currentRequestId)) setError(`${err.message}；未能清理浏览器中的未决提示。`);
        else { setRestoreWarnings(previous => previous.filter(item => item.id !== currentRequestId)); setError(err.message); }
        setRestoreStorageNotice(readRestorePointers() === null ? restoreReadError : '');
      }
      else {
        restoreId.current = crypto.randomUUID();
        const canPersist = persisted && writeRestorePointer(currentRequestId);
        const storageWarning = canPersist ? '' : '浏览器存储不可用，该提示可能无法跨页面保留。';
        if (persisted && !canPersist) setRestoreStorageNotice('浏览器存储不可用；本次恢复的未决提示可能无法跨页面保留。');
        setRestoreWarnings(previous => [...previous.filter(item => item.id !== currentRequestId), { id: currentRequestId, filename: file.name, persisted, message: `恢复结果未知，正在刷新项目列表；请稍后核对项目记录。${storageWarning}` }]);
        const updateWarning = (message: string) => setRestoreWarnings(previous => previous.map(item => item.id === currentRequestId ? { ...item, message: message + storageWarning } : item));
        try {
          await load();
          updateWarning('恢复结果未知，已尝试刷新项目列表；操作可能仍在进行，请稍后核对项目记录，不要仅凭名称判断。');
        } catch {
          updateWarning('恢复结果未知，项目列表刷新失败；请稍后刷新页面并核对项目记录。');
        }
      }
    } finally { setRestoring(false); }
  }
  async function login(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch('/api/v1/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      if (!response.ok) throw await responseError(response, '登录失败，请检查启动终端中的口令。');
      setToken(''); await load();
    } catch (err) { setError(err instanceof Error ? err.message : '登录失败'); } finally { setBusy(false); }
  }
  async function checkRestoreReceipt(warning: RestoreWarning) {
    setCheckingRestoreId(warning.id); setError('');
    try {
      const receipt = await readJson<{ requestId: string; restoredProjectId: string; sourceBindingRequired: boolean }>(await fetch(`/api/v1/restores/${encodeURIComponent(warning.id)}`), '读取恢复回执失败。');
      if (receipt.requestId !== warning.id || typeof receipt.restoredProjectId !== 'string' || receipt.sourceBindingRequired !== true) throw new Error('恢复回执不完整，请稍后重试。');
      if (warning.persisted && !removeRestorePointer(warning.id)) { setError('恢复已确认，但无法清理浏览器中的未决提示。'); return; }
      setRestoreWarnings(previous => previous.filter(item => item.id !== warning.id));
      try { await load(); } catch { setError('恢复已确认，但项目列表刷新失败；请刷新页面。'); }
      setRestoreNotice(`已确认项目记录与附件恢复（${receipt.restoredProjectId.slice(0, 8)}…）；源码未随包恢复，请重新绑定工作目录。`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setRestoreWarnings(previous => previous.map(item => item.id === warning.id ? { ...item, message: '尚未找到恢复回执；操作可能仍在进行，请稍后重试。' } : item));
      else setError(err instanceof Error ? err.message : '读取恢复回执失败，请稍后重试。');
    } finally { setCheckingRestoreId(null); }
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
  const overviewByProject = new Map(overviews?.map(overview => [overview.projectId, overview]));
  return <main><header className="app-header"><h1>SpecMill</h1><p>个人开发续做工作台</p></header>
    {error && <p role="alert">{error}</p>}
    {restoreStorageNotice && <p role="status">{restoreStorageNotice}</p>}
    {restoreWarnings.map(warning => <div key={warning.id}><p role="alert">{warning.filename}：{warning.message}</p>{projects !== null && <button disabled={checkingRestoreId !== null} onClick={() => { void checkRestoreReceipt(warning); }}>查询 {warning.filename} 回执</button>}<button disabled={checkingRestoreId !== null} onClick={() => {
      if (warning.persisted && !removeRestorePointer(warning.id)) { setError('无法清理浏览器中的未决提示，请检查站点存储设置。'); return; }
      setRestoreWarnings(previous => previous.filter(item => item.id !== warning.id));
    }}>已核对，关闭 {warning.filename} 提示</button></div>)}
    {projects === null ? <form onSubmit={login}><label>本次登录口令<input disabled={busy} type="password" value={token} onChange={e => setToken(e.target.value)} required /></label><p>口令显示在启动服务的终端中。</p><button disabled={busy}>登录</button></form>
      : selectedProject ? <ProjectDetails project={selectedProject} onBack={() => { setSelectedProject(null); void load().catch(() => setError('项目列表刷新失败；请刷新页面。')); }} />
      : <><h2>项目</h2><div className="project-layout">
        <section className="project-directory" aria-label="已有项目"><h3>已有项目 <span className="project-count">{projects.length}</span></h3>
          {projects.length === 0 ? <p className="empty-state">尚无项目，请先创建或从恢复包恢复。</p> : <ul className="project-list">{projects.map(project => {
            const overview = overviewByProject.get(project.id);
            return <li key={project.id}><div className="project-summary"><strong>{project.name}</strong>{overview ? <><p>进行中变更：{overview.activeChanges}</p>{overview.workspaces.length === 0 ? <p>尚未登记工作区。</p> : overview.workspaces.map(workspace => <p key={workspace.path}>{workspace.path} · {workspace.directoryStatus === 'missing' ? '目录不存在或不是目录' : workspace.directoryStatus === 'unknown' ? '目录状态待核对' : '目录存在，仓库身份待核对'}{workspace.needsBinding && ' · 需要重新绑定'}</p>)}</> : <p>项目摘要暂不可用。</p>}</div><button aria-label={`打开 ${project.name}`} onClick={() => setSelectedProject(project)}>打开</button></li>;
          })}</ul>}
        </section>
        <section className="project-actions"><h3>新建项目</h3><form onSubmit={create}><label>项目名称<input disabled={busy} value={name} maxLength={200} onChange={e => { setName(e.target.value); requestId.current = crypto.randomUUID(); }} required /></label><button disabled={busy}>创建项目</button></form>
          <div className="restore-area"><label>从恢复包恢复（.zip，仅恢复记录与附件，不含源码）<input type="file" accept=".zip" disabled={busy || restoring} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void restorePackage(file); }} /></label></div>
          <p role="status">{restoreNotice}</p>
        </section>
      </div></>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
