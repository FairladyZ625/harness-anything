import path from "node:path";
import {
  type DecisionWriteRejected
} from "../../../../application/src/index.ts";
import {
  type DecisionPackage,
  type WriteError
} from "../../../../kernel/src/index.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";

export function parseActor(value: string | undefined): DecisionPackage["arbiter"] | null {
  if (!value) return null;
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  const kind = value.slice(0, separator);
  if (kind !== "agent" && kind !== "human" && kind !== "system") return null;
  return { kind, id: value.slice(separator + 1) };
}

export function decisionResult(rootInput: HarnessLayoutInput, command: string, decisionId: string, state: string, dryRun: boolean): CliResult {
  const layout = resolveHarnessLayout(rootInput);
  const documentPath = layout.decisionDocumentPath(decisionId);
  return {
    ok: true,
    command,
    decisionId,
    decisionState: state,
    path: path.relative(layout.rootDir, documentPath).split(path.sep).join("/"),
    report: { schema: "decision-write-cli-report/v1", dryRun }
  };
}

export function decisionFailure(command: string, decisionId: string, error: DecisionWriteRejected | WriteError, current?: DecisionPackage): CliResult {
  const reason = "_tag" in error && error._tag === "DecisionWriteRejected" ? error.reason : JSON.stringify(error);
  return {
    ok: false,
    command,
    decisionId,
    error: cliError(CliErrorCode.DecisionWriteRejected, current && isAcceptEvidenceFloorRejection(command, reason) ? acceptEvidenceFloorHint(current) : reason)
  };
}

export function decisionHasAcceptEvidenceFloor(decision: DecisionPackage): boolean {
  const claimRefs = new Set(decision.claims.map((claim) => `decision/${decision.decision_id}/${claim.id}`));
  return decision.relations.some((relation) =>
    relation.state === "active" &&
    claimRefs.has(relation.source) &&
    /^(?:fact\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+|task\/[A-Za-z0-9_-]+|decision\/[A-Za-z0-9_-]+(?:\/[A-Za-z][A-Za-z0-9_-]*)?)$/u.test(relation.target)
  );
}

export function acceptEvidenceFloorHint(decision: DecisionPackage): string {
  const claimAnchors = decision.claims.map((claim) => claim.id);
  const endpointAnchors = [...decision.chosen.map((entry) => entry.id), ...decision.rejected.map((entry) => entry.id)];
  const firstClaim = claimAnchors[0] ?? "C1";
  const endpointText = endpointAnchors.length > 0 ? ` Chosen/rejected anchors (${endpointAnchors.join(", ")}) are relation endpoints, but they do not satisfy the accept evidence floor unless the same anchor id also appears in claims.` : "";
  return `decision_accept requires at least one active evidence relation from a claim anchor. Existing claim anchor(s): ${claimAnchors.join(", ") || "none"}. Run: ha decision relate ${decision.decision_id} --anchor ${firstClaim} --type relates --target task/<task-id> --rationale <text>, then retry accept; or use ha decision accept ${decision.decision_id} --judgment-only <rationale>.${endpointText}`;
}

function isAcceptEvidenceFloorRejection(command: string, reason: string): boolean {
  return command === "decision-accept" && reason.includes("decision_accept requires at least one evidence relation from a claim anchor");
}
