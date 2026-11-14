import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, readJson } from './api';

type Change = { id: string; phase: string; version: number };
type UploadContext = { head: string | null; branch: string | null; dirty: boolean; stable: boolean; trackedDiffSha256: string | null; fileCount: number; limitations: string[] } | null;
type Execution = { id: string; actor: string; method: string; result: string; exitStatus: string; claimedCommit: string | null; claimedClean: boolean | null; notes: string; uploadContext: UploadContext; uploadLimitation: string; commitVerified: boolean | null; createdAt: string };
type Attachment = { id: string; filename: string; sha256: string; size: number; health: 'ok' | 'missing' | 'corrupted' };
type Evidence = { id: string; executionId: string; criterionSource: string; criterionIndex: number; criterionText: string | null; result: string; actualCommit: string | null; notes: string; formal: boolean; formalEffective: boolean; attachments: Attachment[]; createdAt: string };
type Target = { id: string; actor: string; commitSha: string; commitVerified: boolean; status: string; confirmedAt: string | null; notes: string; createdAt: string };
type Proposal = { id: string; actor: string; targetId: string | null; reason: string; evidenceIds: string[]; createdAt: string };

const healthLabel = (health: Attachment['health']) => health === 'ok' ? '完好' : health === 'missing' ? '缺失' : '摘要损坏';

