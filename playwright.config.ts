import { defineConfig } from '@playwright/test';

// Windows 下新增文件可能被杀毒扫描短暂锁住，串行测试负载也偏重：
// 超时放宽到 60 秒，避免把环境抖动误报为产品缺陷。
export default defineConfig({ testDir: 'tests/e2e', workers: 1, timeout: 60000, expect: { timeout: 8000 }, use: { browserName: 'chromium', headless: true, launchOptions: process.env.SPECMILL_TEST_CHROME ? { executablePath: process.env.SPECMILL_TEST_CHROME } : {} } });
