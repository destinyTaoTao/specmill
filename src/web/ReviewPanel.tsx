import { useEffect, useRef, useState } from 'react';
import { ApiError, readJson } from './api';

type Change = { id: string; phase: string; version: number; baselineId: string | null };
type Disposition = { id: string; criterionId: string; criterionText: string | null; cycle: number; baselineId: string; targetId: string | null; targetCommit: string | null; failureEvidenceId: string; failureCommit: string | null; failureNotes: string; outcome: string; supportingEvidenceIds: string[]; reason: string; actor: string; createdAt: string };
type ReviewData = {
  context: { cycle: number; baselineId: string; criterionRevisionId: string; target: { id: string; commitSha: string; status: string; confirmedAt: string } | null; targetOrderUncertain: boolean; phase: string };
  snapshot: { version: number; cycle: number; baselineId: string; criterionRevisionId: string; targetId: string | null; observationId: string | null; evidenceCount: number; decisionCount: number; dispositionCount: number };
  observation: { path: string; bindingVersion: number; createdAt: string; head: string | null; dirty: boolean; stable: boolean } | null;
  criteria: { criterionId: string; index: number; text: string; decision: { result: string; reason: string; evidenceIds: string[]; createdAt: string; valid: boolean } | null; blockingFailures: { id: string; actualCommit: string | null; notes: string }[]; dispositions: Disposition[]; evidence: { id: string; actualCommit: string | null; formal: boolean; healthy: boolean; matchesTarget: boolean; createdAt: string }[] }[];
  retiredDispositions: Disposition[];
  accepted: boolean;
};
type SelectionMap = Record<string, { mode: 'new' | 'reuse'; evidenceId: string; reuseReason: string }>;
type HistoryData = { criteria: { criterionId: string; text: string; dispositions: Disposition[] }[]; retiredDispositions: Disposition[] };

function DispositionHistory({ items, retired = false }: { items: Disposition[]; retired?: boolean }) {
  if (!items.length) return null;
  return <details><summary>{retired ? '已不在当前条件中的失败处置' : '失败处置历史'}（{items.length}）</summary><p>处置只适用于记录的目标；旧记录未保存目标时须重新处置。</p><ul>{items.map(item => <li key={item.id}><p>历史条件：{item.criterionText ?? '无法核对'}（{item.criterionId}）</p><p>周期 {item.cycle} · 基线 {item.baselineId} · {item.createdAt} · {item.actor === 'user' ? '用户' : item.actor}</p><p>处置目标：{item.targetId ? `${item.targetCommit ?? '提交不可用'}（${item.targetId}）` : '旧记录未保存目标，需重新处置'}</p><p>失败证据：{item.failureEvidenceId} · 验证版本 {item.failureCommit ?? '未声明'}{item.failureNotes && ` · ${item.failureNotes}`}</p><p>处置：{item.outcome === 'resolved' ? '已解决' : item.outcome === 'not_applicable' ? '不适用' : item.outcome}；理由：{item.reason}</p><p>补测证据：{item.supportingEvidenceIds.length ? item.supportingEvidenceIds.join('、') : '无'}</p></li>)}</ul></details>;
}

