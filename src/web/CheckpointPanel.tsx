import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, readJson } from './api';

type Session = { id: string; workspaceId: string; bindingVersion: number; generation: number };
type Change = { id: string; version: number };
type Observation = { id: string; bindingVersion: number; createdAt: string; path: string; stable: boolean };
type Checkpoint = { id: string; createdAt: string; actor: 'user' | 'agent'; goal: string; done: string; failures: string; unverified: string; blockers: string; nextSteps: string; baselineId: string | null; draftRevisionId: string; observationId: string; observationPath: string; observationBindingVersion: number; observationCreatedAt: string; observationStable: boolean; observationLimitations: string[] };
type Context = { sessionId: string; workspaceId: string; bindingVersion: number; generation: number; version: number };
type Draft = { done: string; failures: string; unverified: string; blockers: string; nextSteps: string };
type Pending = { id: string; body: string; context: Context; draft: Draft; observationId: string; createdAt?: string };
type PendingPointer = { id: string; createdAt: string };
// full：本标签页可恢复正文并按原请求重试；pointer：正文已清除，仅可查询回执或确认后清理。
type PendingView = { kind: 'full'; data: Pending } | { kind: 'pointer'; data: PendingPointer };
const empty = (): Draft => ({ done: '', failures: '', unverified: '', blockers: '', nextSteps: '' });
const fields: { key: keyof Draft; label: string }[] = [
  { key: 'done', label: '已完成' }, { key: 'failures', label: '已知失败' }, { key: 'unverified', label: '未验证' }, { key: 'blockers', label: '阻塞项' }, { key: 'nextSteps', label: '下一步' },
];
function storageGet(storage: Storage, key: string): string | null {
  try { return storage.getItem(key); } catch { return null; }
}
function storageRemove(storage: Storage, key: string): boolean {
  try { storage.removeItem(key); return true; } catch { return false; }
}
function storageKeys(storage: Storage, prefix: string): string[] {
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  } catch { return []; }
}
function sessionKey(changeId: string, requestId: string): string {
  return `specmill:pending-checkpoint:${changeId}:${requestId}`;
}
function pointerKey(changeId: string, requestId: string): string {
  return `specmill:pending-checkpoint-request:${changeId}:${requestId}`;
}
function parsePending(text: string | null): Pending | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Pending;
    if (typeof value.id !== 'string' || typeof value.body !== 'string' || !value.context || !value.draft || typeof value.observationId !== 'string') return null;
    if (value.createdAt !== undefined && typeof value.createdAt !== 'string') return null;
    if (fields.some(field => typeof value.draft[field.key] !== 'string')) return null;
    const body = JSON.parse(value.body) as { requestId?: string };
    return body.requestId === value.id ? value : null;
  } catch { return null; }
}
function parsePointer(text: string | null): PendingPointer | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as PendingPointer;
    return typeof value.id === 'string' && typeof value.createdAt === 'string' ? value : null;
  } catch { return null; }
}
function isLaterPending(value: { id: string; createdAt?: string }, latest: { id: string; createdAt?: string }): boolean {
  const valueAt = value.createdAt ?? '';
  const latestAt = latest.createdAt ?? '';
  return valueAt > latestAt || (valueAt === latestAt && value.id > latest.id);
}
function writeFull(changeId: string, pending: Pending): boolean {
  try { sessionStorage.setItem(sessionKey(changeId, pending.id), JSON.stringify(pending)); return true; } catch { return false; }
}
function writePointer(changeId: string, pending: Pending): boolean {
  try { localStorage.setItem(pointerKey(changeId, pending.id), JSON.stringify({ id: pending.id, createdAt: pending.createdAt ?? new Date(0).toISOString() })); return true; } catch { return false; }
}
function readLatestFull(changeId: string): Pending | null {
  const prefix = `specmill:pending-checkpoint:${changeId}:`;
  let latest: Pending | null = null;
  for (const key of storageKeys(sessionStorage, prefix)) {
    const value = parsePending(storageGet(sessionStorage, key));
    if (value && (!latest || isLaterPending(value, latest))) latest = value;
  }
  return latest;
}
function readLatestPointer(changeId: string): PendingPointer | null {
  const prefix = `specmill:pending-checkpoint-request:${changeId}:`;
  let latest: PendingPointer | null = null;
  for (const key of storageKeys(localStorage, prefix)) {
    const value = parsePointer(storageGet(localStorage, key));
    if (value && (!latest || isLaterPending(value, latest))) latest = value;
  }
  return latest;
}
// 旧版把完整正文长期保存在 localStorage；迁移为正文进会话存储、localStorage 只留请求标识指针。
function migratePendingStorage(changeId: string): void {
  const legacyKey = `specmill:pending-checkpoint:${changeId}`;
  const legacy = parsePending(storageGet(localStorage, legacyKey));
  if (legacy && writeFull(changeId, legacy)) {
    writePointer(changeId, legacy);
    storageRemove(localStorage, legacyKey);
  }
  for (const key of storageKeys(localStorage, `${legacyKey}:`)) {
    const value = parsePending(storageGet(localStorage, key));
    if (value && writeFull(changeId, value)) {
      writePointer(changeId, value);
      storageRemove(localStorage, key);
    }
  }
}
function recoverPending(changeId: string): PendingView | null {
  migratePendingStorage(changeId);
  const full = readLatestFull(changeId);
  if (full) return { kind: 'full', data: full };
  const pointer = readLatestPointer(changeId);
  return pointer ? { kind: 'pointer', data: pointer } : null;
}

