import { makePersonActionExplanationService } from "../person-action-explanation-service.ts";
import { makeSquadActionExplanationService } from "../squad-action-explanation-service.ts";
import { makeTaskActionExplanationService } from "../task-action-explanation-service.ts";
import {
  ENTITY_ACTION_EXPLANATION_SCHEMA,
  parseEntityRef,
  parseSquadDeclarationV1,
  projectBaseEntityAtCut,
  requireEntityTypeContract,
  validateEntityActionExplainRequest,
  validateEntityActionExplanationSet,
  type ActorIdentity,
  type BaseEntity,
  type AuthorizationDecision,
  type CompiledArtifactKindContract,
  type EntityActionContract,
  type EntityActionExplainRequestV1,
  type EntityActionExplanationFailureCode,
  type EntityActionExplanationSetV1,
  type EntityActionExplanationSubjectV1,
  type EntityRef,
  type TaskProjection,
  type WriteSource,
} from "@harness-anything/kernel";
import { readEffectiveCloseoutGates } from "./task-settings-read.ts";
import { readCompletionContext } from "./task-completion-read.ts";
import type { TaskCoreQueryPorts } from "./task-query-ports.ts";

export interface TaskActionExplanationBinding {
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly explanationDecisions?: ReadonlyMap<string, AuthorizationDecision>;
  readonly personExplanation?: {
    readonly existsIds: ReadonlySet<string>;
    readonly decisions: ReadonlyMap<string, AuthorizationDecision>;
  };
}

export interface TaskActionExplanationHost {
  readonly commandUsage: (action: EntityActionContract) => string;
  readonly artifactKinds: (projection: TaskProjection, repositoryId: string) => readonly CompiledArtifactKindContract[];
}

export interface TaskActionExplanationReadDependencies {
  readonly projection: TaskProjection;
  readonly binding?: TaskActionExplanationBinding;
  readonly rootDir: string;
  readonly repoId?: string;
  readonly now: () => string;
  readonly host: TaskActionExplanationHost;
  readonly ports?: TaskCoreQueryPorts;
}

export function explainAuthenticationRequired(): never {
  throw Object.assign(new Error("Entity Action explanation requires a daemon-authenticated actor binding."), {
    code: "authentication_required" as const,
  });
}

function requireTaskActionExplanationBinding(
  binding: TaskActionExplanationBinding | undefined,
): TaskActionExplanationBinding {
  return binding ?? explainAuthenticationRequired();
}

