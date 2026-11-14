import { defineConfig } from '@playwright/test';

export default defineConfig({ testDir: 'tests/e2e', workers: 1, use: { browserName: 'chromium', headless: true, launchOptions: process.env.SPECMILL_TEST_CHROME ? { executablePath: process.env.SPECMILL_TEST_CHROME } : {} } });
