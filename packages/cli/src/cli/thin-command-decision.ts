import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import {
  parseDecisionAmend,
  parseDecisionRepin,
  parseDecisionTransition,
  parseDecisionValidation,
} from "./thin-command-decision-lifecycle.ts";
import { parseDecisionRead } from "./thin-command-decision-read.ts";
import {
  accepted,
  nonEmpty,
  readFlags,
  rejectInput,
  rejected,
} from "./thin-command-flags.ts";
import { parseProjected } from "./thin-command-projection.ts";
import type {
  ThinCliInputDirectory,
  ThinParseResult,
} from "./thin-command-types.ts";

export function parseDecision(
  id: string,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  if (id === "decision-validate" || id === "decision-verify")
    return parseDecisionValidation(id, args, rootDir, repoId, json, inputs);
  if (id === "decision-repin")
    return parseDecisionRepin(args, rootDir, repoId, json, inputs);
  if (id === "decision-transition")
    return parseDecisionTransition(args, rootDir, repoId, json, inputs);
  const noId = id === "decision-propose" || id === "decision-list",
    nested =
      id.startsWith("decision-claim-") ||
      id === "decision-relation-retire" ||
      id === "decision-relation-replace",
    decisionId = noId ? undefined : args[nested ? 3 : 2];
  if (!noId && !nonEmpty(decisionId))
    return rejected("missing_field", "Decision id is required.", json);
  if (id === "decision-propose")
    return parseProposal(args, rootDir, repoId, json, inputs);
  if (["decision-accept", "decision-reject", "decision-defer"].includes(id))
    return parseProjected(
      id,
      args.slice(3),
      rootDir,
      repoId,
      json,
      inputs,
      { decisionId },
      id === "decision-accept" ? { judgmentOnlyRationale: null } : {},
    );
  if (id === "decision-supersede" || id === "decision-retire")
    return parseProjected(id, args.slice(3), rootDir, repoId, json, inputs, {
      decisionId,
    });
  if (id === "decision-amend")
    return parseDecisionAmend(decisionId!, args, rootDir, repoId, json, inputs);
  if (id.startsWith("decision-claim-"))
    return parseClaim(id, decisionId!, args, rootDir, repoId, json, inputs);
  if (
    id === "decision-relate" ||
    id === "decision-relation-retire" ||
    id === "decision-relation-replace"
  )
    return parseDecisionRelation(
      id,
      decisionId!,
      args,
      rootDir,
      repoId,
      json,
      inputs,
    );
  if (id === "decision-reckon")
    return parseProjected(id, args.slice(3), rootDir, repoId, json, inputs, {
      decisionId,
    });
  if (id === "decision-list" || id === "decision-show")
    return parseDecisionRead(
      id,
      decisionId,
      args,
      rootDir,
      repoId,
      json,
      inputs,
    );
  return rejected(
    "unsupported_command",
    "Use a canonical Decision command.",
    json,
  );
}

export function parseProposal(
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const f = readFlags("decision-propose", args.slice(2), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const fromFile = f.one.get("--from-file"),
    jsonInput = f.one.get("--json-input"),
    body = f.one.get("--body"),
    bodyFile = f.one.get("--body-file");
  if (
    Boolean(fromFile) === Boolean(jsonInput) ||
    (body !== undefined && bodyFile !== undefined)
  )
    return rejectInput(
      inputs,
      "decision-propose",
      fromFile && jsonInput
        ? "--json-input"
        : body && bodyFile
          ? "--body-file"
          : "--from-file",
      json,
    );
  return accepted(rootDir, repoId, json, {
    kind: "decision-propose",
    ...(fromFile ? { fromFile } : { jsonInput }),
    ...(body !== undefined ? { body } : bodyFile ? { bodyFile } : {}),
  });
}

export function parseClaim(
  id: string,
  decisionId: string,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const add = id === "decision-claim-add",
    f = readFlags(id, args.slice(4), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const claimId = f.one.get("--id");
  return add
    ? accepted(rootDir, repoId, json, {
        kind: id,
        decisionId,
        claimId,
        text: f.one.get("--text"),
        loadBearing: !f.booleans.has("--non-load-bearing"),
      })
    : accepted(rootDir, repoId, json, {
        kind: id,
        decisionId,
        claimId,
        mode: f.one.get("--mode"),
      });
}

export function parseDecisionRelation(
  id: string,
  decisionId: string,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const nested =
      id === "decision-relation-retire" || id === "decision-relation-replace",
    f = readFlags(id, args.slice(nested ? 4 : 3), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  if (id === "decision-relation-retire")
    return accepted(rootDir, repoId, json, {
      kind: id,
      decisionId,
      relationId: f.one.get("--relation"),
      reason: f.one.get("--reason"),
    });
  return accepted(rootDir, repoId, json, {
    kind: id,
    decisionId,
    ...(id === "decision-relation-replace"
      ? {
          relationId: f.one.get("--relation"),
          body: f.one.get("--body") ?? null,
          dryRun: f.booleans.has("--dry-run"),
        }
      : {}),
    anchor: f.one.get("--anchor"),
    relationType: f.one.get("--type"),
    target: f.one.get("--target"),
    rationale: f.one.get("--rationale"),
  });
}
