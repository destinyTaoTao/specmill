import { spawn } from 'node:child_process';
import { join } from 'node:path';

async function dpapi(action: 'Protect' | 'Unprotect', bytes: Buffer): Promise<Buffer> {
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inputText = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($inputText)
$result = [Security.Cryptography.ProtectedData]::${action}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($result))`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return await new Promise((resolve, reject) => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let size = 0;
    const timeout = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4 * 1024 * 1024) child.kill(); else chunks.push(chunk); });
    child.on('error', () => { clearTimeout(timeout); reject(new Error('Credential protection unavailable')); });
    child.on('close', code => {
      clearTimeout(timeout);
      const output = Buffer.concat(chunks).toString('utf8').trim();
      if (code !== 0 || !output || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) return reject(new Error('Credential protection failed'));
      resolve(Buffer.from(output, 'base64'));
    });
    child.stdin.on('error', () => { /* child exit handles the error */ });
    child.stdin.end(bytes.toString('base64'));
  });
}

export async function encodeSecret(value: string) {
  const bytes = Buffer.from(value, 'utf8');
  return process.platform === 'win32' ? `DPAPI1:${(await dpapi('Protect', bytes)).toString('base64')}` : `LOCAL1:${bytes.toString('base64')}`;
}

export async function decodeSecret(value: string) {
  if (process.platform === 'win32' && value.startsWith('DPAPI1:')) return (await dpapi('Unprotect', Buffer.from(value.slice(7), 'base64'))).toString('utf8');
  if (process.platform !== 'win32' && value.startsWith('LOCAL1:')) return Buffer.from(value.slice(7), 'base64').toString('utf8');
  throw new Error('Unsupported credential file');
}
