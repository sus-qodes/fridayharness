import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * A lifetime boundary for a run's process tree (review F07): every process the run starts, however
 * deep and whether or not its parent is still alive, belongs to the group, and ending the group ends
 * them all, confirmed by counting what is left rather than assumed from a signal sent.
 *
 * A grouped run starts at Friday's gate (`GATE_SOURCE`), which starts nothing until it is in the
 * group, so nothing the run starts can escape it.
 * - Windows: a job object with kill-on-close, held by one helper process per daemon. If the helper
 *   or the daemon dies, the job's handle closes and every process in it ends.
 * - POSIX: the process group the gate leads, in its own session. If the daemon dies, the gate's
 *   standard input closes and the gate ends its group. A process that starts its own session
 *   leaves the group: a documented limit (ADR-0029 §8).
 */
export interface ProcessGroup {
  readonly id: string;
  /** Once ended, nothing more is adopted. */
  readonly ended: boolean;
  /**
   * Adds a started process to the group: Windows puts it in the job; POSIX records the leader.
   * Rejects for a group that was ended, so a run stopped before it began never begins.
   */
  adopt(pid: number): Promise<void>;
  /** Ends every process of the group; resolves once none is left, rejects after `timeoutMs`. */
  terminate(timeoutMs?: number): Promise<void>;
  /** Processes still alive in the group (POSIX: 1 while the group exists, else 0). */
  active(): Promise<number>;
  /** Releases the group; anything still in it ends. */
  close(): Promise<void>;
}

