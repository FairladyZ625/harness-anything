import { daemonProtocolFleetPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonStdioLogPath } from "../lifecycle-log.ts";
import { runProcessExitAsync } from "../process-port.ts";
import { localDaemonTargetKey } from "./local-daemon-target.ts";

export type DaemonServiceManager = "launchd" | "systemd" | "task-scheduler";
export interface DaemonServiceUnit {
  readonly manager: DaemonServiceManager;
  /** The systemd unit name without its suffix, launchd label, or scheduled task name. */
  readonly name: string;
  readonly unitPath: string;
}
export interface DaemonServiceState {
  readonly loaded: boolean;
  readonly pid: number | null;
}
export type DaemonServiceCommand = readonly [command: string, ...args: string[]];

/** The process exits with this when a supervised daemon leaves for a newer disk build: non-zero is
 *  what makes the service manager (or, on Windows, the task launcher script) start the successor, so
 *  the daemon must not start one itself. */
export const daemonSupersededExitCode = 75;

// One unit per (user root, daemon id), keyed exactly like the daemon endpoint: two user roots on one
// machine get two units, and installing the same target twice lands on the same file.
export function daemonServiceUnit(
  target: { readonly userRoot: string; readonly daemonId: string },
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): DaemonServiceUnit | null {
  const name = `harness-anything-daemon-${localDaemonTargetKey(target.userRoot, target.daemonId)}`;
  if (platform === "darwin")
    return { manager: "launchd", name, unitPath: path.join(home, "Library", "LaunchAgents", `${name}.plist`) };
  if (platform === "linux")
    return { manager: "systemd", name, unitPath: path.join(home, ".config", "systemd", "user", `${name}.service`) };
  if (platform === "win32")
    return { manager: "task-scheduler", name, unitPath: path.join(target.userRoot, "services", `${name}.xml`) };
  return null;
}
export function installedDaemonServiceUnit(target: {
  readonly userRoot: string;
  readonly daemonId: string;
}): DaemonServiceUnit | null {
  const unit = daemonServiceUnit(target);
  return unit !== null && existsSync(unit.unitPath) ? unit : null;
}

