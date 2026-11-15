import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, readJson } from './api';
import { BaselinePanel } from './BaselinePanel';
import { EvidencePanel } from './EvidencePanel';
import { HandoffPanel } from './HandoffPanel';
import { ReviewPanel } from './ReviewPanel';
import { WriterSessionPanel } from './WriterSessionPanel';

type DraftFields = { title: string; goal: string; scope: string; nonGoals: string; criteria: string };
type Change = { id: string; phase: 'Draft' | 'Working' | 'Reviewing' | 'Accepted' | 'Canceled'; cycle: number; version: number; baselineId: string | null; title: string; goal: string; scope: string; nonGoals: string; criteria: string[] };
type Workspace = { id: string; path: string; version: number };
type Transition = { id: string; from: string; to: string; cycle: number; reason: string; createdAt: string };
const emptyDraft = (): DraftFields => ({ title: '', goal: '', scope: '', nonGoals: '', criteria: '' });
const payload = (draft: DraftFields) => ({ ...draft, criteria: draft.criteria.split(/\r?\n/).filter(line => line.trim() !== '') });
const fromChange = (change: Change): DraftFields => ({ title: change.title, goal: change.goal, scope: change.scope, nonGoals: change.nonGoals, criteria: change.criteria.join('\n') });

function Fields({ value, onChange, disabled }: { value: DraftFields; onChange: (value: DraftFields) => void; disabled: boolean }) {
  return <>
    <label>变更标题<input disabled={disabled} required maxLength={200} value={value.title} onChange={event => onChange({ ...value, title: event.target.value })} /></label>
    <label>目标<textarea disabled={disabled} value={value.goal} onChange={event => onChange({ ...value, goal: event.target.value })} /></label>
    <label>范围<textarea disabled={disabled} value={value.scope} onChange={event => onChange({ ...value, scope: event.target.value })} /></label>
    <label>非目标<textarea disabled={disabled} value={value.nonGoals} onChange={event => onChange({ ...value, nonGoals: event.target.value })} /></label>
    <label>验收条件（每行一项）<textarea disabled={disabled} value={value.criteria} onChange={event => onChange({ ...value, criteria: event.target.value })} /></label>
  </>;
}

