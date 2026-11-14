import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, readJson } from './api';

type Session = { id: string; workspaceId: string; bindingVersion: number; generation: number };
type Change = { id: string; version: number };
type Observation = { id: string; bindingVersion: number; createdAt: string; path: string; stable: boolean };
type Checkpoint = { id: string; createdAt: string; actor: 'user' | 'agent'; goal: string; done: string; failures: string; unverified: string; blockers: string; nextSteps: string; baselineId: string | null; draftRevisionId: string; observationId: string; observationPath: string; observationBindingVersion: number; observationCreatedAt: string; observationStable: boolean; observationLimitations: string[] };
type Context = { sessionId: string; workspaceId: string; bindingVersion: number; generation: number; version: number };
type Draft = { done: string; failures: string; unverified: string; blockers: string; nextSteps: string };
type Pending = { id: string; body: string; context: Context; draft: Draft; observationId: string; createdAt?: string };
const empty = (): Draft => ({ done: '', failures: '', unverified: '', blockers: '', nextSteps: '' });
const fields: { key: keyof Draft; label: string }[] = [
  { key: 'done', label: '已完成' }, { key: 'failures', label: '已知失败' }, { key: 'unverified', label: '未验证' }, { key: 'blockers', label: '阻塞项' }, { key: 'nextSteps', label: '下一步' },
];
function pendingKey(changeId: string, requestId: string): string {
  return `specmill:pending-checkpoint:${changeId}:${requestId}`;
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
function isLaterPending(value: Pending, latest: Pending): boolean {
  const valueAt = value.createdAt ?? '';
  const latestAt = latest.createdAt ?? '';
  return valueAt > latestAt || (valueAt === latestAt && value.id > latest.id);
}
// 每个未决请求使用独立的存储键：同一变更的多个标签页互不覆盖，确认后也只清理自身记录。
function readLatestPending(changeId: string): Pending | null {
  const legacyKey = `specmill:pending-checkpoint:${changeId}`;
  try {
    const legacy = parsePending(localStorage.getItem(legacyKey));
    if (legacy) {
      let migrated = false;
      try { localStorage.setItem(pendingKey(changeId, legacy.id), JSON.stringify({ ...legacy, createdAt: legacy.createdAt ?? new Date(0).toISOString() })); migrated = true; } catch { /* 无法写入新键时保留旧副本 */ }
      if (migrated) { try { localStorage.removeItem(legacyKey); } catch { /* 迁移副本已可用 */ } }
    }
  } catch { /* 站点存储不可用时跳过迁移 */ }
  let latest: Pending | null = null;
  try {
    const prefix = `${legacyKey}:`;
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(prefix)) continue;
      const value = parsePending(localStorage.getItem(key));
      if (value && (!latest || isLaterPending(value, latest))) latest = value;
    }
  } catch { /* 站点存储不可用时无法恢复 */ }
  return latest;
}

