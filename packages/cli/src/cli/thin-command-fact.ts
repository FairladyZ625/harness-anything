import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { accepted, readFlags, rejectInput, rejected } from "./thin-command-flags.ts";
import { parseProjected } from "./thin-command-projection.ts";
import type { ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

export function parseFact(
  id: string,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  if (id === "fact-record") return parseFactRecord(args, rootDir, repoId, json, inputs);
  if (id === "fact-search") {
    const query = args[2]?.startsWith("--") ? undefined : args[2];
    return parseProjected(id, args.slice(query ? 3 : 2), rootDir, repoId, json, inputs, query ? { query } : {});
  }
  if (id === "fact-show") return parseProjected(id, args.slice(2), rootDir, repoId, json, inputs);
  return rejected("unsupported_command", "Use fact record, search, or show.", json);
}

export function parseFactRecord(
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const positionalTaskId = args[2]?.startsWith("--") ? undefined : args[2],
    tokens = args.slice(positionalTaskId ? 3 : 2),
    retired = tokens
      .map((token) => token.split("=", 1)[0])
      .find((token) => token === "--kind" || token === "--summary" || token === "--detail");
  if (retired)
    return rejected(
      "unknown_field",
      `${retired} was removed. Use ha fact record <task-id> --statement <observation> --source <source>.`,
      json,
    );
  const f = readFlags("fact-record", tokens, inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const flaggedTaskId = f.one.get("--task"),
    statement = f.one.get("--statement"),
    text = f.one.get("--text"),
    evidenceSource = f.one.get("--source"),
    observedAt = f.one.get("--observed-at"),
    confidence = f.one.get("--confidence") ?? "medium",
    memoryClass = f.one.get("--memory-class") ?? "episodic",
    supersedes = f.one.get("--supersedes"),
    rationale = f.one.get("--rationale");
  if (positionalTaskId && flaggedTaskId)
    return rejected("duplicate_field", "Use either fact record <task-id> or --task <task-id>, not both.", json);
  if (statement && text) return rejected("duplicate_field", "Use either --statement or --text, not both.", json);
  if (!statement && !text)
    return rejected(
      "missing_field",
      "Use --statement <observation> or --text <observation>; --source <source> is also required.",
      json,
    );
  if (Boolean(supersedes) !== Boolean(rationale)) return rejectInput(inputs, "fact-record", "--rationale", json);
  return accepted(rootDir, repoId, json, {
    kind: "fact-record",
    ...(positionalTaskId || flaggedTaskId ? { taskId: positionalTaskId ?? flaggedTaskId } : {}),
    statement: statement ?? text,
    evidenceSource,
    ...(observedAt ? { observedAt } : {}),
    confidence,
    memoryClass,
    memoryTags: f.many.get("--memory-tag") ?? [],
    ...(supersedes && rationale ? { supersedes: { factRef: supersedes, rationale } } : {}),
  });
}
