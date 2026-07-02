import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { Effect, Either, Option } from "effect";
import { taskEntityId, type ArtifactStoreError, type EngineError, type ExternalRef, type TaskId, type WriteError } from "../../../kernel/src/domain/index.ts";
import { stablePayloadHash } from "../../../kernel/src/integrity/stable-hash.ts";
import type { ArtifactStore, LifecycleEngine, WriteCoordinator } from "../../../kernel/src/ports/index.ts";
import type { HarnessLayoutInput, HarnessLayoutOverrides } from "../../../kernel/src/layout/index.ts";
import { createHarnessRuntimeContext, findTaskIdByExternalRef, resolveHarnessLayout, taskDocumentPath, validateTaskIdSyntax } from "../../../kernel/src/layout/index.ts";
import { writeCoordinatedPayload } from "../../../kernel/src/write-coordination/write-helpers.ts";

export type BindingLookup = Pick<ArtifactStore, "findBindingByExternalRef">;
import type { TaskSnapshot } from "../../../kernel/src/schemas/registry.ts";

export interface MulticaRawIssue {
  readonly ref: ExternalRef;
  readonly title: string;
  readonly status: string;
  readonly url?: string;
  readonly updatedAt?: string;
}

export interface MulticaClient {
  readonly fetchIssue: (ref: ExternalRef) => Effect.Effect<MulticaRawIssue, EngineError>;
  readonly listIssues?: () => Effect.Effect<ReadonlyArray<MulticaRawIssue>, EngineError>;
}

export interface MulticaLifecycleOptions {
  readonly client: MulticaClient;
  readonly clock?: () => Date;
  readonly staleTtlMs?: number;
}

export interface MulticaAdoptionOptions extends MulticaLifecycleOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly coordinator: WriteCoordinator;
  readonly bindingIndex?: BindingLookup;
}

export interface AdoptMulticaTaskInput {
  readonly taskId: TaskId;
  readonly ref: ExternalRef;
  readonly vertical?: string;
  readonly preset?: string;
}

export interface AdoptMulticaTaskResult {
  readonly taskId: TaskId;
  readonly engine: "multica";
  readonly ref: ExternalRef;
}

export interface MulticaBindingFingerprintInput {
  readonly engine: "multica";
  readonly ref: ExternalRef;
  readonly bindingCreatedAt: string;
}

export interface MulticaAdoptionService {
  readonly adopt: (input: AdoptMulticaTaskInput) => Effect.Effect<AdoptMulticaTaskResult, ArtifactStoreError | EngineError | WriteError>;
}

interface CacheEntry {
  readonly snapshot: TaskSnapshot;
  readonly expiresAtMs: number;
}

const defaultTtlMs = 5 * 60 * 1000;

export function makeMulticaLifecycleEngine(options: MulticaLifecycleOptions): LifecycleEngine {
  const clock = options.clock ?? (() => new Date());
  const staleTtlMs = options.staleTtlMs ?? defaultTtlMs;
  const cache = new Map<ExternalRef, CacheEntry>();
  const listIssues = options.client.listIssues;

  return {
    name: "multica",
    capabilities: Effect.succeed({
      snapshots: true,
      listTasks: options.client.listIssues !== undefined,
      publishNote: false
    }),
    snapshot: (ref) => {
      if (ref.engine !== "multica" || ref.ref === null) {
        return Effect.fail({ _tag: "EngineOwnsStatus", engine: ref.engine, ref: ref.ref ?? "" } satisfies EngineError);
      }
      return snapshotMulticaRef(options.client, cache, ref.ref, clock, staleTtlMs);
    },
    listTasks: listIssues
      ? () => listIssues().pipe(
        Effect.map((issues) => issues.map((issue) => mapMulticaIssue(issue, clock())))
      )
      : undefined
  };
}

