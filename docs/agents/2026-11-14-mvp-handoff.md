# SpecMill 首版开发交接（2026-11-14）

用户要求暂停开发并做一次本地提交，供下一位 agent 继续。**不要把本次提交称作首版 MVP 已完成**：M1 的真实双工具续做、M2 冻结版本验收和 M3 独立恢复都未完成。本次没有推送或更改 GitHub Issue 状态。后续提交、推送和公开发布仍按用户当时的明确授权处理。

## 已确认方案

- 先读 `AGENTS.md`、`docs/01-项目愿景与方案总览.md`、`docs/02-首版详细设计.md`、`docs/03-首版技术选型.md` 和 `docs/superpowers/plans/2026-11-14-v0.1-minimum-loop.md`。Q1–Q18 的产品边界已写入文档和 ADR；本机个人续做、单变更单活跃写会话、用户确认关键决定、冻结版本验收及工作台记录可导出恢复是核心约束。
- [GitHub 规格 #1](https://github.com/destinyTaoTao/specmill/issues/1) 下有 #2–#19 共 18 张子 Issue 和阻塞关系。交接时这些 Issue 均仍开放、带 `ready-for-agent`；不要仅凭已有代码或测试结果关闭，需逐项核对各自验收标准。
- 不扩展多人协作、远程服务、自动执行 agent、Spec Kit 自动导入或双向 Markdown 同步。交接 Markdown 是生成输出，不是数据库；保存点不是源码备份。

## 已实现的工作和当前边界

- 本机 Fastify 服务、鉴权、项目持久化及错误契约；用户登录会话随进程重启失效。本机数据目录与源码仓库分离。
- Git 工作区绑定、只读观察和历史；观察使用隔离 Git 配置避免执行项目过滤器，明确列出未覆盖项目。它不能证明源码已备份，结果也可能因未使用原 Git 配置而与常规 Git 状态不同。
- 变更草案、取消/重新打开、普通 Markdown 预览与基线冻结、来源变化提示、显式关联同项目规格条目；不同变更的基线独立。当前条件以文本表示，需继续核对详细设计对可核对预期和证据方式的要求。
- 写会话的事务占用、受限工具授权、正常释放、用户核对后接管、进程重建时旧会话失效；重绑定前需结束活跃会话。会话与保存点通过版本、代次和工作区绑定校验。
- Web/CLI 可记录工作区观察及保存点；记录已做、失败、未验证、阻塞和下一步，并支持按原请求查询回执。保存点可以关联未确认草案或冻结基线；目标未填时如实显示未填写。CLI 不直接写数据库。
- 当前容量限制只覆盖记录投影与活跃会话结束预留；ZIP、附件、清单开销以及接近上限的完整导出/恢复往返尚未实现和验证，不能宣称 Q17 的完整恢复保证已满足。

## 已知问题与后续优先级

1. **先修复多标签页未决保存点覆盖。** `src/web/CheckpointPanel.tsx` 使用按 changeId 固定的浏览器 `localStorage` 键；同一变更的两个标签页可覆盖彼此的未决请求，任一标签完成后还可能清除另一个标签的副本。若响应丢失再刷新，正文和 requestId 可能无法恢复。应按请求隔离并只清理自身记录，覆盖双标签、响应延迟/丢失与刷新恢复。
2. **核对浏览器临时正文的隐私边界。** 未决正文目前以明文保存在浏览器站点存储中，不含写授权凭据，也不在工作台 data-dir 或恢复包里；成功确认后尝试清除。需决定更合适的保存与清理方案，不要误称所有数据都只在工作台数据目录。
3. **补足接近容量上限时的异常接管。** 正常释放与重启中断有预留，但接管前后都占用一个活跃会话，新增的旧会话历史、新会话和回执仍可能触发 413。要覆盖接近上限的接管与原子回滚，不要因此放宽已确认的完整恢复容量边界。
4. **复核 #2–#8 的未覆盖验收。** 尤其检查真实子进程重启、旧 CLI 延迟写回、开始会话与重绑定并发、恢复/重绑定后的仓库身份；当前部分重启测试只是同进程重建应用。独立审查和测试均不能代替逐条验收。
5. 完成 [#9：固定交接与真实续做（M1）](https://github.com/destinyTaoTao/specmill/issues/9)，包括材料过期提示、重新观察和真实 A/B 续做样本；M1 有价值后再依依赖推进 #10–#19 的证据、验收、导出恢复和本地打包。不要提前声称 M1/M2/M3 通过。

## CLI 与运行提示

需要 Node.js 24.22.3 或更高的 24.x、npm 和 Git；首版平台目标为 Windows x64。`npm ci`、`npm run build`、`npm start` 后在本机终端获取 Web 登录口令。`npm run cli -- ... --json` 调用同一个本机服务，可先用 `project list`、`workspace list --project <项目ID>`、`change list --project <项目ID>` 和 `change show --change <变更ID>` 查询。

会话创建需要 `session start --change <变更ID> --workspace <工作区ID> --binding-version <版本> --version <变更版本> --tool <名称> --request-id <请求ID> --grant-file <授权文件>`；随后可用 `workspace observe --workspace <工作区ID> --binding-version <版本> --request-id <请求ID> --grant-file <授权文件>`。观察回执的 resourceId 用于 `checkpoint save --change <变更ID> --version <变更版本> --observation <观察ID> --request-id <请求ID> --grant-file <授权文件> --file <JSON文件>`，也可用 `--stdin` 替代 `--file`。正文包含 `done`、`failures`、`unverified`、`blockers`、`nextSteps` 字符串；没有内容时明确填写“无”或“未知”。`receipt show --request-id <请求ID>` 查询回执，`session release --grant-file <授权文件> --version <变更版本> --request-id <请求ID>` 正常释放。

结果未知时保留原 requestId 和内容，优先查询回执或按相同请求重试。Windows 下 CLI 授权文件及失败的 stdin 正文使用当前用户 DPAPI 加密；`--pending-file` 重试成功时会返回仍保留的加密暂存路径，由用户确认后处理。不要将数据目录、授权文件、附件或个人项目内容提交到仓库。

本轮实际使用 Windows x64、Node 24.22.3 和本机 Chrome；系统 PATH 中的 Node 补丁版本可能不同。提交前 `npm run lint`、`npm run typecheck`、`npm run build` 通过；`npm test` 为 7 个文件、52 项通过，设置 `SPECMILL_TEST_CHROME` 后的 `npm run test:e2e` 为 11 项通过。还在独立临时数据目录启动编译后的服务，通过编译后的 CLI 读取空项目列表。测试中的 SQLite trigger 故障日志是有意注入的回滚验证。本轮未在全新目录重装依赖或完成真实双工具和独立恢复验收。
