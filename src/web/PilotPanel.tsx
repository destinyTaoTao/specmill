import { useEffect, useRef, useState } from 'react';
import type { PilotDetail, PilotSummary } from '../server/pilot/ledger.js';
import { ApiError, readJson } from './api';

const runsUrl = '/api/v1/pilot/runs';
const pendingKey = 'specmill:pilot:pending-command';
const states = {
  draft: '待冻结规格', queued: '等待 Worker 领取', running: 'Worker 执行中',
  review: '待人工审阅', archived: '已验收归档', blocked: '已停止调度',
};
const actions: Record<string, string> = {
  create: '创建试运行', freeze: '冻结规格', claim: '领取任务', finish: '交回结果',
  interrupt: '记录执行中断', return: '退回返工', accept: '验收归档',
};
type Decision = 'freeze' | 'return' | 'accept';
type Command = { action: 'create'; requestId: string }
  | { action: Decision; requestId: string; runId: string; version: number; reason: string };

function readPending(): Command | null {
  try {
    const item = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null');
    if (!item || typeof item.requestId !== 'string') return null;
    if (item.action === 'create') return { action: 'create', requestId: item.requestId };
    if (!['freeze', 'return', 'accept'].includes(item.action) || typeof item.runId !== 'string'
      || !Number.isSafeInteger(item.version) || typeof item.reason !== 'string') return null;
    return item;
  } catch { return null; }
}

function RunEvidence({ run }: { run: PilotDetail }) {
  return <>
    <h4>{run.status === 'draft' ? '待冻结规格' : '冻结规格'} · {run.spec.title}</h4>
    <p>模板修订 {run.templateRevision}</p>
    {run.spec.research && <dl>
      <dt>调研来源</dt><dd>{run.spec.research.source}</dd>
      <dt>业务口径</dt><dd>{run.spec.research.finding}</dd>
      <dt>本次范围</dt><dd>{run.spec.research.scope}</dd>
    </dl>}
    {run.frozenBaseline && <p>规格已在版本 {run.frozenBaseline.version} 冻结 · {run.frozenBaseline.frozenAt}<br />
      SHA-256 <code>{run.frozenBaseline.specSha256}</code></p>}
    <p>{run.spec.queryContract}</p>
    <ul>{run.spec.criteria.map(criterion => <li key={criterion.name}>
      <strong>{criterion.name}</strong> · {criterion.description} · 预期订单 ID {JSON.stringify(criterion.expected)}
    </li>)}</ul>
    {run.attempts.map(attempt => <section key={attempt.id} aria-label={`执行尝试 ${attempt.generation}`}>
      <h4>第 {attempt.generation} 次尝试 · {attempt.status === 'running' ? '执行中' : attempt.status === 'interrupted' ? '已中断' : '已交回'}</h4>
      <p>尝试 ID <code>{attempt.id}</code> · 开始于 {attempt.startedAt}</p>
      {attempt.reason && <p>本次执行依据 · {attempt.reason}</p>}
      {attempt.interruptionReason && <p>中断原因 · {attempt.interruptionReason}</p>}
      {attempt.result && <>
        {attempt.result.error && <p>执行失败 · {attempt.result.error}</p>}
        {attempt.result.commit && <p>测试提交 <code>{attempt.result.commit}</code></p>}
        {attempt.result.sql && <><h5>交付的 SQL</h5><pre><code>{attempt.result.sql}</code></pre></>}
        {attempt.result.checks.length > 0 && <ul>{attempt.result.checks.map(check => <li key={check.name}>
          <strong>{check.name} · {check.passed ? '通过' : '失败'}</strong>
          <p>预期 {JSON.stringify(check.expected)}，实际 {JSON.stringify(check.actual)}</p>
        </li>)}</ul>}
      </>}
    </section>)}
    <details><summary>操作记录（{run.events.length}）</summary><ol>{run.events.map(event => <li key={event.version}>
      {actions[event.action] ?? event.action} · {event.actor} · {event.at} · 版本 {event.version}
      {event.reason && <p>{event.reason}</p>}
    </li>)}</ol></details>
  </>;
}

function DecisionForm({ run, locked, decide }: {
  run: PilotDetail; locked: boolean; decide: (action: Decision, reason: string) => void;
}) {
  const draft = run.status === 'draft';
  const [action, setAction] = useState<Decision>(draft ? 'freeze' : run.canAccept ? 'accept' : 'return');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  if (!draft && run.status !== 'review') return null;
  const canSubmit = !locked && confirmed && (action === 'freeze' || Boolean(reason.trim())) && (action !== 'accept' || run.canAccept);
  return <form aria-label="人工决定" onSubmit={event => { event.preventDefault(); if (canSubmit) decide(action, reason.trim()); }}>
    {draft ? <p>冻结后，Worker 将把合成规格交给编码 Agent。冻结说明保存在本机审计记录中。</p> : <>
      {!run.canAccept && <p>当前尝试缺少完整通过的验收证据。请查看执行结果并退回处理。</p>}
      <label>审阅决定<select disabled={locked} value={action} onChange={event => { setAction(event.target.value as Decision); setConfirmed(false); }}>
        <option value="accept" disabled={!run.canAccept}>验收归档</option><option value="return">退回返工</option>
      </select></label>
      {action === 'return' && <p>{run.returnWillBlock ? '已达到返工上限，确认退回将结束本次运行。' : '确认退回后，Worker 将根据本次意见重新执行。'}</p>}
    </>}
    <label>{draft ? '冻结说明（选填）' : action === 'return' ? '返工意见（重新执行时交给编码 Agent）' : '验收理由'}
      <textarea disabled={locked} value={reason} required={!draft} maxLength={1000} onChange={event => { setReason(event.target.value); setConfirmed(false); }} />
    </label>
    <label><input type="checkbox" disabled={locked} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
      {draft ? '我已核对规格与预期结果，同意冻结并开始执行' : `我已核对版本 ${run.version} 的执行证据，确认${actions[action]}`}</label>
    <button disabled={!canSubmit}>{actions[action]}</button>
  </form>;
}