export function CheckpointPanel({ change, active, sessionReady, refresh }: { change: Change; active: Session | null; sessionReady: boolean; refresh: () => Promise<void> }) {
  const [recovered] = useState(() => readLatestPending(change.id));
  const [history, setHistory] = useState<Checkpoint[] | null>(null);
  const [context, setContext] = useState<Context | null>(recovered?.context ?? null);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [observationSequence, setObservationSequence] = useState(0);
  const [observationId, setObservationId] = useState(recovered?.observationId ?? '');
  const [draft, setDraft] = useState<Draft>(recovered?.draft ?? empty);
  const [busy, setBusy] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<Pending | null>(recovered);
  const [receiptMissing, setReceiptMissing] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const validContext = !!context && !!active && context.sessionId === active.id && context.generation === active.generation && context.bindingVersion === active.bindingVersion && context.version === change.version && sessionReady;
  function discard(command: Pending): Pending | null {
    try { localStorage.removeItem(pendingKey(change.id, command.id)); return readLatestPending(change.id); }
    catch { return command; }
  }
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
  async function complete(command: Pending) {
    let removed = true;
    try { localStorage.removeItem(pendingKey(change.id, command.id)); } catch { removed = false; }
    // 只清理本请求的记录；若浏览器中还有其他未决请求，恢复最新一条继续核对。
    const next = removed ? readLatestPending(change.id) : null;
    requestId.current = crypto.randomUUID();
    if (next) {
      setDraft(next.draft); setObservationId(next.observationId); setContext(next.context); setPending(next);
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
      await complete(command);
    } catch (err) {
      if (wasPending || !(err instanceof ApiError) || !err.status || err.status >= 500) {
        setPending(command); setReceiptMissing(false);
        setError('保存结果未知；请先查询回执或按原请求重试，输入已保留。');
      } else {
        setPending(discard(command));
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
    try { localStorage.setItem(pendingKey(change.id, id), JSON.stringify(command)); }
    catch { setError('无法在浏览器临时保存未决请求，请检查站点存储设置。'); return; }
    setPending(command);
    await attempt(command, false);
  }
  async function checkReceipt() {
    if (!pending) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/v1/receipts/${encodeURIComponent(pending.id)}`);
      if (response.status === 404) { setReceiptMissing(true); setError('目前没有找到回执；原请求仍可能在途，可按原请求重试。'); return; }
      const receipt = await readJson<{ requestId?: string; resourceId?: string; recordVersion?: number; committedAt?: string }>(response, '查询回执失败。');
      if (receipt.requestId !== pending.id || !receipt.resourceId || typeof receipt.recordVersion !== 'number' || !receipt.committedAt) throw new Error('Invalid receipt');
      await complete(pending);
    } catch { setError('无法确认保存结果，请稍后查询或按原请求重试。'); } finally { setBusy(false); }
  }
  return <section><h5>续做保存点</h5>{error && <p role="alert">{error}</p>}
    {notice && <p>{notice}</p>}
    <p>保存工作台记录不等于备份源码或完成验收。</p>
    {history === null ? <p>正在读取保存点。</p> : history.length === 0 ? <p>尚无保存点，可在关键节点记录进度。</p> : <details><summary>保存点历史（{history.length}）</summary>{history.map(item => <article key={item.id}><p>{item.createdAt} · {item.actor === 'user' ? '用户' : '工具'} · {item.baselineId ? `冻结基线 ${item.baselineId}` : `未确认草案修订 ${item.draftRevisionId}`}</p><p>观察：{item.observationCreatedAt} · {item.observationPath} · 绑定版本 {item.observationBindingVersion} · {item.observationId} {item.observationStable ? '' : '（观察不稳定）'}</p><ul>{item.observationLimitations.map((value, index) => <li key={index}>{value}</li>)}</ul><p>目标：{item.goal.trim() ? item.goal : '尚未填写'}</p><p>已完成：{item.done}</p><p>失败：{item.failures}</p><p>未验证：{item.unverified}</p><p>阻塞：{item.blockers}</p><p>下一步：{item.nextSteps}</p></article>)}</details>}
    {!context && <button disabled={!active || !sessionReady || needsReload} onClick={begin}>填写保存点</button>}
    {context && <form aria-label="保存点" onSubmit={save}><p>没有相关内容时请填写“无”或“未知”。</p>
      {!validContext && <p role="alert">会话或变更版本已变化，输入仍保留；请先核对最新状态。</p>}
      {!validContext && !pending && active && sessionReady && <button type="button" onClick={begin}>已核对，使用当前会话与版本</button>}
      {pending && <div><p>待确认请求：{pending.id}。正文临时保存在本浏览器，确认结果后清除；不包含写授权凭据。</p><button type="button" disabled={busy} onClick={() => { void checkReceipt(); }}>查询保存回执</button><button type="button" disabled={busy} onClick={() => { void attempt(pending, true); }}>按原请求重试</button>{receiptMissing && <button type="button" disabled={busy} onClick={() => { const next = discard(pending); setPending(next); setReceiptMissing(false); setError(next === pending ? '无法清理浏览器临时记录，请稍后重试。' : '请确认原请求已结束，核对后再使用新版本保存。'); }}>确认原请求已结束并重新核对</button>}</div>}
      <label>工作区观察<select disabled={busy || needsReload || !!pending} required value={observationId} onChange={event => { setObservationId(event.target.value); requestId.current = crypto.randomUUID(); }}><option value="">请选择观察记录</option>{observations.map(item => <option key={item.id} value={item.id}>{item.createdAt} · {item.path}{item.stable ? '' : '（观察不稳定）'}</option>)}</select></label>
      <button type="button" disabled={busy || needsReload} onClick={() => setObservationSequence(value => value + 1)}>刷新观察列表</button>
      {observations.length === 0 && <p>请先在工作区执行观察，再刷新观察列表。</p>}
      {fields.map(field => <label key={field.key}>{field.label}<textarea required disabled={busy || needsReload || !!pending} value={draft[field.key]} onChange={event => { setDraft({ ...draft, [field.key]: event.target.value }); requestId.current = crypto.randomUUID(); }} /></label>)}
      <button disabled={busy || needsReload || !!pending || !validContext || !observationId}>保存进度</button></form>}
  </section>;
}
