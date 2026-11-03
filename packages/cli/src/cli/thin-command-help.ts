import {
  daemonProtocolCommands,
  thinCliCommands,
} from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import {
  agentDeclarationMigrationCommand,
  completionMigrationCommand,
  generationMigrationCommand,
  writerEpochMigrationCommand,
} from "@harness-anything/daemon/internal/offline-storage-command";
import { renderCliGuidance } from "./guidance-plane.ts";
import { artifactEntityImportGuidance } from "./artifact-entity-import-guidance.ts";

export type ThinHelpCatalogEntry = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly validity: string;
  readonly errorCode?: string;
};

/** One open work row of `ha work list`, shown by `ha task create --help` as the packs a create can join. */
export type ThinHelpWorkEntry = {
  readonly taskId: string;
  readonly title: string;
};

export const clientLocalCommands = [
  generationMigrationCommand,
  completionMigrationCommand,
  agentDeclarationMigrationCommand,
  writerEpochMigrationCommand,
  {
    id: "backup-retention",
    path: ["backup", "retention"],
    usage: "ha backup retention [--days <n>] [--user-root <path>] [--json]",
    summary: "List ~/.harness/backups entries and mark which exceed the retention window.",
    help: [
      "    Read-only, no daemon contact. A backup entry is kept 30 days from its last write by default",
      "    (--days overrides); expired entries are listed only, deletion stays manual.",
    ].join("\n"),
  },
  {
    id: "daemon-metrics",
    path: ["daemon", "metrics"],
    usage:
      "ha daemon metrics [--window 15m|1h|24h|7d] [--root <path>] [--repo <id>] [--user-root <path>] [--daemon-id <id>] [--json]",
    summary: "Read retained request-log coverage and daemon latency; excludes active awaits from latency.",
    help: "    Defaults to 24h. Retained samples only; no CLI-only or complete-window traffic estimate.",
  },
  {
    id: "daemon-top",
    path: ["daemon", "top"],
    usage: "ha daemon top [--once] [--interval 1s|500ms] [--user-root <path>] [--daemon-id <id>] [--json]",
    summary: "Live per-second requests, per-method p50/p99, in-flight work, write queues and edge-node traffic.",
    help: [
      "    Reads the daemon's independent diagnostics socket, so it still answers while the main thread",
      "    is stalled or the daemon is draining. Repeats every second until interrupted; --once prints",
      "    one snapshot. On a build without request tracing it reports the trace as unavailable.",
    ].join("\n"),
  },
  {
    id: "daemon-slo",
    path: ["daemon", "slo"],
    usage: "ha daemon slo [--day YYYYMMDD] [--threshold 1s|500ms] [--user-root <path>] [--daemon-id <id>] [--json]",
    summary: "Daily availability, per-method p99 and over-threshold requests from the conn log and the probe timeline.",
    help: [
      "    Availability comes only from the external probe's daemon-probe/v1 timeline; without probe",
      "    samples it is reported unobserved rather than recomputed from request noise. Request latency,",
      "    bytes and slow-request details come from the same daemon conn log that carries the span fields.",
    ].join("\n"),
  },
  {
    id: "daemon-probe",
    path: ["daemon", "probe"],
    usage:
      "ha daemon probe [--interval 5s] [--timeout 2s] [--slow-ms 1000] [--unresponsive 30s] [--cpu-percent 90] [--cpu-sustain 60s] [--rss-bytes <bytes>] [--cooldown 10m] [--capture-dir <path>] [--kept-days 7] [--iterations <n>] [--duration <span>] [--sample-seconds 5] [--js-stack-method <rpc>] [--user-root <path>] [--daemon-id <id>] [--json]",
    summary:
      "Long-running external liveness and resource probe; captures a scene when the daemon is unresponsive or saturated.",
    help: [
      "    Read-only: hello + status each with --timeout, then CPU/RSS/thread/fd from ps/lsof or /proc.",
      "    A capture runs once per event after --unresponsive down, --cpu-sustain above --cpu-percent,",
      "    or RSS above --rss-bytes; --cooldown separates events. Samples land in <user-root>/logs/.",
      "    Ctrl-C stops it; --iterations/--duration bound a run for acceptance evidence.",
    ].join("\n"),
  },
  {
    id: "daemon-probe-summary",
    path: ["daemon", "probe"],
    usage:
      "ha daemon probe summary [--window 15m|1h|6h|24h|7d] [--day YYYYMMDD] [--until <iso>] [--min-silence 5m] [--user-root <path>] [--daemon-id <id>] [--json]",
    summary:
      "Summarize probe availability and reconstruct starts, attach durations, and downtime from conn/lifecycle logs.",
    help: [
      "    Reads the probe timeline for availability, downtime, slow segments, and capture files.",
      "    Always adds the offline view: process starts per day, repo attach latency, and downtime",
      "    inferred from process_exit or a missing exit dated by the pid's last conn activity.",
      "    --day selects one UTC day; --until freezes a reproducible snapshot of a day still running.",
      "    No samples reports unobserved, never 0% availability.",
    ].join("\n"),
  },
  {
    id: "ledger-restore-offline",
    path: ["restore"],
    usage: "ha restore <backup-directory> --to <absolute-directory>",
    summary: "Restore a backup into a new absolute directory without a running daemon.",
    help: undefined,
  },
  {
    id: "gui",
    path: ["gui"],
    usage: "ha gui [--browser [--parent-origin <origin>]] [--root <path>]",
    summary: "Launch the Electron GUI or serve it through a loopback browser broker.",
    help: [
      "    GUI code comes from the optional @harness-anything/gui package; the CLI handles daemon autostart.",
      "    --browser serves the GUI while this process runs; embedding is denied by default.",
      "    --parent-origin permits one exact serialized HTTP(S) origin or dsh-app://app to embed it (requires --browser).",
      "    Parent permission changes only frame-ancestors, never RPC authentication; paths and wildcards are rejected.",
      "    --root selects the repository context; it defaults to the current directory.",
      "    In a source checkout, a GUI bundle older than the sources is rebuilt before the window opens.",
      "    Closing the GUI never stops the daemon, and the GUI never respawns a stopped daemon.",
    ].join("\n"),
  },
  {
    id: "doctor",
    path: ["doctor"],
    usage: "ha doctor [commands|health] [--root <path>] [--json]",
    summary:
      "Report repository health (default), or validate ha command references in authored Markdown docs " +
      "with `ha doctor commands`.",
    help: [
      "    Scans harness/context, harness/governance, AGENTS.md, CLAUDE.md, .agents/, and docs-release/ for",
      "    ha commands in code fences and inline code spans, then parses each through the same descriptor",
      "    pipeline the CLI runs. Read-only: no daemon contact, no writes. Exits 1 with one",
      "    file:line — command — reason line per stale reference; invocations containing <placeholders> skip.",
    ].join("\n"),
  },
] as const;
const commandDirectory = new Map<string, string[]>();
for (const command of [...thinCliCommands, ...clientLocalCommands]) {
  const domain = command.path[0];
  if (domain) commandDirectory.set(domain, [...(commandDirectory.get(domain) ?? []), command.id]);
}
const sortedCommandDomains = [...commandDirectory]
  .map(([domain, ids]) => [domain, ids.sort()] as const)
  .sort(([left], [right]) => left.localeCompare(right));

