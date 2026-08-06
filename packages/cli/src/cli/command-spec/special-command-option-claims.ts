import type { CommandOptionDefinition } from "./types.ts";

export interface SpecialCommandOptionClaim {
  readonly kind: string;
  readonly commandPaths: ReadonlyArray<ReadonlyArray<string>>;
  readonly options: ReadonlyArray<CommandOptionDefinition>;
}

const agentSpawnOptions = options(
  "--session",
  "--runtime",
  "--prompt",
  "--profile",
  "--provider-session",
  "--cwd",
  "--task",
  "--execution"
);
const daemonControlOptions = options(
  "--timeout-ms",
  "--replacement-timeout-ms",
  "--replacement-settle-timeout-ms",
  "--reason",
  "--socket",
  "--user-root"
);
const daemonRefreshOptions = mergeOptions(daemonControlOptions, options("--trigger"));
const daemonLaunchOptions = options(
  "--authority-manifest",
  "--socket",
  "--user-root",
  "--launch-options-resolved"
);
const daemonRepoOptions = options("--user-root", "--no-link");

/**
 * Option declarations for commands that intentionally dispatch before the
 * registered command parser. Their existing parsers remain unchanged; this
 * table makes their accepted surface available to the common fail-closed
 * preflight.
 */
export const specialCommandOptionClaims = [
  claim("compound-receipt-exit", [["compound-receipt", "exit"]], options(
    "--state-dir",
    "--workspace-id",
    "--view-id",
    "--op-id",
    "--waiter-id",
    "--result-token"
  )),

  claim("agent-help", [["agent"], ["agent", "help"]], []),
  claim("agent-profiles", [["agent", "profiles"]], []),
  claim("agent-run", [["agent", "run"]], agentSpawnOptions),
  claim("agent-resume", [["agent", "resume"]], agentSpawnOptions),
  claim("agent-status", [["agent", "status"]], options("--session")),
  claim("agent-result", [["agent", "result"]], options("--session")),
  claim("agent-attach", [["agent", "attach"]], options("--session")),
  claim("agent-events", [["agent", "events"]], options("--session", "--cursor")),

  claim("daemon-status", [["daemon"], ["daemon", "status"]], options("--check", "--user-root")),
  claim("daemon-start", [["daemon", "start"]], mergeOptions(
    daemonLaunchOptions,
    options("--foreground", "--service")
  )),
  claim("daemon-serve", [["daemon", "serve"]], mergeOptions(
    daemonLaunchOptions,
    options("--check", "--idle-ms", "--stdio")
  )),
  claim("daemon-logs", [["daemon", "logs"]], options(
    "--levels",
    "--limit",
    "--cursor",
    "--since",
    "--errors"
  )),
  claim("daemon-stop", [["daemon", "stop"]], options("--timeout-ms", "--user-root")),
  claim("daemon-restart", [["daemon", "restart"]], daemonControlOptions),
  claim("daemon-refresh", [["daemon", "refresh"]], daemonRefreshOptions),
  claim("daemon-upgrade", [["daemon", "upgrade"]], mergeOptions(
    daemonRefreshOptions,
    options("--ref", "--version")
  )),
  claim("daemon-snapshot-install", [["daemon", "snapshot"], ["daemon", "snapshot", "install"]], options(
    "--ref",
    "--version",
    "--user-root"
  )),
  claim("daemon-connect", [["daemon", "connect"]], options(
    "--stdio",
    "--authority-wire",
    "--socket",
    "--user-root",
    "--principal",
    "--expect-original-command"
  )),
  claim("daemon-repo-list", [["daemon", "repo"], ["daemon", "repo", "list"]], daemonRepoOptions),
  claim("daemon-repo-register", [["daemon", "repo", "register"]], mergeOptions(
    daemonRepoOptions,
    options("--canonical-root", "--repo-id", "--display-name")
  )),
  claim("daemon-repo-unregister", [["daemon", "repo", "unregister"]], mergeOptions(
    daemonRepoOptions,
    options("--repo-id")
  )),
  claim("daemon-bootstrap-server", [["daemon", "bootstrap-server"]], mergeOptions(
    daemonLaunchOptions,
    options(
      "--canonical-root",
      "--ssh-host",
      "--ssh-user",
      "--person-id",
      "--display-name",
      "--email",
      "--role",
      "--readonly-mirror",
      "--report",
      "--skip-ssh-check",
      "--no-start",
      "--repo-id"
    )
  )),
  claim("daemon-install-templates", [["daemon", "install-templates"]], options("--out"))
] as const satisfies ReadonlyArray<SpecialCommandOptionClaim>;

function claim(
  kind: string,
  commandPaths: ReadonlyArray<ReadonlyArray<string>>,
  commandOptions: ReadonlyArray<CommandOptionDefinition>
): SpecialCommandOptionClaim {
  return { kind, commandPaths, options: commandOptions };
}

function options(...flags: ReadonlyArray<string>): ReadonlyArray<CommandOptionDefinition> {
  return flags.map((flag) => ({ flag, description: `Accepted by the existing ${flag} command path.` }));
}

function mergeOptions(
  ...groups: ReadonlyArray<ReadonlyArray<CommandOptionDefinition>>
): ReadonlyArray<CommandOptionDefinition> {
  return [...new Map(groups.flat().map((option) => [option.flag, option])).values()];
}
