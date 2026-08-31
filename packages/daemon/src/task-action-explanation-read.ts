import { makeTaskActionExplanationService } from "../../application/src/task-action-explanation-service.ts";
import {
  ENTITY_ACTION_EXPLANATION_SCHEMA,
  parseEntityRef,
  projectBaseEntityAtCut,
  requireEntityTypeContract,
  validateEntityActionExplanationSet,
  type CanonicalEventStore,
  type BaseEntity,
  type EntityActionExplanationFailureCode,
  type EntityActionExplanationSetV1,
  type EntityActionExplanationSubjectV1,
  type EntityRef,
  type TaskProjection,
} from "../../kernel/src/index.ts";
import { validateEntityActionExplainRequest } from "./protocol/daemon-protocol-rpc-validation.ts";
import { authorizeRepoCellAction } from "./repo-cell-authorization.ts";
import type { RepoCellBinding } from "./repo-cell-types.ts";

export interface TaskActionExplanationReadDependencies {
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly binding?: RepoCellBinding;
  readonly now: () => string;
}

export function explainAuthenticationRequired(): never {
  throw Object.assign(new Error("Entity Action explanation requires a daemon-authenticated actor binding."), {
    code: "authentication_required" as const,
  });
}

function requireTaskActionExplanationBinding(binding: RepoCellBinding | undefined): RepoCellBinding {
  return binding ?? explainAuthenticationRequired();
}

export function readTaskActionExplanation(
  dependencies: TaskActionExplanationReadDependencies,
  payload: Readonly<Record<string, unknown>>,
): EntityActionExplanationSetV1 {
  const binding = requireTaskActionExplanationBinding(dependencies.binding);
  const issues = validateEntityActionExplainRequest(payload);
  if (issues.length > 0) throw invalidCommand(issues.join("; "));
  const request = payload as unknown as { readonly mode: "object" | "catalog"; readonly refs: readonly string[] };
  if (request.mode === "catalog")
    return makeTaskActionExplanationService({
      actor: binding.actor,
      authorize: () => {
        throw new Error("Catalog explanations do not evaluate authorization.");
      },
    }).catalog();

  const stream = dependencies.store.read(),
    cut = `canonical:${stream.revision}`,
    evaluatedAt = dependencies.now(),
    service = makeTaskActionExplanationService({
      actor: binding.actor,
      authorize: ({ action, target, evaluatedAtCut }) => {
        const ingress = action.execution?.ingress;
        if (!ingress) throw new Error(`Task Action ${action.id} has no executable ingress.`);
        return authorizeRepoCellAction({
          action: { kind: ingress, taskId: target.slice("task/".length) },
          binding,
          actionId: `explain:${evaluatedAtCut}:${target}:${action.id}`,
          revision: stream.revision,
          now: evaluatedAt,
        });
      },
    }),
    parsed = request.refs.map((ref) => ({ ref, parsed: parseEntityRef(ref) })),
    needsTaskProjection = parsed.some(
      ({ parsed: entity }) => entity !== null && !entity.externalHarness && entity.kind === "task",
    ),
    projection = needsTaskProjection ? dependencies.projection.list() : null,
    projectionReady =
      projection !== null &&
      projection.status === "ready" &&
      projection.watermark === stream.revision &&
      projection.sourceRevision === stream.revision,
    taskRows = new Map(projection?.rows.map((row) => [row.taskId, row]) ?? []),
    effectiveLeaseByTask = new Map(
      projection?.rows.map((row) => {
        const lease = dependencies.projection.currentLease(row.taskId, evaluatedAt);
        return [row.taskId, lease?.phase === "released" ? null : lease] as const;
      }) ?? [],
    ),
    witnessByRevision = new Map(stream.events.map((event) => [event.workspaceRevision, event])),
    cache = new Map<string, EntityActionExplanationSubjectV1>(),
    subjects = parsed.map(({ ref, parsed: entity }) => {
      const cached = cache.get(ref);
      if (cached) return cached;
      let subject: EntityActionExplanationSubjectV1;
      if (entity === null)
        subject = failure(null, null, "invalid_entity_ref", `Entity ref ${ref} is invalid.`, [
          "Use a registered EntityRef such as task/<task-id>.",
        ]);
      else if (entity.externalHarness)
        subject = failure(
          entity.kind,
          entity.raw as EntityRef,
          "unsupported_explain_target",
          `External harness ref ${entity.raw} cannot be evaluated by this repository daemon.`,
          ["Route the explain request to the owning harness daemon."],
        );
      else if (entity.kind !== "task")
        subject = failure(
          entity.kind,
          entity.raw as EntityRef,
          "unsupported_explain_target",
          `Entity Action explain currently supports Task targets; ${entity.raw} is ${entity.kind}.`,
          ["Use catalog mode to discover the supported Task action surface."],
        );
      else if (!projectionReady)
        subject = failure(
          "task",
          entity.raw as EntityRef,
          "projection_pending",
          `Task projection has not reached ${cut}.`,
          ["Retry after the Task projection reaches the canonical cut."],
        );
      else {
        const row = taskRows.get(entity.id);
        if (!row)
          subject = failure("task", entity.raw as EntityRef, "entity_not_found", `Task ${entity.id} was not found.`, [
            "Run ha task list and choose an existing Task ref.",
          ]);
        else {
          const event = witnessByRevision.get(row.workspaceRevision),
            task = row.snapshot.task;
          if (!event || !task || row.snapshot.revision !== row.workspaceRevision)
            subject = failure(
              "task",
              entity.raw as EntityRef,
              "projection_pending",
              `Task ${entity.id} has no same-cut BaseEntity witness at ${cut}.`,
              ["Retry after the Task projection and canonical ledger witness agree."],
            );
          else {
            const snapshot = { ...row.snapshot, lease: effectiveLeaseByTask.get(entity.id) ?? null },
              entityWitness = projectBaseEntityAtCut<BaseEntity<"task">>(requireEntityTypeContract("task"), {
                kind: "task",
                id: entity.id,
                workspaceRevision: row.workspaceRevision,
                occurredAt: event.occurredAt,
                actor: event.actor,
                source: event.source,
                pinned: task.pinned,
                disposition: task.packageDisposition ?? "active",
              }),
              explained = service.object({ entity: entityWitness, snapshot, evaluatedAtCut: cut });
            subject = explained.subjects[0]!;
          }
        }
      }
      cache.set(ref, subject);
      return subject;
    }),
    result: EntityActionExplanationSetV1 = {
      schema: ENTITY_ACTION_EXPLANATION_SCHEMA.id,
      mode: subjects.some(({ failure }) => failure !== null) ? "failure" : "object",
      subjects,
      evaluatedAtCut: cut,
    },
    resultIssues = validateEntityActionExplanationSet(result);
  if (resultIssues.length > 0) throw new Error(`Invalid daemon Entity Action explanation: ${resultIssues.join("; ")}`);
  return Object.freeze(result);
}

function failure(
  kind: string | null,
  ref: EntityRef | null,
  code: EntityActionExplanationFailureCode,
  message: string,
  nextActions: readonly string[],
): EntityActionExplanationSubjectV1 {
  return Object.freeze({
    kind,
    ref,
    revision: null,
    actions: Object.freeze([]),
    failure: Object.freeze({ code, message, nextActions: Object.freeze(nextActions) }),
  });
}

function invalidCommand(message: string): Error & { readonly code: "invalid_command" } {
  return Object.assign(new Error(message), { code: "invalid_command" as const });
}
