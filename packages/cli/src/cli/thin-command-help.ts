import { daemonProtocolCommands, thinCliCommands } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { renderCliGuidance } from "./guidance-plane.ts";

export type ThinHelpCatalogEntry = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly validity: string;
  readonly errorCode?: string;
};

export const clientLocalCommands = [
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
const publicCommands = () => [...thinCliCommands, ...clientLocalCommands];

function commandDirectory(
  commands: ReadonlyArray<{ readonly id: string; readonly path: readonly string[] }>,
): ReadonlyMap<string, readonly string[]> {
  const groups = new Map<string, string[]>();
  for (const command of commands) {
    const domain = command.path[0];
    if (domain) groups.set(domain, [...(groups.get(domain) ?? []), command.id]);
  }
  return new Map([...groups].map(([domain, ids]) => [domain, ids.sort()]));
}

export function deriveCliCapabilities(
  commands: ReadonlyArray<{
    readonly id: string;
    readonly path: readonly string[];
  }> = publicCommands(),
): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries([...commandDirectory(commands)].sort(([left], [right]) => left.localeCompare(right)));
}

export function runtimeBatchDeclarationFields(): readonly string[] {
  const inputs = (daemonProtocolCommands.find((command) => command.id === "runtime-run")?.inputs ?? []) as readonly {
    readonly name: string;
  }[];
  return [
    "instance",
    ...inputs
      .filter(
        (input) =>
          !["--resume", "--resume-dispatch", "--idempotency-key", "--detach", "--on-exit", "--no-stream"].includes(
            input.name,
          ),
      )
      .map((input) => input.name.slice(2)),
  ];
}

export function runtimeRunEfforts(): readonly string[] {
  const inputs = (daemonProtocolCommands.find((command) => command.id === "runtime-run")?.inputs ?? []) as readonly {
    readonly name: string;
    readonly enum?: readonly string[];
  }[];
  return inputs.find((input) => input.name === "--effort")?.enum ?? [];
}

export function renderThinCapabilities(): string {
  return [
    "Harness Anything CLI capabilities",
    "",
    ...Object.entries(deriveCliCapabilities()).flatMap(([domain, ids]) => [
      `${domain}:`,
      ...ids.map((id) => `  ${id}`),
    ]),
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

export function commandDomains(): readonly {
  readonly name: string;
  readonly count: number;
}[] {
  return [...commandDirectory(publicCommands())]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, ids]) => ({ name, count: ids.length }));
}

export function cliCommandDomains(): readonly string[] {
  return commandDomains().map(({ name }) => name);
}

export function unsupportedCommandHint(args: readonly string[]): string {
  const domains = cliCommandDomains(),
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
