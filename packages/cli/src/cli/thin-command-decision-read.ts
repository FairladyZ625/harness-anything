import type { SafePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { accepted, nonEmpty, readFlags, rejectInput, rejected } from "./thin-command-flags.ts";
import type { ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

export function parseDecisionRead(
  id: string,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  if (id === "decision-show") {
    const positional = args[2]?.startsWith("--") ? undefined : args[2],
      f = readFlags(id, args.slice(positional ? 3 : 2), inputs);
    if (!f.ok) return rejected(f.code, f.nextAction, json);
    const flagged = f.one.get("--id");
    if (positional && flagged)
      return rejected("duplicate_field", "Use either ha decision show <id> or --id <id>, not both.", json);
    return nonEmpty(positional ?? flagged)
      ? accepted(rootDir, repoId, json, {
          kind: id,
          decisionId: positional ?? flagged,
          includeBody: f.booleans.has("--include-body"),
        })
      : rejected("missing_field", "Run ha decision show <id>.", json);
  }
  const f = readFlags(id, args.slice(2), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const range = f.one.get("--legacy-range"),
    match = range && /^E([1-9][0-9]*)-E([1-9][0-9]*)$/u.exec(range);
  if (range && (!match || Number(match[1]) > Number(match[2]))) return rejectInput(inputs, id, "--legacy-range", json);
  return accepted(rootDir, repoId, json, {
    kind: id,
    ...(f.one.get("--search") ? { search: f.one.get("--search") } : {}),
    ...(f.one.get("--state") ? { state: f.one.get("--state") } : {}),
    ...(f.one.get("--legacy-id") ? { legacyId: f.one.get("--legacy-id") } : {}),
    ...(match ? { legacyRange: { start: Number(match[1]), end: Number(match[2]) } } : {}),
    ...(f.one.get("--module") ? { module: f.one.get("--module") } : {}),
    ...(f.one.get("--product-line") ? { productLine: f.one.get("--product-line") } : {}),
    ...(f.one.has("--limit") ? { limit: Number(f.one.get("--limit")) } : {}),
    ...(f.one.get("--cursor") ? { cursor: f.one.get("--cursor") } : {}),
  });
}
