import path from "node:path";
import { appendProgress } from "@harness-anything/application/internal/commands/task-progress-append.ts";
import { taskMutation } from "@harness-anything/application/internal/commands/task-mutation.ts";
import { compileTaskMutationWrite } from "@harness-anything/application/internal/commands/task-mutation-write.ts";
import { readCompletionContext } from "@harness-anything/application/internal/queries/task-completion-read.ts";
import {
  isTaskProgressEvent,
  sha256Text,
  stableStringify,
  type ActorIdentity,
  type AuthorizationDecision,
  type CanonicalEventAppendReceipt,
  type CanonicalEventCut,
  type CanonicalEventStore,
  type CanonicalEventV1,
  type TaskProjection,
  type WriteSource,
} from "@harness-anything/kernel";
import { consumeKnownError } from "@harness-anything/kernel/internal/error-consumption";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";

/** A writer with no checkout. Layout discovery starts here and must not assume a task worktree. */
export const CLOUD_WRITER_ROOT = path.join(path.parse(process.cwd()).root, "harness-cloud-writer");

/** One repository this shard owns as its single writer. */
export interface CloudWriterRepository {
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  /** Runs one write turn while this shard's writer epoch is current; a successor's epoch makes it
   *  throw `writer_epoch_stale` before the turn reads or appends anything. */
  readonly withAppendFence: <T>(operation: () => T) => T;
}

export type CloudWriteAuthorizationResult =
  | {
      readonly outcome: "allowed";
      readonly actor: ActorIdentity;
      readonly authorizationDecision?: AuthorizationDecision;
    }
  | { readonly outcome: "unauthenticated" }
  | { readonly outcome: "denied" }
  | { readonly outcome: "unavailable" };

export interface CloudWriteAuthorizer {
  readonly authorizeRepositoryWrite: (input: {
    readonly token: string;
    readonly repoId: string;
    readonly signal: AbortSignal;
  }) => Promise<CloudWriteAuthorizationResult>;
}

/** An accepted write the outbox publishes after the write turn has released its fence. */
export interface CloudOutboxRecord {
  readonly repoId: string;
  readonly opId: string;
  readonly revision: number;
  readonly cut: CanonicalEventCut;
}

export interface CloudWriterShardOptions {
  readonly repositories: ReadonlyMap<string, CloudWriterRepository>;
  readonly authorizer: CloudWriteAuthorizer;
  /** Write source stamped on every event this shard appends. */
  readonly source: WriteSource;
  /** Admitted requests, including those waiting for authorization; beyond it the shard sheds load. */
  readonly maxInFlight: number;
  /** Authorization deadline; defaults to the declared storage request deadline. */
  readonly authorizationTimeoutMs?: number;
  readonly now?: () => string;
  /** Asynchronous outbox publisher. It runs after the response is decided and never holds the fence. */
  readonly publish?: (record: CloudOutboxRecord) => Promise<void>;
  readonly onError?: (error: unknown) => void;
}

export interface CloudWriteReceipt {
  readonly outcome: "applied";
  readonly opId: string;
  readonly revision: number;
  readonly taskId: string;
  readonly eventType: string;
}

export interface CloudWriterShard {
  readonly handle: (request: Request) => Promise<Response>;
  /** Settles every scheduled outbox publication. */
  readonly drain: () => Promise<void>;
}

const MUTATION_KINDS = new Set(["task-amend", "task-archive", "task-reopen", "task-delete", "task-release"]);
const PROGRESS_KIND = "task-progress-append";
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,200}$/u;
const WRITE_ONLY_HEADERS: ReadonlyArray<readonly [string, string]> = [["allow", "POST"]];
const OVERLOAD_HEADERS: ReadonlyArray<readonly [string, string]> = [["retry-after", "1"]];
const BEARER_CHALLENGE_HEADERS: ReadonlyArray<readonly [string, string]> = [["www-authenticate", "Bearer"]];

/**
 * Stateful single-writer shard for POST /v1/repositories/{repoId}/commands. Each repository write
 * runs synchronously inside its writer-epoch fence, so one shard serializes its own writes and a
 * stale shard is refused once a successor raises the epoch. The operation id derives from the
 * caller's principal and `idempotency-key`, so a retry replays the accepted receipt instead of
 * appending again. Outbox publication runs after the fence is released.
 */