// Each unit's restart path carries an existing invariant and is not style:
// - KillMode=process: runtime workers outlive a daemon restart and are re-adopted by pid, and
//   systemd would otherwise kill the unit's whole control group, workers included. launchd needs
//   no counterpart: it only cleans up the daemon's own process group, and workers are spawned
//   detached into groups of their own.
// - --supervised: a daemon leaving for a newer build exits non-zero instead of starting its own
//   successor, so the service manager is the only one that ever starts a daemon.
// - Restart=on-failure / KeepAlive.SuccessfulExit=false / the task launcher's exit-code loop: an
//   operator stop exits zero and stays stopped. Task Scheduler's own RestartOnFailure cannot play
//   this role: it fires only when an action fails to start, never when the action's process exits
//   non-zero, so on Windows the launcher script itself relaunches on the supersession exit code.
export function daemonServiceUnitContent(
  unit: DaemonServiceUnit,
  input: {
    readonly userRoot: string;
    readonly daemonId: string;
    readonly execPath: string;
    readonly entry: string;
    /** PATH frozen at install time: the daemon finds git and the agent CLIs through it. */
    readonly searchPath: string;
    /** Explicit NODE_EXTRA_CA_CERTS from the installer; relative paths use its current directory. */
    readonly extraCaCerts?: string | undefined;
    /** Windows on-demand starts do not opt the user into login autostart. */
    readonly runAtLogin?: boolean;
  },
): string {
  const program = [
      input.execPath,
      input.entry,
      "--service",
      "--user-root",
      input.userRoot,
      "--daemon-id",
      input.daemonId,
      "--supervised",
    ],
    output = daemonStdioLogPath(input.userRoot, input.daemonId),
    environment = {
      PATH: input.searchPath,
      ...(input.extraCaCerts ? { NODE_EXTRA_CA_CERTS: path.resolve(input.extraCaCerts) } : {}),
    };
  if (unit.manager === "task-scheduler") {
    // Task Scheduler owns a hidden launcher so PATH/CA and output match the other managers. The
    // launcher relaunches the supersession exit itself: RestartOnFailure counts a non-zero process
    // exit as a completed run, so it can never start the successor. Zero (operator stop) stays
    // stopped, and any other exit ends the launcher with the daemon's code, leaving the task ready
    // for on-demand autostart instead of looping a crash.
    const script = [
      ...Object.entries(environment).map(([key, value]) => `$env:${key} = ${powerShellText(value)}`),
      "for (;;) {",
      `  & ${program.map(powerShellText).join(" ")} >> ${powerShellText(output)} 2>&1`,
      `  if ($LASTEXITCODE -ne ${daemonSupersededExitCode}) { exit $LASTEXITCODE }`,
      "}",
    ].join("\n");
    return [
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      input.runAtLogin === false
        ? "<Triggers/>"
        : "<Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>",
      '<Principals><Principal id="User"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>',
      "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>",
      `<Actions Context="User"><Exec><Command>powershell.exe</Command><Arguments>-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}</Arguments></Exec></Actions>`,
      "</Task>",
      "",
    ].join("\n");
  }
  if (unit.manager === "systemd")
    return [
      "[Unit]",
      `Description=Harness Anything daemon (${input.daemonId}, ${input.userRoot})`,
      "",
      "[Service]",
      `ExecStart=${program.map((argument) => systemdQuote(argument)).join(" ")}`,
      ...Object.entries(environment).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`, false)}`),
      `StandardOutput=append:${output}`,
      `StandardError=append:${output}`,
      "Restart=on-failure",
      "KillMode=process",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
  const string = (value: string) => `<string>${xmlText(value)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>${string(unit.name)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...program.map((argument) => `    ${string(argument)}`),
    "  </array>",
    `  <key>EnvironmentVariables</key><dict>${Object.entries(environment)
      .map(([key, value]) => `<key>${key}</key>${string(value)}`)
      .join("")}</dict>`,
    `  <key>StandardOutPath</key>${string(output)}`,
    `  <key>StandardErrorPath</key>${string(output)}`,
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function daemonServiceCommands(
  unit: DaemonServiceUnit,
  uid = process.getuid?.() ?? 0,
): {
  readonly load: readonly DaemonServiceCommand[];
  readonly unload: DaemonServiceCommand;
  readonly start: DaemonServiceCommand;
  readonly state: DaemonServiceCommand;
} {
  if (unit.manager === "task-scheduler") {
    const connect =
        "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; $s = New-Object -ComObject 'Schedule.Service'; $s.Connect(); $f = $s.GetFolder('\\'); ",
      task = `$f.GetTask(${powerShellText(unit.name)})`,
      registered = `$f.GetTasks(1) | Where-Object { $_.Name -eq ${powerShellText(unit.name)} }`,
      command = (script: string): DaemonServiceCommand => [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-OutputFormat",
        "Text",
        "-EncodedCommand",
        Buffer.from(connect + script, "utf16le").toString("base64"),
      ];
    return {
      // A user owns only their own login trigger; an all-users trigger requires elevation.
      load: [
        command(
          `$d = $s.NewTask(0); $d.XmlText = [IO.File]::ReadAllText(${powerShellText(unit.unitPath)}); $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name; $d.Principal.UserId = $user; foreach ($trigger in $d.Triggers) { $trigger.UserId = $user }; $t = $f.RegisterTaskDefinition(${powerShellText(unit.name)}, $d, 6, $null, $null, 3); $null = $t.Run($null)`,
        ),
      ],
      unload: command(`$t = ${task}; $t.Stop(0); $f.DeleteTask(${powerShellText(unit.name)}, 0)`),
      start: command(`$null = ${task}.Run($null)`),
      state: command(
        `$t = ${registered}; if ($null -eq $t) { 'loaded=false' } else { 'loaded=true'; foreach ($r in $t.GetInstances(0)) { Get-CimInstance Win32_Process -Filter ('ParentProcessId = ' + $r.EnginePID) | Where-Object { $_.Name -eq 'node.exe' } | ForEach-Object { 'pid=' + $_.ProcessId } } }`,
      ),
    };
  }
  if (unit.manager === "systemd") {
    const service = `${unit.name}.service`;
    return {
      load: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", service],
      ],
      unload: ["systemctl", "--user", "disable", "--now", service],
      start: ["systemctl", "--user", "start", service],
      state: ["systemctl", "--user", "show", service, "--property=LoadState,MainPID"],
    };
  }
  const domain = `gui/${uid}`,
    job = `${domain}/${unit.name}`;
  return {
    load: [["launchctl", "bootstrap", domain, unit.unitPath]],
    unload: ["launchctl", "bootout", job],
    start: ["launchctl", "kickstart", job],
    state: ["launchctl", "print", job],
  };
}
export interface DaemonServiceCommandOptions {
  readonly runner?: typeof runProcessExitAsync;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly minWindowsTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

const PERMANENT_SPAWN_ERROR_CODES = new Set(["ENOENT", "EACCES", "EPERM"]);

function isWindowsTaskSchedulerCommand(command: DaemonServiceCommand): boolean {
  return command[0].toLowerCase() === "powershell.exe";
}

function truncateDiagnostic(value: string, limit: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}... [truncated ${trimmed.length - limit} chars]`;
}

