import { randomUUID } from "node:crypto";
import { runProcessText } from "../process-text.ts";
import { runProcessTextAsync } from "../process-port.ts";
import { daemonRuntimePolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";

// Use Windows' own job accounting, including descendants whose immediate parent has exited.
// PowerShell's in-memory P/Invoke needs no addon, compiler toolchain or installed helper binary.
// https://learn.microsoft.com/windows/win32/procthread/job-objects
const jobApi = String.raw`
using System;
using System.ComponentModel;
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
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")]
  public static extern ulong GetTickCount64();
  static void Check(bool success) {
    if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  public static void Attach(uint pid, string name) {
    IntPtr job = CreateJobObject(IntPtr.Zero, name);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    int creationError = Marshal.GetLastWin32Error();
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
}
`;

function invocation(command: string): readonly string[] {
  const script = `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition @'\n${jobApi}\n'@\n${command}`;
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function establishWindowsProcessGroup(): Promise<string> {
  // Global names remain visible when a successor daemon runs in another logon session.
  const name = `Global\\HarnessRuntime-${randomUUID()}`;
  await runProcessTextAsync(
    "powershell.exe",
    invocation(`[HarnessRuntimeJob]::Attach(${process.pid}, ${quoted(name)})`),
    undefined,
    undefined,
    undefined,
    undefined,
    { timeoutMs: daemonRuntimePolicy.defaultValue.runtime.windowsProcessGroupTimeoutMs },
  );
  return name;
}

export interface WindowsGroupObservation {
  readonly activeProcesses: number | null;
  readonly uptimeMs: number;
}

export function observeWindowsProcessGroup(
  containmentId: string | undefined,
  terminate: boolean,
): WindowsGroupObservation {
  const active = containmentId
    ? `[HarnessRuntimeJob]::Observe(${quoted(containmentId)}, $${terminate ? "true" : "false"})`
    : "$null";
  const output = runProcessText(
    "powershell.exe",
    invocation(
      `@{ activeProcesses = ${active}; uptimeMs = [HarnessRuntimeJob]::GetTickCount64() } | ConvertTo-Json -Compress`,
    ),
    undefined,
    undefined,
    daemonRuntimePolicy.defaultValue.runtime.windowsProcessGroupTimeoutMs,
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
