import { useEffect, useRef, useState } from 'react';
import { ApiError, readJson } from './api';
import { CheckpointPanel } from './CheckpointPanel';

type Workspace = { id: string; path: string; version: number };
type Session = { id: string; workspaceId: string; bindingVersion: number; toolLabel: string; actor: 'user' | 'agent'; generation: number; status: string };
type Change = { id: string; version: number; phase: string };
type Checkpoint = { id: string; createdAt: string; goal: string; done: string; failures: string; unverified: string; blockers: string; nextSteps: string };
type TakeoverPreview = { sessionId: string; generation: number; version: number; checkpoint: Checkpoint | null };

export function WriterSessionPanel({ change, workspaces, refresh }: { change: Change; workspaces: Workspace[]; refresh: () => Promise<void> }) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [sequence, setSequence] = useState(0);
  const [workspaceId, setWorkspaceId] = useState('');
  const [toolLabel, setToolLabel] = useState('Web 手动');
  const [busy, setBusy] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [error, setError] = useState('');
  const [takeover, setTakeover] = useState<TakeoverPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const takeoverId = useRef(crypto.randomUUID());
  const active = sessions?.find(item => item.status === 'active');
  const workspace = workspaces.find(item => item.id === workspaceId);
  const sessionReady = !loading && loadedVersion === change.version;
  useEffect(() => {
    let live = true;
    setLoading(true);
    void fetch(`/api/v1/changes/${change.id}/writer-sessions`).then(response => readJson<{ sessions: Session[] }>(response, '读取写会话失败。'))
      .then(result => { if (live) { setSessions(result.sessions); setLoadedVersion(change.version); } })
      .catch(() => { if (live) { setLoadedVersion(null); setError('读取写会话失败，请重试。'); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [change.id, change.version, sequence]);
  async function refreshStatus() {
    setLoading(true);
    try { await refresh(); setSequence(value => value + 1); }
    catch { setLoadedVersion(null); setLoading(false); setError('刷新写会话失败，请重试。'); }
  }
  async function submit(action: 'start' | 'release') {
    setBusy(true); setError('');
    try {
      const path = action === 'start' ? `/api/v1/changes/${change.id}/writer-sessions` : `/api/v1/writer-sessions/${active?.id}/release`;
      if (action === 'start' && !workspace) throw new ApiError('请选择工作区。');
      const body = action === 'start' ? { requestId: requestId.current, expectedVersion: change.version, payload: { workspaceId: workspace!.id, expectedBindingVersion: workspace!.version, toolLabel } }
        : { requestId: requestId.current, expectedVersion: change.version, generation: active?.generation };
      await readJson(await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify(body) }), '写会话操作失败。');
      requestId.current = crypto.randomUUID();
      try { await refresh(); } catch { setNeedsReload(true); setError('操作已保存，但刷新失败；请返回后重新打开项目。'); }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '操作结果未知，可用原内容重试。');
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') { try { await refresh(); } catch { /* preserve the original error */ } }
    } finally { setBusy(false); }
  }
  async function previewTakeover() {
    if (!active || !sessionReady) return;
    setBusy(true); setError('');
    try {
      const result = await readJson<{ checkpoints: Checkpoint[] }>(await fetch(`/api/v1/changes/${change.id}/checkpoints`), '读取最后保存点失败。');
      setTakeover({ sessionId: active.id, generation: active.generation, version: change.version, checkpoint: result.checkpoints[0] ?? null });
      setConfirmed(false); takeoverId.current = crypto.randomUUID();
    } catch { setError('读取最后保存点失败，请重试。'); } finally { setBusy(false); }
  }
  async function confirmTakeover() {
    if (!takeover || !confirmed || !active || takeover.sessionId !== active.id || takeover.version !== change.version || !sessionReady) return;
    setBusy(true); setError('');
    try {
      await readJson(await fetch(`/api/v1/changes/${change.id}/writer-sessions/takeover`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify({ requestId: takeoverId.current, expectedVersion: takeover.version, payload: { writerSessionId: takeover.sessionId, expectedGeneration: takeover.generation, expectedCheckpointId: takeover.checkpoint?.id ?? null, toolLabel: 'Web 接管' } }) }), '接管写会话失败。');
      setTakeover(null); setConfirmed(false);
      try { await refresh(); } catch { setNeedsReload(true); setError('接管已保存，但刷新失败；请返回后重新打开项目。'); }
    } catch (err) { setError(err instanceof ApiError ? err.message : '接管结果未知，可按原内容重试。'); } finally { setBusy(false); }
  }
  return <section><h5>写会话</h5>{error && <p role="alert">{error}</p>}
    <button disabled={busy || needsReload} onClick={() => { void refreshStatus(); }}>刷新会话状态</button>
    {!sessionReady && <p>写会话状态尚未核对，请稍候或刷新。</p>}
    {sessions === null ? <p>尚未读取写会话状态。</p> : active ? <><p>{sessionReady ? '活跃' : '上次读取为活跃'}：{active.toolLabel} · 代次 {active.generation} · {workspaces.find(item => item.id === active.workspaceId)?.path ?? '工作区不可用'}</p>
      {active.actor === 'user' ? <button disabled={busy || needsReload || !sessionReady} onClick={() => { void submit('release'); }}>结束手动会话</button> : <><p>工具可以正常释放；失联时可由用户核对后接管。</p><button disabled={busy || needsReload || !sessionReady} onClick={() => { void previewTakeover(); }}>查看保存点并接管</button></>}</>
      : <><p>{sessionReady ? '当前没有活跃写会话。' : '上次读取时没有活跃写会话。'}</p>{change.phase !== 'Canceled' && <><label>会话工作区<select disabled={busy || needsReload} value={workspaceId} onChange={event => { setWorkspaceId(event.target.value); requestId.current = crypto.randomUUID(); }}><option value="">请选择工作区</option>{workspaces.map(item => <option key={item.id} value={item.id}>{item.path}</option>)}</select></label>
        <label>工具名称<input disabled={busy || needsReload} value={toolLabel} onChange={event => { setToolLabel(event.target.value); requestId.current = crypto.randomUUID(); }} /></label>
        <button disabled={busy || needsReload || !sessionReady || !workspace || !toolLabel.trim()} onClick={() => { void submit('start'); }}>开始手动会话</button></>}</>}
    {takeover && <div><h6>接管前核对</h6>{takeover.checkpoint ? <><p>最后保存于 {takeover.checkpoint.createdAt}；目标：{takeover.checkpoint.goal.trim() ? takeover.checkpoint.goal : '尚未填写'}</p><p>已完成：{takeover.checkpoint.done}</p><p>失败：{takeover.checkpoint.failures}；未验证：{takeover.checkpoint.unverified}；阻塞：{takeover.checkpoint.blockers}</p><p>下一步：{takeover.checkpoint.nextSteps}</p></> : <p>尚无成功保存点，旧工具未记录的内容无法从工作台找回。</p>}
      <label><input type="checkbox" disabled={busy || needsReload} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />已核对最后保存点并确认接管</label>
      <button disabled={busy || needsReload || !confirmed || !sessionReady || takeover.sessionId !== active?.id || takeover.version !== change.version} onClick={() => { void confirmTakeover(); }}>确认接管</button></div>}
    <CheckpointPanel change={change} active={active ?? null} sessionReady={sessionReady} refresh={refresh} />
  </section>;
}
