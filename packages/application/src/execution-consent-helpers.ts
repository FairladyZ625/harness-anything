import { Schema } from "effect";
import {
  computeExecutionConsentPin,
  consentDeclaration,
  executionDeclaration,
  generateTaskId,
  type ConsentAction,
  type ConsentRecord,
  type ConsentResponse,
  type ConsentSnapshot,
  type ConsentSource,
  type ExecutionRecord,
  type TaskHolderPrincipal
} from "../../kernel/src/index.ts";

// The content pin is the primary invalidator: any Execution change breaks consent immediately.
// This TTL is only the independent upper bound on how fresh an otherwise matching consent may be.
export const DEFAULT_HUMAN_CONSENT_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_HUMAN_CONSENT_ACTIONS = ["approve_execution", "complete_task"] as const satisfies ReadonlyArray<ConsentAction>;

export function generateConsentId(): string {
  return `cns_${generateTaskId().slice("task_".length)}`;
}

export function decodeExecutionForConsent(
  document: { readonly path: string; readonly body: string },
  taskId: string,
  executionId: string
): ExecutionRecord {
  const execution = Schema.decodeUnknownSync(executionDeclaration.schema)(
    executionDeclaration.documentCodec.decode(document.body)
  ) as ExecutionRecord;
  if (document.path !== `executions/${execution.execution_id}.md`
      || execution.execution_id !== executionId
      || execution.task_ref !== `task/${taskId}`) {
    throw new Error(`execution identity does not match its host path: ${executionId}`);
  }
  return execution;
}

export function decodeConsentDocument(
  document: { readonly path: string; readonly body: string },
  taskId: string,
  consentId: string
): ConsentRecord {
  const consent = Schema.decodeUnknownSync(consentDeclaration.schema)(
    consentDeclaration.documentCodec.decode(document.body)
  ) as ConsentRecord;
  if (document.path !== `consents/${consent.consent_id}.md`
      || consent.consent_id !== consentId
      || consent.task_ref !== `task/${taskId}`) {
    throw new Error(`consent identity does not match its host path: ${consentId}`);
  }
  return consent;
}

export function createConsentRecord(input: {
  readonly consentId: string;
  readonly taskId: string;
  readonly execution: ExecutionRecord;
  readonly actor: TaskHolderPrincipal;
  readonly authorization: {
    readonly source: Exclude<ConsentSource, { readonly strength: "legacy-unrecorded" }>;
    readonly response: ConsentResponse;
  };
  readonly actions: ReadonlyArray<ConsentAction>;
  readonly grantedAt: string;
  readonly ttlMs?: number;
  readonly state?: "open" | "consumed";
  readonly consumedBy?: string;
  readonly consumedAt?: string;
}): ConsentRecord {
  assertConsentActions(input.actions);
  const grantedMs = Date.parse(input.grantedAt);
  if (!Number.isFinite(grantedMs)) throw new Error(`consent granted_at is invalid: ${input.grantedAt}`);
  const ttlMs = input.ttlMs ?? DEFAULT_HUMAN_CONSENT_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new Error("consent TTL must be a positive integer");
  const state = input.state ?? "open";
  return {
    schema: "consent/v2",
    consent_id: input.consentId,
    task_ref: `task/${input.taskId}`,
    execution_ref: `execution/${input.taskId}/${input.execution.execution_id}`,
    principal: { personId: input.actor.principal.personId },
    scope: {
      actions: [...input.actions],
      content_pin: {
        algorithm: "execution-consent-pin/v1",
        digest: computeExecutionConsentPin(input.execution)
      }
    },
    disclosure: {
      completion_claim: input.execution.submission?.completion_claim ?? "",
      known_gaps: [...(input.execution.submission?.known_gaps ?? [])],
      residual_risks: [...(input.execution.submission?.residual_risks ?? [])]
    },
    channel: input.actor.executor === null
      ? { kind: "human-cli", assurance: "principal-bound-command" }
      : { kind: "agent-relayed", assurance: "relayed-assertion" },
    response: input.authorization.response,
    source: input.authorization.source,
    recorded_by: input.actor,
    granted_at: input.grantedAt,
    expires_at: new Date(grantedMs + ttlMs).toISOString(),
    state,
    consumed_by: state === "consumed" ? input.consumedBy ?? null : null,
    consumed_at: state === "consumed" ? input.consumedAt ?? null : null
  };
}

export function consentSnapshot(consent: ConsentRecord): ConsentSnapshot {
  return {
    principal: consent.principal,
    scope: consent.scope,
    disclosure: consent.disclosure,
    channel: consent.channel,
    response: consent.response,
    source: consent.source,
    recorded_by: consent.recorded_by,
    granted_at: consent.granted_at,
    expires_at: consent.expires_at
  };
}

export function assertConsentActions(actions: ReadonlyArray<ConsentAction>): void {
  if (!actions.includes("approve_execution") || new Set(actions).size !== actions.length) {
    throw new Error("consent scope must grant approve_execution exactly once and may also grant complete_task");
  }
}

export function approvalCard(execution: ExecutionRecord): string {
  const submission = execution.submission;
  return [
    "Human consent required for this exact submitted Execution.",
    `Completion claim: ${submission?.completion_claim ?? "<missing>"}`,
    `Known gaps: ${formatList(submission?.known_gaps ?? [])}`,
    `Residual risks: ${formatList(submission?.residual_risks ?? [])}`,
    `Content pin: ${computeExecutionConsentPin(execution)}`,
    "Ask the human: Is this exact delivery approved, and may the task be completed?",
    "An agent may execute the approval on behalf of the responsible human. Keep HARNESS_ACTOR unchanged; changing executor identity will not satisfy this gate."
  ].join("\n");
}

function formatList(values: ReadonlyArray<string>): string {
  return values.length === 0 ? "none declared" : values.join("; ");
}
