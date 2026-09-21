import type { SafePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { accepted, nonEmpty, readFlags, rejected } from "./thin-command-flags.ts";
import { parseRematerialize } from "./thin-command-rematerialize.ts";
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
  if (id === "fact-rematerialize") return parseRematerialize(id, "factId", args, rootDir, repoId, json, inputs);
  if (id === "fact-archive") {
    const factId = args[2]?.startsWith("--") ? undefined : args[2],
      f = readFlags(id, args.slice(factId ? 3 : 2), inputs);
    if (!f.ok) return rejected(f.code, f.nextAction, json);
    const idsFile = f.one.get("--ids-file");
    if (factId && idsFile)
      return rejected("duplicate_field", "Use either ha fact archive <fact-id> or --ids-file <path>, not both.", json);
    if (!factId && !idsFile)
      return rejected(
        "missing_field",
        "Use ha fact archive <fact-id> --reason <why> or --ids-file <path> --reason <why>.",
        json,
      );
    return accepted(rootDir, repoId, json, {
      kind: "fact-archive",
      ...(factId ? { factId } : { idsFile }),
      reason: f.one.get("--reason"),
      ...(f.booleans.has("--dry-run") ? { dryRun: true } : {}),
    });
  }
  if (id === "fact-unarchive") {
    const factId = args[2]?.startsWith("--") ? undefined : args[2],
      f = readFlags(id, args.slice(factId ? 3 : 2), inputs);
    if (!factId) return rejected("missing_field", "Use ha fact unarchive <fact-id> --reason <why>.", json);
    if (!f.ok) return rejected(f.code, f.nextAction, json);
    return accepted(rootDir, repoId, json, {
      kind: "fact-unarchive",
      factId,
      reason: f.one.get("--reason"),
    });
  }
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
  if (id === "fact-type-list")
    return accepted(rootDir, repoId, json, {
      kind: "fact-type-list",
    });
  if (id === "fact-show") {
    const positional = args[2]?.startsWith("--") ? undefined : args[2],
      f = readFlags(id, args.slice(positional ? 3 : 2), inputs);
    if (!f.ok) return rejected(f.code, f.nextAction, json);
    const flagged = f.one.get("--id");
    if (positional && flagged)
      return rejected("duplicate_field", "Use either ha fact show <fact-id> or --id <fact-id>, not both.", json);
    return nonEmpty(positional ?? flagged)
      ? accepted(rootDir, repoId, json, { kind: "fact-show", factId: positional ?? flagged })
      : rejected("missing_field", "Run ha fact show <fact-id>.", json);
  }
  return rejected("unsupported_command", "Use fact record, type register, type list, or show.", json);
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
    ...(supersedes && rationale ? { supersedes: { factRef: supersedes, rationale } } : {}),
  });
}
