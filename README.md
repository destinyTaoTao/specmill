# SpecMill

面向个人开发者的本机开发续做工作台，帮助跨会话、跨工具保存和接续开发上下文。

当前是开发中的首版：已有本机项目与 Git 工作区、Markdown 规格基线、单写会话、保存点、固定交接快照、续做核对、受管理附件、执行证据与目标确认、批量验收确认、失败处置与风险豁免（CLI／Web）、一致的项目恢复包导出与隔离恢复（M1–M3 全部通过自动化与样本验证），以及可离线安装的本地安装包。尚未完成：异构双工具全闭环与容量实测（K18）。不宣称正式验收流程已由用户实际执行。继续开发前请阅读[实施状态与交接](docs/agents/2026-11-15-mvp-handoff.md)。

需要 Node.js 24.22.3 或更高的 24.x 版本和 npm；项目用 `.node-version` 指定开发基线。运行 `npm ci` 安装依赖，运行 `npm run build` 后运行 `npm start`。在浏览器打开终端显示的本机地址，使用终端中的一次性启动口令登录。重启后口令和浏览器会话均失效。

默认数据存放在 Windows 的 `%LOCALAPPDATA%/SpecMill`；可用 `npm start -- --data-dir <目录> --port <端口>` 指定其他目录和端口。数据目录只允许一个服务实例使用；请勿提交数据库、附件或口令。运行 `npm test`、`npm run lint`、`npm run typecheck` 和 `npm run build` 验证。

服务被强制终止后，单实例锁可能短暂保留；确认旧进程已退出后稍等，再重新启动。浏览器测试需安装 Playwright Chromium，或设置 `SPECMILL_TEST_CHROME` 指向本机 Chrome 后运行 `npm run test:e2e`。

构建后可通过 `npm run cli -- project list --json` 查看项目，再使用 `workspace list --project <项目ID>`、`change list --project <项目ID>`、`change show --change <变更ID>`、`checkpoint list --change <变更ID>`、`handoff create --change <变更ID>` 与 `handoff show --snapshot <快照ID>` 查询与生成交接材料。CLI 的会话、观察、保存点、回执命令及其当前限制见交接文档。CLI 只访问本机服务；Windows 下凭据及 CLI 的标准输入暂存使用当前 Windows 用户的系统加密。

## 本地安装包（K17）

`npm run build && npm pack` 生成 `specmill-<版本>.tgz`，内容仅含编译后的服务（dist-server）、静态页面（dist）、CLI（dist-cli）与 README；不含个人数据库、凭据、附件、测试产物或源码。`npm run verify:package` 在隔离目录完成打包内容检查、安装（优先离线缓存，回退在线并记录网络需求）、从安装产物启动服务、登录/项目/会话/保存/交接最小闭环与静态页面验证。

安装使用：在目标目录 `npm install <tgz>` 后，`npx specmill --data-dir <目录> --port <端口>` 启动服务（登录口令打印在终端），`npx specmill-cli --data-dir <目录> --server http://127.0.0.1:<端口> <命令>` 调用 CLI。启动前需 Node 24.x 与 Git；better-sqlite3 为原生模块，安装时可能需要网络下载预编译产物。停止服务直接结束进程（Ctrl+C）；重启后口令与浏览器会话失效、活跃写会话标记中断，数据目录与单实例锁约定与开发运行一致。恢复包仅含工作台记录与受管理附件，不含源码。

保存点提交结果未知时，浏览器会把未决正文保存在当前标签页的会话存储中（关闭标签页即清除，刷新后仍可恢复），并在站点存储中保留不含正文的请求标识用于核对回执；这些副本**不在工作台数据目录或恢复包中**。确认保存结果后只清理自身请求的记录；同一变更的多个标签页互不覆盖彼此的未决请求。不要把敏感信息放入进度正文，详见交接文档。

- [项目方案](docs/01-项目愿景与方案总览.md)
- [首版详细设计](docs/02-首版详细设计.md)
- [技术选型](docs/03-首版技术选型.md)
- [实施计划](docs/superpowers/plans/2026-11-14-v0.1-minimum-loop.md)
