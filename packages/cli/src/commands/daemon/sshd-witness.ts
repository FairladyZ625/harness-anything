import { execFileSync } from "node:child_process";
import path from "node:path";

export interface ProcessWitnessRecord {
  readonly pid: number;
  readonly parentPid: number;
  readonly executable: string;
  readonly privileged: boolean;
}

export type ReadProcessWitness = (pid: number) => ProcessWitnessRecord | undefined;

export function verifyCurrentProcessHasPrivilegedSshdAncestor(
  platform: NodeJS.Platform = process.platform,
  parentPid: number = process.ppid
): boolean {
  return hasPrivilegedSshdAncestor(parentPid, platform === "win32" ? readWindowsProcess : readPosixProcess);
}

export function hasPrivilegedSshdAncestor(
  startingPid: number,
  readProcess: ReadProcessWitness
): boolean {
  const visited = new Set<number>();
  let pid = startingPid;
  for (let depth = 0; depth < 32 && pid > 1 && !visited.has(pid); depth += 1) {
    visited.add(pid);
    const record = readProcess(pid);
    if (!record) return false;
    if (record.privileged && isSshdExecutable(record.executable)) return true;
    pid = record.parentPid;
  }
  return false;
}

function readPosixProcess(pid: number): ProcessWitnessRecord | undefined {
  try {
    const output = execFileSync("ps", ["-o", "pid=", "-o", "ppid=", "-o", "uid=", "-o", "comm=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(output);
    if (!match) return undefined;
    return {
      pid: Number.parseInt(match[1], 10),
      parentPid: Number.parseInt(match[2], 10),
      executable: match[4].trim(),
      privileged: Number.parseInt(match[3], 10) === 0
    };
  } catch {
    return undefined;
  }
}

function readWindowsProcess(pid: number): ProcessWitnessRecord | undefined {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    "if ($null -eq $p) { exit 3 }",
    "$owner = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid",
    "[pscustomobject]@{ pid = [int]$p.ProcessId; parentPid = [int]$p.ParentProcessId; executable = [string]$p.Name; privileged = ($owner.Sid -eq 'S-1-5-18') } | ConvertTo-Json -Compress"
  ].join("; ");
  try {
    const parsed = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })) as { readonly pid?: unknown; readonly parentPid?: unknown; readonly executable?: unknown; readonly privileged?: unknown };
    if (typeof parsed.pid !== "number" || typeof parsed.parentPid !== "number" || typeof parsed.executable !== "string") return undefined;
    return {
      pid: parsed.pid,
      parentPid: parsed.parentPid,
      executable: parsed.executable,
      privileged: parsed.privileged === true
    };
  } catch {
    return undefined;
  }
}

function isSshdExecutable(executable: string): boolean {
  const basename = path.basename(executable).toLowerCase().replace(/\.exe$/u, "");
  return basename === "sshd" || basename.startsWith("sshd:");
}