export function PilotPanel() {
  const [pending, setPending] = useState<Command | null>(readPending);
  const [selected, setSelected] = useState<string | null>(() => pending && pending.action !== 'create' ? pending.runId : null);
  const [runs, setRuns] = useState<PilotSummary[] | null>(null);
  const [run, setRun] = useState<PilotDetail | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [revision, setRevision] = useState(0);
  const [readError, setReadError] = useState('');
  const [commandError, setCommandError] = useState('');
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    let polling = false;
    async function refresh() {
      try {
        const response = await fetch(runsUrl);
        if (!live) return;
        if (response.status === 404) { setEnabled(false); return; }
        const list = await readJson<{ runs: PilotSummary[] }>(response, '无法读取试运行列表。');
        if (!live) return;
        setEnabled(true); setRuns(list.runs);
        const id = list.runs.find(item => item.id === selected)?.id ?? list.runs[0]?.id ?? null;
        if (id !== selected) { setRun(null); setSelected(id); return; }
        if (id) {
          const detail = await readJson<PilotDetail>(await fetch(`${runsUrl}/${encodeURIComponent(id)}`), '无法读取试运行详情。');
          if (!live) return;
          setRun(detail);
          polling = detail.status === 'running' || detail.status === 'queued';
        } else { setRun(null); polling = false; }
        setReadError('');
      } catch (error) {
        if (live) setReadError(error instanceof ApiError ? error.message : '无法连接试点服务，请检查服务状态。');
      } finally { if (live && polling) timer = setTimeout(() => { void refresh(); }, 1200); }
    }
    void refresh();
    return () => { live = false; clearTimeout(timer); };
  }, [selected, revision]);

  async function submit(command: Command) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true); setCommandError(''); setPending(command);
    let stored = true;
    try { sessionStorage.setItem(pendingKey, JSON.stringify(command)); } catch { stored = false; }
    const create = command.action === 'create';
    const url = create ? runsUrl : `${runsUrl}/${encodeURIComponent(command.runId)}/decisions`;
    const payload = create ? { requestId: command.requestId }
      : { requestId: command.requestId, action: command.action, version: command.version, reason: command.reason };
    try {
      const receipt = await readJson<{ id: string }>(await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify(payload),
      }), '试运行操作失败。');
      if (!receipt?.id) throw new Error('缺少回执。');
      setRun(null); setSelected(receipt.id); setRevision(value => value + 1);
    } catch (error) {
      if (pending && error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        setCommandError('当前会话无法核对回执，请重新登录后重试原请求。');
        return;
      }
      if (!(error instanceof ApiError) || (error.status ?? 500) >= 500) {
        setCommandError('提交结果未知，请重试原请求以核对回执。' + (stored ? '' : ' 浏览器无法暂存请求，请保留当前页面。'));
        return;
      }
      setCommandError(error.message); setRun(null); setRevision(value => value + 1);
    } finally { sending.current = false; setBusy(false); }
    setPending(null);
    try {
      if (readPending()?.requestId === command.requestId) sessionStorage.removeItem(pendingKey);
    } catch { /* A retained request can safely be replayed. */ }
  }
  if (enabled === false || (enabled === null && !readError)) return null;
  const locked = busy || pending !== null;
  return <section aria-label="团队工作流试点">
    <div className="section-heading"><h2>团队工作流试点</h2>
      <button disabled={locked || !enabled || Boolean(readError)} onClick={() => { void submit({ action: 'create', requestId: crypto.randomUUID() }); }}>新建订单筛选试运行</button>
    </div>
    {readError && <p role="alert">{readError}</p>}
    {commandError && <p role="alert">{commandError}</p>}
    {pending && !busy && <div><p>待核对的操作 · {actions[pending.action]} · 请求 {pending.requestId}</p>
      <button onClick={() => { void submit(pending); }}>重试原请求</button></div>}
    {runs?.length === 0 && <p className="empty-state">尚无试运行。</p>}
    {Boolean(runs?.length) && <label>查看试运行<select disabled={locked} value={selected ?? ''} onChange={event => {
      setRun(null); setCommandError(''); setSelected(event.target.value);
    }}>{runs?.map(item => <option key={item.id} value={item.id}>{item.createdAt} · {states[item.status]} · {item.id.slice(0, 8)}</option>)}</select></label>}
    <button disabled={busy} onClick={() => { setRun(null); setRevision(value => value + 1); }}>刷新试运行状态</button>
    {run && <><p role="status">{states[run.status]} · 版本 {run.version}</p>
      <RunEvidence run={run} />
      <DecisionForm key={`${run.id}:${run.version}`} run={run} locked={locked || Boolean(readError)} decide={(action, reason) => {
        void submit({ action, reason, version: run.version, runId: run.id, requestId: crypto.randomUUID() });
      }} />
      {run.status === 'blocked' && <p>本次运行已停止，请核对操作记录与中断原因。</p>}
      {run.status === 'archived' && <a href={`${runsUrl}/${encodeURIComponent(run.id)}/archive`} download>下载验收归档（JSON）</a>}
    </>}
  </section>;
}
