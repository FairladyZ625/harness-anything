import {
  decisionAmendFieldSupportsOperation,
  isDecisionAmendField,
  parseEntityRef,
  relationTypes,
  type RelationType
} from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption, readRepeatedRawOption } from "../parse-options.ts";
import type { CliResult, DecisionAmendPatchInput, DecisionEvidenceRelationInput, ParsedCommand } from "../types.ts";
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
  if (transitionOps.has(op ?? "") && args[2]) {
    const arbiter = readOption(args, "--arbiter");
    if (arbiter && !isActorRef(arbiter)) return invalidActor();
    return parsedDecision(rootDir, json, {
      kind: `decision-${op}` as "decision-accept" | "decision-reject" | "decision-defer" | "decision-supersede" | "decision-retire",
      decisionId: args[2]!,
      arbiter,
      decidedAt: readOption(args, "--decided-at"),
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
  return { ok: false, error: cliError(CliErrorCode.UnknownCommand, "Use decision list|show|propose|accept|reject|defer|supersede|amend|relate|relation|retire.") };
}

function parseDecisionAmendPatches(args: ReadonlyArray<string>):
  | { readonly ok: true; readonly value: ReadonlyArray<DecisionAmendPatchInput> }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  const patches: DecisionAmendPatchInput[] = [];
  for (const value of readRepeatedRawOption(args, "--set")) {
    const parsed = parseDecisionAmendPatch("replace", value);
    if (!parsed.ok) return parsed;
    patches.push(parsed.value);
  }
  for (const value of readRepeatedRawOption(args, "--append")) {
    const parsed = parseDecisionAmendPatch("append", value);
    if (!parsed.ok) return parsed;
    patches.push(parsed.value);
  }
  return { ok: true, value: patches };
}

function parseDecisionAmendPatch(operation: DecisionAmendPatchInput["operation"], value: string | undefined):
  | { readonly ok: true; readonly value: DecisionAmendPatchInput }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  if (!value || value.startsWith("--")) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionAmendPatch, "Use decision amend --set <field>:<value> or --append <field>:<json>.") };
  }
  const separator = value.indexOf(":");
  if (separator <= 0) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionAmendPatch, "Use decision amend --set <field>:<value> or --append <field>:<json>.") };
  }
  const field = value.slice(0, separator).trim();
  const patchValue = value.slice(separator + 1).trim();
  if (!isDecisionAmendField(field) || !decisionAmendFieldSupportsOperation(field, operation)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionAmendPatch, `decision field is not ${operation}-amendable: ${field}`) };
  }
  if (!patchValue) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionAmendPatch, `decision amend patch value is empty for field: ${field}`) };
  }
  return { ok: true, value: { field, operation, value: patchValue } };
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
  return parsedDecision(rootDir, json, {
    kind: "decision-propose",
    decisionId: readOption(args, "--id"),
    title,
    question,
    chosen,
    rejected,
    whyNot,
    claim: readOption(args, "--claim"),
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
