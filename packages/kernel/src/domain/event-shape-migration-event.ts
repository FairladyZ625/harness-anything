import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import { RETIRED_SETTINGS_PATHS } from "./settings.ts";
import {
  freezeDeclaredWritePlan,
  hasOnlyFields,
  hasRequiredFields,
  isFrozenWritePlan,
  isRecord,
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
  type FrozenWritePlan,
} from "./write-chain.contract.ts";

export const eventShapeMigrationNames = Object.freeze([
  "closeout-overrides.fact",
  "closeout-overrides.codeDoc",
  "schedule.ciObserve",
  "squad-run.subject",
  "settings.ci",
  "settings.closeout.codeDoc",
  "settings.review.thresholds",
  "runtime.reviewDispatchKey",
  "vertical.completion.sources",
  "vertical.completion.closeoutCodeDoc",
] as const);
export type EventShapeMigrationName = (typeof eventShapeMigrationNames)[number];
export const retiredPersistedSchemaFields = Object.freeze([
  "Task.closeoutOverrides.fact",
  "Task.closeoutOverrides.codeDoc",
  "PresetSnapshot.profile.closeoutOverrides.codeDoc",
  "Schedule.status.ciObserve",
  "SquadRun.taskId+executionId",
  "Settings.gates.ci",
  "Settings.ci.workflows",
  "Settings.closeout.overrides.codeDoc",
  "Settings.review.thresholds.correctness",
  "Settings.review.thresholds.migration",
  "Settings.review.thresholds.securityAuth",
  "RuntimeDispatchRequested.payload.dispatchKey",
  "Vertical.completion.sources.*.kind",
  "Vertical.completion.closeoutDefaults.codeDoc",
] as const);

export type EventShapeMigrationEventV1 = EventEnvelope<
  "event-shape-migration/v1",
  "event_shape_migration_applied",
  ActorIdentity,
  {
    readonly migration: EventShapeMigrationName;
    readonly version: 1;
    readonly sourceRevision: number;
    readonly affectedEvents: number;
  }
>;

export function isEventShapeMigrationEvent(event: { readonly schema: string }): event is EventShapeMigrationEventV1 {
  return event.schema === "event-shape-migration/v1";
}

export function validateEventShapeMigrationEvent(value: unknown): readonly string[] {
  return validateEventShapeMigrationEventFields(value, true);
}

export function validateCurrentEventShapeMigrationEvent(value: unknown): readonly string[] {
  return validateEventShapeMigrationEventFields(value, false);
}

function validateEventShapeMigrationEventFields(value: unknown, allowUnknownFields: boolean): readonly string[] {
  const hasFields = allowUnknownFields ? hasRequiredFields : hasOnlyFields;
  if (
    !isRecord(value) ||
    !hasFields(value, [
      "schema",
      "eventId",
      "workspaceRevision",
      "opId",
      "type",
      "actor",
      "source",
      "occurredAt",
      "payload",
    ]) ||
    value.schema !== "event-shape-migration/v1" ||
    value.type !== "event_shape_migration_applied" ||
    !isRecord(value.payload) ||
    !hasFields(value.payload, ["migration", "version", "sourceRevision", "affectedEvents"]) ||
    !eventShapeMigrationNames.includes(value.payload.migration as EventShapeMigrationName) ||
    value.payload.version !== 1 ||
    ![value.payload.sourceRevision, value.payload.affectedEvents].every(
      (candidate) => Number.isSafeInteger(candidate) && Number(candidate) >= 0,
    )
  )
    return ["event-shape migration event is invalid"];
  return validateEventEnvelopeIdentity(value, allowUnknownFields).length
    ? ["event-shape migration event identity is invalid"]
    : [];
}

