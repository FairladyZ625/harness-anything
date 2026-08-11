import { stablePayloadHash } from "../integrity/stable-hash.ts";

export interface ActorIdentity {
  readonly principal: { readonly personId: string };
  readonly executor: { readonly kind: "agent"; readonly id: string } | null;
}

export type WriteSource = "local" | "remote_direct" | {
  readonly kind: "assignment";
  readonly nodeId: string;
  readonly assignmentId: string;
};

export interface NormalizedCommandEnvelope<A extends ActorIdentity = ActorIdentity> {
  readonly schema: "normalized-command/v1";
  readonly workspaceId: string;
  readonly actor: A;
  readonly source: WriteSource;
  readonly expectedRevision: number;
  readonly opId: string;
  readonly commandDigest: `sha256:${string}`;
}

export interface WriterGeneration {
  readonly workspaceId: string;
  readonly generation: number;
  readonly ownerId: string;
}

export const writeReceiptOutcomes = Object.freeze(["applied", "pending", "indeterminate", "rejected"] as const);
export type WriteReceiptOutcome = (typeof writeReceiptOutcomes)[number];
export type ReceiptVisibility = "center" | { readonly kind: "replica"; readonly viewId: string };
export interface ReceiptProof { readonly committedRevision: number; readonly appliedCut: number; readonly ackCut?: number }
export interface WriteReceipt {
  readonly outcome: WriteReceiptOutcome;
  readonly opId: string;
  readonly revision?: number;
  readonly code?: string;
  readonly origin?: string;
  readonly nextAction?: string;
  readonly evidence?: string;
  readonly visibility?: ReceiptVisibility;
  readonly proof?: ReceiptProof;
}

export interface RecoveryBudget {
  readonly deadline: number;
  readonly maxItems: number;
  readonly retry: number;
}
export const RECOVERY_BUDGET: Readonly<RecoveryBudget> = Object.freeze({ deadline: 100, maxItems: 64, retry: 1 });
export const recoveryStates = Object.freeze(["queued", "running", "deferred", "failed", "done"] as const);

export interface RecoveryBatch<T> {
  readonly items: readonly T[];
  readonly deferred: number;
  readonly nextCursor: number;
}

export function nextRecoveryBatch<T>(items: readonly T[], cursor = 0, budget: RecoveryBudget = RECOVERY_BUDGET): RecoveryBatch<T> {
  if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(budget.maxItems) || budget.maxItems < 1) {
    throw new WriteChainContractError("invalid_contract", "recovery cursor and item budget must be positive integers");
  }
  const batch = Object.freeze(items.slice(cursor, cursor + budget.maxItems));
  const nextCursor = cursor + batch.length;
  return Object.freeze({ items: batch, deferred: Math.max(0, items.length - nextCursor), nextCursor });
}

export interface EventEnvelope<S extends string, T extends string, A extends ActorIdentity, P> {
  readonly schema: S;
  readonly eventId: string;
  readonly workspaceRevision: number;
  readonly opId: string;
  readonly type: T;
  readonly actor: A;
  readonly source: WriteSource;
  readonly occurredAt: string;
  readonly payload: P;
}
export interface EventHead {
  readonly revision: number;
  readonly opId: string;
  readonly eventDigest: `sha256:${string}`;
}

export type WriteTarget =
  | { readonly kind: "event_stream"; readonly stream: string; readonly operation: "append" }
  | { readonly kind: "projection_invalidation"; readonly projection: string; readonly taskId: string }
  | { readonly kind: "lease_sqlite"; readonly table: "lease_cas"; readonly taskId: string; readonly operation: "reserve" | "activate" | "release" }
  | { readonly kind: "task_artifact"; readonly path: string; readonly operation: "create" | "replace" };
export interface WritePlan<C extends string = string> { readonly commandType: C; readonly targets: readonly WriteTarget[] }
declare const frozenWritePlanBrand: unique symbol;
export type FrozenWritePlan<C extends string = string> = Readonly<WritePlan<C>> & { readonly [frozenWritePlanBrand]: true };

export type WriteOperationReceipt<E, S, C extends string = string> = WriteReceipt & {
  readonly event?: E;
  readonly snapshot: S;
  readonly frozenPlan: FrozenWritePlan<C>;
};

declare const writerGenerationTokenBrand: unique symbol;
export type WriterGenerationToken = Readonly<WriterGeneration> & { readonly [writerGenerationTokenBrand]: true };

export interface WriterPort<C extends NormalizedCommandEnvelope = NormalizedCommandEnvelope> {
  readonly execute: (token: WriterGenerationToken, command: C) => Promise<WriteReceipt>;
}

