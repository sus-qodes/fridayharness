import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * Windows DPAPI for the current user (ADR-0029 §2), through Windows PowerShell: no native module.
 * Data travels as base64 on standard input and output, never on a command line. The secret's name
 * is the additional entropy, so a value copied under another name does not decrypt. Asynchronous:
 * starting PowerShell takes about half a second, which must not hold up the daemon.
 */

const script = (op: 'Protect' | 'Unprotect') =>
  [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'Add-Type -AssemblyName System.Security',
    '$lines = [Console]::In.ReadToEnd().Split([char]10)',
    '$entropy = [Convert]::FromBase64String($lines[0].Trim())',
    '$data = [Convert]::FromBase64String($lines[1].Trim())',
    `$out = [System.Security.Cryptography.ProtectedData]::${op}($data, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('\n');

export function dpapiAvailable(): boolean {
  return process.platform === 'win32';
}

/** Windows PowerShell by absolute path, so a `powershell.exe` earlier on PATH is never used. */
function powershell(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

const entropyFor = (name: string) => createHash('sha256').update(`friday-credential:${name}`).digest();

function run(op: 'Protect' | 'Unprotect', name: string, data: Buffer, env: NodeJS.ProcessEnv): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershell(env),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script(op), 'utf16le').toString('base64'),
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill();
      reject(new Error('DPAPI did not answer within 30 s'));
    }, 30_000);
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString('ascii');
    });
    // stderr is PowerShell's error record: it may describe the input, so it is never passed on.
    child.stderr.resume();
    child.once('error', (e) => {
      clearTimeout(timer);
      if (!failed) reject(new Error(`could not start Windows PowerShell: ${e.message}`));
      failed = true;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) reject(new Error(`DPAPI ${op.toLowerCase()} failed (exit ${code})`));
      else resolve(Buffer.from(out.trim(), 'base64'));
    });
    child.stdin.end(`${entropyFor(name).toString('base64')}\n${data.toString('base64')}\n`);
  });
}

export function dpapiProtect(name: string, plain: Buffer, env: NodeJS.ProcessEnv = process.env): Promise<Buffer> {
  return run('Protect', name, plain, env);
}

export function dpapiUnprotect(name: string, blob: Buffer, env: NodeJS.ProcessEnv = process.env): Promise<Buffer> {
  return run('Unprotect', name, blob, env);
}