export const cliCapabilities: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(sortedCommandDomains),
);

const runtimeRunInputs = (daemonProtocolCommands.find((command) => command.id === "runtime-run")?.inputs ??
  []) as readonly {
  readonly name: string;
  readonly enum?: readonly string[];
}[];

export const runtimeBatchDeclarationFields: readonly string[] = Object.freeze([
  "instance",
  ...runtimeRunInputs
    .filter(
      (input) =>
        !["--resume", "--resume-dispatch", "--idempotency-key", "--detach", "--on-exit", "--no-stream"].includes(
          input.name,
        ),
    )
    .map((input) => input.name.slice(2)),
]);

export const runtimeRunEfforts: readonly string[] = Object.freeze(
  runtimeRunInputs.find((input) => input.name === "--effort")?.enum ?? [],
);

export function renderThinCapabilities(): string {
  return [
    "Harness Anything CLI capabilities",
    "",
    ...Object.entries(cliCapabilities).flatMap(([domain, ids]) => [`${domain}:`, ...ids.map((id) => `  ${id}`)]),
    "",
    "entity import:",
    artifactEntityImportGuidance,
  ].join("\n");
}

// The command token is the first argv entry that is neither a flag nor a global's value. Deciding a
// route by scanning the whole argv instead lets any flag *value* that happens to spell a command name
// hijack it — `--title daemon` is a legitimate invocation that must not route to the `daemon` domain.
export function firstCliCommandIndex(argv: readonly string[]): number {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--root" || value === "--repo") {
      index += 1;
      continue;
    }
    if (value?.startsWith("-")) continue;
    return index;
  }
  return -1;
}

export function firstCliCommand(argv: readonly string[]): string | undefined {
  const index = firstCliCommandIndex(argv);
  return index < 0 ? undefined : argv[index];
}

export function helpDomain(argv: readonly string[]): string | undefined {
  return firstCliCommand(argv);
}

export function helpCommandPrefix(argv: readonly string[]): string | undefined {
  const index = firstCliCommandIndex(argv);
  if (index < 0) return undefined;
  const tokens = argv.slice(index).filter((token) => token !== "--help" && token !== "--json");
  if (tokens.length < 2) return undefined;
  return `ha ${tokens.join(" ")}`;
}

export const commandDomains = Object.freeze(sortedCommandDomains.map(([name, ids]) => ({ name, count: ids.length })));

export const cliCommandDomains: readonly string[] = Object.freeze(commandDomains.map(({ name }) => name));

// The help gate accepts every declared domain, not only the visible one: a hidden command stays
// executable, so `ha <hidden-domain> <command> --help` must not be refused as an unknown domain.
// Both declaration sources participate — daemon-owned commands and the client-local entries — so a
// visible domain can never fall outside this set. Unknown-domain hints still use the visible list
// above, so hidden domains are not advertised.
const declaredDomainNames = new Map<string, true>();
for (const command of [...daemonProtocolCommands, ...clientLocalCommands]) {
  if ("internal" in command && command.internal) continue;
  const domain = command.path[0];
  if (domain) declaredDomainNames.set(domain, true);
}
export const declaredCommandDomains: readonly string[] = Object.freeze(
  [...declaredDomainNames.keys()].sort((left, right) => left.localeCompare(right)),
);

export function unsupportedCommandHint(args: readonly string[]): string {
  const domains = cliCommandDomains,
    domain = args[0],
    verb = args
      .slice(1)
      .filter((token) => !token.startsWith("-"))
      .join(" ");
  return renderCliGuidance("unsupported-command", {
    domains,
    ...(domain ? { domain } : {}),
    ...(verb ? { verb } : {}),
  });
}
