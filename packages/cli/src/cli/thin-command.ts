export const thinCliLocalErrorCodes = Object.freeze([
  "daemon_disconnect",
  "daemon_gone",
  "daemon_target_conflict",
  "duplicate_field",
  "invalid_field",
  "missing_field",
  "unknown_field",
  "unsupported_command",
]);

export { deriveCliCapabilities } from "./thin-command-help.ts";
export { runtimeBatchDeclarationFields } from "./thin-command-help.ts";
export { runtimeRunEfforts } from "./thin-command-help.ts";
export { renderThinCapabilities } from "./thin-command-help.ts";
export { firstCliCommandIndex } from "./thin-command-help.ts";
export { firstCliCommand } from "./thin-command-help.ts";
export { helpDomain } from "./thin-command-help.ts";
export { deriveThinCliInputs } from "./thin-command-inputs.ts";
export { cliCommandDomains } from "./thin-command-help.ts";
export { unsupportedCommandHint } from "./thin-command-help.ts";
export type { ThinHelpCatalogEntry } from "./thin-command-help.ts";
export type { ThinCommand } from "./thin-command-types.ts";
export type { ThinParseResult } from "./thin-command-types.ts";
export type { ThinCliInput } from "./thin-command-types.ts";

import {
  daemonProtocolCommands,
  resolveThinCliCommand,
  safePath,
  thinCliCommands,
} from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { accepted, globalOption, nonEmpty, rejected, stripGlobals } from "./thin-command-flags.ts";
import { commandDomains, unsupportedCommandHint } from "./thin-command-help.ts";
import type { ThinHelpCatalogEntry } from "./thin-command-help.ts";
import { deriveInputDirectory } from "./thin-command-inputs.ts";
import { parseRouted } from "./thin-command-router.ts";
import { parseResumeDispatch } from "./thin-command-runtime.ts";
import { parseTask } from "./thin-command-task.ts";
import type { ProtocolCommand, ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

type LifecyclePublicationAction =
  | "task-create"
  | "task-start"
  | "task-submit"
  | "task-review-execution"
  | "task-complete";

export function parseThinCommand(
  argv: readonly string[],
  cwd = process.cwd(),
  commands: readonly ProtocolCommand[] = daemonProtocolCommands,
): ThinParseResult {
  const rootDir = safePath(globalOption(argv, "--root") ?? cwd),
    repoId = globalOption(argv, "--repo"),
    json = argv.includes("--json"),
    args = stripGlobals(argv),
    route =
      commands === daemonProtocolCommands
        ? resolveThinCliCommand(args)
        : commands.find((entry) => entry.path.every((token, index) => args[index] === token)),
    inputs = deriveInputDirectory(route);
  if (route?.id === "runtime-run" && args[2]?.startsWith("--") && args.includes("--resume-dispatch"))
    return parseResumeDispatch(rootDir, repoId, json, args, inputs);
  if (route?.id === "task-dispatches" && nonEmpty(args[2]) && args.length === 3)
    return accepted(rootDir, repoId, json, { kind: "task-dispatches", taskId: args[2] }, "repo.task.dispatches");
  const routed = parseRouted(route, args, rootDir, repoId, json, inputs);
  if (routed) return routed;
  if (!route || args[0] !== "task") return rejected("unsupported_command", unsupportedCommandHint(args), json);
  return parseTaskRoute(route.id, args, rootDir, repoId, json, inputs);
}

function parseTaskRoute(
  id: ProtocolCommand["id"] | LifecyclePublicationAction,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  return parseTask(id, args, rootDir, repoId, json, inputs);
}

export function renderThinHelp(catalog: readonly ThinHelpCatalogEntry[] = [], domain?: string): string {
  const rows = [
      ...thinCliCommands.map(({ usage, summary, help }) => ({
        usage,
        summary,
        help,
      })),
    ],
    visible = domain ? rows.filter(({ usage }) => usage.split(" ")[1] === domain) : rows,
    groups = commandDomains(),
    body = domain
      ? [
          `Commands for ${domain}:`,
          ...visible.map(({ usage, summary, help }) => `  ${usage}\n    ${summary}${help ? `\n${help}` : ""}`),
        ]
      : [
          "Commands:",
          ...groups.map(({ name, count }) => `  ${name} (${count} command${count === 1 ? "" : "s"})`),
          "",
          "Meta:",
          "  capabilities [--json] — Describe the contracted CLI command surface.",
          "  --version — Print the CLI package version.",
          "",
          "Use ha <domain> --help for the commands in a domain.",
          ...rows.filter(({ usage }) => usage.includes("--service")).map(({ usage }) => `  ${usage}`),
        ],
    presetRows = catalog.length ? ["", "Recommended presets:", ...catalog.map(renderPresetHelpEntry)] : [];
  return ["Harness Anything thin CLI", "", ...body, ...presetRows].join("\n");
}

function renderPresetHelpEntry(entry: ThinHelpCatalogEntry): string {
  const contract = entry as ThinHelpCatalogEntry & {
    readonly defaultProfile?: string;
    readonly outputShape?: string;
    readonly completionGates?: readonly string[];
  };
  const description =
    entry.validity === "valid"
      ? [
          entry.description,
          `profile=${String(contract.defaultProfile)}`,
          `outputShape=${String(contract.outputShape)}`,
          `completionGates=${JSON.stringify(contract.completionGates)}`,
        ].join(" — ")
      : `${entry.validity}${entry.errorCode ? ` (${entry.errorCode})` : ""}`;
  return `  ${entry.id} — ${entry.title} — ${description}`;
}
