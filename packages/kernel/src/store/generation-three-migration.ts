import { CODE_DOC_GATE_ID, type FrozenCompletionContract } from "../domain/completion-contract.ts";
import { validateCompletionGateWitnessV1 } from "../domain/completion-gate-witness.ts";
import { submissionDigest, submissionId, type ExecutionV1, type SubmissionV1 } from "../domain/execution.ts";
import { reviewDigest, type ReviewConsentV1, type ReviewV1 } from "../domain/review.ts";
import {
  compileTaskLifecycleWrite,
  lifecycleDocumentFetchPaths,
  type LifecycleContentBlob,
  type LifecycleDocumentState,
} from "../domain/task-lifecycle-publication.ts";
import type { TaskEventV1 } from "../domain/task-lifecycle-event.ts";
import { emptyTaskLifecycleSnapshot, type TaskLifecycleSnapshot } from "../domain/task-lifecycle.contract.ts";
import { isTaskEvent } from "../domain/doc-sync-canonical-events.ts";
import type { CanonicalEventV1 } from "../domain/doc-sync-types.ts";
import { sha256Bytes } from "../integrity/stable-hash.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import type { SqliteEventStore } from "./sqlite-event-store.ts";

export interface GenerationThreeRewrite {
  readonly event: CanonicalEventV1;
  readonly blobs: readonly LifecycleContentBlob[];
  readonly reasons: readonly string[];
}

/** Stateful revision-order rewrite for the one-time generation 2 → 3 cutover. */
export class GenerationThreeMigration {
  readonly #source: SqliteEventStore;
  readonly #submissions = new Map<string, SubmissionV1>();
  readonly #submissionGateIds = new Map<string, readonly string[]>();
  readonly #snapshots = new Map<string, TaskLifecycleSnapshot>();
  readonly #documents = new Map<string, LifecycleDocumentState>();
  readonly #packagePaths = new Map<string, string>();

