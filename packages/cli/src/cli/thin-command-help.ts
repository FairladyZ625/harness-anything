import { daemonProtocolCommands, thinCliCommands } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { renderCliGuidance } from "./guidance-plane.ts";

export type ThinHelpCatalogEntry = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly validity: string;
  readonly errorCode?: string;
};

export const generationMigrationCommand = {
  id: "migrate-ledger",
  path: ["migrate", "ledger"],
  usage: "ha migrate ledger --source <backup> --mode <dry-run|convert|verify|activate> [--destination <absolute-path>]",
  summary: "Convert a verified immutable generation 1 backup to an isolated generation 2 candidate.",
  help: "    Preserves the source; reports unsupported history and never activates the live repository.",
  helpCommand: "ha migrate ledger --help",
  inputs: [
    { name: "--source", kind: "single", required: true, error: { code: "missing_field" } },
    {
      name: "--mode",
      kind: "single",
      required: true,
      enum: ["dry-run", "convert", "verify", "activate"],
      error: { code: "invalid_field" },
    },
    { name: "--destination", kind: "single", required: false, error: { code: "invalid_field" } },
  ],
} as const;

export const clientLocalCommands = [
  generationMigrationCommand,
  {
    id: "gui",
    path: ["gui"],
    usage: "ha gui [--root <path>]",
    summary: "Build and launch the attach-only Electron GUI.",
    help: [
      "    Uses the canonical CLI installation for GUI code and daemon autostart.",
      "    --root selects the repository context; it defaults to the current directory.",
      "    Closing the GUI never stops the daemon, and the GUI never respawns a stopped daemon.",
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

const cliCapabilities: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(sortedCommandDomains),
);

export function deriveCliCapabilities(): Readonly<Record<string, readonly string[]>> {
  return cliCapabilities;
}

const runtimeRunInputs = (daemonProtocolCommands.find((command) => command.id === "runtime-run")?.inputs ??
  []) as readonly {
  readonly name: string;
  readonly enum?: readonly string[];
}[];

const batchDeclarationFields: readonly string[] = Object.freeze([
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

const batchRunEfforts: readonly string[] = Object.freeze(
  runtimeRunInputs.find((input) => input.name === "--effort")?.enum ?? [],
);

export function runtimeBatchDeclarationFields(): readonly string[] {
  return batchDeclarationFields;
}

export function runtimeRunEfforts(): readonly string[] {
  return batchRunEfforts;
}

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

const domains: readonly {
  readonly name: string;
  readonly count: number;
}[] = Object.freeze(sortedCommandDomains.map(([name, ids]) => ({ name, count: ids.length })));

const domainNames: readonly string[] = Object.freeze(domains.map(({ name }) => name));

export function commandDomains(): typeof domains {
  return domains;
}

export function cliCommandDomains(): readonly string[] {
  return domainNames;
}

export function unsupportedCommandHint(args: readonly string[]): string {
  const domains = domainNames,
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