export function readTaskActionExplanation(
  dependencies: TaskActionExplanationReadDependencies,
  payload: Readonly<Record<string, unknown>>,
): EntityActionExplanationSetV1 {
  const binding = requireTaskActionExplanationBinding(dependencies.binding),
    issues = validateEntityActionExplainRequest(payload);
  if (issues.length > 0) throw invalidCommand(issues.join("; "));
  const request = payload as unknown as EntityActionExplainRequestV1;
  if (request.mode === "catalog")
    return catalogExplanation(request.entityKind ?? request.refs[0] ?? "task", binding, {
      projection: dependencies.projection,
      repositoryId: dependencies.rootDir,
      host: dependencies.host,
    });

  const headRevision = dependencies.projection.readCut().sourceRevision,
    cut = `canonical:${headRevision}`,
    evaluatedAt = dependencies.now(),
    taskService = makeTaskActionExplanationService({
      actor: binding.actor,
      authorize: ({ action, target, evaluatedAtCut }) =>
        binding.explanationDecisions?.get(`${target}:${action.id}`) ??
        missingExplanationDecision(binding, target, evaluatedAtCut),
      usage: dependencies.host.commandUsage,
    }),
    squadService = makeSquadActionExplanationService({
      actor: binding.actor,
      authorize: ({ action, target, evaluatedAtCut }) =>
        binding.explanationDecisions?.get(`${target}:${action.id}`) ??
        missingExplanationDecision(binding, target, evaluatedAtCut),
    }),
    personService = makePersonActionExplanationService({
      actor: binding.actor,
      authorize: ({ action, target, evaluatedAtCut }) =>
        binding.personExplanation?.decisions.get(`${target}:${action.id}`) ?? {
          policyRef: "authorization-provider@1",
          actor: binding.actor,
          subject: target,
          bindingsUsed: [],
          outcome: "denied",
          reasonCodes: ["keycloak_evaluation_missing"],
          nextActions: ["Retry the explanation after authorization is available."],
          evaluatedAtCut,
        },
    }),
    parsed = request.refs.map((ref) => ({ ref, parsed: parseEntityRef(ref) })),
    supported = parsed.filter(
      ({ parsed: entity }) =>
        entity !== null && !entity.externalHarness && (entity.kind === "task" || entity.kind === "squad"),
    ),
    cutRead = supported.length ? dependencies.projection.readCut() : null,
    projectionReady =
      cutRead !== null &&
      cutRead.status === "ready" &&
      cutRead.watermark === headRevision &&
      cutRead.sourceRevision === headRevision,
    installedAgentIds = new Set(
      parsed.some(({ parsed: entity }) => entity?.kind === "squad" && !entity.externalHarness) && projectionReady
        ? dependencies.projection.listEntities("agent").map(({ id }) => id)
        : [],
    ),
    /** Same-cut witness for one entity revision: an indexed event page of one,
     * not a Map over the whole ledger. */
    witnessAt = (revision: number) => {
      if (!Number.isSafeInteger(revision) || revision < 1) return undefined;
      return dependencies.projection.readEventWitness(revision) ?? undefined;
    },
    cache = new Map<string, EntityActionExplanationSubjectV1>(),
    subjects = parsed.map(({ ref, parsed: entity }) => {
      const cached = cache.get(ref);
      if (cached) return cached;
      let subject: EntityActionExplanationSubjectV1;
      if (entity === null)
        subject = failure(null, null, "invalid_entity_ref", `Entity ref ${ref} is invalid.`, [
          "Use a registered EntityRef such as task/<task-id>, person/<person-id>, or squad/<squad-id>.",
        ]);
      else if (entity.externalHarness)
        subject = failure(
          entity.kind,
          entity.raw as EntityRef,
          "unsupported_explain_target",
          `External harness ref ${entity.raw} cannot be evaluated by this repository daemon.`,
          ["Route the explain request to the owning harness daemon."],
        );
      else if (entity.kind !== "task" && entity.kind !== "person" && entity.kind !== "squad")
        subject = failure(
          entity.kind,
          entity.raw as EntityRef,
          "unsupported_explain_target",
          `Entity Action explain currently supports Task, Person, and Squad targets; ${entity.raw} is ${entity.kind}.`,
          ["Use catalog mode to discover the supported Entity Action surfaces."],
        );
      else if (entity.kind === "person") {
        // Person identity is no longer projected from people.yaml. The only local witness we can
        // safely materialize is the daemon-authenticated principal itself; every other
        // person ref must fail closed instead of inventing a profile from authored content.
        if (!binding.personExplanation?.existsIds.has(entity.id))
          subject = failure(
            "person",
            entity.raw as EntityRef,
            "entity_not_found",
            `Person ${entity.id} was not found.`,
            ["Confirm the Person is provisioned with the configured identity provider, then retry the explanation."],
          );
        else {
          const entityWitness = projectBaseEntityAtCut<BaseEntity<"person">>(requireEntityTypeContract("person"), {
            kind: "person",
            id: entity.id,
            workspaceRevision: headRevision,
            occurredAt: evaluatedAt,
            actor: binding.actor,
            source: binding.source,
            pinned: false,
            disposition: "active",
          });
          subject = personService.object({ entity: entityWitness, evaluatedAtCut: cut, evaluatedAt }).subjects[0]!;
        }
      } else if (!projectionReady)
        subject = failure(
          entity.kind,
          entity.raw as EntityRef,
          "projection_pending",
          `${entity.kind === "task" ? "Task" : "Squad"} projection has not reached ${cut}.`,
          [`Retry after the ${entity.kind === "task" ? "Task" : "Squad"} projection reaches the canonical cut.`],
        );
      else if (entity.kind === "task") {
        // Point reads: the task exists check, its snapshot, and the witness at
        // its own revision — no full task list, no per-task lease sweep, no Map
        // over every canonical event.
        const row = dependencies.projection.readTaskExists(entity.id) ? dependencies.projection.read(entity.id) : null,
          task = row?.snapshot.task,
          event = row ? witnessAt(row.snapshot.revision) : undefined;
        if (!row)
          subject = failure("task", entity.raw as EntityRef, "entity_not_found", `Task ${entity.id} was not found.`, [
            "Run ha task list and choose an existing Task ref.",
          ]);
        else if (!event || !task)
          subject = failure(
            "task",
            entity.raw as EntityRef,
            "projection_pending",
            `Task ${entity.id} has no same-cut BaseEntity witness at ${cut}.`,
            ["Retry after the Task projection and canonical ledger witness agree."],
          );
        else {
          const lease = dependencies.projection.currentLease(entity.id, evaluatedAt),
            snapshot = { ...row.snapshot, lease: lease?.phase === "released" ? null : lease },
            entityWitness = projectBaseEntityAtCut<BaseEntity<"task">>(requireEntityTypeContract("task"), {
              kind: "task",
              id: entity.id,
              workspaceRevision: row.snapshot.revision,
              occurredAt: event.occurredAt,
              actor: event.actor,
              source: event.source,
              pinned: task.pinned,
              disposition: task.packageDisposition ?? "active",
            });
          subject = taskService.object({
            entity: entityWitness,
            snapshot,
            evaluatedAtCut: cut,
            closeoutGates: readEffectiveCloseoutGates(dependencies.projection, snapshot),
            completionContext: readCompletionContext(
              dependencies.projection,
              entity.id,
              snapshot,
              "ready",
              dependencies.rootDir,
              undefined,
              dependencies.ports,
            ),
          }).subjects[0]!;
        }
      } else {
        const row = dependencies.projection.getEntity("squad", entity.id),
          event = row ? witnessAt(row.workspaceRevision) : undefined;
        if (!row)
          subject = failure("squad", entity.raw as EntityRef, "entity_not_found", `Squad ${entity.id} was not found.`, [
            "Run ha squad list and choose an existing Squad ref.",
          ]);
        else if (!event)
          subject = failure(
            "squad",
            entity.raw as EntityRef,
            "projection_pending",
            `Squad ${entity.id} has no same-cut BaseEntity witness at ${cut}.`,
            ["Retry after the Squad projection and canonical ledger witness agree."],
          );
        else {
          const declaration = parseSquadDeclarationV1(row.value),
            entityWitness = projectBaseEntityAtCut<BaseEntity<"squad">>(requireEntityTypeContract("squad"), {
              kind: "squad",
              id: entity.id,
              workspaceRevision: row.workspaceRevision,
              occurredAt: event.occurredAt,
              actor: event.actor,
              source: event.source,
              pinned: false,
              disposition: "active",
            });
          subject = squadService.object({
            entity: entityWitness,
            declaration,
            installedAgentIds,
            evaluatedAtCut: cut,
          }).subjects[0]!;
        }
      }
      cache.set(ref, subject);
      return subject;
    }),
    result: EntityActionExplanationSetV1 = {
      schema: ENTITY_ACTION_EXPLANATION_SCHEMA.id,
      mode: subjects.some(({ failure: subjectFailure }) => subjectFailure !== null) ? "failure" : "object",
      subjects,
      evaluatedAtCut: cut,
    },
    resultIssues = validateEntityActionExplanationSet(result);
  if (resultIssues.length > 0) throw new Error(`Invalid daemon Entity Action explanation: ${resultIssues.join("; ")}`);
  return Object.freeze(result);
}

