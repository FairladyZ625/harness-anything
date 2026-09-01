import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { accepted, globalOption, nonEmpty, rejected, stripGlobals } from "./thin-command-flags.ts";
import type { ThinHelpOverlayRoute, ThinParseResult } from "./thin-command-types.ts";

const explainUsage =
  "Use ha explain task for the catalog, or ha explain task/<task-id> [task/<task-id>...] for 1..500 objects.";

export function taskExplainHelpOverlay(argv: readonly string[]): ThinHelpOverlayRoute | undefined {
  const args = stripGlobals(argv);
  if (args[0] !== "task" || !args.includes("--help") || !args.includes("--explain")) return undefined;
  const target = args[3];
  if (args.length !== 4 || args[1] !== "--help" || args[2] !== "--explain" || !nonEmpty(target))
    return {
      ok: false,
      code: "invalid_field",
      nextAction: "Use ha task --help --explain task/<task-id> with exactly one Task ref.",
      json: argv.includes("--json"),
    };
  const rootDir = globalOption(argv, "--root"),
    repoId = globalOption(argv, "--repo");
  return {
    ok: true,
    argv: [
      "explain",
      target,
      ...(rootDir === undefined ? [] : ["--root", rootDir]),
      ...(repoId === undefined ? [] : ["--repo", repoId]),
      ...(argv.includes("--json") ? ["--json"] : []),
    ],
  };
}

export function isRetiredEntityExplain(argv: readonly string[]): boolean {
  const args = stripGlobals(argv);
  return args[0] === "entity" && args[1] === "explain";
}

export function parseExplain(
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  method: string,
): ThinParseResult {
  const targets = args.slice(1);
  if (targets.length === 1 && targets[0] === "task")
    return accepted(
      rootDir,
      repoId,
      json,
      { kind: "entity-action-explain", schema: "entity-action-explain-request/v1", mode: "catalog", refs: [] },
      method,
    );
  if (
    targets.length < 1 ||
    targets.length > 500 ||
    targets.some((target) => !nonEmpty(target) || target.startsWith("--"))
  )
    return rejected("invalid_field", explainUsage, json);
  return accepted(
    rootDir,
    repoId,
    json,
    { kind: "entity-action-explain", schema: "entity-action-explain-request/v1", mode: "object", refs: targets },
    method,
  );
}
