// 固定交接快照的内容与确定性渲染。快照在创建时捕获工作台记录，
// 之后不随当前状态变化；渲染是内容到文本的纯函数。
export type HandoffObservation = { id: string; workspaceId?: string; path: string; bindingVersion: number; createdAt: string; head: string | null; branch: string | null; stable: boolean; limitations: string[]; files: { path: string; status: string; sha256?: string }[]; trackedDiffSha256: string | null };
export type HandoffCheckpoint = { id: string; recordVersion: number; actor: 'user' | 'agent'; createdAt: string; goal: string; done: string; failures: string; unverified: string; blockers: string; nextSteps: string; observation: HandoffObservation };
export type HandoffBasis = { kind: 'baseline'; baselineId: string; revisionId: string; sourcePath: string; sourceSha256: string; sourceHead: string | null } | { kind: 'unconfirmedDraft'; revisionId: string };
export type HandoffEvidence = {
  id: string; executionId: string; cycle: number; baselineId: string | null; revisionId: string;
  criterionId: string | null; criterionIndex: number; result: 'passed' | 'failed'; actualCommit: string | null;
  formal: boolean; notes?: string;
};
export type HandoffAcceptance = {
  target: { id: string; commitSha: string } | null;
  targetOrderUncertain: boolean;
  evidence: HandoffEvidence[];
  openFailureIds: string[];
};
export type HandoffContent = {
  projectId: string;
  projectName: string;
  changeId: string;
  changeTitle: string;
  snapshotId: string;
  createdAt: string;
  phase: string;
  cycle: number;
  capturedVersion: number;
  goal: string;
  scope: string;
  nonGoals: string;
  criteria: (string | { id: string; revisionId: string; text: string })[];
  basis: HandoffBasis;
  checkpoint: HandoffCheckpoint | null;
  acceptance?: HandoffAcceptance;
};

function section(title: string, body: string): string {
  return `\n## ${title}\n\n${body.trim() || '（未填写）'}\n`;
}
const line = (label: string, value: string) => `${label}：${value.trim() ? value : '（未填写）'}`;

function renderAcceptance(summary: HandoffAcceptance): string {
  const target = summary.target
    ? `${summary.target.commitSha}（目标 ${summary.target.id}）`
    : summary.targetOrderUncertain ? '历史确认顺序不明，需重新确认目标' : '尚无已确认目标';
  const open = new Set(summary.openFailureIds);
  const failures = summary.evidence.filter(item => open.has(item.id)).map(item =>
    `- 条件 ${item.criterionIndex} · ${item.id}：${item.notes || '详见执行记录 ' + item.executionId}`);
  const references = summary.evidence.map(item => {
    const source = item.baselineId ? `基线 ${item.baselineId}` : `草案 ${item.revisionId}`;
    return `- 条件 ${item.criterionIndex}（${source} · 周期 ${item.cycle}）· ${item.result === 'passed' ? '报告通过' : '报告失败'} · ${item.formal ? '正式证据' : '过程记录'} · 实测提交 ${item.actualCommit ?? '未知'} · 证据 ${item.id} · 执行 ${item.executionId}`;
  });
  return [line('已确认目标提交', target), '未处理的失败：', ...(failures.length ? failures : ['- 无']),
    '证据引用：', ...(references.length ? references : ['- 尚无记录'])].join('\n');
}

export function renderHandoffMarkdown(content: HandoffContent): string {
  const basis = content.basis.kind === 'baseline'
    ? `冻结基线 ${content.basis.baselineId}（草案修订 ${content.basis.revisionId} · 来源 ${content.basis.sourcePath} · 来源摘要 ${content.basis.sourceSha256}${content.basis.sourceHead ? ` · HEAD ${content.basis.sourceHead}` : ' · 来源尚无 HEAD'}）`
    : `未确认草案修订 ${content.basis.revisionId}（尚未冻结，需用户确认后才能作为验收依据）`;
  const checkpoint = content.checkpoint;
  const checkpointBody = checkpoint
    ? [
        `保存点 ${checkpoint.id}（记录版本 ${checkpoint.recordVersion} · ${checkpoint.actor === 'user' ? '用户' : '工具'} · ${checkpoint.createdAt}）`,
        line('目标', checkpoint.goal),
        line('已完成', checkpoint.done),
        line('已知失败', checkpoint.failures),
        line('未验证', checkpoint.unverified),
        line('阻塞', checkpoint.blockers),
        line('下一步', checkpoint.nextSteps),
        `工作区观察 ${checkpoint.observation.id}：${checkpoint.observation.workspaceId ? `工作区 ${checkpoint.observation.workspaceId} · ` : ''}路径 ${checkpoint.observation.path} · 绑定版本 ${checkpoint.observation.bindingVersion} · 时间 ${checkpoint.observation.createdAt} · HEAD ${checkpoint.observation.head ?? '尚无提交'} · 分支 ${checkpoint.observation.branch ?? '未关联分支'} · ${checkpoint.observation.stable ? '观察稳定' : '观察不稳定，需重新观察'}`,
        `已跟踪差异摘要：${checkpoint.observation.trackedDiffSha256 ?? '未能读取'}`,
        '观察覆盖限制：',
        ...checkpoint.observation.limitations.map(item => `- ${item}`),
        '观察到的修改文件：',
        ...(checkpoint.observation.files.length > 0 ? checkpoint.observation.files.map(file => `- ${file.status} ${file.path}${file.sha256 ? `（摘要 ${file.sha256}）` : ''}`) : ['- 无']),
      ].join('\n')
    : content.acceptance ? '尚无保存点；续做前请先核对实际文件。' : '尚无保存点；此材料只有目标与依据，续做前请先核对实际文件。';
  const blocks = [
    `# SpecMill 交接材料\n`,
    [
      `项目：${content.projectName}（${content.projectId}）`,
      `变更：${content.changeTitle}（${content.changeId}）`,
      `快照：${content.snapshotId}`,
      `生成时间：${content.createdAt}`,
      `业务阶段：${content.phase}（周期 ${content.cycle}）· 捕获版本 ${content.capturedVersion}`,
    ].join('\n'),
    section('目标与依据', [line('目标', content.goal), line('范围', content.scope), line('非目标', content.nonGoals), `依据：${basis}`, '验收条件：', ...(content.criteria.length > 0 ? content.criteria.map(item => `- ${typeof item === 'string' ? item : item.text}`) : ['- 未填写'])].join('\n')),
    section('最近保存点', checkpointBody),
    ...(content.acceptance ? [section('验收进展', renderAcceptance(content.acceptance))] : []),
    section('续做须知', [
      '1. 按快照 ID 与变更 ID 查询工作台最新记录；材料日期较新不代表记录有效，旧材料可能已经过时。',
      '2. 核对实际目录、仓库身份、HEAD 与未提交修改；材料不含源码备份，不能替代项目恢复包，也不能用于恢复开发现场。',
      '3. 取得有效写会话后再写入；发现无法解释的并发改动时，先停止受影响的写操作并保留现场供核对，不得自动回滚或覆盖。',
      '4. 直接修改本材料不会回写工作台；需要新副本时按同一快照重新生成。',
    ].join('\n')),
  ];
  return `${blocks.join('\n')}`;
}
