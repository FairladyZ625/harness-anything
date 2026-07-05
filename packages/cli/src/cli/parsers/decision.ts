import {
  parseEntityRef,
  relationTypes,
  type RelationType
} from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption, readRepeatedRawOption } from "../parse-options.ts";
import type { CliResult, DecisionClaimInput, DecisionEvidenceRelationInput, ParsedCommand } from "../types.ts";
import { parseDecisionAmendPatches } from "./decision-amend.ts";
import { parseDecisionRelationOp } from "./decision-relation.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

const transitionOps = new Set(["accept", "reject", "defer", "supersede", "retire"]);
const tiers = new Set(["low", "medium", "high"]);
const actorKinds = new Set(["agent", "human", "system"]);
const evidenceTargetKinds = new Set(["task", "fact", "decision"]);

export function parseDecisionArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] !== "decision") return null;
  const op = args[1];
  if (op === "list") {
    return parsedDecision(rootDir, json, {
      kind: "decision-list",
      search: readOption(args, "--search"),
      legacyId: readOption(args, "--legacy-id"),
      legacyRange: readOption(args, "--legacy-range"),
      state: readOption(args, "--state"),
      moduleKey: readOption(args, "--module"),
      productLine: readOption(args, "--product-line"),
      compact: args.includes("--compact")
    });
  }
  if (op === "show" && args[2]) {
    return parsedDecision(rootDir, json, {
      kind: "decision-show",
      selector: args[2]!
    });
  }
  if (op === "propose") return parseDecisionPropose(args, rootDir, json);
  if (op === "reckon" && args[2]) {
    const taskId = readOption(args, "--task");
    if (!taskId) return { ok: false, error: cliError(CliErrorCode.MissingTaskId, "Use decision reckon <decision-id> --task <task-id>.") };
    return parsedDecision(rootDir, json, {
      kind: "decision-reckon",
      decisionId: args[2],
      taskId,
      dryRun: args.includes("--dry-run")
    });
  }
  if (transitionOps.has(op ?? "") && args[2]) {
    const arbiter = readOption(args, "--arbiter");
    if (arbiter && !isActorRef(arbiter)) return invalidActor();
    const judgmentOnlyRationale = readOption(args, "--judgment-only");
    if (op === "accept" && args.includes("--judgment-only") && (!judgmentOnlyRationale || judgmentOnlyRationale.trim().length === 0)) {
      return { ok: false, error: cliError(CliErrorCode.MissingReason, "Use decision accept <decision-id> --judgment-only <rationale>.") };
    }
    return parsedDecision(rootDir, json, {
      kind: `decision-${op}` as "decision-accept" | "decision-reject" | "decision-defer" | "decision-supersede" | "decision-retire",
      decisionId: args[2]!,
      arbiter,
      decidedAt: readOption(args, "--decided-at"),
      ...(op === "accept" && judgmentOnlyRationale ? { judgmentOnlyRationale } : {}),
      body: readOption(args, "--body"),
      dryRun: args.includes("--dry-run")
    });
  }
  if (op === "amend" && args[2]) {
    const patches = parseDecisionAmendPatches(args);
    if (!patches.ok) return { ok: false, error: patches.error };
    return parsedDecision(rootDir, json, {
      kind: "decision-amend",
      decisionId: args[2],
      title: readOption(args, "--title"),
      body: readOption(args, "--body"),
      patches: patches.value,
      dryRun: args.includes("--dry-run")
    });
  }
  if (op === "relate" && args[2]) return parseDecisionRelate(args, rootDir, json);
  if (op === "relation") return parseDecisionRelationOp(args, rootDir, json);
  return { ok: false, error: cliError(CliErrorCode.UnknownCommand, "Use decision list|show|propose|accept|reject|defer|supersede|amend|relate|reckon|relation|retire.") };
}

function parseDecisionPropose(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const title = readOption(args, "--title");
  const question = readOption(args, "--question");
  const chosen = readOption(args, "--chosen");
  const rejected = readOption(args, "--rejected");
  const whyNot = readOption(args, "--why-not");
  if (!title) return { ok: false, error: cliError(CliErrorCode.MissingTitle, "Use decision propose --title <title>.") };
  if (!question) return { ok: false, error: cliError(CliErrorCode.MissingDecisionQuestion, "Use decision propose --question <text>.") };
  if (!chosen) return { ok: false, error: cliError(CliErrorCode.MissingDecisionChoice, "Use decision propose --chosen <text>.") };
  if (!rejected || !whyNot) return { ok: false, error: cliError(CliErrorCode.MissingDecisionRejected, "Use decision propose --rejected <text> --why-not <text>.") };
  const riskTier = readTier(readOption(args, "--risk-tier") ?? "medium");
  const urgency = readTier(readOption(args, "--urgency") ?? "medium");
  if (!riskTier || !urgency) return { ok: false, error: cliError(CliErrorCode.InvalidDecisionTier, "Use low, medium, or high for --risk-tier and --urgency.") };
  const proposedBy = readOption(args, "--proposed-by");
  const arbiter = readOption(args, "--arbiter");
  if (proposedBy && !isActorRef(proposedBy)) return invalidActor();
  if (arbiter && !isActorRef(arbiter)) return invalidActor();
  const evidenceRelations = parseEvidenceRelations(args);
  if (!evidenceRelations.ok) return { ok: false, error: evidenceRelations.error };
  const claims = parseClaimInputs(args, !args.includes("--non-load-bearing"));
  if (!claims.ok) return { ok: false, error: claims.error };
  return parsedDecision(rootDir, json, {
    kind: "decision-propose",
    decisionId: readOption(args, "--id"),
    title,
    question,
    chosen,
    rejected,
    whyNot,
    claim: readOption(args, "--claim"),
    claims: claims.value,
    claimLoadBearing: !args.includes("--non-load-bearing"),
    riskTier,
    urgency,
    proposedBy,
    arbiter,
    modules: splitList(readOption(args, "--module")),
    productLines: splitList(readOption(args, "--product-line")),
    evidenceRelations: evidenceRelations.value,
    body: readOption(args, "--body"),
    dryRun: args.includes("--dry-run")
  });
}

