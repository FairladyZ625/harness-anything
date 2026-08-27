import {
  freezeDeclaredWritePlan,
  hasContractFields,
  isRecord,
  serializeEventEnvelope,
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
  type FrozenWritePlan,
} from "./write-chain.contract.ts";
import { eventObjectTarget } from "../layout/ledger-object-layout.ts";

export const CI_RUN_OBSERVATION_SCHEMA = Object.freeze({
  id: "ci-run-observation/v1",
  required: Object.freeze([
    "schema",
    "eventId",
    "workspaceRevision",
    "opId",
    "type",
    "actor",
    "source",
    "occurredAt",
    "payload",
  ]),
});

export type CiRunObservationTest = {
  readonly file: string;
  readonly name: string;
  readonly tier: "fast" | "contract" | "integration" | "gui" | "nightly" | "unknown";
  readonly shard: number | null;
  readonly durationMs: number;
  readonly status: "passed" | "failed" | "skipped";
  readonly retry: number;
};

export type CiRunObservationGate = {
  readonly gate: string;
  readonly pass: boolean;
  readonly metrics: Readonly<Record<string, number>>;
};

export type CiRunObservationEventV1 = EventEnvelope<
  "ci-run-observation/v1",
  "ci_run_observed",
  ActorIdentity,
  {
    readonly run: {
      readonly runId: string;
      readonly sha: string;
      readonly branch: string;
      readonly prNumber: number | null;
      readonly job: string;
      readonly wallclockMs: number;
      readonly runner: string;
    };
    readonly tests: readonly CiRunObservationTest[];
    readonly gates: readonly CiRunObservationGate[];
  }
>;

export class CiRunObservationContractError extends Error {
  readonly code = "invalid_contract";
  constructor(message: string) {
    super(message);
    this.name = "CiRunObservationContractError";
  }
}

const tiers = ["fast", "contract", "integration", "gui", "nightly", "unknown"] as const;
const statuses = ["passed", "failed", "skipped"] as const;

export function validateCiRunObservationEvent(value: unknown): readonly string[] {
  return validateFields(value, true);
}

export function validateCurrentCiRunObservationEvent(value: unknown): readonly string[] {
  return validateFields(value, false);
}

function validateFields(value: unknown, allowUnknownFields: boolean): readonly string[] {
  if (
    !isRecord(value) ||
    !hasContractFields(value, CI_RUN_OBSERVATION_SCHEMA.required, allowUnknownFields) ||
    value.schema !== CI_RUN_OBSERVATION_SCHEMA.id ||
    value.type !== "ci_run_observed" ||
    !isRecord(value.payload) ||
    !hasContractFields(value.payload, ["run", "tests", "gates"], allowUnknownFields) ||
    !validRun(value.payload.run, allowUnknownFields) ||
    !Array.isArray(value.payload.tests) ||
    value.payload.tests.some((test) => !validTest(test, allowUnknownFields)) ||
    !Array.isArray(value.payload.gates) ||
    value.payload.gates.some((gate) => !validGate(gate, allowUnknownFields))
  )
    return ["ci run observation event envelope or payload is invalid"];
  return validateEventEnvelopeIdentity(value, allowUnknownFields).length
    ? ["ci run observation event envelope identity is invalid"]
    : [];
}

function validRun(value: unknown, allowUnknownFields: boolean): boolean {
  return (
    isRecord(value) &&
    hasContractFields(
      value,
      ["runId", "sha", "branch", "prNumber", "job", "wallclockMs", "runner"],
      allowUnknownFields,
    ) &&
    nonEmpty(value.runId) &&
    nonEmpty(value.sha) &&
    nonEmpty(value.branch) &&
    (value.prNumber === null || (Number.isSafeInteger(value.prNumber) && Number(value.prNumber) > 0)) &&
    nonEmpty(value.job) &&
    nonNegativeNumber(value.wallclockMs) &&
    nonEmpty(value.runner)
  );
}

function validTest(value: unknown, allowUnknownFields: boolean): boolean {
  return (
    isRecord(value) &&
    hasContractFields(value, ["file", "name", "tier", "shard", "durationMs", "status", "retry"], allowUnknownFields) &&
    nonEmpty(value.file) &&
    nonEmpty(value.name) &&
    tiers.includes(value.tier as (typeof tiers)[number]) &&
    (value.shard === null || (Number.isSafeInteger(value.shard) && Number(value.shard) > 0)) &&
    nonNegativeNumber(value.durationMs) &&
    statuses.includes(value.status as (typeof statuses)[number]) &&
    Number.isSafeInteger(value.retry) &&
    Number(value.retry) >= 0
  );
}

function validGate(value: unknown, allowUnknownFields: boolean): boolean {
  if (
    !isRecord(value) ||
    !hasContractFields(value, ["gate", "pass", "metrics"], allowUnknownFields) ||
    !nonEmpty(value.gate) ||
    typeof value.pass !== "boolean" ||
    !isRecord(value.metrics)
  )
    return false;
  return (
    allowUnknownFields ||
    Object.values(value.metrics).every((metric) => typeof metric === "number" && Number.isFinite(metric))
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isCiRunObservationEvent(event: { readonly schema: string }): event is CiRunObservationEventV1 {
  return event.schema === CI_RUN_OBSERVATION_SCHEMA.id;
}

export function serializeCiRunObservationEvent(event: CiRunObservationEventV1): string {
  const errors = validateCurrentCiRunObservationEvent(event);
  if (errors.length) throw new CiRunObservationContractError(errors.join("; "));
  return serializeEventEnvelope(event);
}

export function ciRunObservationWritePlan(event: CiRunObservationEventV1): FrozenWritePlan<"ci_run_observed"> {
  return freezeDeclaredWritePlan(
    {
      commandType: event.type,
      targets: [
        { kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" },
        { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
        { kind: "projection_invalidation", projection: "ci-run-observation/v1", key: event.payload.run.runId },
      ],
    },
    [event.type],
  );
}
