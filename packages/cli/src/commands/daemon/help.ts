export function renderDaemonHelp(): string {
  return [
    "Usage: harness-anything daemon <start|status|stop|connect|bootstrap-server|install-templates> [options]",
    "Alias: ha daemon <subcommand> [options]",
    "",
    "Commands:",
    "  start --service              Start a detached local daemon service (default).",
    "  start --foreground           Run the daemon service in the foreground.",
    "  status --json                Show lock holder, queue depth, connections, and version.",
    "  stop [--timeout-ms <ms>]     Signal the daemon and wait for queue drain and lock release.",
    "  connect --stdio              Relay stdin/stdout to an already-running daemon.",
    "  repo <subcommand>            Register, list, or unregister daemon repositories.",
    "  bootstrap-server             Initialize a canonical team server repository.",
    "  install-templates --out DIR  Copy systemd, launchd, and Windows Service templates."
  ].join("\n");
}
