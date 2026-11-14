import { useEffect, useRef, useState } from 'react';
import { ApiError, readJson } from './api';

type Change = { id: string; phase: string; version: number; baselineId: string | null };
type ReviewData = {
  context: { cycle: number; baselineId: string; criterionRevisionId: string; target: { id: string; commitSha: string; status: string; confirmedAt: string } | null; phase: string };
  criteria: { criterionId: string; index: number; text: string; decision: { result: string; reason: string; evidenceIds: string[]; createdAt: string } | null; blockingFailures: { id: string; actualCommit: string | null; notes: string }[]; evidence: { id: string; actualCommit: string | null; formal: boolean; healthy: boolean; matchesTarget: boolean; createdAt: string }[] }[];
  accepted: boolean;
};
type SelectionMap = Record<string, { mode: 'new' | 'reuse'; evidenceId: string; reuseReason: string }>;

export function ReviewPanel({ change, refresh }: { change: Change; refresh: () => Promise<void> }) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [selections, setSelections] = useState<SelectionMap>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [previewId, setPreviewId] = useState('');
  const [waiving, setWaiving] = useState('');
  const [waiveReason, setWaiveReason] = useState('');
  const [dispositionFor, setDispositionFor] = useState('');
  const [dispositionOutcome, setDispositionOutcome] = useState<'resolved' | 'not_applicable'>('resolved');
  const [dispositionEvidence, setDispositionEvidence] = useState('');
  const [dispositionReason, setDispositionReason] = useState('');
  const requestId = useRef(crypto.randomUUID());
  const reload = async () => {
    const result = await readJson<ReviewData>(await fetch(`/api/v1/changes/${change.id}/review`), '读取审阅状态失败。');
    setData(result);
    setSelections(previous => {
      const next: SelectionMap = {};
      for (const criterion of result.criteria) {
        const prior = previous[criterion.criterionId];
        const usable = criterion.evidence.find(item => item.healthy && item.formal);
        if (prior) {
          // 上下文变化后重算确认模式；保留用户已选的证据与理由。
          const chosen = criterion.evidence.find(item => item.id === prior.evidenceId) ?? usable;
          const mode = chosen ? (chosen.matchesTarget ? 'new' : 'reuse') : prior.mode;
          next[criterion.criterionId] = { mode, evidenceId: prior.evidenceId, reuseReason: prior.reuseReason };
          continue;
        }
        if (usable) next[criterion.criterionId] = { mode: usable.matchesTarget ? 'new' : 'reuse', evidenceId: usable.id, reuseReason: '' };
      }
      return next;
    });
  };
  useEffect(() => {
    let live = true;
    void reload().catch(() => { if (live) setError('读取审阅状态失败，请返回后重试。'); });
    // 目标确认发生在证据面板：通过事件通知本面板重新读取审阅状态。
    const onExternalRefresh = () => { void reload().catch(() => {}); };
    window.addEventListener('specmill:review-refresh', onExternalRefresh);
    return () => { live = false; window.removeEventListener('specmill:review-refresh', onExternalRefresh); };
  }, [change.id, change.version]);
  const selectedRows = () => Object.entries(selections).filter(([, value]) => value.evidenceId !== '').map(([criterionId, value]) => ({
    criterionId, mode: value.mode, evidenceIds: [value.evidenceId], ...(value.mode === 'reuse' ? { reuseReason: value.reuseReason } : {}),
  }));
  async function runPreview() {
    setBusy(true); setError(''); setNotice(''); setPreviewId('');
    try {
      const receipt = await readJson<{ resourceId: string }>(await fetch(`/api/v1/changes/${change.id}/review/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify({ requestId: requestId.current, payload: { selections: selectedRows() } }) }), '生成确认预览失败。');
      requestId.current = crypto.randomUUID();
      setPreviewId(receipt.resourceId);
      setNotice('确认预览已生成；确认前如证据或失败处置发生变化，预览会过期。');
    } catch (err) { setError(err instanceof ApiError ? err.message : '预览结果未知，可重试。'); } finally { setBusy(false); }
  }
  async function confirmReview(complete: boolean) {
    setBusy(true); setError(''); setNotice('');
    try {
      await readJson(await fetch(`/api/v1/changes/${change.id}/review/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify({ requestId: requestId.current, payload: { previewId, complete } }) }), '确认失败。');
      requestId.current = crypto.randomUUID(); setPreviewId('');
      try { await refresh(); await reload(); } catch { setNeedsReload(); }
      setNotice(complete ? '已完成冻结版本验收。' : '已确认所选条件。');
    } catch (err) { setError(err instanceof ApiError ? err.message : '确认结果未知，可重试。'); } finally { setBusy(false); }
  }
  function setNeedsReload() { setError('已保存，但刷新失败；请返回后重新打开项目。'); }
  async function waive(criterionId: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      await readJson(await fetch(`/api/v1/changes/${change.id}/review/waive`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify({ requestId: requestId.current, expectedVersion: change.version, payload: { criterionId, reason: waiveReason, failureEvidenceIds: data?.criteria.find(item => item.criterionId === criterionId)?.blockingFailures.map(item => item.id) } }) }), '风险豁免失败。');
      requestId.current = crypto.randomUUID(); setWaiving(''); setWaiveReason('');
      try { await refresh(); await reload(); } catch { setNeedsReload(); }
      setNotice('已记录风险豁免。');
    } catch (err) { setError(err instanceof ApiError ? err.message : '豁免结果未知，可重试。'); } finally { setBusy(false); }
  }
  async function submitDisposition() {
    if (!dispositionFor) return;
    const criterion = data?.criteria.find(item => item.criterionId === dispositionFor);
    const failure = criterion?.blockingFailures[0];
    if (!failure) { setError('该条件已无待处置失败。'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const previewReceipt = await readJson<{ resourceId: string }>(await fetch(`/api/v1/changes/${change.id}/review/failure-dispositions/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify({ requestId: requestId.current, expectedVersion: change.version, payload: { rows: [{ criterionId: dispositionFor, failureEvidenceId: failure.id, outcome: dispositionOutcome, ...(dispositionOutcome === 'resolved' ? { supportingEvidenceIds: dispositionEvidence ? [dispositionEvidence] : [] } : {}), reason: dispositionReason }] } }) }), '处置预览失败。');
      requestId.current = crypto.randomUUID();
      await readJson(await fetch(`/api/v1/changes/${change.id}/review/failure-dispositions/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify({ requestId: requestId.current, payload: { previewId: previewReceipt.resourceId } }) }), '处置确认失败。');
      try { await refresh(); await reload(); } catch { setNeedsReload(); }
      setNotice('失败处置已记录。');
    } catch (err) { setError(err instanceof ApiError ? err.message : '处置结果未知，可重试。'); } finally { setBusy(false); }
  }
  async function continueWorking() {
    setBusy(true); setError(''); setNotice('');
    try {
      await readJson(await fetch(`/api/v1/changes/${change.id}/review/continue`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify({ requestId: requestId.current, expectedVersion: change.version }) }), '继续实现失败。');
      requestId.current = crypto.randomUUID();
      try { await refresh(); await reload(); } catch { setNeedsReload(); }
      setNotice('已回到开发阶段；历史证据与决定保留。');
    } catch (err) { setError(err instanceof ApiError ? err.message : '操作结果未知，可重试。'); } finally { setBusy(false); }
  }
  const decidedOrWaived = (criterionId: string) => data?.criteria.find(item => item.criterionId === criterionId)?.decision;
  return <section><h5>验收审阅</h5>{error && <p role="alert">{error}</p>}{notice && <p>{notice}</p>}
    {data === null ? <p>正在读取审阅状态。</p> : <>
      <p>审阅上下文：周期 {data.context.cycle} · 冻结基线 {data.context.baselineId.slice(0, 8)}… · 实现目标 {data.context.target ? `${data.context.target.commitSha.slice(0, 12)}…（${data.context.target.status === 'confirmed' ? '已确认' : '候选'}）` : '尚未确认'}</p>
      <ul>{data.criteria.map(criterion => {
        const selection = selections[criterion.criterionId];
        const decision = decidedOrWaived(criterion.criterionId);
        return <li key={criterion.criterionId}>
          <p>条件 {criterion.index}：{criterion.text}{decision ? ` · ${decision.result === 'waived' ? '已豁免' : '已确认通过'}（${decision.createdAt}）` : criterion.blockingFailures.length > 0 ? ` · 被未处置失败阻塞（${criterion.blockingFailures.length} 项）` : ' · 待确认'}</p>
          {decision && <p>决定：{decision.reason} · 引用证据 {decision.evidenceIds.length} 项</p>}
          {!decision && change.phase === 'Reviewing' && criterion.evidence.length > 0 && <div>
            <label>选择证据<select disabled={busy} value={selection?.evidenceId ?? ''} onChange={event => setSelections(previous => ({ ...previous, [criterion.criterionId]: { mode: previous[criterion.criterionId]?.mode ?? 'new', evidenceId: event.target.value, reuseReason: previous[criterion.criterionId]?.reuseReason ?? '' } }))}><option value="">不确认此条件</option>{criterion.evidence.map(item => <option key={item.id} value={item.id}>{item.id.slice(0, 8)}… · 版本 {item.actualCommit?.slice(0, 10) ?? '未声明'}{item.matchesTarget ? '（与目标一致）' : '（历史版本，需复用理由）'}</option>)}</select></label>
            {selection && selection.evidenceId !== '' && <label>确认模式<select disabled={busy} value={selection.mode} onChange={event => setSelections(previous => ({ ...previous, [criterion.criterionId]: { ...previous[criterion.criterionId], mode: event.target.value as 'new' | 'reuse' } }))}><option value="new">当前版本核对通过</option><option value="reuse">复用历史证据（需说明理由）</option></select></label>}
            {selection && selection.mode === 'reuse' && <label>复用理由<input disabled={busy} value={selection.reuseReason} onChange={event => setSelections(previous => ({ ...previous, [criterion.criterionId]: { ...previous[criterion.criterionId], reuseReason: event.target.value } }))} /> </label>}
          </div>}
          {criterion.blockingFailures.length > 0 && change.phase === 'Reviewing' && <div><p>未处置失败：{criterion.blockingFailures.map(item => <span key={item.id}> {item.id.slice(0, 8)}…（版本 {item.actualCommit?.slice(0, 10) ?? '未声明'}）</span>)}</p>
            {dispositionFor === criterion.criterionId ? <div>
              <label>处置方式<select disabled={busy} value={dispositionOutcome} onChange={event => setDispositionOutcome(event.target.value as 'resolved' | 'not_applicable')}><option value="resolved">已解决（需补测证据）</option><option value="not_applicable">不适用（需说明依据）</option></select></label>
              {dispositionOutcome === 'resolved' && <label>补测证据<select disabled={busy} value={dispositionEvidence} onChange={event => setDispositionEvidence(event.target.value)}><option value="">请选择</option>{criterion.evidence.filter(item => item.healthy && item.formal && item.matchesTarget).map(item => <option key={item.id} value={item.id}>{item.id.slice(0, 8)}…</option>)}</select></label>}
              <label>理由或依据<input disabled={busy} value={dispositionReason} onChange={event => setDispositionReason(event.target.value)} /></label>
              <button disabled={busy || !dispositionReason.trim()} onClick={() => { void submitDisposition(); }}>确认处置</button>
              <button disabled={busy} onClick={() => setDispositionFor('')}>取消</button>
            </div> : <button disabled={busy} onClick={() => { setDispositionFor(criterion.criterionId); setDispositionOutcome('resolved'); setDispositionEvidence(''); setDispositionReason(''); }}>处置失败</button>}
            {waiving !== criterion.criterionId && <button disabled={busy} onClick={() => { setWaiving(criterion.criterionId); setWaiveReason(''); }}>风险豁免</button>}
            {waiving === criterion.criterionId && <div><label>豁免理由与影响<input disabled={busy} value={waiveReason} onChange={event => setWaiveReason(event.target.value)} /></label><button disabled={busy || !waiveReason.trim()} onClick={() => { void waive(criterion.criterionId); }}>确认豁免</button><button disabled={busy} onClick={() => setWaiving('')}>取消</button></div>}
          </div>}
        </li>;
      })}</ul>
      {change.phase === 'Reviewing' && data.context.target && <div>
        <button disabled={busy || selectedRows().length === 0} onClick={() => { void runPreview(); }}>生成确认预览</button>
        {previewId !== '' && <div><p>预览 {previewId.slice(0, 8)}… 已生成（绑定当前版本与证据集合）。</p>
          <button disabled={busy} onClick={() => { void confirmReview(false); }}>仅确认所选条件</button>
          <button disabled={busy} onClick={() => { void confirmReview(true); }}>完成最终验收（要求全部条件有有效决定或豁免）</button></div>}
        <button disabled={busy} onClick={() => { void continueWorking(); }}>继续实现（回到开发阶段）</button>
      </div>}
      {data.accepted && <p>该变更已完成冻结版本验收；后续问题请重新打开或建立新变更。</p>}
    </>}
  </section>;
}
