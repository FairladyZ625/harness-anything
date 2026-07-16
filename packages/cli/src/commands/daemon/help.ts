import type { CommandRegistryEntry } from "../../cli/types.ts";

export const daemonHelpRegistryEntry = {
  kind: "daemon",
  primary: "harness-anything daemon <subcommand> [options]",
  aliases: ["ha daemon <subcommand> [options]"],
  commandPath: ["daemon"],
  summary: "Register repositories and manage the persistent local daemon.",
  options: [],
  examples: [
    "ha daemon repo register --root .",
    "ha daemon start --service",
    "ha daemon status --json"
  ],
  resultEnvelope: "command-receipt/v2"
} as const satisfies CommandRegistryEntry;

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
    "stop",
    "ha daemon stop",
    "Stop the persistent local daemon after draining queued writes."
  ),
  daemonCapabilityOperation(
    "restart",
    "ha daemon restart --json",
    "Request a service-wide daemon restart through the canonical admin control RPC."
  ),
  daemonCapabilityOperation(
    "refresh",
    "ha daemon refresh --json",
    "Request a service-wide daemon refresh after the runtime artifact changes."
  )
] as const;

export function renderDaemonHelp(): string {
  return [
    "Usage: harness-anything daemon <start|status|stop|restart|refresh|connect|repo|bootstrap-server|install-templates> [options]",
    "Alias: ha daemon <subcommand> [options]",
    "",
    "Commands:",
    "  start --service              Start a detached local daemon service (default).",
    "  start --foreground           Run the daemon service in the foreground.",
    "  status --json                Show lock holder, queue depth, connections, and version.",
    "  stop [--timeout-ms <ms>]     Signal the daemon and wait for queue drain and lock release.",
    "  restart [--timeout-ms <ms>]  Request a service-wide restart through admin.daemon.restart.",
    "  refresh [options]            Request a service-wide refresh through admin.daemon.refresh.",
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
