import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import {
  SETTINGS_ID,
  readSettingsFacet,
  repositorySettings,
  validateRepositorySettings,
  type RepositorySettingsV1,
  type SettingsV1,
} from "./settings.ts";
import {
  freezeDeclaredWritePlan,
  hasContractFields,
  isFrozenWritePlan,
  isRecord,
  serializeEventEnvelope,
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
  type FrozenWritePlan,
  type WriteSource,
  type WriteTarget,
} from "./write-chain.contract.ts";

export const SETTINGS_FACET_POLICY_ID = "settings-facet/v1";

export interface SettingsDocumentClaim {
  readonly path: "harness.yaml";
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: "application/yaml";
  readonly policyId: typeof SETTINGS_FACET_POLICY_ID;
}

export type SettingsEventV1 = EventEnvelope<
  "settings-event/v1",
  "settings_changed",
  ActorIdentity,
  {
    readonly settings: RepositorySettingsV1;
    readonly harnessDocumentClaim: SettingsDocumentClaim;
    readonly baseDocumentSha256: string;
  }
> & { readonly entity: { readonly kind: "settings"; readonly id: typeof SETTINGS_ID } };

export interface SettingsEventBundle {
  readonly event: SettingsEventV1;
  readonly plan: FrozenWritePlan<"settings_changed">;
  readonly blobs: readonly [
    { readonly sha256: string; readonly size: number; readonly mediaType: "application/yaml"; readonly body: string },
  ];
}

export function compileSettingsChangedEvent(input: {
  readonly settings: RepositorySettingsV1 | SettingsV1;
  readonly baseDocumentBody: string;
  readonly candidateDocumentBody: string;
  readonly eventId: string;
  readonly opId: string;
  readonly workspaceRevision: number;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly occurredAt: string;
}): SettingsEventBundle {
  const settings = repositorySettings(input.settings),
    claim: SettingsDocumentClaim = {
      path: "harness.yaml",
      sha256: sha256Text(input.candidateDocumentBody),
      size: Buffer.byteLength(input.candidateDocumentBody),
      mediaType: "application/yaml",
      policyId: SETTINGS_FACET_POLICY_ID,
    },
    event: SettingsEventV1 = {
      schema: "settings-event/v1",
      eventId: input.eventId,
      workspaceRevision: input.workspaceRevision,
      opId: input.opId,
      entity: { kind: "settings", id: SETTINGS_ID },
      type: "settings_changed",
      actor: input.actor,
      source: input.source,
      occurredAt: input.occurredAt,
      payload: {
        settings,
        harnessDocumentClaim: claim,
        baseDocumentSha256: sha256Text(input.baseDocumentBody),
      },
    };
  const errors = validateCurrentSettingsEvent(event);
  if (errors.length) throw new Error(errors.join("; "));
  return {
    event,
    plan: settingsEventWritePlan(event),
    blobs: [{ sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType, body: input.candidateDocumentBody }],
  };
}

export function validateSettingsEvent(value: unknown): readonly string[] {
  return validateSettingsEventFields(value, true);
}

export function validateCurrentSettingsEvent(value: unknown): readonly string[] {
  return validateSettingsEventFields(value, false);
}

function validateSettingsEventFields(value: unknown, allowUnknownFields: boolean): readonly string[] {
  if (
    !isRecord(value) ||
    !hasContractFields(
      value,
      ["schema", "eventId", "workspaceRevision", "opId", "entity", "type", "actor", "source", "occurredAt", "payload"],
      allowUnknownFields,
    ) ||
    value.schema !== "settings-event/v1" ||
    value.type !== "settings_changed" ||
    !isRecord(value.entity) ||
    !hasContractFields(value.entity, ["kind", "id"], allowUnknownFields) ||
    value.entity.kind !== "settings" ||
    value.entity.id !== SETTINGS_ID ||
    !isRecord(value.payload) ||
    !hasContractFields(value.payload, ["settings", "harnessDocumentClaim", "baseDocumentSha256"], allowUnknownFields) ||
    !validSettingsSnapshot(value.payload.settings, allowUnknownFields) ||
    !validClaim(value.payload.harnessDocumentClaim, allowUnknownFields) ||
    !/^[0-9a-f]{64}$/u.test(String(value.payload.baseDocumentSha256))
  )
    return ["settings event envelope or payload is invalid"];
  return validateEventEnvelopeIdentity(value, allowUnknownFields).length
    ? ["settings event envelope identity is invalid"]
    : [];
}

