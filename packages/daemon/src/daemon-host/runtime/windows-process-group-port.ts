import { hash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcessText } from "../../runtime-engine/process-text.ts";
import { runProcessTextAsync } from "../process-port.ts";
import { daemonRuntimePolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";

// Use Windows' own job accounting, including descendants whose immediate parent has exited.
// PowerShell compiles this helper once per content hash into a small per-user executable so
// steady-state attach/observe calls avoid per-call PowerShell + csc.exe cold compilation.
// https://learn.microsoft.com/windows/win32/procthread/job-objects
const jobApi = String.raw`
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
public static class HarnessRuntimeJob {
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public Limits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting accounting, uint size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess,
    out IntPtr target, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")]
  public static extern ulong GetTickCount64();
  static void Check(bool success) {
    if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  public static string Attach(uint pid, string baseName) {
    string name = "Global\\" + baseName;
    IntPtr job = CreateJobObject(IntPtr.Zero, name);
    int creationError = Marshal.GetLastWin32Error();
    if (job == IntPtr.Zero && creationError == 5) {
      // Least-privilege scheduled tasks on Windows Server strip SeCreateGlobalPrivilege.
      // Fall back to the interactive logon session namespace so same-session daemon restarts
      // still observe and terminate the witnessed job without widening privileges.
      name = "Local\\" + baseName;
      job = CreateJobObject(IntPtr.Zero, name);
      creationError = Marshal.GetLastWin32Error();
    }
    if (job == IntPtr.Zero) throw new Win32Exception(creationError);
    try {
      if (creationError == 183) throw new InvalidOperationException("Runtime job already exists");
      ExtendedLimits limits = new ExtendedLimits();
      limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE; neither breakaway flag is allowed.
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
      IntPtr worker = OpenProcess(0x0100 | 0x0001 | 0x0040 | 0x1000, false, pid);
      if (worker == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        long workerCreated, helperCreated, exited, kernel, user;
        Check(GetProcessTimes(worker, out workerCreated, out exited, out kernel, out user));
        Check(GetProcessTimes(GetCurrentProcess(), out helperCreated, out exited, out kernel, out user));
        // A reused PID belongs to a process created after this helper, never to its parent.
        // Keep the checked handle pinned through assignment and duplication.
        if (workerCreated >= helperCreated) throw new InvalidOperationException("Runtime parent PID was reused");
        Check(AssignProcessToJobObject(job, worker));
        IntPtr ownedHandle;
        // The worker owns the only lasting, non-inheritable handle. Its OS exit closes it,
        // even after daemon loss. The helper predates assignment and is outside the job.
        Check(DuplicateHandle(GetCurrentProcess(), job, worker, out ownedHandle, 0, false, 2));
      } finally { CloseHandle(worker); }
    } finally { CloseHandle(job); }
    return name;
  }
  public static int Observe(string name, bool terminate) {
    IntPtr job = OpenJobObject(0x0004 | (terminate ? 0x0008u : 0u), false, name);
    if (job == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      // A witnessed job is destroyed only after its handles AND all member processes are gone.
      if (error == 2) return 0;
      throw new Win32Exception(error);
    }
    try {
      if (terminate) Check(TerminateJobObject(job, 1));
      Accounting accounting;
      Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
      return checked((int)accounting.ActiveProcesses);
    } finally { CloseHandle(job); }
  }
  public static int Main(string[] args) {
    if (args.Length == 3 && args[0] == "attach") {
      Console.WriteLine(Attach(uint.Parse(args[1], CultureInfo.InvariantCulture), args[2]));
      return 0;
    }
    if (args.Length == 3 && args[0] == "observe") {
      bool terminate = string.Equals(args[2], "true", StringComparison.OrdinalIgnoreCase);
      string active = string.IsNullOrEmpty(args[1])
        ? "null"
        : Observe(args[1], terminate).ToString(CultureInfo.InvariantCulture);
      Console.WriteLine("{\"activeProcesses\":" + active + ",\"uptimeMs\":" + GetTickCount64().ToString(CultureInfo.InvariantCulture) + "}");
      return 0;
    }
    Console.Error.WriteLine("Usage: attach <pid> <baseName> | observe <name> <terminate>");
    return 2;
  }
}
`;

const HELPER_SOURCE_HASH = hash("sha256", jobApi, "hex").slice(0, 16);
let pendingHelperCompile: Promise<string> | null = null;

function invocation(command: string): readonly string[] {
  const script = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; Add-Type -TypeDefinition @'\n${jobApi}\n'@\n${command}`;
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

function compileHelperInvocation(targetPath: string): readonly string[] {
  const escaped = quoted(targetPath);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$target = ${escaped}`,
    "if (-not (Test-Path -LiteralPath $target)) {",
    "  $tmp = \"$target.$([Guid]::NewGuid().ToString('N')).tmp.exe\"",
    "  Add-Type -TypeDefinition @'",
    jobApi,
    "'@ -OutputAssembly $tmp -OutputType ConsoleApplication",
    "  try {",
    "    Move-Item -LiteralPath $tmp -Destination $target -ErrorAction Stop",
    "  } catch {",
    "    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }",
    "    if (-not (Test-Path -LiteralPath $target)) { throw }",
    "  }",
    "}",
  ].join("\n");
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function cachedWindowsJobHelperPath(source: NodeJS.ProcessEnv = process.env): string {
  const localAppData = source.LOCALAPPDATA ?? source.LocalAppData;
  const localTemp = localAppData ? path.join(localAppData, "Temp") : undefined;
  const cacheDir = localTemp && existsSync(localTemp) ? localTemp : tmpdir();
  return path.join(cacheDir, `harness-runtime-job-${HELPER_SOURCE_HASH}.exe`);
}

function windowsJobCompileTimeoutMs(): number {
  return daemonRuntimePolicy.defaultValue.runtime.windowsProcessGroupTimeoutMs * 3;
}

async function ensureWindowsJobHelperAsync(): Promise<string> {
  const targetPath = cachedWindowsJobHelperPath();
  if (existsSync(targetPath)) return targetPath;
  if (pendingHelperCompile === null) {
    pendingHelperCompile = runProcessTextAsync(
      "powershell.exe",
      compileHelperInvocation(targetPath),
      undefined,
      minimalWindowsPowerShellEnv(),
      undefined,
      undefined,
      { timeoutMs: windowsJobCompileTimeoutMs() },
    )
      .then(() => {
        if (!existsSync(targetPath)) throw new Error(`Windows runtime job helper was not created at ${targetPath}`);
        return targetPath;
      })
      .finally(() => {
        pendingHelperCompile = null;
      });
  }
  return pendingHelperCompile;
}

function ensureWindowsJobHelperSync(): string {
  const targetPath = cachedWindowsJobHelperPath();
  if (existsSync(targetPath)) return targetPath;
  runProcessText(
    "powershell.exe",
    compileHelperInvocation(targetPath),
    undefined,
    minimalWindowsPowerShellEnv(),
    windowsJobCompileTimeoutMs(),
  );
  if (!existsSync(targetPath)) throw new Error(`Windows runtime job helper was not created at ${targetPath}`);
  return targetPath;
}

const WINDOWS_POWERSHELL_ENV_NAMES = new Set([
  "systemroot",
  "systemdrive",
  "windir",
  "os",
  "computername",
  "username",
  "userdomain",
  "programdata",
  "allusersprofile",
  "processor_architecture",
  "number_of_processors",
  "temp",
  "tmp",
  "pathext",
  "comspec",
  "path",
  "psmodulepath",
  "userprofile",
  "appdata",
  "localappdata",
  "homedrive",
  "homepath",
]);

/** Keep only the non-sensitive Windows runtime variables PowerShell and Add-Type need, stripping host secrets and oversized test vars. */
export function minimalWindowsPowerShellEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source))
    if (value !== undefined && WINDOWS_POWERSHELL_ENV_NAMES.has(key.toLowerCase())) env[key] = value;
  return env;
}

