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
 *  what makes the service manager start the successor, so the daemon must not start one itself. */
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

// Three lines of each unit carry an existing invariant and are not style:
// - KillMode=process: runtime workers outlive a daemon restart and are re-adopted by pid, and
//   systemd would otherwise kill the unit's whole control group, workers included. launchd needs
//   no counterpart: it only cleans up the daemon's own process group, and workers are spawned
//   detached into groups of their own.
// - --supervised: a daemon leaving for a newer build exits non-zero instead of starting its own
//   successor, so the service manager is the only one that ever starts a daemon.
// - Restart=on-failure / KeepAlive.SuccessfulExit=false: an operator stop exits zero and stays stopped.
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
    // Task Scheduler owns a hidden launcher so PATH/CA and output match the other managers.
    // Its native child is awaited: zero (operator stop) stays stopped; nonzero is supervised.
    const script = [
      ...Object.entries(environment).map(([key, value]) => `$env:${key} = ${powerShellText(value)}`),
      `& ${program.map(powerShellText).join(" ")} >> ${powerShellText(output)} 2>&1`,
      "exit $LASTEXITCODE",
    ].join("\n");
    return [
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      input.runAtLogin === false
        ? "<Triggers/>"
        : "<Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>",
      '<Principals><Principal id="User"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>',
      "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>",
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
// The pid is the service manager's own account of the process it started, which is what separates a
// supervised daemon from one that merely holds the same socket.
export function parseDaemonServiceState(
  manager: DaemonServiceManager,
  result: { readonly exitCode: number; readonly stdout: string },
): DaemonServiceState {
  const pidIn = (pattern: RegExp): number | null => {
    const pid = Number(pattern.exec(result.stdout)?.[1] ?? 0);
    return pid > 0 ? pid : null;
  };
  if (manager === "task-scheduler") {
    if (result.exitCode !== 0)
      throw new Error(`Task Scheduler state query exited ${result.exitCode}: ${result.stdout.trim()}`);
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
export async function runDaemonServiceCommand(command: DaemonServiceCommand): Promise<void> {
  const result = await runProcessExitAsync(command[0], command.slice(1));
  if (result.exitCode !== 0)
    throw new Error(`${command.join(" ")} exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`);
}
export function startDaemonServiceUnit(unit: DaemonServiceUnit): Promise<void> {
  return runDaemonServiceCommand(daemonServiceCommands(unit).start);
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
