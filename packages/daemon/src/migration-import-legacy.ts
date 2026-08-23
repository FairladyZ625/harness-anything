import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { consumeKnownError, type ArchivedExecutionV0 } from "../../kernel/src/index.ts";
import {
  hasExactMigrationFields,
  hasNonEmptyMigrationStrings,
  isMigrationImportRecord,
  nonEmpty,
  timestamp,
} from "./migration-import-report.ts";
import type { AuthoredNode, DestinationNode } from "./migration-import-types.ts";

export type LegacyLocator =
  | { readonly substrate: "inline"; readonly text: string }
  | { readonly substrate: "file"; readonly path: string }
  | { readonly substrate: "url"; readonly url: string };

export interface LegacyExecutionV2 {
  readonly schema: "execution/v2";
  readonly execution_id: string;
  readonly task_ref: string;
  readonly state: ArchivedExecutionV0["state"];
  readonly primary_actor: {
    readonly principal: { readonly personId: string };
    readonly executor: { readonly kind: "agent"; readonly id: string } | null;
  };
  readonly claimed_at: string;
  readonly submitted_at: string | null;
  readonly closed_at: string | null;
  readonly session_bindings: readonly Readonly<Record<string, unknown>>[];
  readonly outputs: readonly {
    readonly evidence_id: string;
    readonly execution_ref: string;
    readonly locator: LegacyLocator;
  }[];
  readonly submission: {
    readonly completion_claim: string;
    readonly deliverables: readonly string[];
    readonly evidence_refs: readonly string[];
    readonly verification_notes: readonly string[];
    readonly known_gaps: readonly string[];
    readonly residual_risks: readonly string[];
  } | null;
}

export function decodeLegacyExecution(body: string, taskId: string): LegacyExecutionV2 | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
  if (
    !isMigrationImportRecord(value) ||
    !hasExactMigrationFields(value, [
      "schema",
      "execution_id",
      "task_ref",
      "state",
      "primary_actor",
      "claimed_at",
      "submitted_at",
      "closed_at",
      "session_bindings",
      "outputs",
      "submission",
    ]) ||
    value.schema !== "execution/v2" ||
    value.task_ref !== `task/${taskId}` ||
    !nonEmpty(value.execution_id) ||
    !["active", "submitted", "accepted", "changes_requested", "abandoned"].includes(String(value.state)) ||
    !timestamp(value.claimed_at) ||
    (value.submitted_at !== null && !timestamp(value.submitted_at)) ||
    (value.closed_at !== null && !timestamp(value.closed_at)) ||
    !legacyActor(value.primary_actor) ||
    !Array.isArray(value.session_bindings) ||
    !value.session_bindings.every(isMigrationImportRecord) ||
    !Array.isArray(value.outputs) ||
    !value.outputs.every(
      (output) =>
        isMigrationImportRecord(output) &&
        hasExactMigrationFields(output, ["evidence_id", "execution_ref", "locator"]) &&
        nonEmpty(output.evidence_id) &&
        output.execution_ref === `execution/${taskId}/${value.execution_id}` &&
        legacyLocator(output.locator),
    ) ||
    (value.submission !== null && !legacySubmission(value.submission))
  )
    return null;
  return value as unknown as LegacyExecutionV2;
}

export function archivedExecution(value: LegacyExecutionV2, taskId: string): ArchivedExecutionV0 {
  return {
    schema: "archived-execution/v1",
    generation: "v0",
    migratedFrom: value.execution_id,
    executionId: value.execution_id,
    taskId,
    nodeId: "implementation",
    iteration: 0,
    state: value.state,
    actor: {
      principal: { personId: value.primary_actor.principal.personId },
      executor: value.primary_actor.executor,
    },
    claimedAt: value.claimed_at,
    submittedAt: value.submitted_at,
    closedAt: value.closed_at,
    sessionBindings: value.session_bindings,
    outputs: value.outputs.map((output) => ({
      migratedFrom: output.evidence_id,
      ...archivedLocator(output.locator),
      checkerReceiptRef: null,
      checkerResult: "unknown",
    })),
    submission: null,
    archivedSubmission:
      value.submission === null
        ? null
        : {
            completionClaim: value.submission.completion_claim,
            deliverables: value.submission.deliverables,
            evidenceRefs: value.submission.evidence_refs,
            verificationNotes: value.submission.verification_notes,
            knownGaps: value.submission.known_gaps,
            residualRisks: value.submission.residual_risks,
          },
  };
}

export function legacyLocator(value: unknown): value is LegacyLocator {
  return (
    isMigrationImportRecord(value) &&
    ((value.substrate === "inline" && hasExactMigrationFields(value, ["substrate", "text"]) && nonEmpty(value.text)) ||
      (value.substrate === "file" && hasExactMigrationFields(value, ["substrate", "path"]) && nonEmpty(value.path)) ||
      (value.substrate === "url" && hasExactMigrationFields(value, ["substrate", "url"]) && nonEmpty(value.url)))
  );
}

