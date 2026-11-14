# SpecMill

面向个人开发者的本机开发续做工作台，帮助跨会话、跨工具保存和接续开发上下文。

当前是开发中的首版：已有本机项目与 Git 工作区、Markdown 规格基线、单写会话、保存点和部分 CLI。固定交接材料、正式验收、项目导出恢复及首版完整闭环仍未实现；尚未完成真实双工具价值验证。继续开发前请阅读[实施状态与交接](docs/agents/2026-11-14-mvp-handoff.md)。

需要 Node.js 24.22.3 或更高的 24.x 版本和 npm；项目用 `.node-version` 指定开发基线。运行 `npm ci` 安装依赖，运行 `npm run build` 后运行 `npm start`。在浏览器打开终端显示的本机地址，使用终端中的一次性启动口令登录。重启后口令和浏览器会话均失效。

默认数据存放在 Windows 的 `%LOCALAPPDATA%/SpecMill`；可用 `npm start -- --data-dir <目录> --port <端口>` 指定其他目录和端口。数据目录只允许一个服务实例使用；请勿提交数据库、附件或口令。运行 `npm test`、`npm run lint`、`npm run typecheck` 和 `npm run build` 验证。

服务被强制终止后，单实例锁可能短暂保留；确认旧进程已退出后稍等，再重新启动。浏览器测试需安装 Playwright Chromium，或设置 `SPECMILL_TEST_CHROME` 指向本机 Chrome 后运行 `npm run test:e2e`。

构建后可通过 `npm run cli -- project list --json` 查看项目，再使用 `workspace list --project <项目ID>`、`change list --project <项目ID>` 和 `change show --change <变更ID>` 查询。CLI 的会话、观察、保存点和回执命令及其当前限制见交接文档。CLI 只访问本机服务；Windows 下凭据及 CLI 的标准输入暂存使用当前 Windows 用户的系统加密。

保存点提交结果未知时，浏览器会把未决正文保存在当前标签页的会话存储中（关闭标签页即清除，刷新后仍可恢复），并在站点存储中保留不含正文的请求标识用于核对回执；这些副本**不在工作台数据目录或恢复包中**。确认保存结果后只清理自身请求的记录；同一变更的多个标签页互不覆盖彼此的未决请求。不要把敏感信息放入进度正文，详见交接文档。

- [项目方案](docs/01-项目愿景与方案总览.md)
- [首版详细设计](docs/02-首版详细设计.md)
- [技术选型](docs/03-首版技术选型.md)
- [实施计划](docs/superpowers/plans/2026-11-14-v0.1-minimum-loop.md)