function formatServiceCommandFailure(
  command: DaemonServiceCommand,
  failure: {
    readonly exitCode?: number | null;
    readonly code?: string | null;
    readonly killed?: boolean;
    readonly signal?: string | null;
    readonly stderr?: string;
    readonly stdout?: string;
    readonly message?: string;
  },
  runCount: number,
  multiRun: boolean,
): Error {
  const clientPolicy = daemonProtocolFleetPolicy.defaultValue.client;
  const label = isWindowsTaskSchedulerCommand(command) ? "powershell.exe (Schedule.Service)" : command.join(" ");
  const details: string[] = [];
  if (typeof failure.exitCode === "number") details.push(`exitCode=${failure.exitCode}`);
  if (typeof failure.code === "string" && failure.code.length > 0) details.push(`code=${failure.code}`);
  if (failure.killed === true) details.push("killed=true");
  if (typeof failure.signal === "string" && failure.signal.length > 0) details.push(`signal=${failure.signal}`);
  if (multiRun) details.push(`attempts=${runCount}`);
  const stderr = failure.stderr ? truncateDiagnostic(failure.stderr, clientPolicy.serviceDiagnosticStderrLimit) : "";
  const stdout = failure.stdout ? truncateDiagnostic(failure.stdout, clientPolicy.serviceDiagnosticStdoutLimit) : "";
  const summary = details.length > 0 ? `${label} failed (${details.join(", ")})` : `${label} failed`;
  const sections = [summary];
  if (stderr) sections.push(`stderr: ${stderr}`);
  if (stdout) sections.push(`stdout: ${stdout}`);
  if (!stderr && !stdout && failure.message)
    sections.push(truncateDiagnostic(failure.message, clientPolicy.serviceDiagnosticStderrLimit));
  const error = new Error(sections.join(" | "));
  if (typeof failure.code === "string" && failure.code.length > 0)
    (error as Error & { code?: string }).code = failure.code;
  return error;
}

function extractProcessErrorDetails(error: unknown): {
  readonly exitCode: number | null;
  readonly code: string | null;
  readonly killed: boolean;
  readonly signal: string | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly message: string;
} {
  const record = (typeof error === "object" && error !== null ? error : {}) as {
    readonly code?: unknown;
    readonly status?: unknown;
    readonly killed?: unknown;
    readonly signal?: unknown;
    readonly stderr?: unknown;
    readonly stdout?: unknown;
    readonly message?: unknown;
  };
  return {
    exitCode: typeof record.status === "number" ? record.status : typeof record.code === "number" ? record.code : null,
    code: typeof record.code === "string" ? record.code : null,
    killed: record.killed === true,
    signal: typeof record.signal === "string" ? record.signal : null,
    stderr: typeof record.stderr === "string" ? record.stderr : "",
    stdout: typeof record.stdout === "string" ? record.stdout : "",
    message: typeof record.message === "string" ? record.message : String(error),
  };
}