export class WriteChainContractError extends Error {
  readonly code: "invalid_contract" | "writer_rejected" | "invalid_write_plan";
  constructor(code: "invalid_contract" | "writer_rejected" | "invalid_write_plan", message: string) {
    super(message);
    this.name = "WriteChainContractError";
    this.code = code;
  }
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOnlyFields(value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  return Object.keys(value).every((field) => fields.includes(field)) && fields.every((field) => Object.hasOwn(value, field));
}

export function validateActorIdentity(value: unknown): readonly string[] {
  if (!isRecord(value) || !hasOnlyFields(value, ["principal", "executor"]) || !isRecord(value.principal)
    || !hasOnlyFields(value.principal, ["personId"]) || !isNonEmptyString(value.principal.personId)) return ["principal must be a person identity"];
  if (value.executor !== null && (!isRecord(value.executor) || !hasOnlyFields(value.executor, ["kind", "id"])
    || value.executor.kind !== "agent" || !isNonEmptyString(value.executor.id))) return ["executor must be an agent identity or null"];
  return [];
}

export function validateWriteSource(value: unknown): readonly string[] {
  if (value === "local" || value === "remote_direct") return [];
  return isRecord(value) && hasOnlyFields(value, ["kind", "nodeId", "assignmentId"]) && value.kind === "assignment"
    && isNonEmptyString(value.nodeId) && isNonEmptyString(value.assignmentId) ? [] : ["source must be local, remote_direct, or an assignment identity"];
}

export const WRITE_RECEIPT_SCHEMA = Object.freeze({
  id: "write-receipt/v1",
  outcomes: writeReceiptOutcomes,
  required: Object.freeze(["outcome", "opId"]),
  optional: Object.freeze(["revision", "code", "origin", "nextAction", "evidence", "visibility", "proof"])
});

export function validateWriteReceipt(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["receipt must be an object"];
  const receipt = value as Readonly<Record<string, unknown>>;
  const allowed = new Set([...WRITE_RECEIPT_SCHEMA.required, ...WRITE_RECEIPT_SCHEMA.optional]);
  const errors = Object.keys(receipt).filter((key) => !allowed.has(key)).map((key) => `unexpected field: ${key}`);
  if (!(writeReceiptOutcomes as readonly unknown[]).includes(receipt.outcome)) errors.push("receipt outcome is invalid");
  if (!isNonEmptyString(receipt.opId)) errors.push("opId is required");
  if (Object.hasOwn(receipt, "revision") && (!Number.isInteger(receipt.revision) || (receipt.revision as number) < 0)) errors.push("revision must be a non-negative integer");
  for (const field of ["code", "origin", "nextAction", "evidence"] as const) {
    if (Object.hasOwn(receipt, field) && !isNonEmptyString(receipt[field])) errors.push(`${field} must be a non-empty string`);
  }
  const visibility = receipt.visibility;
  const replica = isRecord(visibility) && hasOnlyFields(visibility, ["kind", "viewId"])
    && visibility.kind === "replica" && isNonEmptyString(visibility.viewId);
  if (Object.hasOwn(receipt, "visibility") && visibility !== "center" && !replica) errors.push("visibility must be center or replica(viewId)");
  const proof = receipt.proof;
  const proofFields = isRecord(proof) && Object.hasOwn(proof, "ackCut")
    ? ["committedRevision", "appliedCut", "ackCut"] : ["committedRevision", "appliedCut"];
  const validProof = isRecord(proof) && hasOnlyFields(proof, proofFields)
    && proofFields.every((field) => Number.isInteger(proof[field]) && (proof[field] as number) >= 0);
  if (Object.hasOwn(receipt, "proof") && !validProof) errors.push("proof revisions must be non-negative integer cuts");
  if ((receipt.outcome === "applied" || receipt.outcome === "pending") && (visibility === undefined || !validProof)) errors.push(`${String(receipt.outcome)} requires visibility and proof`);
  if (receipt.outcome === "applied" && validProof && proof.committedRevision !== proof.appliedCut) errors.push("applied proof must use the same committed and applied cut");
  if (receipt.outcome === "applied" && replica && validProof && proof.ackCut !== proof.appliedCut) errors.push("replica applied requires ackCut at the same cut");
  if (receipt.outcome === "applied" && (!Number.isInteger(receipt.revision) || !isNonEmptyString(receipt.evidence))) errors.push("applied requires revision and evidence");
  if (receipt.outcome === "pending" && (!Number.isInteger(receipt.revision) || !isNonEmptyString(receipt.evidence) || !isNonEmptyString(receipt.nextAction))) errors.push("pending requires committed evidence, revision, and nextAction");
  if (receipt.outcome === "indeterminate" || receipt.outcome === "rejected") {
    for (const field of ["code", "origin", "nextAction"] as const) if (!isNonEmptyString(receipt[field])) errors.push(`${field} is required for ${receipt.outcome}`);
  }
  return errors;
}

export function createWriteReceipt<R extends WriteReceipt>(receipt: R): Readonly<R> {
  const errors = validateWriteReceipt(receipt);
  if (errors.length > 0) throw new WriteChainContractError("invalid_contract", `invalid receipt: ${errors.join("; ")}`);
  return Object.freeze({ ...receipt });
}

export function serializeWriteReceipt(receipt: WriteReceipt): string {
  return `${JSON.stringify(canonicalizeWriteValue(createWriteReceipt(receipt)))}\n`;
}

export function issueWriterGenerationToken(writer: WriterGeneration): WriterGenerationToken {
  if (!isNonEmptyString(writer.workspaceId) || !isNonEmptyString(writer.ownerId) || !Number.isInteger(writer.generation) || writer.generation < 0) {
    throw new WriteChainContractError("invalid_contract", "writer generation requires workspace, owner, and a non-negative generation");
  }
  return Object.freeze({ ...writer }) as WriterGenerationToken;
}

export function assertCurrentWriter(active: WriterGeneration, token: WriterGenerationToken, workspaceId: string): void {
  if (active.workspaceId !== workspaceId || token.workspaceId !== workspaceId || token.generation !== active.generation || token.ownerId !== active.ownerId) {
    throw new WriteChainContractError("writer_rejected", "writer token is not the active workspace generation and owner");
  }
}

export function canonicalizeWriteValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeWriteValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeWriteValue((value as Readonly<Record<string, unknown>>)[key])]));
}