function missingExplanationDecision(
  binding: TaskActionExplanationBinding,
  target: EntityRef,
  evaluatedAtCut: string,
): AuthorizationDecision {
  return {
    policyRef: "authorization-provider@1",
    actor: binding.actor,
    subject: target,
    bindingsUsed: [],
    outcome: "denied",
    reasonCodes: ["keycloak_evaluation_missing"],
    nextActions: ["Retry the explanation after authorization is available."],
    evaluatedAtCut,
  };
}

function catalogExplanation(
  kind: string,
  binding: TaskActionExplanationBinding,
  vertical: {
    readonly projection: TaskProjection;
    readonly repositoryId: string;
    readonly host: TaskActionExplanationHost;
  },
): EntityActionExplanationSetV1 {
  const dependencies = {
    actor: binding.actor,
    authorize: () => {
      throw new Error("Catalog explanations do not evaluate authorization.");
    },
    usage: vertical.host.commandUsage,
  };
  if (kind === "task") return makeTaskActionExplanationService(dependencies).catalog();
  if (kind === "person") return makePersonActionExplanationService(dependencies).catalog();
  if (kind === "squad") return makeSquadActionExplanationService(dependencies).catalog();
  const artifact = vertical.host.artifactKinds(vertical.projection, vertical.repositoryId).find(
      ({ typeIdentity }) => typeIdentity === kind,
    ),
    catalog = artifact?.entityKindContract.actionCatalog;
  if (artifact && catalog) {
    const result: EntityActionExplanationSetV1 = {
        schema: ENTITY_ACTION_EXPLANATION_SCHEMA.id,
        mode: "catalog",
        subjects: [
          {
            kind,
            ref: null,
            revision: null,
            actions: catalog.actions.map((action) => ({
              action: {
                kind,
                id: action.id,
                catalogRef: catalog.ref,
                contractVersion: `${action.version.major}.${action.version.minor}`,
                explain: action.explain,
                syntax: {
                  usage: `ha entity import --kind ${kind} --locator <locator> --mode <reference|snapshot> --expected-version <revision>`,
                  inputs: action.input.fields,
                },
              },
              target: null,
              available: null,
              criteria: action.criteria.map((criterion) => ({
                ...criterion,
                status: "not-evaluated" as const,
                nextActions: [],
              })),
              unmetCriteria: [],
              authorizationDecision: null,
              nextActions: [],
              evaluatedAtCut: null,
            })),
            failure: null,
          },
        ],
        evaluatedAtCut: null,
      },
      issues = validateEntityActionExplanationSet(result);
    if (issues.length) throw new Error(`Invalid Artifact Action explanation: ${issues.join("; ")}`);
    return Object.freeze(result);
  }
  throw invalidCommand(`Entity Action catalog explain does not support ${kind}.`);
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
