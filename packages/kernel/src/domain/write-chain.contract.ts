import { stablePayloadHash } from "../integrity/stable-hash.ts";
import { validateWriteReceipt, type WriteReceipt } from "./receipt-domain-registry.ts";
export { receiptDetailRegistry, validateWriteReceipt, WRITE_RECEIPT_SCHEMA } from "./receipt-domain-registry.ts";
export type { DocSyncReceiptDetail, ReceiptProof, ReceiptVisibility, WriteReceipt, WriteReceiptDetail } from "./receipt-domain-registry.ts";

export interface ActorIdentity {
  readonly principal: { readonly personId: string };
  readonly executor: { readonly kind: "agent"; readonly id: string } | null;
}

export type WriteSource = "local" | "remote_direct" | "migration-import/v1"
  | { readonly kind: "assignment"; readonly nodeId: string; readonly assignmentId: string }
  | { readonly kind: "watch_session"; readonly sessionId: string; readonly path: string; readonly fingerprint: string };

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

export interface RecoveryBudget {
  readonly deadline: number;
  readonly maxItems: number;
  readonly retry: number;
}
export const RECOVERY_BUDGET: Readonly<RecoveryBudget> = Object.freeze({ deadline: 100, maxItems: 64, retry: 1 });
export const recoveryStates = Object.freeze(["queued", "running", "exhausted", "failed", "drained"] as const);
export type RecoveryState = (typeof recoveryStates)[number];
export interface RecoveryWindow { readonly elapsed: number; readonly attempt: number }

export interface RecoveryBatch<T> {
  readonly items: readonly T[];
  readonly deferred: number;
  readonly nextCursor: number;
  readonly state: RecoveryState;
}

export function nextRecoveryBatch<T>(items: readonly T[], cursor = 0, budget: RecoveryBudget = RECOVERY_BUDGET,
  window: RecoveryWindow = { elapsed: 0, attempt: 0 }): RecoveryBatch<T> {
  if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(budget.deadline) || budget.deadline < 0
    || !Number.isInteger(budget.maxItems) || budget.maxItems < 1 || !Number.isInteger(budget.retry) || budget.retry < 0
    || !Number.isInteger(window.elapsed) || window.elapsed < 0 || !Number.isInteger(window.attempt) || window.attempt < 0) {
    throw new WriteChainContractError("invalid_contract", "recovery cursor, budget, and window must be non-negative integers with a positive item limit");
  }
  const stopped: RecoveryState | null = window.attempt > budget.retry ? "failed" : window.elapsed >= budget.deadline ? "exhausted" : null;
  if (stopped !== null) return Object.freeze({ items: Object.freeze([]) as readonly T[], deferred: Math.max(0, items.length - cursor), nextCursor: cursor, state: stopped });
  const batch = Object.freeze(items.slice(cursor, cursor + budget.maxItems));
  const nextCursor = cursor + batch.length;
  const deferred = Math.max(0, items.length - nextCursor);
  return Object.freeze({ items: batch, deferred, nextCursor, state: deferred === 0 ? "drained" : "exhausted" });
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
  | { readonly kind: "event_file"; readonly path: string; readonly operation: "create" }
  | { readonly kind: "event_head"; readonly path: string; readonly operation: "replace" } | { readonly kind: "authored_file"; readonly path: string; readonly operation: "replace"; readonly sha256: string; readonly size: number; readonly mediaType: string }
  | { readonly kind: "projection_invalidation"; readonly projection: string; readonly key: string }
  | { readonly kind: "lease_sqlite"; readonly table: "lease_cas"; readonly taskId: string; readonly operation: "reserve" | "activate" | "release" }
  | { readonly kind: "content_blob"; readonly sha256: string; readonly size: number; readonly mediaType: string };
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
  if (value === "local" || value === "remote_direct" || value === "migration-import/v1") return [];
  if (isRecord(value) && hasOnlyFields(value, ["kind", "nodeId", "assignmentId"]) && value.kind === "assignment" && isNonEmptyString(value.nodeId) && isNonEmptyString(value.assignmentId)) return [];
  return isRecord(value) && hasOnlyFields(value, ["kind", "sessionId", "path", "fingerprint"]) && value.kind === "watch_session" && isNonEmptyString(value.sessionId) && safeWorkspacePath(value.path) && /^[0-9a-f]{64}$/u.test(String(value.fingerprint)) ? [] : ["source must be local, remote_direct, migration-import/v1, an assignment identity, or a watch session"];
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
export function bindWriterGenerationToken(writer: WriterGeneration): WriterGenerationToken { return issueWriterGenerationToken(writer); }

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

export function freezeWriteValue<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null) return value;
  for (const nested of Object.values(value)) freezeWriteValue(nested);
  return Object.freeze(value);
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
  return target.kind === "event_file" || target.kind === "event_head" ? `${target.kind}:${target.path}`
    : target.kind === "projection_invalidation" ? `${target.kind}:${target.projection}:${target.key}`
    : target.kind === "lease_sqlite" ? `${target.kind}:${target.table}:${target.taskId}:${target.operation}`
    : `${target.kind}:${target.sha256}`;
}

export function validateDeclaredWritePlan(plan: WritePlan, commandTypes: readonly string[]): readonly string[] {
  const errors: string[] = [];
  if (!commandTypes.includes(plan.commandType)) errors.push("write plan command must come from its domain contract");
  if (!Array.isArray(plan.targets) || !plan.targets.some((target) => target.kind === "event_file")
    || !plan.targets.some((target) => target.kind === "event_head")
    || !plan.targets.some((target) => target.kind === "projection_invalidation")) errors.push("write plan must declare event and projection targets");
  const keys = new Set<string>();
  for (const target of plan.targets) {
    const key = targetKey(target);
    if (keys.has(key)) errors.push(`duplicate write target: ${key}`);
    keys.add(key);
    if (target.kind === "event_file" && (!safeWorkspacePath(target.path) || !target.path.startsWith("harness/events/")
      || !target.path.endsWith(".json") || target.path === "harness/events/head.json" || target.operation !== "create")) errors.push("event file target is invalid");
    if (target.kind === "event_head" && (target.path !== "harness/events/head.json" || target.operation !== "replace")) errors.push("event head target is invalid");
    if (target.kind === "projection_invalidation" && (!isNonEmptyString(target.projection) || !safeWorkspacePath(target.key))) errors.push("projection target is invalid");
    if (target.kind === "lease_sqlite" && (target.table !== "lease_cas" || !safeIdentity(target.taskId)
      || !["reserve", "activate", "release"].includes(target.operation))) errors.push("lease target is invalid");
    if (target.kind === "content_blob" && (!/^[0-9a-f]{64}$/u.test(target.sha256) || !Number.isInteger(target.size) || target.size < 0 || !isNonEmptyString(target.mediaType))) errors.push("content blob target is invalid");
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
  gates: Object.freeze([]),
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
