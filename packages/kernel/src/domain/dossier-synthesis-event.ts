import { dossierContentMaxBytes } from "./cli-operational-policy.ts";
import { safeWorkspacePath } from "./write-source.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import {
  DOSSIER_PAGE_SIZE,
  DOSSIER_DOCUMENT_OWNER,
  DOSSIER_SLOT_ID_PATTERN,
  DOSSIER_VERTICAL_ID_PATTERN,
  dossierDocumentPath,
  dossierMediaType,
  dossierRoot,
  dossierStatePath,
  isDossierWatermark,
  type DossierSlot,
  type DossierSlotState,
} from "./living-dossier.ts";
import { entityDocumentEventWritePlan } from "./entity-document-event.ts";
import { timestamp } from "./timestamp.ts";
import {
  hasOnlyFields,
  isRecord,
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
  type WriteSource,
} from "./write-chain.contract.ts";

type DossierDocumentClaim = {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: "text/markdown" | "text/html" | "application/json";
  readonly policyId: typeof DOSSIER_DOCUMENT_OWNER;
};

export type DossierSynthesisEventV1 = EventEnvelope<
  "dossier-synthesis-event/v1",
  "dossier_synthesized",
  ActorIdentity,
  {
    readonly state: DossierSlotState;
    readonly expectedWatermark: number;
    /** Canonical source head, ignoring a trailing run of synthesis events. */
    readonly sourceWatermark: number;
    readonly documentClaims: readonly [DossierDocumentClaim, DossierDocumentClaim];
  }
>;

export const isDossierSynthesisEvent = (event: { readonly schema: string }): event is DossierSynthesisEventV1 =>
  event.schema === "dossier-synthesis-event/v1";

export function compileDossierSynthesis(input: {
  readonly verticalId: string;
  readonly slot: DossierSlot;
  readonly expectedWatermark: number;
  readonly watermark: number;
  readonly sourceWatermark: number;
  readonly body: string;
  readonly opId: string;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly occurredAt: string;
  readonly workspaceRevision: number;
}) {
  const state: DossierSlotState = {
    verticalId: input.verticalId,
    slotId: input.slot.id,
    lastSynthesizedWatermark: input.watermark,
    synthesizedAt: input.occurredAt,
    path: dossierDocumentPath(input.verticalId, input.slot),
  };
  const document = dossierClaim(state.path, dossierMediaType(input.slot.kind), input.body);
  const cursor = dossierClaim(
    dossierStatePath(state.verticalId, state.slotId),
    "application/json",
    JSON.stringify(state),
  );
  const event: DossierSynthesisEventV1 = {
    schema: "dossier-synthesis-event/v1",
    type: "dossier_synthesized",
    opId: input.opId,
    eventId: `event-${input.opId}`,
    actor: input.actor,
    source: input.source,
    occurredAt: input.occurredAt,
    workspaceRevision: input.workspaceRevision,
    payload: {
      state,
      expectedWatermark: input.expectedWatermark,
      sourceWatermark: input.sourceWatermark,
      documentClaims: [document.claim, cursor.claim],
    },
  };
  const issues = validateCurrentDossierSynthesisEvent(event);
  if (issues.length) throw new Error(issues.join(", "));
  return { event, plan: entityDocumentEventWritePlan(event), blobs: [document.blob, cursor.blob] };
}

function dossierClaim(path: string, mediaType: DossierDocumentClaim["mediaType"], body: string) {
  const claim: DossierDocumentClaim = {
    path,
    mediaType,
    sha256: sha256Text(body),
    size: Buffer.byteLength(body),
    policyId: DOSSIER_DOCUMENT_OWNER,
  };
  return { claim, blob: { body, sha256: claim.sha256, size: claim.size, mediaType } };
}

export function validateDossierSynthesisEvent(value: unknown): readonly string[] {
  return validateDossierSynthesisEventFields(value, true);
}

export function validateCurrentDossierSynthesisEvent(value: unknown): readonly string[] {
  return validateDossierSynthesisEventFields(value, false);
}

