import { commandGroups, globalCommandOptions } from "../../cli/command-spec/command-groups.ts";

const daemonGroup = commandGroups.find((group) => group.name === "daemon")!;

export const daemonCapabilityOperations = [
  daemonCapabilityOperation(
    "register",
    "ha daemon repo register --root .",
    "Register the current initialized repository with the user daemon."
  ),
  daemonCapabilityOperation(
    "start",
    "ha daemon start --service",
    "Start the persistent local daemon service."
  ),
  daemonCapabilityOperation(
    "status",
    "ha daemon status --json",
    "Inspect daemon availability and registered repository state."
  ),
  daemonCapabilityOperation(
    "logs",
    "ha daemon logs --errors --json",
    "Read the daemon-owned operational log with bounded filters and pagination."
  ),
  daemonCapabilityOperation(
    "stop",
    "ha daemon stop",
    "Stop the persistent local daemon after draining queued writes."
  ),
  daemonCapabilityOperation(
    "restart",
    "ha daemon restart --json",
    "Request a service-wide daemon restart and wait for the replacement daemon."
  ),
  daemonCapabilityOperation(
    "refresh",
    "ha daemon refresh --json",
    "Request a service-wide daemon refresh and wait for the replacement daemon."
  )
] as const;

export function renderDaemonHelp(): string {
  return [
    "Usage: harness-anything daemon <start|status|logs|stop|restart|refresh|connect|repo|bootstrap-server|install-templates> [options]",
    "Alias: ha daemon <subcommand> [options]",
    "",
    daemonGroup.summary,
    "",
    "Global options:",
    ...globalCommandOptions.map((option) => `  ${option.flag.padEnd(18)} ${option.description}`),
    "",
    "Commands:",
    "  start --service              Start a detached local daemon service (default).",
    "  start --foreground           Run the daemon service in the foreground.",
    "    --authority-manifest PATH Enable fail-closed V2 authority composition from an explicit manifest.",
    "  status                       Show lock holder, queue depth, connections, and version.",
    "  logs [options]               Read bounded operational daemon logs.",
    "    --limit <1-200>            Set page size (default: 100).",
    "    --since <timestamp>        Include entries at or after an ISO-8601 timestamp.",
    "    --levels <csv>             Filter debug,info,warn,error,fatal levels.",
    "    --errors                   Include error and fatal entries only.",
    "    --cursor <opaque>          Continue a page with the same repo and filters.",
    "  stop [--timeout-ms <ms>]     Signal the daemon and wait for queue drain and lock release.",
    "  restart [--timeout-ms <ms>]  Restart the service and wait for a replacement PID.",
    "  refresh [options]            Refresh the service and wait for a replacement PID.",
    "    --trigger explicit|post-merge|dist-watcher",
    "                               Classify the refresh caller (default: explicit).",
    "    --timeout-ms <ms>          Set the aggregate queue drain timeout (100-120000).",
    "    --reason <text>            Record the operator or automation reason.",
    "  connect --stdio              Relay stdin/stdout to an already-running daemon.",
    "  repo <subcommand>            Register, list, or unregister daemon repositories.",
    "  bootstrap-server             Initialize a canonical team server repository.",
    "  install-templates --out DIR  Copy systemd, launchd, and Windows Service templates."
  ].join("\n");
}

function daemonCapabilityOperation(action: string, command: string, description: string) {
  return {
    commandKind: `daemon-${action}`,
    name: action,
    action,
    command,
    description,
    input: {
      schema: "json-schema",
      schemaId: `harness://schema/cli/daemon-${action}-input/v1`,
      type: "object",
      required: [],
      properties: {}
    },
    shortcuts: [],
    output: { receiptSchema: "daemon-command/v1", itemKind: "daemon" },
    examples: [command]
  } as const;
}
