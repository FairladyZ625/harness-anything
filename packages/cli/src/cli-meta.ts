import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";
import {
  cliCapabilities,
  parseThinCommand,
  renderThinCapabilities,
  type ThinHelpWorkEntry,
} from "./cli/thin-command.ts";
import { runCommandThroughDaemon } from "./daemon/client.ts";
import { stripGlobals } from "./cli/thin-command-flags.ts";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveCliVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as {
        readonly name?: unknown;
        readonly version?: unknown;
      };
      if (pkg.name === "@harness-anything/cli" && typeof pkg.version === "string") return pkg.version;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("CLI version could not be derived from package.json.");
}

export function emitMeta(command: "version" | "capabilities", json: boolean): number {
  if (command === "capabilities") {
    console.log(json ? JSON.stringify(cliCapabilities) : renderThinCapabilities());
    return 0;
  }
  const version = resolveCliVersion();
  console.log(json ? JSON.stringify({ ok: true, command, version }) : version);
  return 0;
}

/** The help path serves `ha task create --help` wherever the globals sit; callers pass raw argv. */
function isTaskCreateHelpInvocation(argv: readonly string[]): boolean {
  const invocation = stripGlobals(argv);
  return invocation[0] === "task" && invocation[1] === "create";
}

export async function taskCreateHelpCatalog(argv: readonly string[]): Promise<
  Array<{
    id: string;
    title: string;
    description: string;
    validity: string;
    errorCode?: string;
  }>
> {
  if (!isTaskCreateHelpInvocation(argv)) return [];
  const globals = argv.flatMap((value, index) =>
      value === "--json" ? [value] : value === "--root" || value === "--repo" ? [value, argv[index + 1] ?? ""] : [],
    ),
    parsed = parseThinCommand(["preset", "list", ...globals]);
  if (!parsed.ok) return [];
  try {
    const receipt = await runCommandThroughDaemon(parsed.command, undefined, {
        autostart: false,
      }),
      rows = typeof receipt.evidence === "string" ? (JSON.parse(receipt.evidence) as unknown) : null;
    return Array.isArray(rows)
      ? rows.filter(
          (
            row,
          ): row is {
            id: string;
            title: string;
            description: string;
            validity: string;
            errorCode?: string;
          } =>
            !!row &&
            typeof row === "object" &&
            ["id", "title", "description", "validity"].every(
              (key) => typeof (row as Record<string, unknown>)[key] === "string",
            ),
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * The packs a create can be filed under, read through the daemon route `ha work list` itself uses:
 * one row per open work, already activity-ordered and cut-limited by the daemon, so help shows the
 * same works the command would and no second work-list query exists on this side.
 */
export async function taskCreateHelpWorks(argv: readonly string[]): Promise<readonly ThinHelpWorkEntry[]> {
  if (!isTaskCreateHelpInvocation(argv)) return [];
  const globals = argv.flatMap((value, index) =>
      value === "--root" || value === "--repo" ? [value, argv[index + 1] ?? ""] : [],
    ),
    parsed = parseThinCommand(["work", "list", "--limit", String(TASK_CREATE_HELP_WORK_LIMIT), ...globals]);
  if (!parsed.ok) return [];
  try {
    const receipt = await runCommandThroughDaemon(parsed.command, undefined, { autostart: false }),
      payload = typeof receipt.evidence === "string" ? (JSON.parse(receipt.evidence) as unknown) : null,
      rows =
        payload !== null && typeof payload === "object" && Array.isArray((payload as { rows?: unknown }).rows)
          ? ((payload as { rows: unknown[] }).rows as unknown[])
          : [];
    return rows.flatMap((row) =>
      row !== null &&
      typeof row === "object" &&
      typeof (row as { taskId?: unknown }).taskId === "string" &&
      typeof (row as { title?: unknown }).title === "string"
        ? [{ taskId: (row as { taskId: string }).taskId, title: (row as { title: string }).title }]
        : [],
    );
  } catch {
    return [];
  }
}

const TASK_CREATE_HELP_WORK_LIMIT = 20;

export function cliFailure(command: string, code: string, expectation: string): JsonObject {
  return {
    schema: "command-receipt/v2",
    ok: false,
    command,
    outcome: "op_rejected",
    opId: "N/A",
    origin: "cli",
    code,
    evidence: `rejection:${code}`,
    error: { code },
    diagnostic: {
      kind: "validation",
      entity: "cli-command",
      field: "input",
      actual: code,
      expectation,
    },
  };
}
