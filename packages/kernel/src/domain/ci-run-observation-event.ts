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
import { completionEvidenceResults, type CompletionEvidenceResult } from "./completion-evidence.ts";

export const CI_RUN_OBSERVATION_SCHEMA = Object.freeze({
  id: "ci-run-observation/v3",
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
  readonly result: CompletionEvidenceResult;
  readonly metrics: Readonly<Record<string, number>>;
};

export type CiRunObservationGateV2 = {
  readonly gate: string;
  readonly pass: boolean;
  readonly metrics: Readonly<Record<string, number>>;
};

/**
 * The observed workflow verdict. `github-actions` names the real run and its trigger event;
 * `event: null` is a migration-preserved gap — the run was observed before trigger collection
 * (dec_ED8A4E774FA7A96820D32D171D) and the fact stays unavailable, never guessed. New writers
 * must record a non-empty event (serializeCiRunObservationEvent enforces it).
 * `write-coordinator` is the ledger's own publication observation and carries no trigger event.
 */
export type CiWorkflowVerification =
  | {
      readonly source: "github-actions";
      readonly workflow: string;
      readonly runId: string;
      readonly attempt: number;
      readonly headSha: string;
      readonly conclusion: string;
      readonly event: string | null;
    }
  | {
      readonly source: "write-coordinator";
      readonly workflow: "ledger-publication";
      readonly runId: string;
      readonly attempt: 1;
      readonly headSha: string;
      readonly conclusion: "success";
    };

export type CiRunObservationEventV2 = EventEnvelope<
  "ci-run-observation/v2",
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
    readonly verification: CiWorkflowVerification | null;
    readonly tests: readonly CiRunObservationTest[];
    readonly gates: readonly CiRunObservationGateV2[];
  }
>;

export type CiRunObservationEventV3 = EventEnvelope<
  "ci-run-observation/v3",
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
    readonly verification: CiWorkflowVerification | null;
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

/** The single current-schema parser; ci-run-observation/v2 decodes only through the offline migrator. */
export function validateCiRunObservationEvent(value: unknown, allowUnknownFields = false): readonly string[] {
  return validateFields(value, allowUnknownFields, CI_RUN_OBSERVATION_SCHEMA.id, "result");
}

export function validateCiRunObservationEventV2(value: unknown): readonly string[] {
  return validateFields(value, true, "ci-run-observation/v2", "pass");
}

function validateFields(
  value: unknown,
  allowUnknownFields: boolean,
  schema: string,
  gateField: "pass" | "result",
): readonly string[] {
  if (
    !isRecord(value) ||
    !hasContractFields(value, CI_RUN_OBSERVATION_SCHEMA.required, allowUnknownFields) ||
    value.schema !== schema ||
    value.type !== "ci_run_observed" ||
    !isRecord(value.payload) ||
    !hasContractFields(value.payload, ["run", "tests", "gates", "verification"], allowUnknownFields) ||
    !validRun(value.payload.run, allowUnknownFields) ||
    !validVerification(value.payload.verification, value.payload.run, allowUnknownFields, gateField) ||
    !Array.isArray(value.payload.tests) ||
    value.payload.tests.some((test) => !validTest(test, allowUnknownFields)) ||
    !Array.isArray(value.payload.gates) ||
    value.payload.gates.some((gate) => !validGate(gate, allowUnknownFields, gateField))
  )
    return ["ci run observation event envelope or payload is invalid"];
  return validateEventEnvelopeIdentity(value, allowUnknownFields).length
    ? ["ci run observation event envelope identity is invalid"]
    : [];
}

function validVerification(
  value: unknown,
  run: unknown,
  allowUnknownFields: boolean,
  gateField: "pass" | "result",
): boolean {
  if (value === null) return true;
  if (
    isRecord(value) &&
    value.source === "write-coordinator" &&
    value.workflow === "ledger-publication" &&
    hasContractFields(value, ["source", "workflow", "runId", "attempt", "headSha", "conclusion"], false) &&
    typeof value.runId === "string" &&
    value.runId.startsWith("ledger-") &&
    value.attempt === 1 &&
    nonEmpty(value.headSha) &&
    value.conclusion === "success" &&
    isRecord(run) &&
    run.runId === value.runId &&
    run.sha === value.headSha
  )
    return true;
  return (
    isRecord(value) &&
    isRecord(run) &&
    hasContractFields(
      value,
      // v3 always carries the trigger event explicitly — null marks a migration-preserved gap.
      ["source", "workflow", "runId", "attempt", "headSha", "conclusion", ...(gateField === "result" ? ["event"] : [])],
      allowUnknownFields,
    ) &&
    value.source === "github-actions" &&
    nonEmpty(value.workflow) &&
    typeof value.runId === "string" &&
    /^[1-9][0-9]*$/u.test(value.runId) &&
    Number.isSafeInteger(value.attempt) &&
    Number(value.attempt) > 0 &&
    nonEmpty(value.headSha) &&
    nonEmpty(value.conclusion) &&
    (gateField === "pass" || value.event === null || nonEmpty(value.event)) &&
    run.runId === `${value.runId}.${value.attempt}` &&
    run.sha === value.headSha &&
    run.branch === "main"
  );
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

function validGate(value: unknown, allowUnknownFields: boolean, gateField: "pass" | "result"): boolean {
  if (
    !isRecord(value) ||
    !hasContractFields(value, ["gate", gateField, "metrics"], allowUnknownFields) ||
    !nonEmpty(value.gate) ||
    (gateField === "pass"
      ? typeof value.pass !== "boolean"
      : !completionEvidenceResults.includes(value.result as CompletionEvidenceResult)) ||
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

export function isCiRunObservationEvent(event: { readonly schema: string }): event is CiRunObservationEventV3 {
  return event.schema === CI_RUN_OBSERVATION_SCHEMA.id;
}

export function serializeCiRunObservationEvent(event: CiRunObservationEventV3): string {
  const errors = validateCiRunObservationEvent(event);
  if (errors.length) throw new CiRunObservationContractError(errors.join("; "));
  const verification = event.payload.verification;
  if (verification !== null && verification.source === "github-actions" && verification.event === null)
    throw new CiRunObservationContractError(
      "a new github-actions observation must record the run's trigger event; " +
        "event:null is reserved for migration-preserved history",
    );
  return serializeEventEnvelope(event);
}

export function ciRunObservationWritePlan(event: CiRunObservationEventV3): FrozenWritePlan<"ci_run_observed"> {
  return freezeDeclaredWritePlan(
    {
      commandType: event.type,
      targets: [
        { kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" },
        { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
        { kind: "projection_invalidation", projection: "ci-run-observation/v3", key: event.payload.run.runId },
      ],
    },
    [event.type],
  );
}