  constructor(source: SqliteEventStore) {
    this.#source = source;
    // A submission's frozen contract must name every requirement that governed its cut — including
    // gates a mid-flight preset upgrade or contract migration attached after submit. Prepass the
    // stream once and union each old submission's gateIds over every event that embeds it.
    for (const row of source.eventRows?.() ?? []) {
      const parsed = JSON.parse(row.eventJson) as CanonicalEventV1;
      if (!isTaskEvent(parsed)) continue;
      const submission = (parsed.payload as { execution?: ExecutionV1 }).execution?.submission,
        gateIds = (parsed.payload as { task?: { completionGateIds?: unknown } }).task?.completionGateIds;
      if (!submission || !Array.isArray(gateIds)) continue;
      const id = submissionId(submission);
      this.#submissionGateIds.set(id, [
        ...new Set([
          ...(this.#submissionGateIds.get(id) ?? []),
          ...gateIds.filter((gateId): gateId is string => typeof gateId === "string"),
        ]),
      ]);
    }
  }

  rewrite(original: CanonicalEventV1): GenerationThreeRewrite {
    this.#captureDocuments(original);
    if (!isTaskEvent(original)) return { event: original, blobs: [], reasons: [] };
    this.#observePackagePath(original);
    const rewritten = this.#rewriteTaskEvent(original),
      changed = JSON.stringify(rewritten) !== JSON.stringify(original);
    if (!changed) {
      this.#project(rewritten);
      return { event: rewritten, blobs: [], reasons: [] };
    }
    const snapshot = this.#project(rewritten),
      packagePath = this.#packagePath(rewritten),
      documents = lifecycleDocumentFetchPaths(rewritten, packagePath).flatMap((path) => {
        const document = this.#documents.get(path);
        return document ? [document] : [];
      }),
      compiled = compileTaskLifecycleWrite({ event: rewritten, snapshot, packagePath, currentDocuments: documents });
    for (const blob of compiled.blobs)
      this.#documents.set(blobPath(compiled.event, blob.sha256), {
        path: blobPath(compiled.event, blob.sha256),
        body: blob.body,
        blobSha256: blob.sha256,
      });
    return {
      event: compiled.event,
      blobs: compiled.blobs,
      reasons: ["submission bindings and lifecycle machine documents migrated to generation 3"],
    };
  }

  invalidations(startRevision: number, occurredAt: string): readonly GenerationThreeRewrite[] {
    const rewrites: GenerationThreeRewrite[] = [];
    for (const [taskId, snapshot] of [...this.#snapshots].sort(([left], [right]) => left.localeCompare(right))) {
      // C8 closes only genuinely in-flight executions: replayed invalidation requires the task to
      // still sit in an active review loop. Terminal tasks and superseded tasks already returned to
      // planned keep their suspended historical execution untouched.
      if (!snapshot.task || !["active", "in_review", "blocked"].includes(snapshot.task.status)) continue;
      const execution = snapshot.executions.find(
        (candidate) =>
          candidate.schema === "execution/v1" &&
          candidate.iteration === snapshot.task!.iteration &&
          ["active", "submitted"].includes(candidate.state),
      );
      if (!execution || execution.schema !== "execution/v1") continue;
      const suffix = sha256Text(`${taskId}:${execution.executionId}:generation-migration`),
        event: TaskEventV1 = {
          schema: "task-event/v1",
          type: "execution_invalidated",
          eventId: `event-${suffix}`,
          opId: `migration-${suffix}`,
          workspaceRevision: startRevision + rewrites.length,
          taskId,
          actor: { principal: { personId: "migration-operator" }, executor: null },
          source: "migration-import/v1",
          occurredAt,
          payload: {
            task: {
              ...snapshot.task,
              status: "active",
              currentNode: "implementation",
              iteration: snapshot.task.iteration + 1,
            },
            execution: { ...execution, state: "abandoned", closedAt: occurredAt },
            reason: "generation-migration",
            releasedLease: snapshot.lease,
            documentClaims: [],
          },
        },
        next = this.#project(event),
        packagePath = this.#packagePath(event),
        documents = lifecycleDocumentFetchPaths(event, packagePath).flatMap((path) => {
          const document = this.#documents.get(path);
          return document ? [document] : [];
        }),
        compiled = compileTaskLifecycleWrite({ event, snapshot: next, packagePath, currentDocuments: documents });
      for (const blob of compiled.blobs)
        this.#documents.set(blobPath(compiled.event, blob.sha256), {
          path: blobPath(compiled.event, blob.sha256),
          body: blob.body,
          blobSha256: blob.sha256,
        });
      rewrites.push({
        event: compiled.event,
        blobs: compiled.blobs,
        reasons: ["in-flight execution invalidated for generation migration"],
      });
    }
    return rewrites;
  }

  #rewriteTaskEvent(event: TaskEventV1): TaskEventV1 {
    const payload = event.payload as TaskEventV1["payload"] & {
      readonly execution?: ExecutionV1;
      readonly review?: ReviewV1;
      readonly consent?: ReviewConsentV1;
      readonly supersedesSubmissionId?: string;
    };
    if (!payload.execution) return event;
    const oldSubmission = payload.execution.submission,
      submission = oldSubmission === null ? null : this.#submission(oldSubmission, payload.task.completionGateIds),
      execution = submission === oldSubmission ? payload.execution : { ...payload.execution, submission };
    let next: Record<string, unknown> = { ...payload, execution };
    if (payload.supersedesSubmissionId !== undefined) {
      const predecessor = this.#submissions.get(payload.supersedesSubmissionId);
      if (!predecessor) throw new Error(`missing migrated predecessor ${payload.supersedesSubmissionId}`);
      next = { ...next, supersedesSubmissionId: submissionId(predecessor) };
    }
    if (payload.review !== undefined) {
      if (!submission) throw new Error(`review ${payload.review.reviewId} has no submitted execution`);
      const review = { ...payload.review, submissionDigest: submissionDigest(submission) };
      next = { ...next, review };
      if (payload.consent !== undefined)
        next = {
          ...next,
          consent: {
            ...payload.consent,
            reviewDigest: reviewDigest(review),
            submissionDigest: submissionDigest(submission),
          },
        };
    }
    if (event.type === "completion_gate_verified" && submission) {
      const witness = event.payload.witness as unknown as Readonly<Record<string, unknown>>,
        { observed, basis, provenance, override, ...identity } = witness;
      let evidence: unknown;
      if (basis === undefined && provenance === undefined)
        evidence = { kind: "historical-verdict", gap: "binding-not-recorded" };
      else if (basis === undefined || provenance === undefined)
        throw new Error(`witness ${witness.witnessId} carries a partial evidence binding`);
      else {
        const rePinned = { ...(basis as Record<string, unknown>), submissionDigest: submissionDigest(submission) },
          legacyProvenance = provenance as Record<string, unknown>;
        evidence = Object.hasOwn(legacyProvenance, "adapterId")
          ? {
              kind: "observed",
              observed: observed ?? true,
              basis: rePinned,
              provenance: legacyProvenance,
              ...(override !== undefined ? { override } : {}),
            }
          : {
              kind: "historical-verdict",
              gap: "adapter-not-recorded",
              basis: rePinned,
              provenance: {
                source: legacyProvenance.source,
                runId: legacyProvenance.runId,
                rawResult: legacyProvenance.rawResult,
              },
            };
      }
      const migratedWitness = { ...identity, evidence },
        witnessIssues = validateCompletionGateWitnessV1(migratedWitness);
      if (witnessIssues.length)
        throw new Error(
          `witness ${String(witness.witnessId)} cannot be migrated: ${witnessIssues.map((issue) => issue.message).join("; ")}`,
        );
      next = { ...next, witness: migratedWitness };
    }
    return { ...event, payload: next } as TaskEventV1;
  }

  #submission(value: SubmissionV1, gateIds: readonly string[]): SubmissionV1 {
    const oldId = submissionId(value);
    const existing = this.#submissions.get(oldId);
    if (existing) return existing;
    // A generation-2 submission cannot already carry a completion contract: the frozen contract is
    // the generation-3 feature. Anything present here is an unsupported input, never a shape to guess.
    if (Object.hasOwn(value, "completionContract"))
      throw new Error("generation-2 submission carries a completion contract; refusing to reinterpret it");
    const migrated = {
      ...value,
      completionContract: this.#completionContract(this.#submissionGateIds.get(oldId) ?? gateIds),
    };
    this.#submissions.set(oldId, migrated);
    return migrated;
  }

  /**
   * Materialize the declared gates into the frozen contract (dec_ED8A4E774FA7A96820D32D171D):
   * code-doc reconciliation is Harness's internal checker and keeps its adapter requirement;
   * every other declared gate was witnessed before frozen policy existed, so it becomes the
   * read-only `historical-policy-unavailable` requirement — the historical adapter identity is
   * not recorded anywhere and is never guessed from the gate id.
   */
  #completionContract(gateIds: readonly string[]): FrozenCompletionContract {
    const gates: FrozenCompletionContract["gates"][number][] = [];
    for (const gateId of new Set(gateIds))
      gates.push(
        gateId === CODE_DOC_GATE_ID
          ? {
              gateId,
              appliesTo: "code" as const,
              witness: { kind: "adapter" as const, adapterId: CODE_DOC_GATE_ID, adapterOptions: {} },
            }
          : {
              gateId,
              appliesTo: "code" as const,
              witness: { kind: "historical-policy-unavailable" as const, reason: "not-recorded" as const },
            },
      );
    return { gates };
  }

  #project(event: TaskEventV1): TaskLifecycleSnapshot {
    const previous = this.#snapshots.get(event.taskId) ?? emptyTaskLifecycleSnapshot(event.workspaceRevision - 1),
      payload = event.payload as TaskEventV1["payload"] & {
        readonly execution?: ExecutionV1;
        readonly review?: ReviewV1;
        readonly consent?: ReviewConsentV1;
        readonly witness?: unknown;
        readonly lease?: TaskLifecycleSnapshot["lease"];
        readonly edge?: TaskLifecycleSnapshot["edgesTaken"][number];
      },
      executions = payload.execution
        ? [
            ...previous.executions.filter((candidate) => candidate.executionId !== payload.execution!.executionId),
            payload.execution,
          ]
        : previous.executions;
    const snapshot: TaskLifecycleSnapshot = {
      ...previous,
      revision: event.workspaceRevision,
      task: payload.task,
      executions,
      reviews: payload.review ? [...previous.reviews, payload.review] : previous.reviews,
      consents: payload.consent ? [...previous.consents, payload.consent] : previous.consents,
      edgesTaken: payload.edge ? [...previous.edgesTaken, payload.edge] : previous.edgesTaken,
      lease:
        event.type === "execution_started" || event.type === "lease_renewed"
          ? (payload.lease ?? null)
          : ["execution_submitted", "review_recorded", "lease_released", "execution_invalidated"].includes(event.type)
            ? null
            : previous.lease,
      codeDocWitnesses:
        event.type === "code_doc_reconciled"
          ? [...previous.codeDocWitnesses, event.payload.witness]
          : event.type === "code_doc_repointed"
            ? [...previous.codeDocWitnesses, event.payload.record]
            : previous.codeDocWitnesses,
      gateWitnesses:
        event.type === "completion_gate_verified"
          ? [...previous.gateWitnesses, event.payload.witness]
          : previous.gateWitnesses,
    };
    this.#snapshots.set(event.taskId, snapshot);
    return snapshot;
  }

  #captureDocuments(event: CanonicalEventV1): void {
    const payload = event.payload as Record<string, unknown>,
      candidates = [payload.initialDocumentClaims, payload.documentClaims].filter(Array.isArray).flat();
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      const claim = candidate as { readonly path?: unknown; readonly sha256?: unknown; readonly size?: unknown };
      if (typeof claim.path !== "string" || typeof claim.sha256 !== "string" || typeof claim.size !== "number")
        continue;
      const bytes = this.#source.readContentObject(claim.sha256);
      if (!bytes || bytes.byteLength !== claim.size || sha256Bytes(bytes) !== claim.sha256) continue;
      this.#documents.set(claim.path, {
        path: claim.path,
        body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        blobSha256: claim.sha256,
      });
    }
  }

  #packagePath(event: TaskEventV1): string {
    const existing = this.#packagePaths.get(event.taskId);
    if (existing) return existing;
    const index = event.payload.documentClaims?.find((claim) => claim.path.endsWith("/INDEX.md"));
    if (!index) throw new Error(`task ${event.taskId} has no package path at migrated cut`);
    const packagePath = index.path.slice(0, -"/INDEX.md".length);
    this.#packagePaths.set(event.taskId, packagePath);
    return packagePath;
  }

  #observePackagePath(event: TaskEventV1): void {
    if (this.#packagePaths.has(event.taskId)) return;
    const index = event.payload.documentClaims?.find((claim) => claim.path.endsWith("/INDEX.md"));
    if (index) this.#packagePaths.set(event.taskId, index.path.slice(0, -"/INDEX.md".length));
  }
}

function blobPath(event: TaskEventV1, digest: string): string {
  const claim = event.payload.documentClaims?.find((candidate) => candidate.sha256 === digest);
  if (!claim) throw new Error(`compiled lifecycle blob ${digest} has no document claim`);
  return claim.path;
}
