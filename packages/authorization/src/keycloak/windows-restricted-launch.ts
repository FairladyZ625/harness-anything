import type { ManagedRbacHost } from "./managed-host.ts";

let cachedWindowsAdminToken: Promise<boolean> | null = null;

const WINDOWS_POWERSHELL_ENV_NAMES = new Set([
  "systemroot",
  "windir",
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
  "lang",
  "tz",
]);

/**
 * Keep only the Windows runtime variables PowerShell, Add-Type (`csc.exe`), and PostgreSQL need,
 * avoiding .NET Framework's 65,535-byte `Process.Start` environment block limit when the parent
 * inherits large test/tooling variables (such as `HARNESS_TEST_TIER_MANIFEST`).
 */
export function minimalWindowsPowerShellEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (WINDOWS_POWERSHELL_ENV_NAMES.has(lower) || lower.startsWith("lc_") || lower.startsWith("pg")) env[key] = value;
  }
  return env;
}

/**
 * PostgreSQL refuses to run `postgres.exe` with an enabled `BUILTIN\Administrators` token
 * (such as GitHub Actions `windows-latest` runners or elevated Windows shells), whereas
 * `initdb.exe` and `pg_ctl.exe` self-restrict via Win32 `CreateRestrictedToken`.
 */
export function isWindowsAdminToken(host: ManagedRbacHost, platform: NodeJS.Platform): Promise<boolean> {
  if (platform !== "win32") return Promise.resolve(false);
  if (cachedWindowsAdminToken === null) {
    cachedWindowsAdminToken = host
      .runProcessExitAsync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
        ],
        undefined,
        minimalWindowsPowerShellEnv(),
      )
      .then(
        (result) => result.exitCode === 0 && result.stdout.trim().toLowerCase() === "true",
        () => false,
      );
  }
  return cachedWindowsAdminToken;
}

export function quoteWindowsArg(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"]/u.test(value)) return value;
  let result = '"',
    backslashes = 0;
  for (const ch of value) {
    if (ch === "\\") {
      backslashes += 1;
    } else if (ch === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      if (backslashes > 0) {
        result += "\\".repeat(backslashes);
        backslashes = 0;
      }
      result += ch;
    }
  }
  if (backslashes > 0) result += "\\".repeat(backslashes * 2);
  return `${result}"`;
}

const restrictedLauncherSource = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
public static class HarnessRestrictedLauncher {
  [StructLayout(LayoutKind.Sequential)] private struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct STARTUPINFO {
    public int cb; public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] private struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS { public ulong R, W, O, RT, WT, OT; }
  [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(int n);
  [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr p, uint a, out IntPtr t);
  [DllImport("advapi32.dll", SetLastError = true)] private static extern bool CreateRestrictedToken(IntPtr t, uint f, uint dc, [In] SID_AND_ATTRIBUTES[] ds, uint pc, IntPtr p, uint rc, IntPtr r, out IntPtr nt);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool CreateProcessAsUser(IntPtr t, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inh, uint cf, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr j, int c, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION i, int l);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr p, out uint c);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr h);
  public static int Run(string exePath, string commandLine) {
    IntPtr token = IntPtr.Zero, restricted = IntPtr.Zero, job = IntPtr.Zero;
    var pi = new PROCESS_INFORMATION();
    GCHandle ah = default(GCHandle), ph = default(GCHandle);
    try {
      if (!OpenProcessToken(GetCurrentProcess(), 0x018Bu, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
      var aSid = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
      var pSid = new SecurityIdentifier(WellKnownSidType.BuiltinPowerUsersSid, null);
      byte[] ab = new byte[aSid.BinaryLength], pb = new byte[pSid.BinaryLength];
      aSid.GetBinaryForm(ab, 0); pSid.GetBinaryForm(pb, 0);
      ah = GCHandle.Alloc(ab, GCHandleType.Pinned); ph = GCHandle.Alloc(pb, GCHandleType.Pinned);
      var ds = new SID_AND_ATTRIBUTES[] {
        new SID_AND_ATTRIBUTES { Sid = ah.AddrOfPinnedObject(), Attributes = 0 },
        new SID_AND_ATTRIBUTES { Sid = ph.AddrOfPinnedObject(), Attributes = 0 }
      };
      if (!CreateRestrictedToken(token, 0x1u, 2u, ds, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted)) throw new Win32Exception(Marshal.GetLastWin32Error());
      var si = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)), dwFlags = 0x100, hStdInput = GetStdHandle(-10), hStdOutput = GetStdHandle(-11), hStdError = GetStdHandle(-12) };
      if (!CreateProcessAsUser(restricted, exePath, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, 0x08000004u, IntPtr.Zero, null, ref si, out pi)) throw new Win32Exception(Marshal.GetLastWin32Error());
      job = CreateJobObject(IntPtr.Zero, null);
      if (job != IntPtr.Zero) {
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = 0x2000u;
        if (SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(info))) AssignProcessToJobObject(job, pi.hProcess);
      }
      if (ResumeThread(pi.hThread) == 0xFFFFFFFFu) throw new Win32Exception(Marshal.GetLastWin32Error());
      WaitForSingleObject(pi.hProcess, 0xFFFFFFFFu);
      uint code = 1; GetExitCodeProcess(pi.hProcess, out code); return unchecked((int)code);
    } finally {
      if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
      if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
      if (job != IntPtr.Zero) CloseHandle(job);
      if (restricted != IntPtr.Zero) CloseHandle(restricted);
      if (token != IntPtr.Zero) CloseHandle(token);
      if (ah.IsAllocated) ah.Free();
      if (ph.IsAllocated) ph.Free();
    }
  }
}
`.trim();

/**
 * Builds a PowerShell command that launches `command` under a Win32 restricted token
 * (stripping `BUILTIN\Administrators` and `BUILTIN\Power Users` with `DISABLE_MAX_PRIVILEGE`),
 * inheriting standard handles and binding the child tree to a `KILL_ON_JOB_CLOSE` Job Object.
 */
export function buildWindowsRestrictedLaunchArgs(
  command: string,
  args: readonly string[],
): readonly [string, readonly string[]] {
  const commandLine = [quoteWindowsArg(command), ...args.map(quoteWindowsArg)].join(" "),
    exeB64 = Buffer.from(command, "utf8").toString("base64"),
    cmdB64 = Buffer.from(commandLine, "utf8").toString("base64"),
    script = [
      "$ErrorActionPreference = 'Stop'",
      "$ProgressPreference = 'SilentlyContinue'",
      "$src = @'",
      restrictedLauncherSource,
      "'@",
      "Add-Type -TypeDefinition $src -Language CSharp",
      `$exe = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${exeB64}'))`,
      `$cmd = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${cmdB64}'))`,
      "[Environment]::Exit([HarnessRestrictedLauncher]::Run($exe, $cmd))",
    ].join("\n"),
    encoded = Buffer.from(script, "utf16le").toString("base64");
  return [
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", encoded],
  ];
}

export async function windowsPostgresLaunch(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform,
  host: ManagedRbacHost,
  isAdmin?: () => Promise<boolean> | boolean,
): Promise<readonly [string, readonly string[]]> {
  if (platform !== "win32") return [command, [...args]];
  const elevated = isAdmin ? await isAdmin() : await isWindowsAdminToken(host, platform);
  return elevated ? buildWindowsRestrictedLaunchArgs(command, args) : [command, [...args]];
}