export function EvidencePanel({ projectId, change, refresh }: { projectId: string; change: Change; refresh: () => Promise<void> }) {
  const [executions, setExecutions] = useState<Execution[] | null>(null);
  const [evidence, setEvidence] = useState<Evidence[] | null>(null);
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reason, setReason] = useState('');
  const [selectedTarget, setSelectedTarget] = useState('');
  const [uploading, setUploading] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const confirmId = useRef(crypto.randomUUID());
  const uploadId = useRef(crypto.randomUUID());
  const reload = async () => {
    const [runs, items, candidate, drafts] = await Promise.all([
      readJson<{ executions: Execution[] }>(await fetch(`/api/v1/changes/${change.id}/executions`), '读取执行记录失败。'),
      readJson<{ evidence: Evidence[] }>(await fetch(`/api/v1/changes/${change.id}/evidence`), '读取证据失败。'),
      readJson<{ targets: Target[] }>(await fetch(`/api/v1/changes/${change.id}/acceptance-targets`), '读取实现目标失败。'),
      readJson<{ proposals: Proposal[] }>(await fetch(`/api/v1/changes/${change.id}/acceptance-proposals`), '读取验收建议失败。'),
    ]);
    setExecutions(runs.executions); setEvidence(items.evidence); setTargets(candidate.targets); setProposals(drafts.proposals);
  };
  useEffect(() => {
    let live = true;
    void reload().catch(() => { if (live) setError('读取证据与验收数据失败，请返回后重试。'); });
    return () => { live = false; };
  }, [change.id, change.version]);
  async function submitProposal(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      await readJson(await fetch(`/api/v1/changes/${change.id}/acceptance-proposals`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' },
        body: JSON.stringify({ requestId: requestId.current, expectedVersion: change.version, payload: { reason, targetId: selectedTarget || undefined } }) }), '提交验收建议失败。');
      requestId.current = crypto.randomUUID(); setReason(''); setSelectedTarget('');
      try { await refresh(); } catch { setNeedsReload(); }
      setNotice('验收建议已提交，变更进入审阅阶段。');
    } catch (err) { setError(err instanceof ApiError ? err.message : '提交结果未知，可用原按钮重试。'); } finally { setBusy(false); }
  }
  function setNeedsReload() { setError('建议已保存，但刷新失败；请返回后重新打开项目。'); }
  async function uploadAttachment(file: File) {
    if (!file.size) { setError('附件内容为空。'); return; }
    setUploading(true); setError(''); setNotice('');
    try {
      await readJson(await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/attachments?requestId=${encodeURIComponent(uploadId.current)}&filename=${encodeURIComponent(file.name)}&contentType=${encodeURIComponent(file.type || 'application/octet-stream')}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-SpecMill-Request': '1' }, body: file }), '附件上传失败。');
      uploadId.current = crypto.randomUUID();
      await reload();
      setNotice('附件已上传（内容寻址存储；重复内容按项目唯一附件计量）。');
    } catch (err) { setError(err instanceof ApiError ? err.message : '上传结果未知，可重试。'); } finally { setUploading(false); }
  }
  async function confirmTarget(id: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      await readJson(await fetch(`/api/v1/changes/${change.id}/acceptance-targets/${encodeURIComponent(id)}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SpecMill-Request': '1' }, body: JSON.stringify({ requestId: confirmId.current }) }), '确认实现目标失败。');
      confirmId.current = crypto.randomUUID();
      await reload();
      setNotice('已确认实现目标（完整 commit 及仓库身份）。');
    } catch (err) { setError(err instanceof ApiError ? err.message : '确认结果未知，可重试。'); } finally { setBusy(false); }
  }
  const state = (value: string) => value === 'passed' ? '通过' : value === 'failed' ? '失败' : '未知';
  return <section><h5>证据与验收</h5>{error && <p role="alert">{error}</p>}{notice && <p>{notice}</p>}
    {executions === null ? <p>正在读取证据数据。</p> : <>
      <details><summary>执行记录（{executions.length}）</summary>{executions.length === 0 ? <p>尚无执行记录；工具或用户可经 CLI 提交外部检查结果。</p> : <ul>{executions.map(item => <li key={item.id}><p>{item.createdAt} · {item.actor === 'user' ? '用户' : '工具'} · {state(item.result)} · {item.method}{item.exitStatus ? `（${item.exitStatus}）` : ''}</p><p>工具声明：测试版本 {item.claimedCommit ?? '未声明'} · 测试时{item.claimedClean === null ? '未声明' : item.claimedClean ? '干净' : '含未提交修改'}{item.commitVerified === null ? '' : item.commitVerified ? ' · commit 已在仓库核对' : ' · commit 无法在仓库核对'}</p><p>上传时观察：{item.uploadContext ? `HEAD ${item.uploadContext.head ?? '尚无提交'} · ${item.uploadContext.dirty ? '含未提交修改' : '干净'} · ${item.uploadContext.stable ? '观察稳定' : '观察不稳定'}` : '未能观察'}{item.uploadLimitation ? `（${item.uploadLimitation}）` : ''}</p>{item.notes && <p>备注：{item.notes}</p>}</li>)}</ul>}</details>
      <details><summary>证据（{evidence?.length ?? 0}）</summary>{evidence !== null && evidence.length === 0 ? <p>尚无证据；证据需关联执行记录与具体条件。</p> : <ul>{evidence?.map(item => <li key={item.id}><p>{item.createdAt} · {state(item.result)} · 条件 {item.criterionIndex}（{item.criterionSource === 'baseline' ? '冻结基线' : '草案修订'}）{item.formalEffective ? ' · 具备正式通过资格' : item.formal ? ' · 曾具备正式资格，但附件已缺失或损坏，当前不合格' : ' · 仅作参考，不具备正式通过资格'}</p><p>预期：{item.criterionText ?? '条件文本不可用'}</p><p>实际验证版本：{item.actualCommit ?? '未声明'}</p>{item.attachments.length > 0 && <p>受管理附件（默认下载，不作为页面执行）：{item.attachments.map(item2 => <span key={item2.id}> <a href={`/api/v1/attachments/${item2.id}`}>{item2.filename}</a>（{healthLabel(item2.health)}）</span>)}</p>}{item.notes && <p>备注：{item.notes}</p>}</li>)}</ul>}</details>
      <details><summary>实现目标候选（{targets?.length ?? 0}）</summary>{targets !== null && targets.length === 0 ? <p>尚无实现目标候选；需指向可在仓库核对的完整 commit。</p> : <ul>{targets?.map(item => <li key={item.id}><p>commit {item.commitSha} · {item.commitVerified ? '已核对存在于仓库' : '未能在仓库核对'} · {item.status === 'confirmed' ? `已确认（${item.confirmedAt}）` : '候选，待用户确认'}</p>{item.notes && <p>备注：{item.notes}</p>}{item.status === 'proposed' && change.phase === 'Reviewing' && <button disabled={busy} onClick={() => { void confirmTarget(item.id); }}>确认此实现目标</button>}</li>)}</ul>}</details>
      <details><summary>验收建议（{proposals?.length ?? 0}）</summary>{proposals !== null && proposals.length === 0 ? <p>尚无验收建议。</p> : <ul>{proposals?.map(item => <li key={item.id}><p>{item.createdAt} · {item.actor === 'user' ? '用户' : '工具'} · 引用证据 {item.evidenceIds.length} 项{item.targetId ? ' · 含实现目标' : ''}</p><p>{item.reason}</p></li>)}</ul>}</details>
      <label>上传受管理附件（日志、截图等；单文件 ≤ 5 MiB，计入项目容量预算）<input type="file" disabled={busy || uploading} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void uploadAttachment(file); }} /></label>
      {change.phase === 'Working' && <form aria-label="提交验收建议" onSubmit={submitProposal}><p>提交后变更进入审阅阶段；工具仅能建议，最终确认由用户完成。</p>
        <label>理由与缺口说明<textarea disabled={busy} required maxLength={4000} value={reason} onChange={event => { setReason(event.target.value); requestId.current = crypto.randomUUID(); }} /></label>
        <label>候选实现目标<select disabled={busy} value={selectedTarget} onChange={event => setSelectedTarget(event.target.value)}><option value="">不指定</option>{targets?.filter(item => item.status === 'proposed').map(item => <option key={item.id} value={item.id}>{item.commitSha.slice(0, 12)}…（{item.createdAt}）</option>)}</select></label>
        <button disabled={busy || !reason.trim()}>提交验收建议</button></form>}
      {change.phase === 'Reviewing' && <p>变更正在审阅：用户确认实现目标后，后续可生成确认预览（批量确认由后续版本提供）。</p>}
    </>}
  </section>;
}
