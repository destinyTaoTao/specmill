import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { committedSource } from './git.js';

export async function readSpecification(root: string, commonDir: string, path: string) {
  if (!path || isAbsolute(path) || extname(path).toLowerCase() !== '.md') throw new Error('Invalid specification path');
  const candidate = resolve(root, path);
  const actual = await realpath(candidate);
  const within = relative(root, actual);
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('Specification is outside workspace');
  const link = await lstat(candidate);
  if (!link.isFile() || link.isSymbolicLink() || link.size > 2 * 1024 * 1024) throw new Error('Invalid specification file');
  const before = await stat(actual);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of createReadStream(actual)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 2 * 1024 * 1024) throw new Error('Specification exceeds limit');
    chunks.push(bytes);
  }
  const after = await stat(actual);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || size !== after.size) throw new Error('Specification changed during reading');
  const bytes = Buffer.concat(chunks);
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const source = await committedSource(root, commonDir, within, sha256);
  return { path: within.replaceAll('\\', '/'), content, sha256, ...source };
}