export function eventShapeMigrationWritePlan(
  event: EventShapeMigrationEventV1,
): FrozenWritePlan<"EventShapeMigration"> {
  return freezeDeclaredWritePlan(
    {
      commandType: "EventShapeMigration",
      targets: [
        { kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" },
        { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
        { kind: "projection_invalidation", projection: "event-shape-migration/v1", key: event.payload.migration },
      ],
    },
    ["EventShapeMigration"],
  );
}

export function assertEventShapeMigrationWritePlan(
  event: EventShapeMigrationEventV1,
  plan: FrozenWritePlan | undefined,
): void {
  const expected = eventShapeMigrationWritePlan(event);
  if (
    !plan ||
    !isFrozenWritePlan(plan) ||
    plan.commandType !== expected.commandType ||
    JSON.stringify(plan.targets) !== JSON.stringify(expected.targets)
  )
    throw new Error("event-shape migration plan must exactly declare event, head, and migration projection targets");
}

/**
 * Closeout override keys retired by the code/doc deletion (owner ruling 2026-10-21 14:35, B3).
 * `fact` is the earlier precedent: a task-bound or preset-profile override that no profile or
 * setting can still produce. The two read carriers (Task/v2 snapshots and preset-snapshot profiles)
 * share this one stripper so a new carrier cannot grow its own copy.
 */
export const retiredCloseoutOverrideKeys = Object.freeze(["fact", "codeDoc"] as const);

/** Pure transformations shared by attach replay, generation conversion, and document reads. */
export function withoutRetiredCloseoutOverrides(value: unknown): unknown {
  if (!isRecord(value) || !retiredCloseoutOverrideKeys.some((key) => Object.hasOwn(value, key))) return value;
  const remaining = Object.fromEntries(
    Object.entries(value).filter(([key]) => !(retiredCloseoutOverrideKeys as readonly string[]).includes(key)),
  );
  return Object.keys(remaining).length ? remaining : undefined;
}

/**
 * Snapshot-level fields retired by the code/doc deletion. They are not closeout overrides, so the
 * override stripper above never touches them, and version 38's cleaner only reaches a cache a
 * *replay* rewrites — a cache written before it keeps this key on disk.
 *
 * The retired key is therefore ignored on read. It carries no authority (every reader of the
 * code/doc witness state was deleted with the mechanism), so dropping it at the read boundary is
 * the same answer a replay gives, at the cost of one object copy instead of 216–340 s of replay.
 * The version constant deliberately stays at 38: bumping it would force those caches through that
 * replay inside attach, which does not survive the 30 s ready-watchdog.
 */
export const retiredTaskSnapshotFields = Object.freeze(["codeDocWitnesses"] as const);

export function withoutRetiredTaskSnapshotFields(value: unknown): unknown {
  if (!isRecord(value) || !retiredTaskSnapshotFields.some((key) => Object.hasOwn(value, key))) return value;
  const remaining = Object.fromEntries(
    Object.entries(value).filter(([key]) => !(retiredTaskSnapshotFields as readonly string[]).includes(key)),
  );
  return remaining;
}

/**
 * Hosted-CI witness kinds retired when the CI gate left the product. One list for the settings gate
 * mapping, the vertical completion sources and the decode-time recognition of both, so a reader that
 * names a retired source and the migration step that strips it can never disagree about which kinds
 * are retired.
 */
export const retiredHostedCiSourceKinds = Object.freeze(["github-actions", "gitlab-pipeline"] as const);

export function withoutRetiredScheduleCiObserve(value: unknown): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, "ciObserve")) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "ciObserve"));
}

export function withoutRetiredSettings(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const next = structuredClone(value) as Record<string, unknown>;
  let changed = false;
  for (const path of RETIRED_SETTINGS_PATHS) {
    const parents: Record<string, unknown>[] = [];
    let parent: unknown = next as Record<string, unknown>,
      present = true;
    for (const segment of path.slice(0, -1)) {
      if (!isRecord(parent) || !Object.hasOwn(parent, segment)) {
        present = false;
        break;
      }
      parents.push(parent);
      parent = parent[segment];
    }
    const key = path.at(-1)!;
    if (!present || !isRecord(parent) || !Object.hasOwn(parent, key)) continue;
    const ownerAtKey = parent as Record<string, unknown>;
    delete ownerAtKey[key];
    for (const owner of parents.reverse())
      for (const [candidate, value] of Object.entries(owner))
        if (isRecord(value) && Object.keys(value).length === 0) delete owner[candidate];
    changed = true;
  }
  if (Array.isArray(next.gates)) {
    const gates = next.gates.filter(
      (gate) => !isRecord(gate) || !(retiredHostedCiSourceKinds as readonly string[]).includes(String(gate.adapter)),
    );
    if (gates.length !== next.gates.length) {
      next.gates = gates;
      changed = true;
    }
  }
  return changed ? next : value;
}

