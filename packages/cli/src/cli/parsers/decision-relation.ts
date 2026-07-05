import {
  parseEntityRef,
  relationTypes,
  type RelationType
} from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

const evidenceTargetKinds = new Set(["task", "fact", "decision"]);

export function parseDecisionRelationOp(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const relationOp = args[2];
  const decisionId = args[3];
  const relationId = readOption(args, "--relation");
  if ((relationOp !== "retire" && relationOp !== "replace") || !decisionId || !relationId || !/^rel_[a-f0-9]{16}$/u.test(relationId)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionEvidenceRelation, "Use decision relation retire|replace <decision-id> --relation <relation-id>.") };
  }
  if (relationOp === "retire") {
    return parsedDecisionRelation(rootDir, json, {
      kind: "decision-relation-retire",
      decisionId,
      relationId,
      body: readOption(args, "--body"),
      dryRun: args.includes("--dry-run")
    });
  }
  const anchor = readOption(args, "--anchor");
  const type = readOption(args, "--type");
  const target = readOption(args, "--target");
  const rationale = readOption(args, "--rationale");
  const targetRef = target ? parseEntityRef(target) : null;
  if (!anchor || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(anchor)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionEvidenceRelation, "Use decision relation replace <decision-id> --relation <relation-id> --anchor <CH1|RJ1|C1> --type <relation-type> --target <entity-ref> --rationale <text>.") };
  }
  if (!isReplacementRelationType(type)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionEvidenceRelation, `Unknown relation type for decision relation replace: ${type ?? "<missing>"}. Valid relation types: ${relationTypes.join(", ")}.`) };
  }
  if (!targetRef || targetRef.externalHarness || !evidenceTargetKinds.has(targetRef.kind)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionEvidenceRelation, "Use decision relation replace --target task/<id>, decision/<id>[/anchor], or fact/<task-id>/<fact-id>.") };
  }
  if (!rationale || rationale.trim().length === 0) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionEvidenceRelation, "Use decision relation replace --rationale <non-empty text>.") };
  }
  return parsedDecisionRelation(rootDir, json, {
    kind: "decision-relation-replace",
    decisionId,
    relationId,
    anchor,
    relationType: type,
    target: target ?? "",
    rationale,
    body: readOption(args, "--body"),
    dryRun: args.includes("--dry-run")
  });
}

function isReplacementRelationType(value: string | undefined): value is RelationType {
  return relationTypes.includes(value as RelationType);
}

function parsedDecisionRelation(rootDir: string, json: boolean, action: ParsedCommand["action"]): ParseResult {
  return { ok: true, value: { rootDir, json, action } };
}
