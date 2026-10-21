export const thinCliLocalErrorCodes = Object.freeze([
  "oidc_device_expired",
  "browser_broker_failed",
  "command_not_found",
  "daemon_start_runtime_forbidden",
  "daemon_stopped_by_operator",
  "daemon_disconnect",
  "daemon_gone",
  "daemon_restarting",
  "daemon_target_conflict",
  "service_rejected",
  "duplicate_field",
  "invalid_field",
  "invalid_runtime_fast",
  "missing_field",
  "materialization_failed",
  "unknown_field",
  "unsupported_command",
  "cli_render_failed",
]);

export { cliCapabilities } from "./thin-command-help.ts";
export { runtimeBatchDeclarationFields } from "./thin-command-help.ts";
export { runtimeRunEfforts } from "./thin-command-help.ts";
export { renderThinCapabilities } from "./thin-command-help.ts";
export { firstCliCommandIndex } from "./thin-command-help.ts";
export { firstCliCommand } from "./thin-command-help.ts";
export { helpDomain } from "./thin-command-help.ts";
export { helpCommandPrefix } from "./thin-command-help.ts";
export { deriveThinCliInputs } from "./thin-command-inputs.ts";
export { cliCommandDomains } from "./thin-command-help.ts";
export { unsupportedCommandHint } from "./thin-command-help.ts";
export type { ThinHelpCatalogEntry } from "./thin-command-help.ts";
export type { ThinHelpWorkEntry } from "./thin-command-help.ts";
export type { ThinCommand } from "./thin-command-types.ts";
export type { ThinParseResult } from "./thin-command-types.ts";
export type { ThinCliInput } from "./thin-command-types.ts";

import path from "node:path";
import {
  daemonProtocolCommands,
  resolveThinCliCommand,
  safePath,
  thinCliCommands,
} from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import type { SafePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { accepted, globalOption, nonEmpty, rejected, stripGlobals } from "./thin-command-flags.ts";
import { clientLocalCommands, commandDomains, unsupportedCommandHint } from "./thin-command-help.ts";
import type { ThinHelpCatalogEntry, ThinHelpWorkEntry } from "./thin-command-help.ts";
import { deriveInputDirectory } from "./thin-command-inputs.ts";
import { parseRouted, parseStorageRoute } from "./thin-command-router.ts";
import { parseResumeDispatch } from "./thin-command-runtime.ts";
import { parseTask } from "./thin-command-task.ts";
import { preferTaskActionHelp } from "./task-action-help.ts";
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
  // Every accepted result names its route id, so the daemon-side logs can key the invocation by
  // the CLI command the user actually typed instead of the transport method it rode on.
  const declared = (result: ThinParseResult): ThinParseResult =>
    result.ok && route ? { ...result, command: { ...result.command, id: route.id } } : result;
  if (route?.id === "runtime-run" && args[2]?.startsWith("--") && args.includes("--resume-dispatch"))
    return declared(parseResumeDispatch(rootDir, repoId, json, args, inputs));
  if (route?.id === "task-dispatches" && nonEmpty(args[2]) && args.length === 3)
    return declared(
      accepted(rootDir, repoId, json, { kind: "task-dispatches", taskId: args[2] }, "repo.task.dispatches"),
    );
  const routed =
    parseStorageRoute(route, args, rootDir, repoId, json, inputs) ??
    parseRouted(route, args, rootDir, repoId, json, inputs);
  if (routed?.ok && typeof routed.command.action.packageSource === "string")
    return declared({
      ...routed,
      command: {
        ...routed.command,
        action: { ...routed.command.action, packageSource: path.resolve(cwd, routed.command.action.packageSource) },
      },
    });
  if (routed) return declared(routed);
  if (!route || args[0] !== "task") return rejected("unsupported_command", unsupportedCommandHint(args), json);
  return declared(parseTaskRoute(route.id, args, rootDir, repoId, json, inputs));
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

export function renderThinHelp(
  catalog: readonly ThinHelpCatalogEntry[] = [],
  domain?: string,
  commandPrefix?: string,
  works: readonly ThinHelpWorkEntry[] = [],
): string {
  const rows = [
      ...thinCliCommands.map(({ usage, summary, help }) =>
        preferTaskActionHelp({
          usage,
          summary,
          help,
        }),
      ),
      ...clientLocalCommands,
    ],
    commandWords = commandPrefix?.split(" ") ?? [],
    matchedPrefix = commandWords
      .map((_, dropped) => commandWords.slice(0, commandWords.length - dropped).join(" "))
      .find(
        (prefix) =>
          prefix.split(" ").length > 2 && rows.some(({ usage }) => usage === prefix || usage.startsWith(`${prefix} `)),
      ),
    visible = matchedPrefix
      ? rows.filter(({ usage }) => usage === matchedPrefix || usage.startsWith(`${matchedPrefix} `))
      : domain
        ? rows.filter(({ usage }) => usage.split(" ")[1] === domain)
        : rows,
    groups = commandDomains,
    body = domain
      ? [
          matchedPrefix && !matchedPrefix.split(" ").at(-1)?.startsWith("-")
            ? `Command ${matchedPrefix}:`
            : `Commands for ${domain}:`,
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
          "Organize work — a work is one root task plus its subtree: ha work create --title <name>, then " +
            "ha task create --work <id> --title <title>; ha work list · ha work show <id> · ha agenda --work <id>.",
          "",
          "Use ha <domain> --help for the commands in a domain.",
          ...rows.filter(({ usage }) => usage.includes("--service")).map(({ usage }) => `  ${usage}`),
        ],
    presetRows = catalog.length ? ["", "Recommended presets:", ...catalog.map(renderPresetHelpEntry)] : [],
    workRows = works.length
      ? [
          "",
          `Active works (${works.length} shown, newest activity first — the same rows ha work list returns):`,
          ...works.map(({ taskId, title }) => `  ${taskId} — ${title}`),
          "File this task with --work <id>; ha work create --title <name> starts a new one.",
        ]
      : [];
  return ["Harness Anything thin CLI", "", ...body, ...workRows, ...presetRows].join("\n");
}

function renderPresetHelpEntry(entry: ThinHelpCatalogEntry): string {
  const contract = entry as ThinHelpCatalogEntry & {
    readonly defaultProfile?: string;
    readonly profiles?: readonly { readonly id: string }[];
    readonly outputShape?: string;
    readonly completionGates?: readonly string[];
  };
  const others = (contract.profiles ?? []).map(({ id }) => id).filter((id) => id !== contract.defaultProfile);
  const description =
    entry.validity === "valid"
      ? [
          entry.description,
          `profile=${String(contract.defaultProfile)}${
            others.length ? ` (also ${others.map((id) => `--profile ${id}`).join(", ")})` : ""
          }`,
          `outputShape=${String(contract.outputShape)}`,
          `completionGates=${JSON.stringify(contract.completionGates)}`,
        ].join(" — ")
      : `${entry.validity}${entry.errorCode ? ` (${entry.errorCode})` : ""}`;
  return `  ${entry.id} — ${entry.title} — ${description}`;
}