export function withoutRetiredVerticalHostedCi(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.completion)) return value;
  const completion = value.completion;
  if (!isRecord(completion) || !isRecord(completion.sources)) return value;
  const retiredSources = new Set(
    Object.entries(completion.sources)
      .filter(
        ([, source]) =>
          isRecord(source) && (retiredHostedCiSourceKinds as readonly string[]).includes(String(source.kind)),
      )
      .map(([sourceId]) => sourceId),
  );
  if (retiredSources.size === 0) return value;
  const sources = Object.fromEntries(
    Object.entries(completion.sources).filter(([sourceId]) => !retiredSources.has(sourceId)),
  );
  const gates = isRecord(completion.gates)
    ? Object.fromEntries(
        Object.entries(completion.gates).filter(
          ([, gate]) => !isRecord(gate) || !retiredSources.has(String(gate.source)),
        ),
      )
    : completion.gates;
  return { ...value, completion: { ...completion, sources, gates } };
}

/** Preserve dispatch identity while moving historical cut-review keys to the reviewer-qualified shape. */
export function withReviewerQualifiedDispatchKey(value: unknown): unknown {
  if (!isRecord(value) || value.schema !== "agent-runtime-event/v1" || value.type !== "runtime_dispatch_requested")
    return value;
  const payload = value.payload;
  if (
    !isRecord(payload) ||
    payload.role !== "reviewer" ||
    typeof payload.agentId !== "string" ||
    payload.agentId.length === 0 ||
    payload.agentId.includes(":") ||
    typeof payload.taskId !== "string" ||
    typeof payload.executionId !== "string" ||
    (typeof payload.dispatchKey !== "string" &&
      !(payload.dispatchKey === undefined && typeof payload.idempotencyKey === "string"))
  )
    return value;
  const legacyKey = typeof payload.dispatchKey === "string" ? payload.dispatchKey : String(payload.idempotencyKey);
  const prefix = `task-review:${payload.taskId}:${payload.executionId}:`;
  if (!legacyKey.startsWith(prefix)) return value;
  // A reviewer dispatch key continues with `:attemptN` when the cut retried the reviewer, and with
  // `:fallback:N` when the provider fallback chain continued the same dispatch; either may follow
  // the other. Reviewer qualification belongs directly after the digest, before both suffixes.
  const match = /^([0-9]+):(sha256:[0-9a-f]{64})((?::attempt[1-9][0-9]*)?(?::fallback:[1-9][0-9]*)?)$/u.exec(
    legacyKey.slice(prefix.length),
  );
  if (!match) return value;
  const target = payload.reviewTarget;
  if (
    target !== undefined &&
    (!isRecord(target) ||
      target.kind !== "task" ||
      target.taskId !== payload.taskId ||
      target.executionId !== payload.executionId ||
      target.digest !== match[2])
  )
    return value;
  const { idempotencyKey: _idempotencyKey, ...currentPayload } = payload;
  return {
    ...value,
    payload: {
      ...currentPayload,
      dispatchKey: `${prefix}${match[1]}:${match[2]}:reviewer:${payload.agentId}${match[3]}`,
    },
  };
}

/**
 * Retired 2026-10-21 with the code/doc reconciliation mechanism: this default only ever forced the
 * code/doc gate on. Accepted vertical declarations and preset snapshots still carry it, so reads
 * normalize it away instead of rejecting the record that named it.
 */
export function withoutRetiredCloseoutCodeDoc(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.completion) || !isRecord(value.completion.closeoutDefaults)) return value;
  const defaults = value.completion.closeoutDefaults;
  if (!Object.hasOwn(defaults, "codeDoc")) return value;
  const { codeDoc: _retired, ...rest } = defaults;
  return { ...value, completion: { ...value.completion, closeoutDefaults: rest } };
}
