import { existsSync, readFileSync, realpathSync, readlinkSync } from "node:fs";
import path from "node:path";
import type { ManagedRbacHost } from "./managed-host.ts";

export async function stopManagedPostgresOrphan(input: {
  readonly host: ManagedRbacHost;
  readonly pgCtl: string;
  readonly binary: string;
  readonly data: string;
  readonly port: number;
  readonly platform: NodeJS.Platform;
}): Promise<void> {
  const pidFile = path.join(input.data, "postmaster.pid");
  if (!existsSync(pidFile)) return;

  const lines = readFileSync(pidFile, "utf8").split(/\r?\n/u),
    pid = Number(lines[0]),
    pidData = lines[1],
    pidPort = Number(lines[3]);
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !pidData ||
    !existsSync(pidData) ||
    realpathSync(pidData) !== realpathSync(input.data) ||
    pidPort !== input.port
  )
    return;

  const status = await input.host.runProcessExitAsync(
    input.pgCtl,
    ["status", "-D", input.data],
    undefined,
    undefined,
    undefined,
    undefined,
    { timeoutMs: 5_000 },
  );
  if (status.exitCode !== 0 || !(await processOwnsPostgres(input, pid, input.port))) return;

  const stopped = await input.host.runProcessExitAsync(
    input.pgCtl,
    ["stop", "-D", input.data, "-m", "fast", "-t", "30"],
    undefined,
    undefined,
    undefined,
    undefined,
    { timeoutMs: 35_000 },
  );
  if (stopped.exitCode !== 0)
    throw Object.assign(new Error("The managed PostgreSQL postmaster could not be stopped cleanly."), {
      code: "rbac_postgres_orphan_stop_failed",
    });
}

async function processOwnsPostgres(
  input: {
    readonly host: ManagedRbacHost;
    readonly binary: string;
    readonly data: string;
    readonly platform: NodeJS.Platform;
  },
  pid: number,
  port: number,
): Promise<boolean> {
  const binary = realpathSync(input.binary),
    data = realpathSync(input.data),
    currentPid = Number(readFileSync(path.join(input.data, "postmaster.pid"), "utf8").split(/\r?\n/u)[0]);
  if (currentPid !== pid) return false;

  if (input.platform === "linux") {
    const processRoot = `/proc/${pid}`;
    if (!existsSync(processRoot)) return false;
    return (
      readlinkSync(path.join(processRoot, "exe")) === binary && readlinkSync(path.join(processRoot, "cwd")) === data
    );
  }

  if (input.platform === "darwin") {
    const [image, directory] = await Promise.all([
      input.host.runProcessExitAsync("lsof", ["-nP", "-a", "-p", String(pid), "-d", "txt", "-Fn"]),
      input.host.runProcessExitAsync("lsof", ["-nP", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]),
    ]);
    return (
      image.exitCode === 0 &&
      image.stdout.split(/\r?\n/u).includes(`n${binary}`) &&
      directory.exitCode === 0 &&
      directory.stdout.split(/\r?\n/u).includes(`n${data}`)
    );
  }

  if (input.platform === "win32") {
    const query =
        `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; ` +
        "if ($null -eq $p) { exit 1 }; " +
        "[pscustomobject]@{ path=$p.ExecutablePath; commandLine=$p.CommandLine } | ConvertTo-Json -Compress",
      process = await input.host.runProcessExitAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        query,
      ]);
    if (process.exitCode !== 0) return false;
    const observed = JSON.parse(process.stdout) as { readonly path?: string; readonly commandLine?: string },
      commandLine = observed.commandLine ?? "",
      dataArgument = new RegExp(`(?:^|\\s)-D\\s+(?:"${escapeRegExp(data)}"|${escapeRegExp(data)})(?=\\s|$)`, "iu"),
      portArgument = new RegExp(`(?:^|\\s)-p\\s+${port}(?=\\s|$)`, "u");
    return (
      observed.path?.toLowerCase() === binary.toLowerCase() &&
      dataArgument.test(commandLine) &&
      portArgument.test(commandLine)
    );
  }

  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
