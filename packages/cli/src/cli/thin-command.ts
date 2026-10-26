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
  // `ha agent rollback` reads a retained declaration body before it writes, so this receipt can
  // be answered without the daemon (a corrupt version payload names the same code).
  "agent_version_unavailable",
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
import type { ProtocolCommand, ThinCliInputDirectory, ThinCommand, ThinParseResult } from "./thin-command-types.ts";

type LifecyclePublicationAction =
  | "task-create"
  | "task-start"
  | "task-submit"
  | "task-review-execution"
  | "task-respond-review"
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
  // `--root` is a global daemon target for every command, and also the edge join workspace
  // selector. Reintroduce it for the route-local parser after global stripping.
  if (route?.id === "edge-join") {
    const commandIndex = argv.findIndex((value, index) => value === "edge" && argv[index + 1] === "join"),
      rootIndex = argv.findIndex((value, index) => value === "--root" && index > commandIndex);
    if (commandIndex >= 0 && rootIndex >= 0) args.push("--root", argv[rootIndex + 1] ?? "");
  }
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
  if (routed) return declared(resolveCallerPaths(routed, rootDir, cwd));
  if (!route || args[0] !== "task") return rejected("unsupported_command", unsupportedCommandHint(args), json);
  return declared(resolveCallerPaths(parseTaskRoute(route.id, args, rootDir, repoId, json, inputs), rootDir, cwd));
}

// A value naming a file belongs to the workspace the caller selected with --root (default cwd), and
// the daemon resolves file paths from the center's own root instead — a different directory when a
// worker runs inside a task worktree, whose own file then read as missing and whose real refusal
// (too large) was replaced by that wrong one. Resolving against the selected workspace root keeps
// one definition here and agrees with how every other workspace path flag reads; the local, fleet,
// and remote routes then all name the same file. Keyed by action kind because `source` is a
// free-text provenance label on fact-record, not a path. `packageSource` stays anchored to the cwd:
// its declaration makes it independent of the repository selection.
const workspacePathFields: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "task-artifact-add": ["source"],
});

function resolveCallerPaths(result: ThinParseResult, workspaceRoot: SafePath, cwd: string): ThinParseResult {
  if (!result.ok) return result;
  const action = result.command.action,
    resolved: Record<string, unknown> = { ...action };
  let changed = false;
  const resolve = (field: string, base: string): void => {
    const value = action[field];
    if (typeof value !== "string") return;
    resolved[field] = path.resolve(base, value);
    changed = true;
  };
  for (const field of workspacePathFields[action.kind] ?? []) resolve(field, workspaceRoot);
  resolve("packageSource", cwd);
  return changed ? { ...result, command: { ...result.command, action: resolved as ThinCommand["action"] } } : result;
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
      ...thinCliCommands.map(({ usage, summary, help }) => {
        const preferred = preferTaskActionHelp({ usage, summary, help });
        return usage.startsWith("ha task create ")
          ? {
              ...preferred,
              help: [
                preferred.help,
                "Risk tier selects the task flow: low is for a small localized change or docs-only work and skips review and consent; " +
                  "medium is the default for ordinary feature work and gets one functional review; high is for data, security, " +
                  "or protected-surface changes and gets full review plus consent.",
                'Examples: ha task create --title "Fix a typo" --risk-tier low; ha task create --title "Add a feature"; ' +
                  'ha task create --title "Change stored data format" --risk-tier high.',
                "Low uses a short package when the preset provides one. Submit checks the actual delivery diff with " +
                  "repository-configured risk-floor scripts; they may only raise the tier.",
              ]
                .filter(Boolean)
                .join("\n"),
            }
          : preferred;
      }),
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
          // The rule the receipt candidates enforce: placement follows the work's goal, so a task
          // never lands under whichever line happens to be busy.
          "File this task with --work <id>, chosen by the work's goal: the task belongs where it serves that",
          "goal, not under whichever line is currently busy (ha work show <id> states the goal). No fitting",
          "work? ha work create --title <name> starts one, or file under a general work (defect fixes,",
          "system-friction governance).",
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
  const others = (contract.profiles ?? [])
    .map(({ id }) => id)
    .filter((id) => id !== contract.defaultProfile && id !== "lightweight");
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