export function createCloudWriterShard(options: CloudWriterShardOptions): CloudWriterShard {
  const authorizationTimeoutMs = options.authorizationTimeoutMs ?? storageReadPolicy.defaultValue.deadlines.query;
  if (!isPositiveSafeInteger(options.maxInFlight) || !isPositiveSafeInteger(authorizationTimeoutMs))
    throw new RangeError("Cloud writer admission requires positive, bounded limits.");
  const repositories = new Map(options.repositories),
    fenced = new Set<string>(),
    now = options.now ?? (() => new Date().toISOString());
  let inFlight = 0,
    // One ordered outbox chain: records publish in acceptance order, after their write turn.
    outbox: Promise<void> = Promise.resolve();

  const schedulePublication = (record: CloudOutboxRecord) => {
    const publish = options.publish;
    if (!publish) return;
    outbox = outbox
      .then(() => new Promise<void>((resolve) => setImmediate(resolve)))
      .then(() => publish(record))
      .catch((error: unknown) => {
        consumeKnownError(error);
        options.onError?.(error);
      });
  };

  const handle = async (request: Request): Promise<Response> => {
    const match = /^\/v1\/repositories\/([A-Za-z0-9._-]{1,256})\/commands$/u.exec(new URL(request.url).pathname);
    if (!match) return fault(404, "route_not_found");
    if (request.method !== "POST") return fault(405, "method_not_allowed", WRITE_ONLY_HEADERS);
    const repoId = match[1]!;
    const token = /^Bearer ([^\s,]+)$/iu.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token) return fault(401, "authentication_required", BEARER_CHALLENGE_HEADERS);
    const idempotencyKey = request.headers.get("idempotency-key");
    if (idempotencyKey === null || !IDEMPOTENCY_KEY.test(idempotencyKey)) return fault(400, "idempotency_key_required");
    if (inFlight >= options.maxInFlight) return fault(429, "write_overloaded", OVERLOAD_HEADERS);
    inFlight++;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(authorizationTimeoutMs)]);
    try {
      const actor = await authorize(options.authorizer, token, repoId, signal);
      const repository = repositories.get(repoId);
      if (!repository) return fault(404, "repository_not_found");
      if (fenced.has(repoId)) return fault(409, "writer_epoch_stale");
      const action = parseAction(await request.json().catch(() => null));
      const binding = {
        actor: actor.actor,
        source: options.source,
        ...(actor.authorizationDecision ? { authorizationDecision: actor.authorizationDecision } : {}),
      };
      const opId = `cloud-${sha256Text(stableStringify({ repoId, person: actor.actor.principal, idempotencyKey }))}`;
      const result = repository.withAppendFence(() => executeWrite(repository, repoId, action, binding, opId, now));
      if (result.appended) schedulePublication({ repoId, ...result.appended });
      return Response.json(
        { receipt: result.receipt, replayed: result.appended === null },
        {
          headers: [
            ["cache-control", "no-store"],
            ...(result.appended === null ? [["idempotent-replay", "true"] as [string, string]] : []),
          ],
        },
      );
    } catch (error) {
      if (error instanceof WriteFault) return fault(error.status, error.code, error.headers);
      if (signal.aborted) return fault(request.signal.aborted ? 499 : 504, "authorization_timeout");
      const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
      if (code === "writer_epoch_stale") {
        fenced.add(repoId);
        return fault(409, code);
      }
      if (code === "op_conflict" || code === "idempotency_key_reused") return fault(409, "idempotency_key_reused");
      if (code !== null) return fault(422, code, [], error instanceof Error ? error.message : undefined);
      options.onError?.(error);
      return fault(500, "write_failed");
    } finally {
      inFlight--;
    }
  };

  return {
    handle,
    drain: async () => {
      let settled: Promise<void>;
      do {
        settled = outbox;
        await settled;
      } while (settled !== outbox);
    },
  };
}

type CloudBinding = {
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly authorizationDecision?: AuthorizationDecision;
};

