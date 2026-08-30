import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { accepted, projectionWaitMs, readFlags, rejectInput, rejected } from "./thin-command-flags.ts";
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
  if (id === "fact-reclassify") {
    const factId = args[2]?.startsWith("--") ? undefined : args[2],
      f = readFlags(id, args.slice(factId ? 3 : 2), inputs);
    if (!factId)
      return rejected("missing_field", "Use ha fact reclassify <fact-id> --type <type> --rationale <why>.", json);
    if (!f.ok) return rejected(f.code, f.nextAction, json);
    return accepted(rootDir, repoId, json, {
      kind: "fact-reclassify",
      factId,
      domainTypes: f.many.get("--type") ?? [],
      rationale: f.one.get("--rationale"),
    });
  }
  if (id === "fact-type-register") {
    const domainType = args[3],
      f = readFlags(id, args.slice(4), inputs);
    if (!domainType || domainType.startsWith("--"))
      return rejected("missing_field", "Use ha fact type register <type> --source <source>.", json);
    if (!f.ok) return rejected(f.code, f.nextAction, json);
    return accepted(rootDir, repoId, json, {
      kind: "fact-type-register",
      statement: `Registered Fact domain type: ${domainType}`,
      evidenceSource: f.one.get("--source"),
      confidence: "high",
      memoryClass: "semantic",
      memoryTags: [],
      registersDomainType: domainType,
    });
  }
  if (id === "fact-search") {
    const query = args[2]?.startsWith("--") ? undefined : args[2];
    return parseProjected(id, args.slice(query ? 3 : 2), rootDir, repoId, json, inputs, query ? { query } : {});
  }
  if (id === "fact-show") return parseProjected(id, args.slice(2), rootDir, repoId, json, inputs);
  return rejected("unsupported_command", "Use fact record, type register, search, or show.", json);
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
    domainTypes = f.many.get("--type") ?? [],
    memoryClass = f.one.get("--memory-class") ?? "episodic",
    waitProjectionMs = projectionWaitMs(f.one.get("--wait-projection")),
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
  if (waitProjectionMs === null)
    return rejected("invalid_field", "Use a non-negative safe integer projection wait limit in milliseconds.", json);
  if (Boolean(supersedes) !== Boolean(rationale)) return rejectInput(inputs, "fact-record", "--rationale", json);
  return accepted(rootDir, repoId, json, {
    kind: "fact-record",
    ...(positionalTaskId || flaggedTaskId ? { taskId: positionalTaskId ?? flaggedTaskId } : {}),
    statement: statement ?? text,
    evidenceSource,
    ...(observedAt ? { observedAt } : {}),
    confidence,
    ...(domainTypes.length ? { domainTypes } : {}),
    memoryClass,
    memoryTags: f.many.get("--memory-tag") ?? [],
    ...(waitProjectionMs === undefined ? {} : { waitProjectionMs }),
    ...(supersedes && rationale ? { supersedes: { factRef: supersedes, rationale } } : {}),
  });
}