export function archivedLocator(
  value: LegacyLocator,
): Pick<ArchivedExecutionV0["outputs"][number], "locator" | "substrate"> {
  return value.substrate === "file"
    ? { locator: value.path, substrate: "repository-path" }
    : value.substrate === "url"
      ? { locator: value.url, substrate: "uri" }
      : { locator: value.text, substrate: "opaque" };
}

export function legacyActor(value: unknown): boolean {
  return (
    isMigrationImportRecord(value) &&
    hasExactMigrationFields(value, ["principal", "executor", "responsibleHuman"]) &&
    isMigrationImportRecord(value.principal) &&
    nonEmpty(value.principal.personId) &&
    (value.executor === null ||
      (isMigrationImportRecord(value.executor) &&
        hasExactMigrationFields(value.executor, ["kind", "id"]) &&
        value.executor.kind === "agent" &&
        nonEmpty(value.executor.id))) &&
    nonEmpty(value.responsibleHuman)
  );
}

export function legacySubmission(value: unknown): boolean {
  return (
    isMigrationImportRecord(value) &&
    hasExactMigrationFields(value, [
      "completion_claim",
      "deliverables",
      "evidence_refs",
      "verification_notes",
      "known_gaps",
      "residual_risks",
    ]) &&
    nonEmpty(value.completion_claim) &&
    [value.deliverables, value.evidence_refs, value.verification_notes, value.known_gaps, value.residual_risks].every(
      hasNonEmptyMigrationStrings,
    )
  );
}

export function utf8File(root: string, sourcePath: string): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path.join(root, sourcePath)));
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

export function symlinkTarget(root: string, sourcePath: string): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      readlinkSync(path.join(root, sourcePath), { encoding: "buffer" }),
    );
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

export function destinationLinkConflict(
  destinationRoot: string,
  sourcePath: string,
  sourceTarget: string,
): {
  readonly surface: string;
  readonly disposition: "excluded" | "required";
  readonly reason: string;
  readonly targetConflict?: true;
} | null {
  const target = path.join(destinationRoot, sourcePath);
  let info;
  try {
    info = lstatSync(target);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
  if (!info.isSymbolicLink())
    return {
      surface: sourcePath,
      disposition: "required",
      targetConflict: true,
      reason: [
        "destination already contains a non-link at the same path; source link ",
        "target=",
        `${JSON.stringify(sourceTarget)}`,
        "",
      ].join(""),
    };
  const destinationTarget = symlinkTarget(destinationRoot, sourcePath);
  return destinationTarget === sourceTarget
    ? {
        surface: "already-present",
        disposition: "excluded",
        reason: [
          "destination already contains the same symbolic link at ",
          `${sourcePath}`,
          " -> ",
          `${JSON.stringify(sourceTarget)}`,
          "",
        ].join(""),
      }
    : {
        surface: sourcePath,
        disposition: "required",
        targetConflict: true,
        reason: [
          "destination symbolic link differs: source target=",
          `${JSON.stringify(sourceTarget)}`,
          "; destination target=",
          `${JSON.stringify(destinationTarget)}`,
          "",
        ].join(""),
      };
}

export function authoredNode(nodeKind: "file" | "symbolic-link", bytes: Uint8Array, linkTarget?: string): AuthoredNode {
  return {
    nodeKind,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    ...(linkTarget === undefined ? {} : { linkTarget }),
  };
}

export function destinationNode(root: string, sourcePath: string): DestinationNode | null {
  const target = path.join(root, sourcePath);
  let info;
  try {
    info = lstatSync(target);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
  if (info.isDirectory()) return { nodeKind: "directory" };
  if (info.isSymbolicLink()) {
    const bytes = readlinkSync(target, { encoding: "buffer" });
    let linkTarget: string;
    try {
      linkTarget = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      consumeKnownError(error);
      linkTarget = "<non-UTF-8 link target>";
    }
    return authoredNode("symbolic-link", bytes, linkTarget);
  }
  return info.isFile() ? authoredNode("file", readFileSync(target)) : { nodeKind: "directory" };
}

export function nodeSummary(label: string, node: DestinationNode): string {
  return node.nodeKind === "directory"
    ? `${label} kind=directory`
    : [
        "",
        `${label}`,
        " kind=",
        `${node.nodeKind}`,
        ", ",
        `${label}`,
        " sha256=",
        `${node.sha256}`,
        ", ",
        `${label}`,
        " bytes=",
        `${node.size}`,
        "",
        `${node.nodeKind === "symbolic-link" ? `, ${label} link target=${JSON.stringify(node.linkTarget)}` : ""}`,
        "",
      ].join("");
}