/** Makes the groups of one daemon; `close` ends every one of them. */
export class ProcessGroups {
  #host: JobHost | null = null;
  #next = 0;
  readonly #groups = new Set<ProcessGroup>();

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  create(): ProcessGroup {
    const id = `g${++this.#next}`;
    const forget = () => this.#groups.delete(group);
    const group: ProcessGroup =
      process.platform === 'win32'
        ? new JobGroup(
            id,
            () => {
              if (!this.#host?.alive) this.#host = new JobHost(this.env);
              return this.#host;
            },
            forget,
          )
        : new PosixGroup(id, forget);
    this.#groups.add(group);
    return group;
  }

  /** Ends every group's processes, then the helper. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.#groups].map((g) => g.terminate().finally(() => g.close())));
    await this.#host?.close();
    this.#host = null;
  }
}

class PosixGroup implements ProcessGroup {
  #leader: number | null = null;
  #ended = false;
  constructor(
    readonly id: string,
    private readonly forget: () => void,
  ) {}

  get ended(): boolean {
    return this.#ended;
  }

  async adopt(pid: number): Promise<void> {
    if (this.#ended) throw new Error(`group ${this.id} was ended`);
    this.#leader = pid;
  }

  async active(): Promise<number> {
    if (this.#leader === null) return 0;
    try {
      process.kill(-this.#leader, 0);
      return 1;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM' ? 1 : 0;
    }
  }

  async terminate(timeoutMs = 10_000): Promise<void> {
    this.#ended = true;
    if (this.#leader === null) return;
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        process.kill(-this.#leader, 'SIGKILL');
      } catch {
        // gone, or nothing left to signal
      }
      if ((await this.active()) === 0) return;
      if (Date.now() > end)
        throw new Error(`processes of group ${this.#leader} were still running after ${timeoutMs} ms`);
      await sleep(25);
    }
  }

  async close(): Promise<void> {
    this.forget();
    await this.terminate().catch(() => undefined);
  }
}

class JobGroup implements ProcessGroup {
  /** The helper holding this group's job: a later helper never knows it. */
  #host: JobHost | null = null;
  #closed = false;
  #ended = false;
  constructor(
    readonly id: string,
    private readonly host: () => JobHost,
    private readonly forget: () => void,
  ) {}

  get ended(): boolean {
    return this.#ended;
  }

  async adopt(pid: number): Promise<void> {
    if (this.#ended || this.#closed) throw new Error(`group ${this.id} was ended`);
    this.#host ??= this.host();
    await this.#host.call({ op: 'adopt', job: this.id, pid });
    // Ended while the helper placed it: the terminate queued behind the adoption ends it.
    if (this.#ended) throw new Error(`group ${this.id} was ended`);
  }

  async active(): Promise<number> {
    if (!this.#host || this.#closed) return 0;
    // The helper that held the job is gone: its handle closed, and the job's processes ended with it.
    if (!this.#host.alive) return 0;
    const r = await this.#host.call({ op: 'active', job: this.id });
    return Number(r.active ?? 0);
  }

  async terminate(timeoutMs = 10_000): Promise<void> {
    this.#ended = true;
    if (!this.#host?.alive || this.#closed) return;
    const end = Date.now() + timeoutMs;
    await this.#host.call({ op: 'terminate', job: this.id });
    while ((await this.active()) > 0) {
      if (Date.now() > end) throw new Error(`processes of job ${this.id} were still running after ${timeoutMs} ms`);
      await sleep(25);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.forget();
    if (this.#host?.alive) {
      await this.#host.call({ op: 'close', job: this.id }).catch(() => undefined);
    }
  }
}

/** The PowerShell helper that holds the daemon's job objects; its stdin closing ends them all. */
class JobHost {
  readonly #child: ChildProcess;
  readonly #ready: Promise<void>;
  readonly #waiting = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();
  #seq = 0;
  #exited = false;

  constructor(env: NodeJS.ProcessEnv) {
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
    this.#child = spawn(
      path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(JOB_HOST_SCRIPT, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.#child.stderr?.resume();
    let markReady: () => void = () => {};
    let failReady: (e: Error) => void = () => {};
    this.#ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
    });
    // Never an unhandled rejection: callers see the failure through `call`.
    this.#ready.catch(() => undefined);
    const lines = createInterface({ input: this.#child.stdout as NodeJS.ReadableStream });
    lines.on('line', (line) => {
      let r: Reply;
      try {
        r = JSON.parse(line) as Reply;
      } catch {
        return;
      }
      if (r.ready) {
        markReady();
        return;
      }
      const w = this.#waiting.get(Number(r.id));
      if (!w) return;
      this.#waiting.delete(Number(r.id));
      if (r.ok) w.resolve(r);
      else w.reject(new Error(`job object: ${r.error ?? 'failed'}`));
    });
    const gone = (why: string) => {
      this.#exited = true;
      failReady(new Error(why));
      for (const w of this.#waiting.values()) w.reject(new Error(why));
      this.#waiting.clear();
    };
    this.#child.once('error', (e) => gone(`the job helper could not start: ${e.message}`));
    this.#child.once('exit', (code) => gone(`the job helper exited (${code})`));
  }

  get alive(): boolean {
    return !this.#exited;
  }

  async call(req: { op: string; job: string; pid?: number }): Promise<Reply> {
    await withTimeout(this.#ready, 30_000, 'the job helper did not start within 30 s');
    if (this.#exited) throw new Error('the job helper is gone');
    const id = ++this.#seq;
    const answer = new Promise<Reply>((resolve, reject) => this.#waiting.set(id, { resolve, reject }));
    this.#child.stdin?.write(`${JSON.stringify({ ...req, id })}\n`);
    return withTimeout(answer, 15_000, `the job helper did not answer ${req.op}`);
  }

  async close(): Promise<void> {
    if (this.#exited) return;
    const exited = new Promise<void>((r) => this.#child.once('exit', () => r()));
    this.#child.stdin?.end();
    await withTimeout(exited, 5_000, 'slow').catch(() => {
      this.#child.kill();
    });
  }
}

interface Reply {
  id?: number;
  ready?: boolean;
  ok?: boolean;
  error?: string;
  active?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The gate: the first process of a grouped run. It starts nothing until its spec arrives as the
 * first line of standard input, which Friday sends only once the gate is in the group (Windows: in
 * the job). It then starts the real command, which inherits the group and the gate's output, and
 * exits as the command does. Standard input stays open while Friday runs: on POSIX, where the gate
 * leads the process group, its end means Friday is gone, and the gate ends the whole group.
 */
export const GATE_SOURCE = [
  "let buf = '';",
  'let started = false;',
  "const posix = process.platform !== 'win32';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (d) => {",
  '  if (started) return;',
  '  buf += d;',
  "  const nl = buf.indexOf('\\n');",
  '  if (nl < 0) return;',
  '  started = true;',
  '  const spec = JSON.parse(buf.slice(0, nl));',
  "  const c = require('node:child_process').spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, windowsVerbatimArguments: spec.verbatim });",
  "  c.on('error', (e) => { process.stderr.write('could not start ' + spec.file + ': ' + e.message + '\\n'); process.exit(127); });",
  "  c.on('exit', (code, signal) => { if (signal && posix) process.kill(process.pid, signal); else process.exit(code === null ? 1 : code); });",
  '});',
  "process.stdin.on('end', () => {",
  "  if (posix) { try { process.kill(-process.pid, 'SIGKILL'); } catch {} }",
  '  if (!started) process.exit(1);',
  '});',
].join('\n');

/** Job objects through P/Invoke from Windows PowerShell; JSON lines in and out. */
const JOB_HOST_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class FridayJobs {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long A; public long B; public uint LimitFlags; public UIntPtr C; public UIntPtr D; public uint E; public UIntPtr F; public uint G; public uint H; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A; public ulong B; public ulong C; public ulong D; public ulong E; public ulong F; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit Basic; public IoCounters Io; public UIntPtr A; public UIntPtr B; public UIntPtr C; public UIntPtr D; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long A; public long B; public long C; public long D; public uint E; public uint TotalProcesses; public uint ActiveProcesses; public uint F; }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  public static IntPtr Create() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed: " + Marshal.GetLastWin32Error());
    ExtendedLimit info = new ExtendedLimit();
    info.Basic.LimitFlags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(ExtendedLimit)))) throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
    return job;
  }
  public static void Assign(IntPtr job, uint pid) {
    IntPtr process = OpenProcess(0x0101 | 0x1000, false, pid);
    if (process == IntPtr.Zero) throw new Exception("OpenProcess failed: " + Marshal.GetLastWin32Error());
    try { if (!AssignProcessToJobObject(job, process)) throw new Exception("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error()); }
    finally { CloseHandle(process); }
  }
  public static uint Active(IntPtr job) {
    Accounting a;
    if (!QueryInformationJobObject(job, 1, out a, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new Exception("QueryInformationJobObject failed: " + Marshal.GetLastWin32Error());
    return a.ActiveProcesses;
  }
  public static void Terminate(IntPtr job) { if (!TerminateJobObject(job, 1)) throw new Exception("TerminateJobObject failed: " + Marshal.GetLastWin32Error()); }
  public static void Close(IntPtr job) { CloseHandle(job); }
}
"@
$jobs = @{}
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $reply = @{ ok = $true }
  try {
    $req = $line | ConvertFrom-Json
    $reply.id = $req.id
    $key = [string]$req.job
    switch ($req.op) {
      'adopt' { if (-not $jobs.ContainsKey($key)) { $jobs[$key] = [FridayJobs]::Create() }; [FridayJobs]::Assign($jobs[$key], [uint32]$req.pid) }
      'active' { if ($jobs.ContainsKey($key)) { $reply.active = [FridayJobs]::Active($jobs[$key]) } else { $reply.active = 0 } }
      'terminate' { if ($jobs.ContainsKey($key)) { [FridayJobs]::Terminate($jobs[$key]) } }
      'close' { if ($jobs.ContainsKey($key)) { [FridayJobs]::Close($jobs[$key]); $jobs.Remove($key) } }
      default { throw "unknown op $($req.op)" }
    }
  } catch { $reply.ok = $false; $reply.error = $_.Exception.Message }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
`;