export function CheckpointPanel({ change, active, sessionReady, refresh }: { change: Change; active: Session | null; sessionReady: boolean; refresh: () => Promise<void> }) {
  const [recovered] = useState(() => recoverPending(change.id));
  const [history, setHistory] = useState<Checkpoint[] | null>(null);
  const [context, setContext] = useState<Context | null>(recovered?.kind === 'full' ? recovered.data.context : null);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [observationSequence, setObservationSequence] = useState(0);
  const [observationId, setObservationId] = useState(recovered?.kind === 'full' ? recovered.data.observationId : '');
  const [draft, setDraft] = useState<Draft>(recovered?.kind === 'full' ? recovered.data.draft : empty);
  const [busy, setBusy] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<PendingView | null>(recovered);
  const [receiptMissing, setReceiptMissing] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const validContext = !!context && !!active && context.sessionId === active.id && context.generation === active.generation && context.bindingVersion === active.bindingVersion && context.version === change.version && sessionReady;
  useEffect(() => {
    let live = true;
    void fetch(`/api/v1/changes/${change.id}/checkpoints`).then(response => readJson<{ checkpoints: Checkpoint[] }>(response, '读取保存点失败。'))
      .then(result => { if (live) setHistory(result.checkpoints); })
      .catch(() => { if (live) setError('读取保存点失败，请返回后重试。'); });
    return () => { live = false; };
  }, [change.id, change.version]);
  useEffect(() => {
    if (!context) return;
    let live = true;
    void fetch(`/api/v1/workspaces/${context.workspaceId}/observations`).then(response => readJson<{ observations: Observation[] }>(response, '读取工作区观察失败。'))
      .then(result => { if (live) setObservations(result.observations.filter(item => item.bindingVersion === context.bindingVersion)); })
      .catch(() => { if (live) setError('读取工作区观察失败，请返回后重试。'); });
    return () => { live = false; };
  }, [context?.workspaceId, context?.bindingVersion, observationSequence]);
  function begin() {
    if (!active || !sessionReady || pending) return;
    if (context && (context.workspaceId !== active.workspaceId || context.bindingVersion !== active.bindingVersion)) setObservationId('');
    setContext({ sessionId: active.id, workspaceId: active.workspaceId, bindingVersion: active.bindingVersion, generation: active.generation, version: change.version });
    requestId.current = crypto.randomUUID();
  }
  function discard(entry: PendingView): PendingView | null {
    try {
      if (entry.kind === 'full') storageRemove(sessionStorage, sessionKey(change.id, entry.data.id));
      storageRemove(localStorage, pointerKey(change.id, entry.data.id));
      return recoverPending(change.id);
    } catch { return entry; }
  }
  async function complete(entry: PendingView) {
    let removed = true;
    try {
      if (entry.kind === 'full') storageRemove(sessionStorage, sessionKey(change.id, entry.data.id));
      if (!storageRemove(localStorage, pointerKey(change.id, entry.data.id))) removed = false;
    } catch { removed = false; }
    // 只清理本请求的记录；若浏览器中还有其他未决请求，恢复最新一条继续核对。
    const next = removed ? recoverPending(change.id) : null;
    requestId.current = crypto.randomUUID();
    if (next) {
      if (next.kind === 'full') { setDraft(next.data.draft); setObservationId(next.data.observationId); setContext(next.data.context); }
      else { setDraft(empty()); setObservationId(''); setContext(null); }
      setPending(next);
    } else {
      setDraft(empty()); setObservationId(''); setContext(null); setPending(null);
    }
    setReceiptMissing(false); setError('');
    setNotice(removed ? (next ? '已确认保存进度；浏览器中还有另一条未决请求，请继续核对。' : '已确认保存进度。') : '已确认保存，但浏览器中的临时副本未能清除，请检查站点数据。');
    try { await refresh(); } catch { setNeedsReload(true); setError('保存点已保存，但刷新失败；请返回后重新打开项目。'); }
  }
  async function attempt(command: Pending, wasPending: boolean) {
    setBusy(true); setError('');
    try {
      const receipt = await readJson<{ requestId?: string; resourceId?: string; recordVersion?: number; committedAt?: string }>(await fetch(`/api/v1/changes/${change.id}/checkpoints`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: command.body }), '保存进度失败。');
      if (receipt.requestId !== command.id || !receipt.resourceId || typeof receipt.recordVersion !== 'number' || !receipt.committedAt) throw new Error('Invalid receipt');
      await complete({ kind: 'full', data: command });
    } catch (err) {
      if (wasPending || !(err instanceof ApiError) || !err.status || err.status >= 500) {
        setPending({ kind: 'full', data: command }); setReceiptMissing(false);
        setError('保存结果未知；请先查询回执或按原请求重试，输入已保留。');
      } else {
        setPending(discard({ kind: 'full', data: command }));
        setError(err.message);
      }
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') { try { await refresh(); } catch { /* preserve the draft */ } }
    } finally { setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!context || !validContext || pending) return;
    const id = requestId.current;
    const command = { id, body: JSON.stringify({ requestId: id, expectedVersion: context.version, writerSessionId: context.sessionId, generation: context.generation, payload: { ...draft, observationId } }), context, draft, observationId, createdAt: new Date().toISOString() };
    // 正文只写进本标签页的会话存储；localStorage 仅保留请求标识指针，用于在标签页关闭后核对结果。
    if (!writePointer(change.id, command)) { setError('无法在浏览器保存请求标识，请检查站点存储设置。'); return; }
    if (!writeFull(change.id, command)) { setError('无法在本标签页保存未决正文，请检查站点存储设置。'); storageRemove(localStorage, pointerKey(change.id, id)); return; }
    setPending({ kind: 'full', data: command });
    await attempt(command, false);
  }
  async function checkReceipt() {
    if (!pending) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/v1/receipts/${encodeURIComponent(pending.data.id)}`);
      if (response.status === 404) {
        setReceiptMissing(true);
        setError(pending.kind === 'full' ? '目前没有找到回执；原请求仍可能在途，可按原请求重试。' : '目前没有找到回执；原请求仍可能在途，请稍后再查询。');
        return;
      }
      const receipt = await readJson<{ requestId?: string; resourceId?: string; recordVersion?: number; committedAt?: string }>(response, '查询回执失败。');
      if (receipt.requestId !== pending.data.id || !receipt.resourceId || typeof receipt.recordVersion !== 'number' || !receipt.committedAt) throw new Error('Invalid receipt');
      await complete(pending);
    } catch { setError('无法确认保存结果，请稍后查询或按原请求重试。'); } finally { setBusy(false); }
  }
  return <section><h5>续做保存点</h5>{error && <p role="alert">{error}</p>}
    <p role="status">{notice}</p>
    <p>保存工作台记录不等于备份源码或完成验收。</p>
    {history === null ? <p>正在读取保存点。</p> : history.length === 0 ? <p>尚无保存点，可在关键节点记录进度。</p> : <details><summary>保存点历史（{history.length}）</summary>{history.map(item => <article key={item.id}><p>{item.createdAt} · {item.actor === 'user' ? '用户' : '工具'} · {item.baselineId ? `冻结基线 ${item.baselineId}` : `未确认草案修订 ${item.draftRevisionId}`}</p><p>观察：{item.observationCreatedAt} · {item.observationPath} · 绑定版本 {item.observationBindingVersion} · {item.observationId} {item.observationStable ? '' : '（观察不稳定）'}</p><ul>{item.observationLimitations.map((value, index) => <li key={index}>{value}</li>)}</ul><p>目标：{item.goal.trim() ? item.goal : '尚未填写'}</p><p>已完成：{item.done}</p><p>失败：{item.failures}</p><p>未验证：{item.unverified}</p><p>阻塞：{item.blockers}</p><p>下一步：{item.nextSteps}</p></article>)}</details>}
    {!context && <button disabled={!active || !sessionReady || needsReload || !!pending} onClick={begin}>填写保存点</button>}
    {pending && <div>{pending.kind === 'full'
      ? <p>待确认请求：{pending.data.id}。正文只保存在本标签页的会话存储中，关闭标签页即清除；本浏览器另保留请求标识用于核对结果，确认后清除。不包含写授权凭据。</p>
      : <p>待确认请求：{pending.data.id}。该请求的正文未保留，本浏览器只保留请求标识用于核对结果，不包含写授权凭据。</p>}
      <button type="button" disabled={busy} onClick={() => { void checkReceipt(); }}>查询保存回执</button>
      {pending.kind === 'full' && <button type="button" disabled={busy} onClick={() => { void attempt(pending.data, true); }}>按原请求重试</button>}
      {receiptMissing && <button type="button" disabled={busy} onClick={() => { const next = discard(pending); setPending(next); setReceiptMissing(false); setError(next === pending ? '无法清理浏览器临时记录，请稍后重试。' : pending.kind === 'full' ? '请确认原请求已结束，核对后再使用新版本保存。' : '已清理该请求的浏览器记录，请核对后再使用新版本保存。'); }}>{pending.kind === 'full' ? '确认原请求已结束并重新核对' : '确认原请求已结束并清理'}</button>}</div>}
    {context && <form aria-label="保存点" onSubmit={save}><p>没有相关内容时请填写“无”或“未知”。</p>
      {!validContext && <p role="alert">会话或变更版本已变化，输入仍保留；请先核对最新状态。</p>}
      {!validContext && !pending && active && sessionReady && <button type="button" onClick={begin}>已核对，使用当前会话与版本</button>}
      <label>工作区观察<select disabled={busy || needsReload || !!pending} required value={observationId} onChange={event => { setObservationId(event.target.value); requestId.current = crypto.randomUUID(); }}><option value="">请选择观察记录</option>{observations.map(item => <option key={item.id} value={item.id}>{item.createdAt} · {item.path}{item.stable ? '' : '（观察不稳定）'}</option>)}</select></label>
      <button type="button" disabled={busy || needsReload} onClick={() => setObservationSequence(value => value + 1)}>刷新观察列表</button>
      {observations.length === 0 && <p>请先在工作区执行观察，再刷新观察列表。</p>}
      {fields.map(field => <label key={field.key}>{field.label}<textarea required disabled={busy || needsReload || !!pending} value={draft[field.key]} onChange={event => { setDraft({ ...draft, [field.key]: event.target.value }); requestId.current = crypto.randomUUID(); }} /></label>)}
      <button disabled={busy || needsReload || !!pending || !validContext || !observationId}>保存进度</button></form>}
  </section>;
}
