import {
  daemonProtocolCommands,
  thinCliCommands,
} from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { generationMigrationCommand } from "@harness-anything/daemon/internal/offline-storage-command";
import { renderCliGuidance } from "./guidance-plane.ts";

export type ThinHelpCatalogEntry = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly validity: string;
  readonly errorCode?: string;
};

export const clientLocalCommands = [
  generationMigrationCommand,
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
    usage: "ha gui [--root <path>]",
    summary: "Launch the attach-only Electron GUI.",
    help: [
      "    GUI code comes from the optional @harness-anything/gui package; the CLI handles daemon autostart.",
      "    --root selects the repository context; it defaults to the current directory.",
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
  ].join("\n");
}

// The command token is the first argv entry that is neither a flag nor a global's value. Deciding a
// route by scanning the whole argv instead lets any flag *value* that happens to spell a command name
// hijack it — `--module daemon` is a legitimate invocation in a repo that registers a `daemon` module.
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
