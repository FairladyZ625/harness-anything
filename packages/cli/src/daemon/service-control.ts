import { existsSync, readFileSync } from "node:fs";
import {
  clearDaemonStoppedMarker,
  removeDaemonServiceUnit,
  writeDaemonServiceUnit,
} from "@harness-anything/daemon/internal/client/daemon-autostart";
import {
  daemonServiceCommands,
  daemonServiceUnit,
  daemonServiceUnitContent,
  readDaemonServiceState,
  runDaemonServiceCommand,
  type DaemonServiceUnit,
} from "@harness-anything/daemon/internal/client/daemon-service";
import { localUserDaemonEndpoint } from "@harness-anything/daemon/internal/client/local-daemon-target";
import {
  daemonProcessAlive,
  daemonSocketProbe,
  readDaemonPid,
} from "@harness-anything/daemon/internal/daemon-singleton";
import { daemonStdioLogPath } from "@harness-anything/daemon/internal/lifecycle-log";
import { ensureCliDaemonRunning } from "./autostart.ts";
import { daemonServeEntry } from "./client.ts";
import { daemonFailure } from "./control-support.ts";

type ControlFinisher = (receipt: Record<string, unknown>, exitCode: number) => number;

export async function runDaemonServiceControl(
  subcommand: string | undefined,
  userRoot: string,
  daemonId: string,
  invokingRoot: string,
  finish: ControlFinisher,
): Promise<number> {
  const command = `daemon-service-${subcommand ?? "unknown"}`;
  if (!(subcommand === "install" || subcommand === "uninstall" || subcommand === "status"))
    return finish(
      daemonFailure("daemon-service", "unsupported_command", "Use daemon service install, uninstall, or status."),
      2,
    );
  const unit = daemonServiceUnit({ userRoot, daemonId });
  if (unit === null)
    return finish(
      daemonFailure(
        command,
        "daemon_service_unsupported_platform",
        `A daemon service unit is generated for macOS (launchd) and Linux (systemd) only; ${process.platform} is not supported. Start the daemon with \`ha daemon start --service\`.`,
      ),
      1,
    );
  if (subcommand === "status") return serviceStatus(unit, userRoot, daemonId, finish);
  const commands = daemonServiceCommands(unit);
  if (subcommand === "uninstall") {
    if (!existsSync(unit.unitPath))
      return finish(
        { ok: true, command, ...unitFields(unit), changed: false, summary: `${command}: not installed` },
        0,
      );
    await unload(unit);
    removeDaemonServiceUnit(unit);
    // systemd keeps the removed unit in memory until told the file is gone.
    if (unit.manager === "systemd") await runDaemonServiceCommand(commands.load[0]!);
    return finish(
      {
        ok: true,
        command,
        ...unitFields(unit),
        changed: true,
        summary: `${command}: removed ${unit.unitPath}; the daemon it ran was stopped`,
      },
      0,
    );
  }
  const content = daemonServiceUnitContent(unit, {
      userRoot,
      daemonId,
      execPath: process.execPath,
      entry: daemonServeEntry(),
      searchPath: process.env.PATH ?? "",
      extraCaCerts: process.env.NODE_EXTRA_CA_CERTS,
    }),
    changed = !existsSync(unit.unitPath) || readFileSync(unit.unitPath, "utf8") !== content;
  // A loaded unit keeps running its old definition, so a changed one is unloaded before it is replaced.
  if (changed && existsSync(unit.unitPath)) await unload(unit);
  writeDaemonServiceUnit(unit, content, daemonStdioLogPath(userRoot, daemonId));
  // Installing is an explicit request to run, the same as `ha daemon start --service`.
  clearDaemonStoppedMarker(userRoot, daemonId);
  if (unit.manager === "systemd" || !(await readDaemonServiceState(unit)).loaded)
    for (const step of commands.load) await runDaemonServiceCommand(step);
  // Loading the unit starts the daemon; this waits for it to answer, and starts it through the
  // service manager when the unit was already loaded and stopped.
  const started = await ensureCliDaemonRunning({ mode: "--service", invokingRoot, userRoot, daemonId });
  if (!started.ok) return finish(daemonFailure(command, started.code ?? "daemon_start_failed", started.hint), 1);
  return serviceStatus(unit, userRoot, daemonId, (receipt, exitCode) =>
    finish({ ...receipt, command, changed }, exitCode),
  );
}

async function serviceStatus(
  unit: DaemonServiceUnit,
  userRoot: string,
  daemonId: string,
  finish: ControlFinisher,
): Promise<number> {
  const installed = existsSync(unit.unitPath),
    service = installed ? await readDaemonServiceState(unit) : { loaded: false, pid: null },
    daemonPid = readDaemonPid(userRoot, daemonId),
    daemon = {
      pid: daemonPid,
      alive: daemonPid !== null && daemonProcessAlive(daemonPid),
      accepting: await daemonSocketProbe(localUserDaemonEndpoint(userRoot, daemonId)),
    },
    // The service manager's pid is compared with the daemon's own pid file: a daemon that answers on
    // the socket but was not started by the unit is running, and is not supervised.
    supervised = service.pid !== null && service.pid === daemon.pid && daemon.alive,
    fields = { ...unitFields(unit), installed, loaded: service.loaded, servicePid: service.pid, daemon, supervised },
    line = `daemon-service-status: ${unit.manager} unit ${unit.name}`;
  if (supervised)
    return finish(
      {
        ok: true,
        command: "daemon-service-status",
        ...fields,
        summary: `${line} is loaded; daemon pid ${String(daemon.pid)} is supervised`,
      },
      0,
    );
  const hint = !installed
    ? "Run `ha daemon service install` to have the service manager keep the daemon running."
    : daemon.alive
      ? `Daemon pid ${String(daemon.pid)} was not started by the unit. Run \`ha daemon stop\`, then \`ha daemon start --service\`, to move it under the service manager.`
      : "The unit is installed and no daemon is running. Run `ha daemon start --service` to start it under the service manager.";
  return finish(
    {
      ...daemonFailure("daemon-service-status", "daemon_service_inactive", hint),
      ...fields,
      summary: `${line} is ${installed ? (service.loaded ? "loaded" : "installed but not loaded") : "not installed"}; no supervised daemon`,
    },
    1,
  );
}

function unitFields(unit: DaemonServiceUnit): Record<string, unknown> {
  return { manager: unit.manager, unit: unit.name, unitPath: unit.unitPath };
}
// launchctl bootout fails for a job that is not loaded; systemctl disable --now accepts a stopped unit.
async function unload(unit: DaemonServiceUnit): Promise<void> {
  if (unit.manager === "systemd" || (await readDaemonServiceState(unit)).loaded)
    await runDaemonServiceCommand(daemonServiceCommands(unit).unload);
}