function parseClaimInputs(args: ReadonlyArray<string>, defaultLoadBearing: boolean):
  | { readonly ok: true; readonly value: ReadonlyArray<DecisionClaimInput> }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  const claims: DecisionClaimInput[] = [];
  for (const raw of readRepeatedRawOption(args, "--claim")) {
    const parsed = parseClaimInput(raw, defaultLoadBearing);
    if (!parsed.ok) return parsed;
    claims.push(parsed.value);
  }
  return { ok: true, value: claims };
}

function parseClaimInput(raw: string | undefined, defaultLoadBearing: boolean):
  | { readonly ok: true; readonly value: DecisionClaimInput }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  if (!raw || raw.startsWith("--")) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionAmendPatch, "Use --claim <text> or --claim <json-object>.") };
  }
  if (!raw.trim().startsWith("{")) return { ok: true, value: { text: raw, ...(defaultLoadBearing ? {} : { load_bearing: false }) } };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("claim JSON must be an object");
    const object = parsed as { readonly id?: unknown; readonly text?: unknown; readonly load_bearing?: unknown };
    if (typeof object.text !== "string" || object.text.trim().length === 0) throw new Error("claim JSON requires text");
    return {
      ok: true,
      value: {
        ...(typeof object.id === "string" && object.id.trim() ? { id: object.id } : {}),
        text: object.text,
        ...(typeof object.load_bearing === "boolean" ? { load_bearing: object.load_bearing } : defaultLoadBearing ? {} : { load_bearing: false })
      }
    };
  } catch (error) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionAmendPatch, `Invalid --claim JSON: ${error instanceof Error ? error.message : String(error)}`) };
  }
}

function parseDecisionRelate(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const anchor = readOption(args, "--anchor");
  const type = readOption(args, "--type");
  const target = readOption(args, "--target");
  const rationale = readOption(args, "--rationale");
  const targetRef = target ? parseEntityRef(target) : null;
  if (!anchor || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(anchor)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionEvidenceRelation, "Use decision relate <decision-id> --anchor <CH1|RJ1|C1> --type <relation-type> --target <entity-ref> --rationale <text>.") };
  }
  if (!isRelationType(type)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionEvidenceRelation, `Unknown relation type for decision relate: ${type ?? "<missing>"}. Valid relation types: ${relationTypes.join(", ")}.`) };
  }
  if (!targetRef || targetRef.externalHarness || !evidenceTargetKinds.has(targetRef.kind)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionEvidenceRelation, "Use decision relate --target task/<id>, decision/<id>[/anchor], or fact/<task-id>/<fact-id>.") };
  }
  if (!rationale || rationale.trim().length === 0) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionEvidenceRelation, "Use decision relate --rationale <non-empty text>.") };
  }
  return parsedDecision(rootDir, json, {
    kind: "decision-relate",
    decisionId: args[2],
    anchor,
    relationType: type,
    target: target ?? "",
    rationale,
    body: readOption(args, "--body"),
    dryRun: args.includes("--dry-run")
  });
}

function parseEvidenceRelations(args: ReadonlyArray<string>):
  | { readonly ok: true; readonly value: ReadonlyArray<DecisionEvidenceRelationInput> }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  const values = readRepeatedRawOption(args, "--evidence-relation");
  const relations: DecisionEvidenceRelationInput[] = [];
  for (const value of values) {
    const relation = parseEvidenceRelation(value);
    if (!relation) {
      return {
        ok: false,
        error: cliError(CliErrorCode.InvalidDecisionEvidenceRelation, "Use --evidence-relation <anchor>:<type>:<task|decision|fact-ref>:<rationale>.")
      };
    }
    relations.push(relation);
  }
  return { ok: true, value: relations };
}

function parseEvidenceRelation(value: string | undefined): DecisionEvidenceRelationInput | null {
  if (!value || value.startsWith("--")) return null;
  const [anchor, type, target, ...rationaleParts] = value.split(":");
  const rationale = rationaleParts.join(":").trim();
  const targetRef = target ? parseEntityRef(target) : null;
  if (!anchor || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(anchor)) return null;
  if (!isRelationType(type)) return null;
  if (!targetRef || targetRef.externalHarness || !evidenceTargetKinds.has(targetRef.kind)) return null;
  if (rationale.length === 0) return null;
  return { anchor, type, target, rationale };
}

function isRelationType(value: string | undefined): value is RelationType {
  return relationTypes.includes(value as RelationType);
}

function readTier(value: string): "low" | "medium" | "high" | null {
  return tiers.has(value) ? value as "low" | "medium" | "high" : null;
}

function splitList(value: string | undefined): ReadonlyArray<string> {
  return value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

function isActorRef(value: string): boolean {
  const separator = value.indexOf(":");
  return separator > 0 && separator < value.length - 1 && actorKinds.has(value.slice(0, separator));
}

function invalidActor(): ParseResult {
  return { ok: false, error: cliError(CliErrorCode.InvalidDecisionActor, "Use actor refs as agent:<id>, human:<id>, or system:<id>.") };
}

function parsedDecision(rootDir: string, json: boolean, action: ParsedCommand["action"]): ParseResult {
  return { ok: true, value: { rootDir, json, action } };
}
