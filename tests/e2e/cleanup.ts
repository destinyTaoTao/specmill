import { rm as rmNode } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// Windows 可能在测试结束后仍短暂锁定刚写入的临时目录（杀毒扫描等）。
// 与 node:fs/promises 的 rm 同签名：失败时延迟重试一次，仍失败则交给系统临时目录策略。
export async function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
  try { await rmNode(path, options); }
  catch {
    await delay(1500);
    await rmNode(path, options).catch(() => { /* 残留交由系统临时目录清理 */ });
  }
}
