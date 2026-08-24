import {
  deriveCliCapabilities,
  parseThinCommand,
  renderThinCapabilities,
} from "./cli/thin-command.ts";
import { runCommandThroughDaemon } from "./daemon/client.ts";
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
      if (
        pkg.name === "@harness-anything/cli" &&
        typeof pkg.version === "string"
      )
        return pkg.version;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("CLI version could not be derived from package.json.");
}

export function emitMeta(
  command: "version" | "capabilities",
  json: boolean,
): number {
  if (command === "capabilities") {
    const capabilities = deriveCliCapabilities();
    console.log(json ? JSON.stringify(capabilities) : renderThinCapabilities());
    return 0;
  }
  const version = resolveCliVersion();
  console.log(json ? JSON.stringify({ ok: true, command, version }) : version);
  return 0;
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
  if (argv[0] !== "task" || argv[1] !== "create") return [];
  const globals = argv.flatMap((value, index) =>
      value === "--json"
        ? [value]
        : value === "--root" || value === "--repo"
          ? [value, argv[index + 1] ?? ""]
          : [],
    ),
    parsed = parseThinCommand(["preset", "list", ...globals]);
  if (!parsed.ok) return [];
  try {
    const receipt = await runCommandThroughDaemon(parsed.command, undefined, {
        autostart: false,
      }),
      rows =
        typeof receipt.evidence === "string"
          ? (JSON.parse(receipt.evidence) as unknown)
          : null;
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
              (key) =>
                typeof (row as Record<string, unknown>)[key] === "string",
            ),
        )
      : [];
  } catch {
    return [];
  }
}

export function cliFailure(
  command: string,
  code: string,
  nextAction: string,
): Record<string, unknown> {
  return {
    schema: "command-receipt/v2",
    ok: false,
    command,
    outcome: "op_rejected",
    opId: "N/A",
    origin: "cli",
    code,
    evidence: `rejection:${code}`,
    error: { code, hint: nextAction },
    nextAction,
  };
}
