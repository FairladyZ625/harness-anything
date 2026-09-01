import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { makePersonActionExplanationService, makeTaskActionExplanationService } from "../../application/src/index.ts";
import {
  ENTITY_ACTION_EXPLANATION_SCHEMA,
  consumeKnownError,
  isPeopleEvent,
  parsePeopleRosterDocument,
  parseEntityRef,
  validateEntityActionExplainRequest,
  projectBaseEntityAtCut,
  requireEntityTypeContract,
  resolveHarnessLayout,
  validateEntityActionExplanationSet,
  type CanonicalEventStore,
  type BaseEntity,
  type EntityActionExplainRequestV1,
  type EntityActionContract,
  type EntityActionExplanationFailureCode,
  type EntityActionExplanationSetV1,
  type EntityActionExplanationSubjectV1,
  type EntityRef,
  type PeopleRosterDocumentV1,
  type TaskProjection,
} from "../../kernel/src/index.ts";
import { authorizeRepoCellAction } from "./repo-cell-authorization.ts";
import type { RepoCellBinding } from "./repo-cell-types.ts";

export interface TaskActionExplanationReadDependencies {
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly binding?: RepoCellBinding;
  readonly rootDir: string;
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
  const request = payload as unknown as EntityActionExplainRequestV1;
  if (request.mode === "catalog") {
    const kind = request.refs[0] ?? "task",
      dependencies = {
        actor: binding.actor,
        authorize: () => {
          throw new Error("Catalog explanations do not evaluate authorization.");
        },
      };
    return kind === "person"
      ? makePersonActionExplanationService(dependencies).catalog()
      : makeTaskActionExplanationService(dependencies).catalog();
  }

  const stream = dependencies.store.read(),
    cut = `canonical:${stream.revision}`,
    evaluatedAt = dependencies.now(),
    authorize = ({
      action,
      target,
      evaluatedAtCut,
    }: {
      readonly action: EntityActionContract;
      readonly target: EntityRef;
      readonly evaluatedAtCut: string;
    }) => {
      const ingress = action.execution?.ingress;
      if (!ingress) throw new Error(`${action.target.kind} Action ${action.id} has no executable ingress.`);
      const targetId = target.slice(`${action.target.kind}/`.length);
      return authorizeRepoCellAction({
        action: {
          kind: ingress,
          ...(action.target.kind === "task" ? { taskId: targetId } : { personId: targetId }),
        },
        binding,
        actionId: `explain:${evaluatedAtCut}:${target}:${action.id}`,
        revision: stream.revision,
        now: evaluatedAt,
        targetOverride: target,
      });
    },
    service = makeTaskActionExplanationService({
      actor: binding.actor,
      authorize,
    }),
    personService = makePersonActionExplanationService({ actor: binding.actor, authorize }),
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
    personCut = parsed.some(({ parsed: entity }) => entity?.kind === "person" && !entity.externalHarness)
      ? personRosterAtCut(dependencies.rootDir, stream.events, stream.revision, binding, evaluatedAt)
      : null,
    cache = new Map<string, EntityActionExplanationSubjectV1>(),
    subjects = parsed.map(({ ref, parsed: entity }) => {
      const cached = cache.get(ref);
      if (cached) return cached;
      let subject: EntityActionExplanationSubjectV1;
      if (entity === null)
        subject = failure(null, null, "invalid_entity_ref", `Entity ref ${ref} is invalid.`, [
          "Use a registered EntityRef such as task/<task-id> or person/<person-id>.",
        ]);
      else if (entity.externalHarness)
        subject = failure(
          entity.kind,
          entity.raw as EntityRef,
          "unsupported_explain_target",
          `External harness ref ${entity.raw} cannot be evaluated by this repository daemon.`,
          ["Route the explain request to the owning harness daemon."],
        );
      else if (entity.kind !== "task" && entity.kind !== "person")
        subject = failure(
          entity.kind,
          entity.raw as EntityRef,
          "unsupported_explain_target",
          `Entity Action explain currently supports Task and Person targets; ${entity.raw} is ${entity.kind}.`,
          ["Use catalog mode to discover the supported Entity Action surfaces."],
        );
      else if (entity.kind === "person") {
        const person = personCut?.roster.people.find(({ personId }) => personId === entity.id);
        if (!personCut)
          subject = failure(
            "person",
            entity.raw as EntityRef,
            "projection_pending",
            `The authoritative People roster has no readable witness at ${cut}.`,
            ["Restore people.yaml or retry after the canonical People event settles."],
          );
        else if (!person)
          subject = failure(
            "person",
            entity.raw as EntityRef,
            "entity_not_found",
            `Person ${entity.id} was not found.`,
            ["Choose an existing Person identity from people.yaml."],
          );
        else {
          const entityWitness = projectBaseEntityAtCut<BaseEntity<"person">>(requireEntityTypeContract("person"), {
              kind: "person",
              id: entity.id,
              workspaceRevision: personCut.revision,
              occurredAt: personCut.occurredAt,
              actor: personCut.actor,
              source: personCut.source,
              pinned: false,
              disposition: "active",
            }),
            explained = personService.object({
              entity: entityWitness,
              roster: personCut.roster,
              evaluatedAtCut: cut,
              evaluatedAt,
            });
          subject = explained.subjects[0]!;
        }
      } else if (!projectionReady)
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

function personRosterAtCut(
  rootDir: string,
  events: ReturnType<CanonicalEventStore["read"]>["events"],
  streamRevision: number,
  binding: RepoCellBinding,
  evaluatedAt: string,
): {
  readonly roster: PeopleRosterDocumentV1;
  readonly revision: number;
  readonly occurredAt: string;
  readonly actor: RepoCellBinding["actor"];
  readonly source: RepoCellBinding["source"];
} | null {
  const peopleEvent = events.filter(isPeopleEvent).at(-1);
  if (peopleEvent)
    return {
      roster: peopleEvent.payload.roster,
      revision: peopleEvent.workspaceRevision,
      occurredAt: peopleEvent.occurredAt,
      actor: peopleEvent.actor,
      source: peopleEvent.source,
    };
  const rosterPath = path.join(resolveHarnessLayout(rootDir).authoredRoot, "people.yaml");
  if (!existsSync(rosterPath) || streamRevision < 1) return null;
  try {
    return {
      roster: parsePeopleRosterDocument(readFileSync(rosterPath, "utf8")),
      revision: streamRevision,
      occurredAt: evaluatedAt,
      actor: binding.actor,
      source: binding.source,
    };
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
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