function executeWrite(
  repository: CloudWriterRepository,
  repoId: string,
  action: Readonly<Record<string, unknown>> & { readonly kind: string },
  binding: CloudBinding,
  opId: string,
  now: () => string,
): { readonly receipt: CloudWriteReceipt; readonly appended: Omit<CloudOutboxRecord, "repoId"> | null } {
  const { store, projection } = repository,
    existing = store.readEvent(opId);
  if (existing) return { receipt: replayReceipt(existing, action, opId), appended: null };
  const port = {
    input: { repoId },
    store,
    projection,
    now,
    operationId: () => opId,
    cellCodedError: codedError,
    requiredCellText,
    publicPublication: (value: Pick<CanonicalEventAppendReceipt, "commitSha" | "cut">) => ({
      commitSha: value.commitSha?.sha ?? null,
      cut: value.cut,
    }),
    progressReceipt: (event: CanonicalEventV1) => ({
      outcome: "applied" as const,
      opId,
      revision: event.workspaceRevision,
      evidence: `event-object:${opId}`,
      visibility: "center" as const,
      proof: {
        committedRevision: event.workspaceRevision,
        appliedCut: event.workspaceRevision,
        durable: true,
        canonicalVisible: true,
        worktreeVisible: false,
      },
    }),
    projectedTaskIds: () => new Set<string>(),
    // A cloud shard tracks no host-local dispatch index; supersede, which needs it, is not routed here.
    readDispatchLiveEntries: () => [],
  };
  if (action.kind === PROGRESS_KIND) appendProgress(port, action, binding);
  else {
    const taskId = requiredCellText(action.taskId, "taskId"),
      current = projection.read(taskId);
    if (current.status !== "ready" || !current.snapshot.task || !current.packagePath)
      throw new CodedError("task_not_found", `Task ${taskId} is not ready in this repository's projection.`);
    const packagePath = current.packagePath,
      mutation = taskMutation(port, action, current.snapshot.task, current.snapshot, binding),
      compiled = compileTaskMutationWrite({
        taskId,
        packagePath,
        snapshot: current.snapshot,
        mutation,
        binding,
        opId,
        workspaceRevision: (store.readHead()?.revision ?? 0) + 1,
        occurredAt: now(),
        readDocument: (target) => {
          const active = projection.readDocument(target),
            read = active.document ? active : (projection.readDocumentHistory?.(target) ?? active);
          if (read.status !== "ready")
            throw new CodedError(
              "content_not_ready",
              `Retry ${action.kind} after document projection ${target} catches up.`,
            );
          return read.document
            ? { path: target, body: read.document.body, blobSha256: read.document.blobSha256 }
            : null;
        },
        completionContext: (next) => readCompletionContext(projection, taskId, next, current.status, CLOUD_WRITER_ROOT),
      });
    store.append(compiled);
    projection.apply(compiled.event, compiled.plan);
  }
  const event = store.readEvent(opId);
  if (event === null) throw new CodedError("write_not_accepted", `Write ${opId} was not appended.`);
  return {
    receipt: receiptFor(event, opId),
    appended: { opId, revision: event.workspaceRevision, cut: store.publication(event).cut },
  };
}

function replayReceipt(
  event: CanonicalEventV1,
  action: Readonly<Record<string, unknown>> & { readonly kind: string },
  opId: string,
): CloudWriteReceipt {
  const receipt = receiptFor(event, opId),
    sameKind = action.kind === PROGRESS_KIND ? isTaskProgressEvent(event) : !isTaskProgressEvent(event);
  if (!sameKind || receipt.taskId !== action.taskId)
    throw new CodedError(
      "idempotency_key_reused",
      `Idempotency key already accepted operation ${opId} for another write.`,
    );
  return receipt;
}

/** The accepted receipt is a function of the stored event alone, so a replay returns it unchanged. */
function receiptFor(event: CanonicalEventV1, opId: string): CloudWriteReceipt {
  const taskId =
    "taskId" in event && typeof event.taskId === "string"
      ? event.taskId
      : isTaskProgressEvent(event)
        ? event.payload.taskId
        : "";
  return {
    outcome: "applied",
    opId,
    revision: event.workspaceRevision,
    taskId,
    eventType:
      "type" in event && typeof event.type === "string" ? event.type : (event as { readonly schema: string }).schema,
  };
}

function parseAction(value: unknown): Readonly<Record<string, unknown>> & { readonly kind: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WriteFault(400, "invalid_command");
  const action = value as Record<string, unknown>;
  if (typeof action.kind !== "string" || !(MUTATION_KINDS.has(action.kind) || action.kind === PROGRESS_KIND))
    throw new WriteFault(400, "unsupported_command");
  if (action.dryRun !== undefined) throw new WriteFault(400, "invalid_command");
  return action as Readonly<Record<string, unknown>> & { readonly kind: string };
}

async function authorize(
  authorizer: CloudWriteAuthorizer,
  token: string,
  repoId: string,
  signal: AbortSignal,
): Promise<Extract<CloudWriteAuthorizationResult, { readonly outcome: "allowed" }>> {
  const decision = await authorizer.authorizeRepositoryWrite({ token, repoId, signal });
  if (decision.outcome === "unauthenticated")
    throw new WriteFault(401, "authentication_required", BEARER_CHALLENGE_HEADERS);
  if (decision.outcome === "unavailable") throw new WriteFault(503, "identity_unavailable");
  if (decision.outcome !== "allowed") throw new WriteFault(403, "authorization_denied");
  return decision;
}

class CodedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function codedError(code: string, message: string): Error {
  return new CodedError(code, message);
}

function requiredCellText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new CodedError("invalid_command", `${name} is required.`);
  return value.trim();
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

class WriteFault extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;

  constructor(status: number, code: string, headers: ReadonlyArray<readonly [string, string]> = []) {
    super(code);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

function fault(
  status: number,
  code: string,
  extraHeaders: ReadonlyArray<readonly [string, string]> = [],
  message?: string,
): Response {
  const headers = new Headers([
    ["cache-control", "no-store"],
    ...extraHeaders.map(([name, value]): [string, string] => [name, value]),
  ]);
  return Response.json({ error: { code, ...(message === undefined ? {} : { message }) } }, { status, headers });
}