// The pid is the service manager's own account of the process it started, which is what separates a
// supervised daemon from one that merely holds the same socket.
export function parseDaemonServiceState(
  manager: DaemonServiceManager,
  result: { readonly exitCode: number; readonly stdout: string; readonly stderr?: string },
): DaemonServiceState {
  const pidIn = (pattern: RegExp): number | null => {
    const pid = Number(pattern.exec(result.stdout)?.[1] ?? 0);
    return pid > 0 ? pid : null;
  };
  if (manager === "task-scheduler") {
    if (result.exitCode !== 0) {
      const detail = result.stderr?.trim() || result.stdout.trim();
      throw new Error(`Task Scheduler state query exited ${result.exitCode}: ${detail}`);
    }
    return { loaded: /^loaded=true$/mu.test(result.stdout), pid: pidIn(/^pid=([0-9]+)$/mu) };
  }
  if (manager === "systemd")
    return { loaded: /^LoadState=loaded$/mu.test(result.stdout), pid: pidIn(/^MainPID=([0-9]+)$/mu) };
  // launchctl print answers only for a job that is bootstrapped into the domain.
  return { loaded: result.exitCode === 0, pid: result.exitCode === 0 ? pidIn(/^\tpid = ([0-9]+)$/mu) : null };
}
export async function readDaemonServiceState(unit: DaemonServiceUnit): Promise<DaemonServiceState> {
  const [command, ...args] = daemonServiceCommands(unit).state;
  return parseDaemonServiceState(unit.manager, await runProcessExitAsync(command, args));
}
type ServiceCommandAttemptOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly transient: boolean; readonly failure: Error };

async function executeServiceCommandOnce(
  runner: typeof runProcessExitAsync,
  command: DaemonServiceCommand,
  effectiveTimeoutMs: number | undefined,
  timeoutSignal: "SIGTERM" | "SIGKILL",
  runCount: number,
  multiRun: boolean,
): Promise<ServiceCommandAttemptOutcome> {
  try {
    const result = await runner(
      command[0],
      command.slice(1),
      undefined,
      undefined,
      undefined,
      undefined,
      effectiveTimeoutMs === undefined ? {} : { timeoutMs: effectiveTimeoutMs, timeoutSignal },
    );
    if (result.exitCode === 0) return { ok: true };
    const failure = formatServiceCommandFailure(
      command,
      { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout },
      runCount,
      multiRun,
    );
    return { ok: false, transient: true, failure };
  } catch (error) {
    const details = extractProcessErrorDetails(error);
    const failure = formatServiceCommandFailure(command, details, runCount, multiRun);
    const transient = details.code === null || !PERMANENT_SPAWN_ERROR_CODES.has(details.code);
    return { ok: false, transient, failure };
  }
}

export async function runDaemonServiceCommand(
  command: DaemonServiceCommand,
  timeoutMs?: number,
  options: DaemonServiceCommandOptions = {},
): Promise<void> {
  const clientPolicy = daemonProtocolFleetPolicy.defaultValue.client;
  const isWindowsScheduler = isWindowsTaskSchedulerCommand(command);
  const runner = options.runner ?? runProcessExitAsync;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const maxRuns = isWindowsScheduler ? Math.max(1, options.maxAttempts ?? clientPolicy.windowsServiceMaxAttempts) : 1;
  const baseDelayMs = options.baseDelayMs ?? clientPolicy.windowsServiceRetryBaseDelayMs;
  const minWindowsTimeoutMs = options.minWindowsTimeoutMs ?? clientPolicy.windowsServiceMinTimeoutMs;
  const effectiveTimeoutMs =
    isWindowsScheduler && timeoutMs !== undefined ? Math.max(timeoutMs, minWindowsTimeoutMs) : timeoutMs;

  for (let index = 0; index < maxRuns; index += 1) {
    const runCount = index + 1;
    const outcome = await executeServiceCommandOnce(
      runner,
      command,
      effectiveTimeoutMs,
      clientPolicy.serviceTimeoutSignal,
      runCount,
      index > 0,
    );
    if (outcome.ok) return;
    if (!outcome.transient || runCount >= maxRuns) throw outcome.failure;
    const jitterMs = Math.floor(random() * baseDelayMs);
    await sleep(baseDelayMs * runCount + jitterMs);
  }
}
export function startDaemonServiceUnit(unit: DaemonServiceUnit, timeoutMs: number): Promise<void> {
  return runDaemonServiceCommand(daemonServiceCommands(unit).start, timeoutMs);
}

function systemdQuote(value: string, expandDollar = true): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  // Environment= does not expand dollars; ExecStart= does.
  return `"${expandDollar ? escaped.replaceAll("$", "$$$$") : escaped}"`;
}
function xmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\r", "&#13;");
}

function powerShellText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