function snapshotMulticaRef(
  client: MulticaClient,
  cache: Map<ExternalRef, CacheEntry>,
  ref: ExternalRef,
  clock: () => Date,
  staleTtlMs: number
): Effect.Effect<TaskSnapshot, EngineError> {
  return Effect.gen(function* () {
    const result = yield* Effect.either(client.fetchIssue(ref));
    if (Either.isRight(result)) {
      const snapshot = mapMulticaIssue(result.right, clock());
      cache.set(ref, {
        snapshot,
        expiresAtMs: clock().getTime() + staleTtlMs
      });
      return snapshot;
    }

    const error = result.left;
    if (error._tag !== "EngineUnreachable" && error._tag !== "Timeout" && error._tag !== "RateLimited") {
      return yield* Effect.fail(error);
    }

    const cached = cache.get(ref);
    if (cached && cached.expiresAtMs >= clock().getTime()) {
      return {
        ...cached.snapshot,
        freshness: "stale-but-usable",
        staleReason: error._tag,
        source: "snapshot-cache"
      } satisfies TaskSnapshot;
    }

    return {
      canonicalStatus: "unknown",
      rawStatus: "unavailable",
      freshness: "unavailable-no-cache",
      fetchedAt: clock().toISOString(),
      staleReason: error._tag,
      source: "external-engine",
      engine: "multica",
      ref
    } satisfies TaskSnapshot;
  });
}

export function makeMulticaAdoptionService(options: MulticaAdoptionOptions): MulticaAdoptionService {
  const rootDir = path.resolve(options.rootDir);
  const layoutInput = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const clock = options.clock ?? (() => new Date());
  const engine = makeMulticaLifecycleEngine(options);
  const bindingIndex = options.bindingIndex ?? makeMarkdownBindingIndex(layoutInput);

  return {
    adopt: (input) => Effect.gen(function* () {
      validateTaskId(input.taskId);
      const claims = yield* Effect.try({
        try: () => acquireAdoptClaims(layoutInput, input.taskId, input.ref),
        catch: (): EngineError => ({
          _tag: "DuplicateAdoptClaim",
          engine: "multica",
          ref: input.ref
        })
      });
      try {
        if (existsSync(taskIndexPath(layoutInput, input.taskId))) {
          return yield* Effect.fail({
            _tag: "TaskAlreadyExists",
            taskId: input.taskId
          } satisfies EngineError);
        }
        const existingBinding = yield* bindingIndex.findBindingByExternalRef("multica", input.ref);
        if (Option.isSome(existingBinding)) {
          return yield* Effect.fail({
            _tag: "DuplicateExternalBinding",
            engine: "multica",
            ref: input.ref
          } satisfies EngineError);
        }
        const snapshot = yield* engine.snapshot({ engine: "multica", ref: input.ref });
        if (snapshot.freshness !== "fresh") {
          return yield* Effect.fail({
            _tag: "StaleSnapshotRefused",
            engine: "multica",
            ref: input.ref
          } satisfies EngineError);
        }
        yield* writeTaskDocument(options.coordinator, input.taskId, renderAdoptedIndex({
          taskId: input.taskId,
          ref: input.ref,
          title: snapshot.title ?? input.ref,
          url: snapshot.url ?? null,
          bindingCreatedAt: clock().toISOString(),
          vertical: input.vertical ?? "default",
          preset: input.preset ?? "default"
        }));
      } finally {
        releaseAdoptClaims(claims);
      }
      return {
        taskId: input.taskId,
        engine: "multica",
        ref: input.ref
      } satisfies AdoptMulticaTaskResult;
    })
  };
}

function acquireAdoptClaims(rootInput: HarnessLayoutInput, taskId: TaskId, ref: ExternalRef): ReadonlyArray<string> {
  const taskClaimPath = claimPath(rootInput, "task", taskId);
  const bindingClaimPath = claimPath(rootInput, "binding", `multica:${ref}`);
  const acquired: string[] = [];
  try {
    mkdirSync(path.dirname(taskClaimPath), { recursive: true });
    mkdirSync(path.dirname(bindingClaimPath), { recursive: true });
    mkdirSync(taskClaimPath, { recursive: false });
    acquired.push(taskClaimPath);
    mkdirSync(bindingClaimPath, { recursive: false });
    acquired.push(bindingClaimPath);
    return acquired;
  } catch {
    releaseAdoptClaims(acquired);
    throw new Error(`adopt claim already held: multica ${ref}`);
  }
}

