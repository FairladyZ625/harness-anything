import {
  parseEntityRef,
  relationTypes,
  type RelationType
} from "../../../../kernel/src/index.ts";
import type { CommandDescriptorIdentity } from "../command-spec/types.ts";
import { cliError, CliErrorCode } from "../error-codes.ts";
import type { CommandJsonInput } from "../json-input.ts";
import { readOption, readRepeatedRawOption } from "../parse-options.ts";
import type { CliResult, DecisionEvidenceRelationInput, ParsedCommand } from "../types.ts";
import { parseDecisionAmendPatches } from "./decision-amend.ts";
import { parseClaimFulfillments } from "./decision-fulfillment.ts";
import { readDecisionBody } from "./decision-body.ts";
import { parseDecisionPinCommand } from "./decision-pin.ts";
import { decisionTransitionOpForState, isDecisionTransitionOp, parseDecisionTransitionArgs } from "./decision-transition.ts";
import { parseChoiceInputs, parseClaimInputs, parseRejectedInputs } from "./decision-propose-inputs.ts";
import { parseDecisionRelationOp } from "./decision-relation.ts";
import { jsonBoolean, jsonPayloadFor, jsonString, jsonStringList, jsonValues, type JsonPayload } from "./json-values.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

const tiers = new Set(["low", "medium", "high"]);
const evidenceTargetKinds = new Set(["task", "fact", "decision"]);
export function parseDecisionArgs(
  args: ReadonlyArray<string>,
  rootDir: string,
  json: boolean,
  _commandSpecs?: ReadonlyArray<CommandDescriptorIdentity>,
  input?: CommandJsonInput
): ParseResult | null {
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
  const pinCommand = parseDecisionPinCommand(op, args, rootDir, json);
  if (pinCommand) return pinCommand;
  if (op === "propose") return parseDecisionPropose(args, rootDir, json, jsonPayloadFor(input, "decision-propose"));
  if (op === "transition") {
    const transitionOp = decisionTransitionOpForState(args[2]);
    if (!transitionOp || !args[3]) {
      return { ok: false, error: cliError(CliErrorCode.UnknownCommand, "Use decision transition <active|rejected|deferred|superseded|retired> <decision-id>.") };
    }
    const normalizedArgs = ["decision", transitionOp, args[3], ...args.slice(4)];
    const transition = parseDecisionTransitionArgs(normalizedArgs, transitionOp);
    if (!transition.ok) return transition;
    return parsedDecision(rootDir, json, transition.value);
  }
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
  if (isDecisionTransitionOp(op) && args[2]) {
    const transition = parseDecisionTransitionArgs(args, op);
    if (!transition.ok) return transition;
    return parsedDecision(rootDir, json, transition.value);
  }
  if (op === "amend" && args[2]) {
    const patches = parseDecisionAmendPatches(args);
    if (!patches.ok) return { ok: false, error: patches.error };
    const body = readDecisionBody(args, readOption(args, "--body"));
    if (!body.ok) return body;
    const fulfillments = parseClaimFulfillments(args);
    if (!fulfillments.ok) return fulfillments;
    return parsedDecision(rootDir, json, {
      kind: "decision-amend",
      decisionId: args[2],
      title: readOption(args, "--title"),
      ...(args.includes("--standing-policy") ? { standingPolicy: true } : {}),
      fulfillments: fulfillments.value,
      body: body.value,
      patches: patches.value,
      dryRun: args.includes("--dry-run")
    });
  }
  if (op === "relate" && args[2]) return parseDecisionRelate(args, rootDir, json);
  if (op === "relation") return parseDecisionRelationOp(args, rootDir, json);
  return { ok: false, error: cliError(CliErrorCode.UnknownCommand, "Use decision list|show|verify|repin|propose|transition|amend|relate|reckon|relation.") };
}

