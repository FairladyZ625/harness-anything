import { isAgentRuntimeEvent, runtimeEventContentClaims } from "../domain/agent-runtime.ts";
import { isEntityDeclarationEvent, isEntityEvent } from "../domain/entity-event.ts";
import { isScheduleEvent } from "../domain/schedule-event.ts";
import { isSettingsEvent } from "../domain/settings-event.ts";
import { isVerticalDeclarationEvent } from "../domain/vertical-declaration.ts";
import { isPeopleEvent } from "../domain/people-event.ts";
import {
  isDecisionEvent,
  isDocEvent,
  isFactEvent,
  isMigrationImportEvent,
  isTaskEvent,
  type CanonicalEventV1,
  type PersistedCanonicalEventV1,
} from "../domain/doc-sync.contract.ts";
import { migrationImportClaims, migrationImportContentClaims } from "../domain/migration-import-event.ts";
import { isTaskBootstrapEvent, taskBootstrapClaims } from "../domain/task-bootstrap-event.ts";
import { isTaskProgressEvent } from "../domain/task-progress-event.ts";
import { isSnapshotUpgradeEvent, snapshotUpgradeClaims } from "../domain/task-snapshot-upgrade-store-seam.ts";
import { type WriteTarget } from "../domain/write-chain.contract.ts";
import { stableStringify } from "../integrity/stable-hash.ts";

// Canonical document claim extraction plus flat-to-sharded layout auditing.
export function canonicalDocumentClaims(event: PersistedCanonicalEventV1): readonly {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}[] {
  if (isEntityEvent(event)) return isEntityDeclarationEvent(event) ? [event.payload.declarationDocumentClaim] : [];
  if (isScheduleEvent(event))
    return "declarationDocumentClaim" in event.payload ? [event.payload.declarationDocumentClaim] : [];
  if (isSettingsEvent(event)) return [event.payload.harnessDocumentClaim];
  if (isVerticalDeclarationEvent(event)) return [event.payload.declarationDocumentClaim];
  if (isPeopleEvent(event)) return [event.payload.peopleDocumentClaim];
  return isDocEvent(event)
    ? event.payload.changes.flatMap(({ path: target, candidate }) =>
        candidate === null ? [] : [{ path: target, ...candidate }],
      )
    : isTaskEvent(event)
      ? [
          ...(event.payload.documentClaims ?? []),
          ...(event.payload.carriedDocumentClaims ?? []).map(({ path: target, candidate }) => ({
            path: target,
            ...candidate,
          })),
        ]
      : isTaskBootstrapEvent(event)
        ? event.payload.initialDocumentClaims
        : isSnapshotUpgradeEvent(event)
          ? [event.payload.taskContractClaim]
          : isTaskProgressEvent(event)
            ? [
                event.payload.resultDocumentClaim,
                ...(event.payload.carriedDocumentClaims ?? []).map(({ path: target, candidate }) => ({
                  path: target,
                  ...candidate,
                })),
              ]
            : isFactEvent(event)
              ? [event.payload.factsDocumentClaim]
              : isDecisionEvent(event)
                ? [event.payload.decisionDocumentClaim]
                : isMigrationImportEvent(event)
                  ? migrationImportClaims(event)
                  : [];
}
export function canonicalDocumentRetirements(
  event: PersistedCanonicalEventV1,
): readonly { readonly path: string; readonly baseBlobSha256: string }[] {
  if (isEntityEvent(event)) return [];
  if (isScheduleEvent(event) && "declarationDocumentRetirement" in event.payload)
    return [event.payload.declarationDocumentRetirement];
  return isDocEvent(event)
    ? event.payload.changes.flatMap(({ path: target, baseBlobSha256, candidate }) =>
        candidate === null && baseBlobSha256 !== null ? [{ path: target, baseBlobSha256 }] : [],
      )
    : [];
}
export function canonicalDocumentMode(event: CanonicalEventV1, documentPath: string): "100644" | "120000" {
  return isMigrationImportEvent(event) &&
    event.payload.entity.kind === "repo-document" &&
    event.payload.entity.nodeKind === "symbolic-link" &&
    event.payload.entity.documentClaim.path === documentPath
    ? "120000"
    : "100644";
}
export function contentClaims(event: CanonicalEventV1): readonly {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}[] {
  if (isScheduleEvent(event))
    return "declarationDocumentClaim" in event.payload ? [event.payload.declarationDocumentClaim] : [];
  if (isSettingsEvent(event)) return [event.payload.harnessDocumentClaim];
  if (isVerticalDeclarationEvent(event)) return [event.payload.declarationDocumentClaim];
  if (isPeopleEvent(event)) return [event.payload.peopleDocumentClaim];
  const claims = isDocEvent(event)
    ? event.payload.changes.flatMap((change) => (change.candidate === null ? [] : [change.candidate]))
    : isEntityEvent(event)
      ? isEntityDeclarationEvent(event)
        ? [event.payload.declarationDocumentClaim]
        : []
      : isTaskEvent(event)
        ? [
            ...(event.payload.documentClaims ?? []),
            ...(event.payload.carriedDocumentClaims ?? []).map((change) => change.candidate),
          ]
        : isTaskBootstrapEvent(event)
          ? taskBootstrapClaims(event)
          : isSnapshotUpgradeEvent(event)
            ? snapshotUpgradeClaims(event)
            : isTaskProgressEvent(event)
              ? [
                  event.payload.resultDocumentClaim,
                  ...(event.payload.carriedDocumentClaims ?? []).map((change) => change.candidate),
                ]
              : isFactEvent(event)
                ? [event.payload.factsDocumentClaim]
                : isDecisionEvent(event)
                  ? [event.payload.decisionDocumentClaim]
                  : isMigrationImportEvent(event)
                    ? migrationImportContentClaims(event)
                    : isAgentRuntimeEvent(event)
                      ? runtimeEventContentClaims(event)
                      : [];
  return [...new Map(claims.map((claim) => [claim.sha256, claim])).values()];
}
export function targetShape(targets: readonly WriteTarget[]): string {
  return stableStringify(targets.map(stableStringify).sort());
}
