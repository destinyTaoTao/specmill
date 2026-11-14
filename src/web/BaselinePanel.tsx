import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, readJson } from './api';

type Workspace = { id: string; path: string; version: number };
type Change = { id: string; version: number; baselineId: string | null; goal: string; scope: string; nonGoals: string; criteria: string[] };
type Criterion = { id: string; revisionId: string; text: string };
type Baseline = { id: string; createdAt: string; path: string; selection: string; sourceItemId: string; sourceRevisionId: string; sourceHead: string | null; sourceCommitted: boolean | null; goal: string; scope: string; nonGoals: string; criteria: Criterion[] };
type SpecRevision = { sourceItemId: string; sourceRevisionId: string; selection: string; path: string };
type Preview = { content: string; sha256: string; head: string | null; committed: boolean | null; bindingVersion: number };

export function BaselinePanel({ projectId, change, workspaces, refresh, canAdopt }: { projectId: string; change: Change; workspaces: Workspace[]; refresh: () => Promise<void>; canAdopt: boolean }) {
  const [history, setHistory] = useState<Baseline[]>([]);
  const [specRevisions, setSpecRevisions] = useState<SpecRevision[]>([]);
  const [shown, setShown] = useState('');
  const [sourceStatus, setSourceStatus] = useState<'checking' | 'unchanged' | 'changed' | 'unavailable'>('checking');
  const [workspaceId, setWorkspaceId] = useState('');
  const [path, setPath] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selection, setSelection] = useState('');
  const [links, setLinks] = useState<Record<number, string>>({});
  const [sourceRevision, setSourceRevision] = useState('');
  const [previewVersion, setPreviewVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(crypto.randomUUID());
  const current = history.find(item => item.id === change.baselineId);
  const knownCriteria = [...new Map([...history].reverse().flatMap(item => item.criteria).map(item => [item.id, item])).values()];
  const displayed = history.find(item => item.id === shown);
  const workspace = workspaces.find(item => item.id === workspaceId);
  useEffect(() => {
    let active = true;
    void fetch(`/api/v1/changes/${change.id}/baselines`).then(response => readJson<{ baselines: Baseline[] }>(response, '读取规格基线失败。'))
      .then(result => { if (active) { setHistory(result.baselines); setShown(result.baselines[0]?.id ?? ''); } })
      .catch(() => { if (active) setError('读取规格基线失败，请返回后重试。'); });
    return () => { active = false; };
  }, [change.id, change.baselineId]);
  useEffect(() => {
    let active = true;
    void fetch(`/api/v1/projects/${projectId}/spec-items`).then(response => readJson<{ revisions: SpecRevision[] }>(response, '读取规格条目失败。'))
      .then(result => { if (active) setSpecRevisions(result.revisions); })
      .catch(() => { if (active) setError('读取规格条目失败，请返回后重试。'); });
    return () => { active = false; };
  }, [projectId, change.baselineId]);
  useEffect(() => {
    if (!shown) return;
    let active = true;
    setSourceStatus('checking');
    void fetch(`/api/v1/changes/${change.id}/baselines/${shown}/source-status`)
      .then(response => readJson<{ status: 'unchanged' | 'changed' | 'unavailable' }>(response, '无法核对规格来源。'))
      .then(result => { if (active) setSourceStatus(result.status); })
      .catch(() => { if (active) setSourceStatus('unavailable'); });
    return () => { active = false; };
  }, [change.id, shown]);
  function invalidatePreview() { setPreview(null); setSelection(''); setLinks({}); setSourceRevision(''); setPreviewVersion(null); requestId.current = crypto.randomUUID(); }
  async function previewSource(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      if (!workspace) throw new ApiError('请选择规格所在的工作区。');
      const result = await readJson<Preview>(await fetch(`/api/v1/workspaces/${workspace.id}/spec-preview`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify({ expectedBindingVersion: workspace.version, path }) }), '预览规格失败。');
      setPreview(result); setSelection(previous => previous || result.content.replace(/\r\n?/g, '\n')); setLinks({}); setSourceRevision(''); setPreviewVersion(change.version); requestId.current = crypto.randomUUID();
    } catch (err) { setError(err instanceof ApiError ? err.message : '预览失败，请检查工作区。'); } finally { setBusy(false); }
  }
  async function adopt() {
    if (!workspace || !preview || previewVersion !== change.version) return;
    setError(''); setBusy(true);
    try {
      const normalized = preview.content.replace(/\r\n?/g, '\n');
      const chosen = selection.replace(/\r\n?/g, '\n');
      const start = normalized.indexOf(chosen);
      if (!chosen.trim() || start < 0) throw new ApiError('所选内容为空或不属于当前规格来源。');
      const selectedRevision = specRevisions.find(item => item.sourceRevisionId === sourceRevision);
      await readJson(await fetch(`/api/v1/changes/${change.id}/baselines`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' },
        body: JSON.stringify({ requestId: requestId.current, expectedVersion: previewVersion, payload: { workspaceId: workspace.id, expectedBindingVersion: preview.bindingVersion, path, expectedSha256: preview.sha256, selectionRange: { start, end: start + chosen.length }, criterionLinks: change.criteria.map((_, index) => links[index] || null), previousSourceItemId: selectedRevision?.sourceItemId ?? null, previousSourceRevisionId: selectedRevision?.sourceRevisionId ?? null } }) }), '确认规格基线失败。');
      invalidatePreview();
      try { await refresh(); } catch { setNeedsReload(true); setError('基线已保存，但刷新失败；请返回后重新打开项目。'); }
    } catch (err) { setError(err instanceof ApiError ? err.message : '确认结果未知，可使用原内容重试。'); } finally { setBusy(false); }
  }
  return <section><h5>规格基线</h5>{error && <p role="alert">{error}</p>}
    {history.length > 0 && <><label>查看历史基线<select value={shown} onChange={event => setShown(event.target.value)}>{history.map(item => <option key={item.id} value={item.id}>{item.createdAt} · {item.path}</option>)}</select></label>
      {displayed && <div><p>已确认基线：{displayed.path}；{displayed.sourceCommitted === true ? '来源与该提交一致' : displayed.sourceCommitted === false ? '来源尚未提交' : '来源提交状态未知'}</p>
        <p>{sourceStatus === 'checking' ? '正在核对来源。' : sourceStatus === 'changed' ? '来源已变化；当前冻结基线不变。' : sourceStatus === 'unchanged' ? '本次核对来源未变化。' : '无法核对来源；历史基线仍可查看。'}</p>
        <p>目标：{displayed.goal || '无'}；范围：{displayed.scope || '无'}；非目标：{displayed.nonGoals || '无'}</p><pre>{displayed.selection}</pre><ul>{displayed.criteria.map(item => <li key={item.id}>{item.text}</li>)}</ul></div>}</>}
    {canAdopt && <form onSubmit={previewSource}><label>规格工作区<select disabled={busy || needsReload} required value={workspaceId} onChange={event => { setWorkspaceId(event.target.value); invalidatePreview(); }}><option value="">请选择工作区</option>{workspaces.map(item => <option key={item.id} value={item.id}>{item.path}</option>)}</select></label>
      <label>Markdown 相对路径<input disabled={busy || needsReload} required value={path} onChange={event => { setPath(event.target.value); invalidatePreview(); }} /></label><button disabled={busy || needsReload}>预览规格</button></form>
    }
    {canAdopt && preview && <><p>{preview.committed === true ? '来源与当前提交一致' : preview.committed === false ? '来源尚未提交' : '来源提交状态未知'}</p><pre>{preview.content}</pre>
      <label>选定的规格摘录<textarea disabled={busy || needsReload} value={selection} onChange={event => { setSelection(event.target.value); requestId.current = crypto.randomUUID(); }} /></label>
      <p>当前草案：目标 {change.goal || '无'}；范围 {change.scope || '无'}；非目标 {change.nonGoals || '无'}</p>
      <label>规格条目关联<select disabled={busy || needsReload} value={sourceRevision} onChange={event => { setSourceRevision(event.target.value); requestId.current = crypto.randomUUID(); }}><option value="">作为新规格条目</option>{specRevisions.map(item => <option key={item.sourceRevisionId} value={item.sourceRevisionId}>{item.path} · {item.selection.slice(0, 80)}</option>)}</select></label>
      {change.criteria.map((text, index) => <div key={index}><p>验收条件：{text}</p>{knownCriteria.length > 0 && <label>关联历史条件 {index + 1}<select disabled={busy || needsReload} value={links[index] ?? ''} onChange={event => { setLinks({ ...links, [index]: event.target.value }); requestId.current = crypto.randomUUID(); }}><option value="">作为新条件</option>{knownCriteria.map(item => <option key={item.id} value={item.id}>{item.text}</option>)}</select></label>}</div>)}
      {current && <div><h6>与当前基线比较</h6><p>目标：{current.goal || '无'} → {change.goal || '无'}</p><p>范围：{current.scope || '无'} → {change.scope || '无'}</p><p>非目标：{current.nonGoals || '无'} → {change.nonGoals || '无'}</p>
        <ul>{current.criteria.filter(item => !Object.values(links).includes(item.id)).map(item => <li key={item.id}>移除：{item.text}</li>)}{change.criteria.map((text, index) => { const prior = current.criteria.find(item => item.id === links[index]); return <li key={index}>{prior ? prior.text === text ? '保留' : `修改 ${prior.text} →` : '新增'}：{text}</li>; })}</ul>
        <p>采用新基线后，旧证据的适用性需重新判断。</p></div>}
      {previewVersion !== change.version && <p role="alert">变更已更新，请重新预览并确认关联；已输入的摘录仍保留。</p>}
      <button disabled={busy || needsReload || !selection.trim() || previewVersion !== change.version} onClick={() => { void adopt(); }}>确认规格基线</button></>}
  </section>;
}