function parseDecisionPropose(args: ReadonlyArray<string>, rootDir: string, json: boolean, payload?: JsonPayload): ParseResult {
  const title = readOption(args, "--title") ?? jsonString(payload, "title");
  const question = readOption(args, "--question") ?? jsonString(payload, "question");
  const whyNot = readOption(args, "--why-not") ?? jsonString(payload, "why_not", "whyNot");
  if (!title) return { ok: false, error: cliError(CliErrorCode.MissingTitle, "Use decision propose --title <title>.") };
  if (!question) return { ok: false, error: cliError(CliErrorCode.MissingDecisionQuestion, "Use decision propose --question <text>.") };
  const chosen = parseChoiceInputs(args, payload?.chosen);
  if (!chosen.ok) return { ok: false, error: chosen.error };
  const rejected = parseRejectedInputs(args, whyNot, payload?.rejected);
  if (!rejected.ok) return { ok: false, error: rejected.error };
  const riskTier = readTier(readOption(args, "--risk-tier") ?? jsonString(payload, "riskTier") ?? "medium");
  const urgency = readTier(readOption(args, "--urgency") ?? jsonString(payload, "urgency") ?? "medium");
  if (!riskTier || !urgency) return { ok: false, error: cliError(CliErrorCode.InvalidDecisionTier, "Use low, medium, or high for --risk-tier and --urgency.") };
  const evidenceRelations = parseEvidenceRelations(args, jsonValues(payload, "evidenceRelations"));
  if (!evidenceRelations.ok) return { ok: false, error: evidenceRelations.error };
  const hasClaimFlags = readRepeatedRawOption(args, "--claim").length > 0;
  const claims = parseClaimInputs(args, !args.includes("--non-load-bearing"), [
    ...(hasClaimFlags ? [] : jsonValues(payload, "claim")),
    ...jsonValues(payload, "claims")
  ]);
  if (!claims.ok) return { ok: false, error: claims.error };
  const fulfillments = parseClaimFulfillments(args, jsonValues(payload, "fulfillments"));
  if (!fulfillments.ok) return fulfillments;
  const body = readDecisionBody(
    args,
    readOption(args, "--body") ?? jsonString(payload, "body"),
    jsonString(payload, "bodyFile")
  );
  if (!body.ok) return body;
  return parsedDecision(rootDir, json, {
    kind: "decision-propose",
    decisionId: readOption(args, "--id") ?? jsonString(payload, "decisionId"),
    title,
    question,
    chosen: chosen.value,
    rejected: rejected.value,
    claim: readOption(args, "--claim") ?? jsonString(payload, "claim"),
    claims: claims.value,
    claimLoadBearing: !args.includes("--non-load-bearing"),
    fulfillments: fulfillments.value,
    riskTier,
    urgency,
    modules: [...jsonStringList(payload, "modules"), ...splitRepeatedList(args, "--module")],
    productLines: [...jsonStringList(payload, "productLines"), ...splitRepeatedList(args, "--product-line")],
    evidenceRelations: evidenceRelations.value,
    body: body.value,
    dryRun: args.includes("--dry-run") || jsonBoolean(payload, "dryRun")
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

function parseEvidenceRelations(args: ReadonlyArray<string>, input: ReadonlyArray<unknown> = []):
  | { readonly ok: true; readonly value: ReadonlyArray<DecisionEvidenceRelationInput> }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  const values: ReadonlyArray<unknown> = [...input, ...readRepeatedRawOption(args, "--evidence-relation")];
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

function parseEvidenceRelation(value: unknown): DecisionEvidenceRelationInput | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    const anchor = typeof candidate.anchor === "string" ? candidate.anchor : undefined;
    const type = typeof candidate.type === "string" ? candidate.type : undefined;
    const target = typeof candidate.target === "string" ? candidate.target : undefined;
    const rationale = typeof candidate.rationale === "string" ? candidate.rationale.trim() : "";
    const targetRef = target ? parseEntityRef(target) : null;
    if (!anchor || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(anchor)) return null;
    if (!isRelationType(type)) return null;
    if (!targetRef || targetRef.externalHarness || !evidenceTargetKinds.has(targetRef.kind)) return null;
    if (!target || rationale.length === 0) return null;
    return { anchor, type, target, rationale };
  }
  if (typeof value !== "string" || !value || value.startsWith("--")) return null;
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

function splitRepeatedList(args: ReadonlyArray<string>, name: string): ReadonlyArray<string> {
  return readRepeatedRawOption(args, name).flatMap(splitList);
}

function parsedDecision(rootDir: string, json: boolean, action: ParsedCommand["action"]): ParseResult {
  return { ok: true, value: { rootDir, json, action } };
}
