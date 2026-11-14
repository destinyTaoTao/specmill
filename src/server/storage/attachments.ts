import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export function attachmentPathFor(attachmentsDir: string, projectId: string, sha256: string) {
  return join(attachmentsDir, projectId, sha256);
}

// 附件健康：文件存在且摘要与记录一致；缺失或损坏都明确暴露。
export async function checkAttachmentHealth(attachmentsDir: string, projectId: string, sha256: string, size: number): Promise<'ok' | 'missing' | 'corrupted'> {
  try {
    const content = await readFile(attachmentPathFor(attachmentsDir, projectId, sha256));
    return createHash('sha256').update(content).digest('hex') === sha256 && content.length === size ? 'ok' : 'corrupted';
  } catch { return 'missing'; }
}