export function serializeEventEnvelope(event: EventEnvelope<string, string, ActorIdentity, unknown>): string {
  if (!isNonEmptyString(event.schema) || !isNonEmptyString(event.eventId) || !isNonEmptyString(event.opId) || !isNonEmptyString(event.type)
    || !isNonEmptyString(event.occurredAt) || !Number.isInteger(event.workspaceRevision) || event.workspaceRevision < 1
    || validateActorIdentity(event.actor).length > 0 || validateWriteSource(event.source).length > 0) {
    throw new WriteChainContractError("invalid_contract", "event envelope identity is invalid");
  }
  return `${JSON.stringify(canonicalizeWriteValue(event))}\n`;
}

export function serializeEventHead(head: EventHead): string {
  if (!Number.isInteger(head.revision) || head.revision < 1 || !isNonEmptyString(head.opId) || !/^sha256:[0-9a-f]{64}$/u.test(head.eventDigest)) {
    throw new WriteChainContractError("invalid_contract", "event head requires revision, opId, and a SHA-256 event digest");
  }
  return `${JSON.stringify(canonicalizeWriteValue(head))}\n`;
}

function safeWorkspacePath(value: unknown): value is string {
  return isNonEmptyString(value) && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function safeIdentity(value: unknown): value is string {
  return isNonEmptyString(value) && !/[\\/]/u.test(value) && value !== "." && value !== "..";
}

function targetKey(target: WriteTarget): string {
  return target.kind === "event_stream" ? `${target.kind}:${target.stream}`
    : target.kind === "projection_invalidation" ? `${target.kind}:${target.projection}:${target.taskId}`
    : target.kind === "lease_sqlite" ? `${target.kind}:${target.table}:${target.taskId}:${target.operation}`
    : `${target.kind}:${target.path}`;
}

export function validateDeclaredWritePlan(plan: WritePlan, commandTypes: readonly string[]): readonly string[] {
  const errors: string[] = [];
  if (!commandTypes.includes(plan.commandType)) errors.push("write plan command must come from its domain contract");
  if (!Array.isArray(plan.targets) || !plan.targets.some((target) => target.kind === "event_stream")
    || !plan.targets.some((target) => target.kind === "projection_invalidation")) errors.push("write plan must declare event and projection targets");
  const keys = new Set<string>();
  for (const target of plan.targets) {
    const key = targetKey(target);
    if (keys.has(key)) errors.push(`duplicate write target: ${key}`);
    keys.add(key);
    if (target.kind === "event_stream" && (!safeWorkspacePath(target.stream) || target.operation !== "append")) errors.push("event stream target is invalid");
    if (target.kind === "projection_invalidation" && (!isNonEmptyString(target.projection) || !safeIdentity(target.taskId))) errors.push("projection target is invalid");
    if (target.kind === "lease_sqlite" && (target.table !== "lease_cas" || !safeIdentity(target.taskId)
      || !["reserve", "activate", "release"].includes(target.operation))) errors.push("lease target is invalid");
    if (target.kind === "task_artifact" && (!safeWorkspacePath(target.path) || !["create", "replace"].includes(target.operation))) errors.push("artifact target is invalid");
  }
  return errors;
}

export function freezeDeclaredWritePlan<C extends string>(plan: WritePlan<C>, commandTypes: readonly string[]): FrozenWritePlan<C> {
  const errors = validateDeclaredWritePlan(plan, commandTypes);
  if (errors.length > 0) throw new WriteChainContractError("invalid_write_plan", errors.join("; "));
  return Object.freeze({ commandType: plan.commandType,
    targets: Object.freeze(plan.targets.map((target) => Object.freeze({ ...target }))) }) as FrozenWritePlan<C>;
}

export function isFrozenWritePlan(plan: WritePlan): boolean {
  return Object.isFrozen(plan) && Object.isFrozen(plan.targets);
}

export function appendWriteTarget<C extends string>(plan: WritePlan<C>, target: WriteTarget): WritePlan<C> {
  return { commandType: plan.commandType, targets: [...plan.targets, target] };
}

export function normalizeCommandEnvelope<A extends ActorIdentity>(input: {
  readonly workspaceId: string;
  readonly actor: A;
  readonly source: WriteSource;
  readonly expectedRevision: number;
  readonly command: Readonly<Record<string, unknown>>;
}): NormalizedCommandEnvelope<A> {
  const payloadBinding = ["actor", "source", "workspaceId"].find((field) => Object.hasOwn(input.command, field));
  const errors = [...validateActorIdentity(input.actor), ...validateWriteSource(input.source)];
  if (!isNonEmptyString(input.workspaceId) || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) errors.push("workspace namespace and expected revision are invalid");
  if (input.command.type === "CreateReplayTask" && input.expectedRevision !== 0) errors.push("create commands require expectedRevision 0");
  if (payloadBinding !== undefined) errors.push(`command payload cannot report ingress binding ${payloadBinding}`);
  if (errors.length > 0) throw new WriteChainContractError("invalid_contract", errors.join("; "));
  const digest = stablePayloadHash(input);
  return Object.freeze({ schema: "normalized-command/v1", workspaceId: input.workspaceId, actor: input.actor,
    source: input.source, expectedRevision: input.expectedRevision, opId: `op_${digest}`, commandDigest: `sha256:${digest}` });
}

export function validateNormalizedCommandEnvelope<A extends ActorIdentity>(envelope: NormalizedCommandEnvelope<A>, input: {
  readonly workspaceId: string;
  readonly actor: A;
  readonly source: WriteSource;
  readonly expectedRevision: number;
  readonly command: Readonly<Record<string, unknown>>;
}): readonly string[] {
  const expected = normalizeCommandEnvelope(input);
  const errors: string[] = [];
  if (envelope.schema !== "normalized-command/v1" || envelope.workspaceId !== input.workspaceId) errors.push("normalized command schema or workspace is invalid");
  if (JSON.stringify(canonicalizeWriteValue(envelope.actor)) !== JSON.stringify(canonicalizeWriteValue(input.actor))) errors.push("normalized command actor is invalid");
  if (JSON.stringify(canonicalizeWriteValue(envelope.source)) !== JSON.stringify(canonicalizeWriteValue(input.source))
    || envelope.expectedRevision !== input.expectedRevision) errors.push("normalized command source or expected revision is invalid");
  if (envelope.commandDigest !== expected.commandDigest) errors.push("normalized command digest does not match its payload");
  if (envelope.opId !== expected.opId) errors.push("normalized command opId does not match its digest");
  return errors;
}

export default Object.freeze({
  id: "write-chain",
  phases: Object.freeze(["P4"]),
  commands: Object.freeze([]),
  gates: Object.freeze(["G01", "G02", "G03", "G07", "G08"]),
  guards: Object.freeze([]),
  schemas: Object.freeze([Object.freeze({
    id: "write-receipt/v1",
    schema: "packages/kernel/src/domain/write-chain.contract.ts#WRITE_RECEIPT_SCHEMA",
    parser: "packages/kernel/src/domain/write-chain.contract.ts#validateWriteReceipt",
    writer: "packages/kernel/src/domain/write-chain.contract.ts#serializeWriteReceipt",
    error: "packages/kernel/src/domain/write-chain.contract.ts#WriteChainContractError",
    negativeFixtures: Object.freeze(["tools/gates/test/fixtures/receipt-missing-next-action.json"])
  })])
});