function DraftCard({ projectId, change, workspaces, refresh }: { projectId: string; change: Change; workspaces: Workspace[]; refresh: () => Promise<void> }) {
  const [draft, setDraft] = useState(() => fromChange(change));
  const [editing, setEditing] = useState(false);
  const [editVersion, setEditVersion] = useState(change.version);
  const [canceling, setCanceling] = useState(false);
  const [cancelVersion, setCancelVersion] = useState(change.version);
  const [showBaseline, setShowBaseline] = useState(false);
  const [confirmBaseline, setConfirmBaseline] = useState(false);
  const [reopenDraft, setReopenDraft] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [error, setError] = useState('');
  const [transitions, setTransitions] = useState<Transition[]>([]);
  const editId = useRef(crypto.randomUUID());
  const transitionId = useRef(crypto.randomUUID());
  useEffect(() => {
    let active = true;
    void fetch(`/api/v1/changes/${change.id}/transitions`).then(response => readJson<{ transitions: Transition[] }>(response, '读取状态历史失败。'))
      .then(result => { if (active) setTransitions(result.transitions); })
      .catch(() => { if (active) setError('读取状态历史失败，请返回后重试。'); });
    return () => { active = false; };
  }, [change.id, change.version]);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await readJson(await fetch(`/api/v1/changes/${change.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' },
        body: JSON.stringify({ requestId: editId.current, expectedVersion: editVersion, payload: payload(draft) }) }), '保存草案失败。');
      editId.current = crypto.randomUUID(); setEditing(false);
      try { await refresh(); } catch { setNeedsReload(true); setError('草案已保存，但刷新失败；请返回后重新打开项目。'); }
    } catch (err) { setError(err instanceof ApiError ? err.message : '保存结果未知，可用原内容重试。'); } finally { setBusy(false); }
  }
  async function transition(action: 'cancel' | 'reopen') {
    setBusy(true); setError('');
    try {
      await readJson(await fetch(`/api/v1/changes/${change.id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' },
        body: JSON.stringify({ requestId: transitionId.current, expectedVersion: action === 'cancel' ? cancelVersion : change.version, payload: action === 'cancel' ? { reason } : change.baselineId ? { baselineId: change.baselineId, ...(change.phase === 'Accepted' ? { reason } : {}) } : {} }) }), '操作失败。');
      transitionId.current = crypto.randomUUID(); setCanceling(false); setReason(''); setConfirmBaseline(false);
      try { await refresh(); } catch { setNeedsReload(true); setError('操作已保存，但刷新失败；请返回后重新打开项目。'); }
    } catch (err) { setError(err instanceof ApiError ? err.message : '操作结果未知，可用原内容重试。'); } finally { setBusy(false); }
  }
  const phase = change.phase === 'Draft' ? `草案 · 周期 ${change.cycle}` : change.phase === 'Working' ? `开发中 · 周期 ${change.cycle}` : change.phase === 'Reviewing' ? `审阅中 · 周期 ${change.cycle}` : change.phase === 'Accepted' ? `已验收 · 周期 ${change.cycle}` : '已取消';
  return <section><h4>{change.title}</h4><p>{phase} · 版本 {change.version}</p>
    {error && <p role="alert">{error}</p>}
    <p>{change.goal || '尚未填写目标'}</p>
    {transitions.length > 0 && <details><summary>状态历史</summary><ul>{transitions.map(item => <li key={item.id}>{item.createdAt} · 周期 {item.cycle} · {item.from} → {item.to}{item.reason ? ` · 原因：${item.reason}` : ''}</li>)}</ul></details>}
    {change.phase !== 'Canceled' && !editing && <button disabled={busy || needsReload} onClick={() => { setDraft(fromChange(change)); setEditVersion(change.version); setEditing(true); }}>编辑 {change.title}</button>}
    {editing && <form aria-label="编辑变更" onSubmit={save}><Fields value={draft} disabled={busy || needsReload} onChange={value => { setDraft(value); editId.current = crypto.randomUUID(); }} /><button disabled={busy || needsReload}>保存草案</button></form>}
    {change.phase !== 'Canceled' && !canceling && <button disabled={busy || needsReload} onClick={() => { setCancelVersion(change.version); setCanceling(true); }}>取消变更 {change.title}</button>}
    {canceling && <form onSubmit={event => { event.preventDefault(); void transition('cancel'); }}><label>取消原因<input disabled={busy || needsReload} required value={reason} onChange={event => { setReason(event.target.value); transitionId.current = crypto.randomUUID(); }} /></label><button disabled={busy || needsReload}>确认取消</button></form>}
    {change.phase === 'Canceled' && change.baselineId && <label><input type="checkbox" disabled={busy || needsReload} checked={confirmBaseline} onChange={event => setConfirmBaseline(event.target.checked)} />确认继续采用已有规格基线</label>}
    {change.phase === 'Canceled' && <button disabled={busy || needsReload || (!!change.baselineId && !confirmBaseline)} onClick={() => { void transition('reopen'); }}>重新打开 {change.title}</button>}
    {change.phase === 'Accepted' && !reopenDraft && <button disabled={busy || needsReload} onClick={() => setReopenDraft(true)}>重新打开 {change.title}</button>}
    {reopenDraft && change.phase === 'Accepted' && <form aria-label="重新打开变更" onSubmit={event => { event.preventDefault(); void transition('reopen'); }}><label>重新打开原因<input disabled={busy || needsReload} required value={reason} onChange={event => { setReason(event.target.value); transitionId.current = crypto.randomUUID(); }} /></label><button disabled={busy || needsReload}>确认重新打开</button></form>}
    <button disabled={busy || needsReload} onClick={() => setShowBaseline(value => !value)}>规格 {change.title}</button>
    <WriterSessionPanel change={change} workspaces={workspaces} refresh={refresh} />
    <HandoffPanel change={change} workspaces={workspaces} />
    <EvidencePanel projectId={projectId} change={change} refresh={refresh} />
    {(change.phase === 'Reviewing' || change.phase === 'Accepted' || (change.phase === 'Working' && change.baselineId)) && <ReviewPanel key={change.phase === 'Working' ? 'history' : 'review'} change={change} refresh={refresh} />}
    {showBaseline && <BaselinePanel projectId={projectId} change={change} workspaces={workspaces} refresh={refresh} canAdopt={change.phase !== 'Canceled'} />}
  </section>;
}

export function ChangeDrafts({ projectId, workspaces, onChanged }: { projectId: string; workspaces: Workspace[]; onChanged: () => Promise<void> }) {
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(crypto.randomUUID());
  const refreshSequence = useRef(0);
  async function refresh() {
    const sequence = ++refreshSequence.current;
    try {
      const result = await readJson<{ changes: Change[] }>(await fetch(`/api/v1/projects/${projectId}/changes`), '读取变更失败。');
      if (sequence !== refreshSequence.current) return;
      setChanges(result.changes);
      await onChanged();
    } catch (error) {
      if (sequence === refreshSequence.current) throw error;
    }
  }
  useEffect(() => {
    let active = true;
    void refresh().catch(() => { if (active) setError('读取变更失败，请返回后重试。'); });
    return () => { active = false; refreshSequence.current++; };
  }, [projectId]);
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await readJson(await fetch(`/api/v1/projects/${projectId}/changes`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' },
        body: JSON.stringify({ requestId: requestId.current, expectedVersion: null, payload: payload(draft) }) }), '创建变更失败。');
      requestId.current = crypto.randomUUID(); setDraft(emptyDraft());
      try { await refresh(); } catch { setError('变更已保存，但刷新失败；请返回后重新打开项目。'); }
    } catch (err) { setError(err instanceof ApiError ? err.message : '创建结果未知，可用原内容重试。'); } finally { setBusy(false); }
  }
  return <section id="project-changes"><div className="section-heading"><h3>变更</h3><a href="#new-change">新建变更</a></div>{error && <p role="alert">{error}</p>}
    {changes === null ? (!error && <p>正在读取变更。</p>) : changes.length === 0 ? <p>尚无变更。</p> : changes.map(change => <DraftCard key={change.id} projectId={projectId} change={change} workspaces={workspaces} refresh={refresh} />)}
    <section id="new-change"><h4>新建变更</h4><form aria-label="新建变更" onSubmit={create}><Fields value={draft} disabled={busy} onChange={value => { setDraft(value); requestId.current = crypto.randomUUID(); }} /><button disabled={busy}>创建变更</button></form></section>
  </section>;
}