function validSettingsSnapshot(value: unknown, allowUnknownFields: boolean): boolean {
  if (!isRecord(value) || !isRecord(value.scaffolds)) return false;
  const normalized = {
      schema: value.schema,
      settingsId: value.settingsId,
      defaultVertical: value.defaultVertical,
      defaultPreset: value.defaultPreset,
      defaultProfile: value.defaultProfile,
      scaffolds: {
        task: value.scaffolds.task,
        repository: value.scaffolds.repository,
      },
    },
    current = validateRepositorySettings(normalized).length === 0;
  if (!current) return false;
  if (!allowUnknownFields)
    return Object.keys(value).every((field) =>
      ["schema", "settingsId", "defaultVertical", "defaultPreset", "defaultProfile", "scaffolds"].includes(field),
    );
  return (
    validateRepositorySettings({
      ...normalized,
    }).length === 0
  );
}

export function isSettingsEvent(event: { readonly schema: string }): event is SettingsEventV1 {
  return event.schema === "settings-event/v1";
}

export function serializeSettingsEvent(event: SettingsEventV1): string {
  const errors = validateCurrentSettingsEvent(event);
  if (errors.length) throw new Error(errors.join("; "));
  return serializeEventEnvelope(event);
}

export function settingsEventWritePlan(event: SettingsEventV1): FrozenWritePlan<"settings_changed"> {
  const claim = event.payload.harnessDocumentClaim,
    targets: WriteTarget[] = [
      { kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" },
      { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
      {
        kind: "authored_file",
        path: claim.path,
        operation: "replace",
        sha256: claim.sha256,
        size: claim.size,
        mediaType: claim.mediaType,
      },
      { kind: "content_blob", sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType },
      { kind: "projection_invalidation", projection: "document/v1", key: claim.path },
      { kind: "projection_invalidation", projection: "entity/v1", key: `settings/${SETTINGS_ID}` },
    ];
  return freezeDeclaredWritePlan({ commandType: event.type, targets }, ["settings_changed"]);
}

export function assertSettingsEventInputs(
  event: SettingsEventV1,
  plan: FrozenWritePlan | undefined,
  blobs: readonly {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly body: string;
  }[],
): void {
  assertSettingsEventWritePlan(event, plan);
  const claim = event.payload.harnessDocumentClaim,
    blob = blobs.find((candidate) => candidate.sha256 === claim.sha256);
  if (!blob || blob.size !== claim.size || blob.mediaType !== claim.mediaType || sha256Text(blob.body) !== claim.sha256)
    throw new Error("settings harness.yaml blob must be exact");
  if (
    stableStringify(repositorySettings(readSettingsFacet(blob.body))) !==
    stableStringify(repositorySettings(event.payload.settings))
  )
    throw new Error("settings harness.yaml blob must contain the exact settings facet");
}

export function assertSettingsEventWritePlan(event: SettingsEventV1, plan: FrozenWritePlan | undefined): void {
  const shape = (value: FrozenWritePlan) =>
    stableStringify({ commandType: value.commandType, targets: value.targets.map(stableStringify).sort() });
  if (!plan || !isFrozenWritePlan(plan) || shape(plan) !== shape(settingsEventWritePlan(event)))
    throw new Error("settings write plan must exactly declare event, harness.yaml, content, and projection targets");
}

function validClaim(value: unknown, allowUnknownFields: boolean): boolean {
  return (
    isRecord(value) &&
    hasContractFields(value, ["path", "sha256", "size", "mediaType", "policyId"], allowUnknownFields) &&
    value.path === "harness.yaml" &&
    /^[0-9a-f]{64}$/u.test(String(value.sha256)) &&
    Number.isSafeInteger(value.size) &&
    Number(value.size) >= 0 &&
    value.mediaType === "application/yaml" &&
    value.policyId === SETTINGS_FACET_POLICY_ID
  );
}