export function ReviewPanel({ change, refresh }: { change: Change; refresh: () => Promise<void> }) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [selections, setSelections] = useState<SelectionMap>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(true);
  const [readError, setReadError] = useState('');
  const [notice, setNotice] = useState('');
  const [previewId, setPreviewId] = useState('');
  const [previewDetails, setPreviewDetails] = useState<{ data: ReviewData; selections: SelectionMap } | null>(null);
  const [confirmUncertain, setConfirmUncertain] = useState(false);
  const [continueUncertain, setContinueUncertain] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [waiving, setWaiving] = useState('');
  const [waiveReason, setWaiveReason] = useState('');
  const [waiveUncertain, setWaiveUncertain] = useState(false);
  const [dispositionFor, setDispositionFor] = useState('');
  const [dispositionFailure, setDispositionFailure] = useState('');
  const [dispositionOutcome, setDispositionOutcome] = useState<'resolved' | 'not_applicable'>('resolved');
  const [dispositionEvidence, setDispositionEvidence] = useState('');
  const [dispositionReason, setDispositionReason] = useState('');
  const [dispositionPreview, setDispositionPreview] = useState<{ id: string; criterion: string; failureId: string; outcome: 'resolved' | 'not_applicable'; evidenceId: string; reason: string; target: string | null } | null>(null);
  const [dispositionUncertain, setDispositionUncertain] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const pendingConfirm = useRef<{ requestId: string; payload: { previewId: string; complete: boolean } } | null>(null);
  const pendingContinue = useRef<{ requestId: string; expectedVersion: number } | null>(null);
  const pendingWaiver = useRef<{ requestId: string; expectedVersion: number; payload: { criterionId: string; reason: string; failureEvidenceIds: string[] } } | null>(null);
  const pendingDisposition = useRef(false);
  const dispositionPreviewRequest = useRef(crypto.randomUUID());
  const dispositionConfirmRequest = useRef(crypto.randomUUID());
  const loadSequence = useRef(0);
  const reload = async () => {
    const sequence = ++loadSequence.current;
    setReading(true); setReadError('');
    try {
      if (change.phase === 'Working') {
        const result = await readJson<HistoryData>(await fetch(`/api/v1/changes/${change.id}/review/failure-dispositions`), '读取失败处置历史失败。');
        if (sequence === loadSequence.current) setHistory(result);
        return;
      }
      const result = await readJson<ReviewData>(await fetch(`/api/v1/changes/${change.id}/review`), '读取审阅状态失败。');
      if (sequence !== loadSequence.current) return;
      setData(result);
      setSelections(previous => {
        const next: SelectionMap = {};
        for (const criterion of result.criteria) {
          const prior = previous[criterion.criterionId];
          if (prior) {
            // 仅保留仍可用、且用户明确选择过的证据。
            const chosen = criterion.evidence.find(item => item.id === prior.evidenceId && item.healthy && item.formal);
            next[criterion.criterionId] = { mode: prior.mode, evidenceId: chosen?.id ?? '', reuseReason: prior.reuseReason };
            continue;
          }
        }
        return next;
      });
    } catch (error) {
      if (sequence === loadSequence.current) {
        setReadError(change.phase === 'Working' ? '读取失败处置历史失败，请重试。' : '读取审阅状态失败，请重试。');
        throw error;
      }
    } finally {
      if (sequence === loadSequence.current) setReading(false);
    }
  };
  useEffect(() => {
    if (!pendingConfirm.current && !pendingContinue.current && !pendingWaiver.current && !pendingDisposition.current) {
      setPreviewId(''); setPreviewDetails(null); invalidateDisposition();
      void reload().catch(() => {});
    }
    // 目标确认发生在证据面板：通过事件通知本面板重新读取审阅状态。
    const onExternalRefresh = () => { if (pendingConfirm.current || pendingContinue.current || pendingWaiver.current || pendingDisposition.current) return; setPreviewId(''); setPreviewDetails(null); invalidateDisposition(); void reload().catch(() => {}); };
    window.addEventListener('specmill:review-refresh', onExternalRefresh);
    return () => { loadSequence.current++; window.removeEventListener('specmill:review-refresh', onExternalRefresh); };
  }, [change.id, change.version]);
  const selectedRows = () => (data?.criteria ?? []).flatMap(criterion => {
    const value = selections[criterion.criterionId];
    const chosen = criterion.evidence.find(item => item.id === value?.evidenceId && item.formal && item.healthy);
    return (!criterion.decision || !criterion.decision.valid) && criterion.blockingFailures.length === 0 && value && chosen ? [{ criterionId: criterion.criterionId, mode: value.mode, evidenceIds: [chosen.id], ...(value.mode === 'reuse' ? { reuseReason: value.reuseReason } : {}) }] : [];
  });
  async function runPreview() {
    if (!data) return;
    const chosen = selectedRows();
    const sequence = loadSequence.current;
    setBusy(true); setError(''); setNotice(''); setPreviewId(''); setPreviewDetails(null);
    try {
      const receipt = await readJson<{ resourceId: string }>(await fetch(`/api/v1/changes/${change.id}/review/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify({ requestId: requestId.current, expectedSnapshot: data.snapshot, payload: { selections: chosen } }) }), '生成确认预览失败。');
      requestId.current = crypto.randomUUID();
      if (sequence !== loadSequence.current) { setError('审阅状态已更新，请重新生成预览。'); return; }
      setPreviewId(receipt.resourceId);
      setPreviewDetails({ data, selections: Object.fromEntries(chosen.map(item => [item.criterionId, selections[item.criterionId]])) });
      setNotice(`确认预览已生成（选中 ${chosen.length} 项）；确认前如证据或失败处置发生变化，预览会过期。`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REVIEW_CHANGED') { requestId.current = crypto.randomUUID(); setReadError('审阅状态已变化，请重新读取后生成预览。'); }
      else setError(err instanceof ApiError ? err.message : '预览结果未知，可重试。');
    } finally { setBusy(false); }
  }
  async function confirmReview(complete: boolean) {
    if (pendingConfirm.current && pendingConfirm.current.payload.complete !== complete) return;
    const command = pendingConfirm.current ?? { requestId: requestId.current, payload: { previewId, complete } };
    pendingConfirm.current = command;
    setBusy(true); setError(''); setNotice('');
    try {
      await readJson(await fetch(`/api/v1/changes/${change.id}/review/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify(command) }), '确认失败。');
      pendingConfirm.current = null; setConfirmUncertain(false);
      requestId.current = crypto.randomUUID(); setPreviewId(''); setPreviewDetails(null);
      try { await refresh(); await reload(); } catch { setNeedsReload(); }
      setNotice(complete ? '已完成冻结版本验收。' : '已确认所选条件。');
    } catch (err) {
      const uncertain = !(err instanceof ApiError) || err.status === undefined || err.status >= 500;
      if (uncertain) setConfirmUncertain(true);
      else { pendingConfirm.current = null; setConfirmUncertain(false); requestId.current = crypto.randomUUID(); }
      setError(uncertain ? '确认结果未知，请重试原确认。' : err instanceof ApiError ? err.message : '确认失败。');
    } finally { setBusy(false); }
  }
  function setNeedsReload() { setRefreshFailed(true); setError('已保存，但刷新失败；请返回后重新打开项目。'); }
  async function waive(criterionId: string) {
    setBusy(true); setError(''); setNotice('');
    const command = pendingWaiver.current ?? { requestId: crypto.randomUUID(), expectedVersion: change.version, payload: { criterionId, reason: waiveReason, failureEvidenceIds: data?.criteria.find(item => item.criterionId === criterionId)?.blockingFailures.map(item => item.id) ?? [] } };
    pendingWaiver.current = command;
    try {
      await readJson(await fetch(`/api/v1/changes/${change.id}/review/waive`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify(command) }), '风险豁免失败。');
      pendingWaiver.current = null; setWaiveUncertain(false); setWaiving(''); setWaiveReason('');
      try { await refresh(); await reload(); } catch { setNeedsReload(); }
      setNotice('已记录风险豁免。');
    } catch (err) {
      const uncertain = !(err instanceof ApiError) || (err.status !== undefined && err.status >= 500);
      if (uncertain) setWaiveUncertain(true);
      else { pendingWaiver.current = null; setWaiveUncertain(false); }
      setError(uncertain ? '豁免结果未知，请使用原内容重试确认。' : err instanceof ApiError ? err.message : '豁免失败。');
    } finally { setBusy(false); }
  }
  function invalidateDisposition() {
    setDispositionPreview(null);
    dispositionPreviewRequest.current = crypto.randomUUID();
    dispositionConfirmRequest.current = crypto.randomUUID();
  }
  async function previewDisposition() {
    if (!dispositionFor) return;
    const criterion = data?.criteria.find(item => item.criterionId === dispositionFor);
    const failure = criterion?.blockingFailures.find(item => item.id === dispositionFailure);
    if (!criterion || !failure) { setError('该条件已无待处置失败。'); return; }
    const sequence = loadSequence.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const receipt = await readJson<{ resourceId: string }>(await fetch(`/api/v1/changes/${change.id}/review/failure-dispositions/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify({ requestId: dispositionPreviewRequest.current, expectedVersion: change.version, payload: { rows: [{ criterionId: dispositionFor, failureEvidenceId: failure.id, outcome: dispositionOutcome, ...(dispositionOutcome === 'resolved' ? { supportingEvidenceIds: dispositionEvidence ? [dispositionEvidence] : [] } : {}), reason: dispositionReason }] } }) }), '处置预览失败。');
      if (sequence !== loadSequence.current) { invalidateDisposition(); setError('审阅状态已更新，请重新生成处置预览。'); return; }
      setDispositionPreview({ id: receipt.resourceId, criterion: criterion.text, failureId: failure.id, outcome: dispositionOutcome, evidenceId: dispositionEvidence, reason: dispositionReason, target: data?.context.target?.commitSha ?? null });
    } catch (err) { setError(err instanceof ApiError ? err.message : '预览结果未知，可用原内容重试。'); } finally { setBusy(false); }
  }
  async function confirmDisposition() {
    if (!dispositionPreview) return;
    pendingDisposition.current = true;
    setBusy(true); setError(''); setNotice('');
    try {
      await readJson(await fetch(`/api/v1/changes/${change.id}/review/failure-dispositions/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify({ requestId: dispositionConfirmRequest.current, payload: { previewId: dispositionPreview.id } }) }), '处置确认失败。');
      pendingDisposition.current = false; setDispositionUncertain(false);
      setDispositionFor('');
      invalidateDisposition();
      try { await refresh(); await reload(); } catch { setNeedsReload(); }
      setNotice('失败处置已记录。');
    } catch (err) {
      const uncertain = !(err instanceof ApiError) || (err.status !== undefined && err.status >= 500);
      if (uncertain) setDispositionUncertain(true);
      else { pendingDisposition.current = false; setDispositionUncertain(false); }
      setError(uncertain ? '处置结果未知，请使用同一预览重试确认。' : err instanceof ApiError ? err.message : '确认失败。');
    } finally { setBusy(false); }
  }
  async function continueWorking() {
    const command = pendingContinue.current ?? { requestId: requestId.current, expectedVersion: change.version };
    pendingContinue.current = command;
    setBusy(true); setError(''); setNotice('');
    try {
      await readJson(await fetch(`/api/v1/changes/${change.id}/review/continue`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify(command) }), '继续实现失败。');
      pendingContinue.current = null; setContinueUncertain(false);
      requestId.current = crypto.randomUUID();
      try { await refresh(); await reload(); } catch { setNeedsReload(); }
      setNotice('已回到开发阶段；历史证据与决定保留。');
    } catch (err) {
      const uncertain = !(err instanceof ApiError) || err.status === undefined || err.status >= 500;
      if (uncertain) setContinueUncertain(true);
      else { pendingContinue.current = null; setContinueUncertain(false); requestId.current = crypto.randomUUID(); }
      setError(uncertain ? '继续实现结果未知，请重试原操作。' : err instanceof ApiError ? err.message : '继续实现失败。');
    } finally { setBusy(false); }
  }
  const decidedOrWaived = (criterionId: string) => data?.criteria.find(item => item.criterionId === criterionId)?.decision;
  const readBlocked = reading || !!readError;
  const locked = busy || readBlocked || confirmUncertain || continueUncertain || waiveUncertain || dispositionUncertain || refreshFailed;
  const readFailure = readError && <><p role="alert">{readError}</p>{!refreshFailed && <button disabled={reading || busy} onClick={() => { void reload().catch(() => {}); }}>重试读取{change.phase === 'Working' ? '失败处置历史' : '审阅状态'}</button>}</>;
  if (change.phase === 'Working') {
    const withHistory = history?.criteria.filter(item => item.dispositions.length > 0) ?? [];
    if (!error && !readError && !withHistory.length && !history?.retiredDispositions.length) return null;
    return <section><h5>失败处置历史</h5>{error && <p role="alert">{error}</p>}{readFailure}<p>开发阶段仅供查阅，最终验收需进入审阅并确认目标。</p>{withHistory.map(item => <div key={item.criterionId}><p>当前条件：{item.text}</p><DispositionHistory items={item.dispositions} /></div>)}{history && <DispositionHistory items={history.retiredDispositions} retired />}</section>;
  }
  return <section><h5>验收审阅</h5>{error && <p role="alert">{error}</p>}{readFailure}<p role="status">{notice}</p>
    {data === null ? <p>{reading ? '正在读取审阅状态。' : '审阅状态暂不可用。'}</p> : <>
      {data.criteria.some(item => item.evidence.length > 0) && <p>历史工具记录可能早于写会话校验；请核对记录来源与实际结果。</p>}
      <p>失败处置仅适用于确认时的目标；更换目标后需要重新处置。</p>
      <p>审阅上下文：周期 {data.context.cycle} · 冻结基线 {data.context.baselineId.slice(0, 8)}… · 实现目标 {data.context.target ? `${data.context.target.commitSha.slice(0, 12)}…（${data.context.target.status === 'confirmed' ? '已确认' : '候选'}）` : '尚未确认'}</p>
      {data.context.targetOrderUncertain && <p role="alert">历史实现目标的确认顺序无法确定。{data.accepted ? '历史验收记录会保留；重新打开变更后可重新确认目标。' : '请到“证据与验收”的目标候选中重新生成并确认目标；历史验收记录不会改写。'}</p>}
      <ul>{data.criteria.map(criterion => {
        const selection = selections[criterion.criterionId];
        const chosenEvidence = criterion.evidence.find(item => item.id === selection?.evidenceId);
        const decision = decidedOrWaived(criterion.criterionId);
        return <li key={criterion.criterionId}>
          <p>条件 {criterion.index}：{criterion.text}{decision ? ` · ${!decision.valid ? '已有决定的依据不可用，需重新确认' : decision.result === 'waived' ? '已豁免' : '已确认通过'}（${decision.createdAt}）` : criterion.blockingFailures.length > 0 ? ` · 被未处置失败阻塞（${criterion.blockingFailures.length} 项）` : ' · 待确认'}</p>
          {decision && <p>决定：{decision.reason} · 引用证据 {decision.evidenceIds.length} 项</p>}
          <DispositionHistory items={criterion.dispositions} />
          {decision && criterion.blockingFailures.length > 0 && <p>该条件仍有 {criterion.blockingFailures.length} 项未处置失败，阻止最终验收。</p>}
          {(!decision || !decision.valid) && change.phase === 'Reviewing' && criterion.evidence.length > 0 && <div>
            <label>选择证据<select disabled={locked || criterion.blockingFailures.length > 0} value={selection?.evidenceId ?? ''} onChange={event => { setPreviewId(''); setNotice(''); requestId.current = crypto.randomUUID(); setSelections(previous => ({ ...previous, [criterion.criterionId]: { mode: criterion.evidence.find(item => item.id === event.target.value)?.matchesTarget === false ? 'reuse' : 'new', evidenceId: event.target.value, reuseReason: previous[criterion.criterionId]?.reuseReason ?? '' } })); }}><option value="">不确认此条件</option>{criterion.evidence.map(item => <option key={item.id} value={item.id} disabled={!item.formal || !item.healthy}>{item.id.slice(0, 8)}… · 版本 {item.actualCommit?.slice(0, 10) ?? '未声明'}{!item.formal || !item.healthy ? '（证据不合格）' : item.matchesTarget ? '（与目标一致）' : '（历史版本，需复用理由）'}</option>)}</select></label>
            {selection && selection.evidenceId !== '' && <label>确认模式<select disabled={locked} value={selection.mode} onChange={event => { setPreviewId(''); setNotice(''); requestId.current = crypto.randomUUID(); setSelections(previous => ({ ...previous, [criterion.criterionId]: { ...previous[criterion.criterionId], mode: event.target.value as 'new' | 'reuse' } })); }}><option value="new">当前版本核对通过</option><option value="reuse">复用历史证据（需说明理由）</option></select></label>}
            {selection?.mode === 'new' && chosenEvidence && !chosenEvidence.matchesTarget && <p>所选证据的验证版本与当前目标不一致；如需继续使用，请切换复用模式并说明理由。</p>}
            {selection && selection.mode === 'reuse' && <label>复用理由<input disabled={locked} value={selection.reuseReason} onChange={event => { setPreviewId(''); setNotice(''); requestId.current = crypto.randomUUID(); setSelections(previous => ({ ...previous, [criterion.criterionId]: { ...previous[criterion.criterionId], reuseReason: event.target.value } })); }} /> </label>}
          </div>}
          {criterion.blockingFailures.length > 0 && change.phase === 'Reviewing' && <div><p>未处置失败：{criterion.blockingFailures.map(item => <span key={item.id}> {item.id.slice(0, 8)}…（版本 {item.actualCommit?.slice(0, 10) ?? '未声明'}）</span>)}</p>
            {dispositionFor === criterion.criterionId ? <div>
              <label>选择失败<select disabled={locked || dispositionUncertain} value={dispositionFailure} onChange={event => { invalidateDisposition(); setDispositionFailure(event.target.value); }}>{criterion.blockingFailures.map(item => <option key={item.id} value={item.id}>{item.id}（版本 {item.actualCommit ?? '未声明'}）</option>)}</select></label>
              <label>处置方式<select disabled={locked || dispositionUncertain} value={dispositionOutcome} onChange={event => { invalidateDisposition(); setDispositionOutcome(event.target.value as 'resolved' | 'not_applicable'); }}><option value="resolved">已解决（需补测证据）</option><option value="not_applicable">不适用（需说明依据）</option></select></label>
              {dispositionOutcome === 'resolved' && <label>补测证据<select disabled={locked || dispositionUncertain} value={dispositionEvidence} onChange={event => { invalidateDisposition(); setDispositionEvidence(event.target.value); }}><option value="">请选择</option>{criterion.evidence.filter(item => item.healthy && item.formal && item.matchesTarget).map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>}
              <label>理由或依据<input disabled={locked || dispositionUncertain} value={dispositionReason} onChange={event => { invalidateDisposition(); setDispositionReason(event.target.value); }} /></label>
              <button disabled={locked || dispositionUncertain || !dispositionReason.trim() || (dispositionOutcome === 'resolved' && !dispositionEvidence)} onClick={() => { void previewDisposition(); }}>预览处置</button>
              <button disabled={locked || dispositionUncertain} onClick={() => { setDispositionFor(''); invalidateDisposition(); }}>取消</button>
              {dispositionPreview && <section className="review-preview" aria-label="失败处置预览"><h6>失败处置预览</h6><p>条件：{dispositionPreview.criterion}</p><p>失败证据：{dispositionPreview.failureId}</p><p>冻结提交：{dispositionPreview.target ?? '尚未确认'}</p><p>处置：{dispositionPreview.outcome === 'resolved' ? `已解决；补测证据 ${dispositionPreview.evidenceId}` : '不适用'}</p><p>理由：{dispositionPreview.reason}</p><p>此处置只解除指定失败的阻塞，不自动确认条件通过。</p><button disabled={busy || (!dispositionUncertain && readBlocked) || confirmUncertain || continueUncertain || waiveUncertain || refreshFailed} onClick={() => { void confirmDisposition(); }}>确认处置</button></section>}
            </div> : <button disabled={locked || dispositionUncertain} onClick={() => { invalidateDisposition(); setDispositionFor(criterion.criterionId); setDispositionFailure(criterion.blockingFailures[0].id); setDispositionOutcome('resolved'); setDispositionEvidence(''); setDispositionReason(''); }}>处置失败</button>}
          </div>}
          {(!decision || !decision.valid || criterion.blockingFailures.length > 0) && change.phase === 'Reviewing' && <div>
            {waiving !== criterion.criterionId && <button disabled={locked || waiveUncertain || !data.context.target} onClick={() => { setWaiving(criterion.criterionId); setWaiveReason(''); }}>风险豁免</button>}
            {waiving === criterion.criterionId && <div><p>{criterion.blockingFailures.length ? `将记录对 ${criterion.blockingFailures.length} 项失败的风险接受。` : '将记录对该条件缺口的风险接受；不代表条件已通过。'}</p><label>豁免理由与影响<input disabled={locked || waiveUncertain} value={waiveReason} onChange={event => setWaiveReason(event.target.value)} /></label><button disabled={busy || (!waiveUncertain && readBlocked) || confirmUncertain || continueUncertain || dispositionUncertain || refreshFailed || !waiveReason.trim()} onClick={() => { void waive(criterion.criterionId); }}>确认豁免</button><button disabled={locked || waiveUncertain} onClick={() => { setWaiving(''); pendingWaiver.current = null; }}>取消</button></div>}
          </div>}
        </li>;
      })}</ul>
      <DispositionHistory items={data.retiredDispositions} retired />
      {change.phase === 'Reviewing' && data.context.target && <div>
        <button disabled={locked || (selectedRows().length === 0 && !data.criteria.every(item => item.decision?.valid))} onClick={() => { void runPreview(); }}>生成确认预览</button>
        {previewId !== '' && previewDetails && <section className="review-preview" aria-label="验收确认预览"><h6>验收确认预览</h6>
          <p>冻结基线：{previewDetails.data.context.baselineId}</p>
          <p>冻结提交：{previewDetails.data.context.target?.commitSha}。工作区中尚未采用的修改不属于本次验收。</p>
          {previewDetails.data.observation ? <p>最近工作区观察：{previewDetails.data.observation.createdAt}，路径 {previewDetails.data.observation.path}，绑定版本 {previewDetails.data.observation.bindingVersion}，HEAD {previewDetails.data.observation.head ?? '无提交'}，{previewDetails.data.observation.dirty ? '存在未提交修改' : '无已观察到的未提交修改'}{previewDetails.data.observation.stable ? '' : '；观察不稳定，需重新核对'}。这是历史观察，不代表当前文件状态。</p> : <p>尚无该目标工作区的观察记录，请按需核对实际文件。</p>}
          <ul>{previewDetails.data.criteria.map(criterion => {
            const choice = previewDetails.selections[criterion.criterionId];
            const evidence = criterion.evidence.find(item => item.id === choice?.evidenceId);
            const reason = criterion.blockingFailures.length ? '存在未处置失败' : criterion.decision && !criterion.decision.valid ? '已有决定的证据不可用' : criterion.decision ? (criterion.decision.result === 'waived' ? `已有风险豁免：${criterion.decision.reason}` : '已有确认决定') : !criterion.evidence.some(item => item.formal && item.healthy) ? '没有合格证据' : '未选择';
            return <li key={criterion.criterionId}><p>{criterion.text}</p>{choice && evidence ? <p>本次确认：证据 {evidence.id}，验证版本 {evidence.actualCommit ?? '未声明'}；{choice.mode === 'reuse' ? `复用理由：${choice.reuseReason}` : '当前版本核对通过'}</p> : <p>本次不确认：{reason}</p>}</li>;
          })}</ul>
          <button disabled={busy || (!confirmUncertain && readBlocked) || refreshFailed || continueUncertain || waiveUncertain || dispositionUncertain || (confirmUncertain && pendingConfirm.current?.payload.complete !== false)} onClick={() => { void confirmReview(false); }}>{confirmUncertain && pendingConfirm.current?.payload.complete === false ? '重试确认所选条件' : '仅确认所选条件'}</button>
          <p>最终验收要求全部条件均有有效决定或豁免。</p>
          <button disabled={busy || (!confirmUncertain && readBlocked) || refreshFailed || continueUncertain || waiveUncertain || dispositionUncertain || (confirmUncertain && pendingConfirm.current?.payload.complete !== true)} onClick={() => { void confirmReview(true); }}>{confirmUncertain && pendingConfirm.current?.payload.complete === true ? '重试最终验收' : '完成最终验收'}（冻结提交 {previewDetails.data.context.target?.commitSha}）</button></section>}
        <button disabled={busy || (!continueUncertain && readBlocked) || confirmUncertain || waiveUncertain || dispositionUncertain || refreshFailed} onClick={() => { void continueWorking(); }}>{continueUncertain ? '重试继续实现' : '继续实现（回到开发阶段）'}</button>
      </div>}
      {data.accepted && <p>该变更已完成冻结版本验收{data.criteria.some(item => item.decision?.result === 'waived') ? `，含 ${data.criteria.filter(item => item.decision?.result === 'waived').length} 项风险豁免` : ''}；后续问题请重新打开或建立新变更。</p>}
    </>}
  </section>;
}
