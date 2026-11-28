import { useEffect, useRef, useState } from 'react';
import { ApiError, readJson } from './api';

type Change = { id: string; version: number };
type Workspace = { id: string; path: string; version: number };
type Snapshot = { id: string; createdAt: string; capturedVersion: number; phase: string; cycle: number };
type Diff = { headChanged: boolean; trackedDiffChanged: boolean | null; added: { path: string; status: string }[]; removed: { path: string; status: string }[]; changed: { path: string; status: string }[] };
type ComparedWorkspace = { path: string; bindingVersion: number; head: string | null };
type Continuation = { savedObservation: ComparedWorkspace; fresh: ComparedWorkspace & { stable: boolean }; diff: Diff; notice: string };

export function HandoffPanel({ change, workspaces }: { change: Change; workspaces: Workspace[] }) {
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [rendered, setRendered] = useState<{ id: string; markdown: string } | null>(null);
  const [continuation, setContinuation] = useState<Continuation | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const createId = useRef(crypto.randomUUID());
  const reloadSnapshots = async () => {
    const result = await readJson<{ snapshots: Snapshot[] }>(await fetch(`/api/v1/changes/${change.id}/handoffs`), '读取交接快照失败。');
    setSnapshots(result.snapshots);
  };
  useEffect(() => {
    let live = true;
    void reloadSnapshots().catch(() => { if (live) setError('读取交接快照失败，请返回后重试。'); });
    return () => { live = false; };
  }, [change.id, change.version]);
  async function create() {
    setBusy(true); setError(''); setNotice('');
    try {
      await readJson(await fetch(`/api/v1/changes/${change.id}/handoffs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify({ requestId: createId.current }) }), '生成交接快照失败。');
      createId.current = crypto.randomUUID();
      await reloadSnapshots();
      setNotice('交接文件已生成（快照已保存）；修改渲染出的文本不会回写工作台。');
    } catch (err) { setError(err instanceof ApiError ? err.message : '生成结果未知，可用原按钮重试。'); } finally { setBusy(false); }
  }
  async function renderSnapshot(id: string) {
    setBusy(true); setError('');
    try { setRendered({ id, markdown: (await readJson<{ markdown: string }>(await fetch(`/api/v1/handoffs/${encodeURIComponent(id)}/render`), '渲染交接材料失败。')).markdown }); }
    catch (err) { setError(err instanceof ApiError ? err.message : '渲染失败，可重试。'); } finally { setBusy(false); }
  }
  async function compare() {
    if (!workspaceId) return;
    setBusy(true); setError(''); setContinuation(null); setNotice('');
    try {
      setContinuation(await readJson<Continuation>(await fetch(`/api/v1/changes/${change.id}/continuation/${encodeURIComponent(workspaceId)}`), '续做核对失败。'));
    } catch (err) { setError(err instanceof ApiError ? err.message : '续做核对失败，可重试。'); } finally { setBusy(false); }
  }
  return <section><h5>交接与续做</h5>{error && <p role="alert">{error}</p>}<p role="status">{notice}</p>
    <button disabled={busy} onClick={() => { void create(); }}>生成固定交接</button>
    {snapshots === null ? <p>正在读取交接快照。</p> : snapshots.length === 0 ? <p>尚无交接快照。</p> : <ul>{snapshots.map(item => <li key={item.id}>快照 {item.id} · 捕获版本 {item.capturedVersion} · {item.createdAt} · <button disabled={busy} onClick={() => { void renderSnapshot(item.id); }}>读取固定交接</button></li>)}</ul>}
    {rendered && <div><p>快照 {rendered.id} 的固定材料：</p><pre aria-label="固定交接材料" style={{ whiteSpace: 'pre-wrap' }}>{rendered.markdown}</pre></div>}
    <label>续做核对工作区<select value={workspaceId} disabled={busy} onChange={event => { setWorkspaceId(event.target.value); setContinuation(null); setError(''); }}><option value="">请选择工作区</option>{workspaces.map(item => <option key={item.id} value={item.id}>{item.path}</option>)}</select></label>
    <button disabled={busy || !workspaceId} onClick={() => { void compare(); }}>对比最近保存点与当前文件</button>
    {continuation && <div><p role="status">{continuation.notice}</p>
      <p>原观察：{continuation.savedObservation.path} · 绑定版本 {continuation.savedObservation.bindingVersion} · HEAD {continuation.savedObservation.head ?? '尚无提交'}</p>
      <p>本次核对：{continuation.fresh.path} · 绑定版本 {continuation.fresh.bindingVersion} · HEAD {continuation.fresh.head ?? '尚无提交'}{continuation.fresh.stable ? '' : ' · 本次观察不稳定'}</p>
      {(continuation.diff.added.length > 0 || continuation.diff.removed.length > 0 || continuation.diff.changed.length > 0) && <ul>{[...continuation.diff.added.map(item => `新增 ${item.status} ${item.path}`), ...continuation.diff.removed.map(item => `移除 ${item.status} ${item.path}`), ...continuation.diff.changed.map(item => `变化 ${item.status} ${item.path}`)].map(item => <li key={item}>{item}</li>)}</ul>}
    </div>}
  </section>;
}