function releaseAdoptClaims(claims: ReadonlyArray<string>): void {
  for (const claim of [...claims].reverse()) {
    rmSync(claim, { recursive: true, force: true });
  }
}

function mapMulticaIssue(raw: MulticaRawIssue, fetchedAt: Date): TaskSnapshot {
  const status = mapStatus(raw.status);
  return {
    canonicalStatus: status.canonicalStatus,
    rawStatus: raw.status,
    freshness: "fresh",
    fetchedAt: fetchedAt.toISOString(),
    staleReason: status.warning,
    source: "external-engine",
    engine: "multica",
    ref: raw.ref,
    url: raw.url,
    title: raw.title
  };
}

function mapStatus(rawStatus: string): { readonly canonicalStatus: TaskSnapshot["canonicalStatus"]; readonly warning?: string } {
  const normalized = rawStatus.toLowerCase().replace(/[_-]+/gu, " ").trim();
  if (/^(todo|to do|backlog|planned|open|new)$/u.test(normalized)) return { canonicalStatus: "planned" };
  if (/^(active|in progress|doing|started)$/u.test(normalized)) return { canonicalStatus: "active" };
  if (/blocked/u.test(normalized)) return { canonicalStatus: "blocked" };
  if (/review/u.test(normalized)) return { canonicalStatus: "in_review" };
  if (/^(done|completed|closed|resolved)$/u.test(normalized)) return { canonicalStatus: "done" };
  if (/^(cancelled|canceled|wont do|won't do)$/u.test(normalized)) return { canonicalStatus: "cancelled" };
  return { canonicalStatus: "unknown", warning: "status_unmapped" };
}

function makeMarkdownBindingIndex(rootInput: HarnessLayoutInput): BindingLookup {
  return {
    findBindingByExternalRef: (engine, ref) => Effect.sync(() => {
      return Option.fromNullable(findTaskIdByExternalRef(rootInput, engine, ref));
    })
  };
}

function writeTaskDocument(
  coordinator: WriteCoordinator,
  taskId: TaskId,
  body: string
): Effect.Effect<void, WriteError> {
  return Effect.gen(function* () {
    yield* writeCoordinatedPayload(coordinator, stableHash, {
      entityId: taskEntityId(taskId),
      kind: "doc_write",
      payload: {
        path: "INDEX.md",
        body
      },
      opIdPrefix: "multica-adopt"
    });
  });
}

function renderAdoptedIndex(input: {
  readonly taskId: TaskId;
  readonly ref: ExternalRef;
  readonly title: string;
  readonly url: string | null;
  readonly bindingCreatedAt: string;
  readonly vertical: string;
  readonly preset: string;
}): string {
  const bindingFingerprint = stableMulticaBindingFingerprint({
    engine: "multica",
    ref: input.ref,
    bindingCreatedAt: input.bindingCreatedAt
  });
  return [
    "---",
    "schema: task-package/v2",
    `task_id: ${input.taskId}`,
    `title: ${input.title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: multica",
    `  ref: ${input.ref}`,
    `  titleSnapshot: ${input.title}`,
    `  url: ${input.url ?? ""}`,
    `  bindingCreatedAt: ${input.bindingCreatedAt}`,
    `  bindingFingerprint: ${bindingFingerprint}`,
    "packageDisposition: active",
    `vertical: ${input.vertical}`,
    `preset: ${input.preset}`,
    "---",
    "",
    `# ${input.title}`,
    ""
  ].join("\n");
}

function validateTaskId(taskId: TaskId): void {
  validateTaskIdSyntax(taskId);
}

function taskIndexPath(rootInput: HarnessLayoutInput, taskId: TaskId): string {
  return taskDocumentPath(rootInput, taskId, "INDEX.md");
}

function claimPath(rootInput: HarnessLayoutInput, kind: "binding" | "task", key: string): string {
  return path.join(resolveHarnessLayout(rootInput).claimsRoot, kind, stableHash(key));
}

function stableHash(value: unknown): string {
  return stablePayloadHash(value);
}

export function stableMulticaBindingFingerprint(input: MulticaBindingFingerprintInput): `sha256:${string}` {
  return `sha256:${stableHash(input)}`;
}