export async function establishWindowsProcessGroup(deps?: {
  readonly runPowerShell?: typeof runProcessTextAsync;
  readonly baseName?: string;
}): Promise<string> {
  // Prefer Global\ when SeCreateGlobalPrivilege is held so a successor daemon in another logon
  // session can observe the job; fall back to Local\ under least-privilege scheduled tasks on
  // Windows Server where SeCreateGlobalPrivilege is stripped.
  const baseName = deps?.baseName ?? `HarnessRuntime-${randomUUID()}`;
  const timeoutMs = daemonRuntimePolicy.defaultValue.runtime.windowsProcessGroupTimeoutMs;
  const output = deps?.runPowerShell
    ? await deps.runPowerShell(
        "powershell.exe",
        invocation(`[HarnessRuntimeJob]::Attach(${process.pid}, ${quoted(baseName)})`),
        undefined,
        minimalWindowsPowerShellEnv(),
        undefined,
        undefined,
        { timeoutMs },
      )
    : await runProcessTextAsync(
        await ensureWindowsJobHelperAsync(),
        ["attach", String(process.pid), baseName],
        undefined,
        minimalWindowsPowerShellEnv(),
        undefined,
        undefined,
        { timeoutMs },
      );
  const containmentId = output.trim();
  if (containmentId !== `Global\\${baseName}` && containmentId !== `Local\\${baseName}`)
    throw new Error(`Unexpected Windows runtime job name: ${containmentId || "(empty)"}`);
  return containmentId;
}

export interface WindowsGroupObservation {
  readonly activeProcesses: number | null;
  readonly uptimeMs: number;
}

export function observeWindowsProcessGroup(
  containmentId: string | undefined,
  terminate: boolean,
): WindowsGroupObservation {
  const timeoutMs = daemonRuntimePolicy.defaultValue.runtime.windowsProcessGroupTimeoutMs;
  const output = runProcessText(
    ensureWindowsJobHelperSync(),
    ["observe", containmentId ?? "", terminate ? "true" : "false"],
    undefined,
    minimalWindowsPowerShellEnv(),
    timeoutMs,
  );
  const value = JSON.parse(output) as WindowsGroupObservation;
  // External process output is decoded here; malformed/partial accounting cannot authorize release.
  if (
    !Number.isSafeInteger(value.uptimeMs) ||
    value.uptimeMs < 0 ||
    (value.activeProcesses !== null && (!Number.isSafeInteger(value.activeProcesses) || value.activeProcesses < 0))
  )
    throw new Error("Invalid Windows runtime job accounting");
  return value;
}