function validateDossierSynthesisEventFields(value: unknown, allowUnknownFields: boolean): readonly string[] {
  if (
    !isRecord(value) ||
    (!allowUnknownFields &&
      !hasOnlyFields(value, [
        "schema",
        "type",
        "opId",
        "eventId",
        "actor",
        "source",
        "occurredAt",
        "workspaceRevision",
        "payload",
      ])) ||
    value.schema !== "dossier-synthesis-event/v1" ||
    value.type !== "dossier_synthesized" ||
    validateEventEnvelopeIdentity(value, allowUnknownFields).length > 0 ||
    !isDossierWatermark(value.workspaceRevision) ||
    !timestamp(value.occurredAt) ||
    !isRecord(value.payload) ||
    (!allowUnknownFields &&
      !hasOnlyFields(value.payload, ["state", "expectedWatermark", "sourceWatermark", "documentClaims"]))
  )
    return ["dossier synthesis event envelope is invalid"];

  const { state, expectedWatermark, sourceWatermark, documentClaims } = value.payload;
  if (
    !isRecord(state) ||
    (!allowUnknownFields &&
      !hasOnlyFields(state, ["verticalId", "slotId", "path", "lastSynthesizedWatermark", "synthesizedAt"])) ||
    typeof state.verticalId !== "string" ||
    !DOSSIER_VERTICAL_ID_PATTERN.test(state.verticalId) ||
    typeof state.slotId !== "string" ||
    !DOSSIER_SLOT_ID_PATTERN.test(state.slotId) ||
    state.synthesizedAt !== value.occurredAt ||
    !isDossierWatermark(state.lastSynthesizedWatermark) ||
    !isDossierWatermark(expectedWatermark) ||
    !isDossierWatermark(sourceWatermark) ||
    state.lastSynthesizedWatermark <= expectedWatermark ||
    state.lastSynthesizedWatermark - expectedWatermark > DOSSIER_PAGE_SIZE ||
    state.lastSynthesizedWatermark > sourceWatermark ||
    sourceWatermark >= value.workspaceRevision ||
    !Array.isArray(documentClaims) ||
    documentClaims.length !== 2
  )
    return ["dossier synthesis state or watermark is invalid"];

  const [document, cursor] = documentClaims;
  const root = dossierRoot(state.verticalId);
  if (
    !validClaim(document, allowUnknownFields) ||
    document.path !== state.path ||
    !document.path.startsWith(root) ||
    document.path.toLowerCase().startsWith(`${root}.state/`) ||
    !(
      (document.mediaType === "text/markdown" && document.path.toLowerCase().endsWith(".md")) ||
      (document.mediaType === "text/html" && document.path.toLowerCase().endsWith(".html"))
    ) ||
    !validClaim(cursor, allowUnknownFields) ||
    cursor.path !== dossierStatePath(state.verticalId, state.slotId) ||
    cursor.mediaType !== "application/json"
  )
    return ["dossier synthesis document claims are invalid"];

  const body = JSON.stringify({
    verticalId: state.verticalId,
    slotId: state.slotId,
    lastSynthesizedWatermark: state.lastSynthesizedWatermark,
    synthesizedAt: state.synthesizedAt,
    path: state.path,
  });
  return cursor.sha256 === sha256Text(body) && cursor.size === Buffer.byteLength(body)
    ? []
    : ["dossier synthesis state claim does not match the event"];
}

function validClaim(value: unknown, allowUnknownFields: boolean): value is DossierDocumentClaim {
  return (
    isRecord(value) &&
    (allowUnknownFields || hasOnlyFields(value, ["path", "sha256", "size", "mediaType", "policyId"])) &&
    typeof value.path === "string" &&
    safeWorkspacePath(value.path) &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(value.sha256) &&
    isDossierWatermark(value.size) &&
    value.size > 0 &&
    value.size <= dossierContentMaxBytes &&
    value.policyId === DOSSIER_DOCUMENT_OWNER
  );
}
