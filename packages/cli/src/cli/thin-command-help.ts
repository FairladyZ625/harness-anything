import {
  daemonProtocolCommands,
  thinCliCommands,
} from "../../../daemon/src/protocol/daemon-protocol.contract.ts";

export const thinCliLocalErrorCodes = Object.freeze([
  "daemon_disconnect",
  "daemon_target_conflict",
  "duplicate_field",
  "invalid_field",
  "missing_field",
  "unknown_field",
  "unsupported_command",
]);

export type ThinHelpCatalogEntry = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly validity: string;
  readonly errorCode?: string;
};

export function renderThinHelp(
  catalog: readonly ThinHelpCatalogEntry[] = [],
  domain?: string,
): string {
  const rows = [
      ...thinCliCommands.map(({ usage, summary, help }) => ({
        usage,
        summary,
        help,
      })),
    ],
    visible = domain
      ? rows.filter(({ usage }) => usage.split(" ")[1] === domain)
      : rows,
    groups = commandDomains(),
    body = domain
      ? [
          `Commands for ${domain}:`,
          ...visible.map(
            ({ usage, summary, help }) =>
              `  ${usage}\n    ${summary}${help ? `\n${help}` : ""}`,
          ),
        ]
      : [
          "Commands:",
          ...groups.map(
            ({ name, count }) =>
              `  ${name} (${count} command${count === 1 ? "" : "s"})`,
          ),
          "",
          "Meta:",
          "  capabilities [--json] — Describe the contracted CLI command surface.",
          "  --version — Print the CLI package version.",
          "",
          "Use ha <domain> --help for the commands in a domain.",
          ...rows
            .filter(({ usage }) => usage.includes("--service"))
            .map(({ usage }) => `  ${usage}`),
        ],
    presetRows = catalog.length
      ? ["", "Recommended presets:", ...catalog.map(renderPresetHelpEntry)]
      : [];
  return ["Harness Anything thin CLI", "", ...body, ...presetRows].join("\n");
}

function renderPresetHelpEntry(entry: ThinHelpCatalogEntry): string {
  const description =
    entry.validity === "valid"
      ? entry.description
      : `${entry.validity}${entry.errorCode ? ` (${entry.errorCode})` : ""}`;
  return `  ${entry.id} — ${entry.title} — ${description}`;
}

export function deriveCliCapabilities(
  commands: ReadonlyArray<{
    readonly id: string;
    readonly path: readonly string[];
  }> = daemonProtocolCommands,
): Readonly<Record<string, readonly string[]>> {
  const groups = new Map<string, string[]>();
  for (const command of commands) {
    const domain = command.path[0];
    if (domain) groups.set(domain, [...(groups.get(domain) ?? []), command.id]);
  }
  return Object.fromEntries(
    [...groups]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([domain, ids]) => [domain, ids.sort()]),
  );
}

export function runtimeBatchDeclarationFields(): readonly string[] {
  const inputs =
    daemonProtocolCommands.find((command) => command.id === "runtime-run")
      ?.inputs ?? [];
  return [
    "instance",
    ...inputs
      .filter(
        (input) =>
          ![
            "--resume",
            "--resume-dispatch",
            "--idempotency-key",
            "--detach",
            "--on-exit",
            "--no-stream",
          ].includes(input.name),
      )
      .map((input) => input.name.slice(2)),
  ];
}

export function runtimeRunEfforts(): readonly string[] {
  return (
    daemonProtocolCommands
      .find((command) => command.id === "runtime-run")
      ?.inputs.find((input) => input.name === "--effort")?.enum ?? []
  );
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
  const counts = new Map<string, number>();
  for (const command of daemonProtocolCommands) {
    const domain = command.path[0];
    if (domain) counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => ({ name, count }));
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
  if (domain === undefined)
    return `No command domain was named; use one of ${domains.join(", ")}.`;
  if (!domains.includes(domain))
    return `${domain} is not a command domain; use one of ${domains.join(", ")}.`;
  return verb
    ? `${domain} has no ${verb} command; run ha ${domain} --help for the commands it does have.`
    : `ha ${domain} needs a command; run ha ${domain} --help for the commands it has.`;
}
