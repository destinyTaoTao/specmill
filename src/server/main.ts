import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { rename, rm, writeFile } from 'node:fs/promises';
import { buildApp } from './app.js';
import { encodeSecret } from '../shared/credentials.js';

const args = process.argv.slice(2);
function option(name: string, fallback: string) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return args[index + 1];
}
const port = Number(option('--port', '43127'));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
const dataDir = resolve(option('--data-dir', join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'SpecMill')));
const ownerToken = randomBytes(32).toString('hex');
const agentToken = randomBytes(32).toString('hex');
const app = await buildApp({ dataDir, port, ownerToken, agentToken, webDir: resolve('dist') });
try {
  const temporary = join(dataDir, `cli-token-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, await encodeSecret(agentToken), { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(dataDir, 'cli-token'));
  } finally { await rm(temporary, { force: true }); }
  await app.listen({ host: '127.0.0.1', port });
  console.log(`SpecMill: http://127.0.0.1:${port}\n本次登录口令：${ownerToken}\n数据目录：${dataDir}`);
} catch (error) { await app.close(); throw error; }
