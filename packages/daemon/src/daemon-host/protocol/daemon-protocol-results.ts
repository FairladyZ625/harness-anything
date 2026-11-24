import type { TaskDispatchesPayload } from "@harness-anything/application/queries";
import type { ActionExecutionClass } from "@harness-anything/kernel/internal/domain/action-declaration.ts";
import { actionExecutionClasses } from "@harness-anything/kernel/internal/domain/action-execution-class.generated.ts";
import type { DispatchAttemptOutcome } from "@harness-anything/kernel/internal/domain/dispatch-lifecycle.ts";
import type * as ProjectionStatus from "@harness-anything/kernel/internal/domain/task-read-set.ts";
import type { WriteReceiptOutcome } from "@harness-anything/kernel/internal/domain/write-receipt-status.ts";
import type { DaemonHomeOverviewResult } from "../home/home-overview-types.ts";
import type { TaskAssignmentDirectory, TaskClaimableResult } from "./daemon-protocol-schema-ids.ts";
export type { TaskAssignmentDirectory, TaskClaimableResult } from "./daemon-protocol-schema-ids.ts";
import type { DaemonTaskCompletionResult } from "./daemon-protocol-task-completion.ts";
import type { DaemonTaskDeliveryDiffResult } from "./daemon-protocol-task-delivery-diff.ts";
export type {
  DaemonTaskDeliveryDiffFile,
  DaemonTaskDeliveryDiffLine,
  DaemonTaskDeliveryDiffResult,
} from "./daemon-protocol-task-delivery-diff.ts";
import type { TaskDispatchRow } from "./task-dispatch-contract.ts";
export type { TaskDispatchRow } from "./task-dispatch-contract.ts";
import type {
  CanonicalEventV1,
  DaemonRepoMode,
  ProjectionPage,
  ReceiptDiagnostic,
  EntityActionExplanationSetV1,
  EntityKindCatalogV1,
  VerticalDefinition,
} from "@harness-anything/kernel";
import type { AgentEntityGuiRead, AgentSkillGuiRead } from "../agent-entities.ts";
export type { AgentDeclarationV1, AgentHostAccess, SquadDeclarationV1 } from "@harness-anything/kernel";
import type {
  AgentRuntimeEventsResult,
  AgentRuntimeOverviewResult,
  AgentRuntimeSessionGroupDto,
  AgentRuntimeSessionResult,
} from "../agent-runtime-contract.ts";
import type {
  AgentRuntimeTokenUsageDetailResult,
  AgentRuntimeTokenUsageRange,
  AgentRuntimeTokenUsageResult,
} from "../agent-runtime-token-usage.ts";
import type {
  DaemonUseCaseProjectionPayload,
  DaemonUseCaseProjectionResult,
} from "./daemon-protocol-use-case-projection.ts";
import type { AgentRuntimeAttachResult } from "../agent-runtime-stream.ts";
import type { SquadRunReadResult, SquadRunsListResult } from "../squad-run-contract.ts";
import type { ArtifactsListResult } from "./artifacts-contract.ts";
import type { DaemonTaskRuntimeContextResult } from "./daemon-protocol-runtime-context.ts";
import type { daemonActionRoutes } from "./daemon-protocol-action-routes.ts";
import type { ReplicaSyncProgress } from "@harness-anything/kernel/internal/domain/query-payload-validation.ts";
import { isJsonObject, unknownFieldViolation, type JsonObject } from "./json-rpc-types.ts";
export type {
  AgendaAnsweredRow,
  AgendaAwaitsRow,
  AgendaDecisionReviewRow,
  AgendaDecisionRow,
  AgendaExecutionRow,
  AgendaPinnedEntityRow,
  AgendaRestartRow,
  AgendaRulingRow,
  AgendaTaskRow,
  AgendaWorkRef,
  DaemonAgendaResult,
  DaemonDecisionFullRow,
  DaemonDecisionListPayload,
  DaemonDecisionListResult,
  DaemonDecisionReviewDispatchRow,
  DaemonDecisionSummaryRow,
  DaemonFactSummaryRow,
  DaemonRelationEdgeFacetPayload,
  DaemonRelationGraphEdgeRow,
  DaemonRelationGraphFacet,
  DaemonRelationGraphFacetPayload,
  DaemonRelationGraphFacetResult,
  DaemonRelationGraphFullResult,
  DaemonRelationGraphResult,
  DaemonTaskDocumentListResult,
  DaemonTaskSnapshotInvalidRow,
  DaemonTaskWipResult,
  DaemonWorkspaceSummaryResult,
  ExecutionEvidenceProjection,
  GuiSubmissionV1,
  TaskDocumentListEntryRow,
  TaskPlacementSupplement,
  TaskWorkspaceView,
} from "@harness-anything/application/internal/queries/task-query-types.ts";
export type { TaskDeliveryStage } from "@harness-anything/application/internal/queries/task-delivery-stage.ts";
export type { DaemonTaskSnapshotListResult } from "@harness-anything/application/internal/queries/task-query-types.ts";
export type { AgendaAttentionItem, AgendaRegionWeights } from "./daemon-protocol-agenda-attention.ts";

export type RuntimeStreamCursor = {
  readonly repoId: string;
  readonly streamKind: string;
  readonly streamEpoch: string;
  readonly seq: number;
};

export function isRuntimeStreamCursor(value: unknown): value is RuntimeStreamCursor {
  return (
    isJsonObject(value) &&
    Object.keys(value).length === 4 &&
    ["repoId", "streamKind", "streamEpoch", "seq"].every((field) => Object.hasOwn(value, field)) &&
    [value.repoId, value.streamKind, value.streamEpoch].every(
      (field) => typeof field === "string" && field.length > 0 && field.length <= 96,
    ) &&
    typeof value.seq === "number" &&
    Number.isSafeInteger(value.seq) &&
    value.seq >= 0
  );
}

export function declaredActionClass(kind: string): ActionExecutionClass | undefined {
  return Object.hasOwn(actionExecutionClasses, kind) ? actionExecutionClasses[kind] : undefined;
}

/** The payload codec is transport-owned. Write classification comes from the action declaration. */
export function actionRpc<const Id extends string, const Method extends string, const Kind extends string>(
  id: Id,
  method: Method,
  actionKind: Kind,
  payload: RpcShape,
  options: {
    readonly read?: true;
    readonly defaults?: Readonly<Record<string, unknown>>;
    readonly outputSchemaId?: string;
  } = {},
) {
  const declared = declaredActionClass(actionKind);
  if ((options.read && declared !== undefined && declared !== "repo-read") || (!options.read && !declared))
    throw new Error(`RPC ${method} has no matching action declaration for ${actionKind}.`);
  return {
    id,
    method,
    actionKind,
    phase: "W5-GUI-S3",
    requiresRepo: true as const,
    params: shape({ repo: shape({ repoId: "string" }), payload }),
    commandClass: options.read ? ("repo-read" as const) : declared!,
    ...(options.defaults === undefined ? {} : { actionDefaults: options.defaults }),
    ...(options.outputSchemaId === undefined ? {} : { outputSchemaId: options.outputSchemaId }),
  };
}

export type RpcEnumRule = {
  readonly values: readonly string[];
  readonly optional: boolean;
};

export type RpcShape = {
  readonly fields: Readonly<
    Record<
      string,
      | "string"
      | "number"
      | "number?"
      | "boolean?"
      | "string?"
      | "string-or-empty?"
      | "string-null?"
      | "json"
      | "json?"
      | "array"
      | "array?"
      | RpcEnumRule
      | RpcShape
    >
  >;
  readonly open?: boolean;
};

export const shape = <const Fields extends RpcShape["fields"]>(fields: Fields, open = false) => ({
  fields,
  open,
});

export const optionalEnum = <const Values extends readonly string[]>(values: Values) => ({
  values,
  optional: true as const,
});

export function validateShape(value: unknown, expected: RpcShape, prefix: string): string[] {
  if (!isJsonObject(value)) return [`${prefix} must be an object`];
  const errors: string[] = [],
    allowed = Object.keys(expected.fields);
  if (!expected.open)
    for (const field of Object.keys(value)) {
      const unknownField = unknownFieldViolation({ [field]: value[field] }, allowed);
      if (unknownField) errors.push(`${prefix} contains an ${unknownField}`);
    }
  for (const [field, rule] of Object.entries(expected.fields)) {
    const item = value[field],
      enumRule = "values" in Object(rule) ? (rule as RpcEnumRule) : null;
    if (
      ((rule === "string?" ||
        rule === "string-or-empty?" ||
        rule === "string-null?" ||
        rule === "json?" ||
        rule === "array?" ||
        rule === "boolean?" ||
        rule === "number?" ||
        enumRule?.optional) &&
        item === undefined) ||
      (rule === "string-null?" && item === null)
    )
      continue;
    if (enumRule) {
      if (!enumRule.values.includes(String(item)))
        errors.push(`${prefix}.${field} must be one of ${enumRule.values.join(", ")}`);
    } else if (rule === "json" || rule === "json?") {
      if (!isJsonObject(item)) errors.push(`${prefix}.${field} must be object`);
    } else if (rule === "array" || rule === "array?") {
      if (!Array.isArray(item)) errors.push(`${prefix}.${field} must be array`);
    } else if (
      rule === "string" ||
      rule === "string?" ||
      rule === "string-or-empty?" ||
      rule === "string-null?" ||
      rule === "number" ||
      rule === "number?" ||
      rule === "boolean?"
    ) {
      const type = rule.startsWith("string") ? "string" : rule === "boolean?" ? "boolean" : "number";
      if (typeof item !== type || (type === "string" && rule !== "string-or-empty?" && !item))
        errors.push(`${prefix}.${field} must be ${type}`);
    } else errors.push(...validateShape(item, rule as RpcShape, `${prefix}.${field}`));
  }
  return errors;
}

export const observeTailKinds = ["events", "repo-log", "daemon-log", "lifecycle", "dispatch"] as const;
export type ObserveTailKind = (typeof observeTailKinds)[number];
export const observeTailDirections = ["history", "follow"] as const;
export type ObserveTailDirection = (typeof observeTailDirections)[number];

export type ObserveTailCursor =
  | { readonly kind: "events"; readonly revision: number }
  | { readonly kind: "repo-log"; readonly fileId: string; readonly offset: number }
  | { readonly kind: "daemon-log"; readonly fileId: string; readonly offset: number }
  | { readonly kind: "lifecycle"; readonly fileId: string; readonly offset: number }
  | { readonly kind: "dispatch"; readonly fileId: string; readonly offset: number };

type ObserveTailRequestFor<K extends ObserveTailKind> =
  | {
      readonly kind: K;
      readonly direction: "history";
      readonly cursor?: Extract<ObserveTailCursor, { readonly kind: K }>;
    }
  | {
      readonly kind: K;
      readonly direction: "follow";
      readonly cursor: Extract<ObserveTailCursor, { readonly kind: K }>;
    };

export type ObserveTailPayload =
  | (ObserveTailRequestFor<"events"> & {
      /**
       * Opt into the fleet overview's header-only event projection. Default event tails keep the
       * canonical summary; this narrows one aggregate read without changing the shared tail.
       */
      readonly fields?: "fleet";
      readonly scopePersonId?: string;
      readonly filterNodeId?: string;
    })
  | ObserveTailRequestFor<"repo-log">
  | ObserveTailRequestFor<"daemon-log">
  | ObserveTailRequestFor<"lifecycle">
  | (ObserveTailRequestFor<"dispatch"> & { readonly dispatchId: string });

type ObserveTailBase = {
  /** In-process fleet activity request, unavailable on the public observe.tail payload. */
  readonly fleetActivity?: readonly import("@harness-anything/kernel/internal/domain/canonical-event-summary.ts").FleetNodeActivity[];
  readonly schema: "daemon.observe-tail/v3";
  readonly ok: true;
  readonly repoId: string;
  readonly mode: DaemonRepoMode;
  readonly kind: ObserveTailKind;
  readonly direction: ObserveTailDirection;
  readonly items: readonly (CanonicalEventV1 | Readonly<Record<string, unknown>>)[];
  /** Exclusive upper boundary for the next older history page. */
  readonly historyCursor: ObserveTailCursor | null;
  /** Last record included by the initial history page or a forward follow page. */
  readonly liveCursor: ObserveTailCursor | null;
  /** Current end of the retained source snapshot; it may be ahead of liveCursor while pending. */
  readonly sourceCursor: ObserveTailCursor | null;
  /** history: no older retained records; follow: liveCursor has reached sourceCursor. */
  readonly done: boolean;
};

export type ObserveTailResult =
  | (ObserveTailBase & { readonly status: ProjectionStatus.ReadSetProjectionCut["status"] })
  | (ObserveTailBase & {
      readonly status: "unavailable";
      readonly unavailable: {
        readonly reason: "edge-mirror-has-no-events" | "center-request-log-not-wired";
        readonly centerRevision: number | null;
      };
    })
  | (ObserveTailBase & {
      readonly status: "gap";
      readonly gap: {
        readonly reason: "cursor-file-not-retained" | "cursor-offset-out-of-range";
        readonly requestedFileId: string;
      };
    });

export function validateObserveTailPayload(value: unknown): readonly string[] {
  if (!isJsonObject(value)) return ["observe tail payload must be an object"];
  if (
    Object.keys(value).some(
      (key) => !["kind", "direction", "cursor", "dispatchId", "fields", "scopePersonId", "filterNodeId"].includes(key),
    )
  )
    return ["observe tail payload contains an unknown field"];
  if (value.fields !== undefined && (value.kind !== "events" || value.fields !== "fleet"))
    return ["observe tail fields is only valid as fleet on an events tail"];
  for (const field of ["scopePersonId", "filterNodeId"] as const) {
    const filter = value[field];
    if (
      filter !== undefined &&
      (value.kind !== "events" || value.fields !== undefined || typeof filter !== "string" || !filter.trim())
    )
      return [`observe tail ${field} requires a non-empty event filter`];
  }
  if (!observeTailKinds.includes(value.kind as ObserveTailKind)) return ["observe tail kind is invalid"];
  if (!observeTailDirections.includes(value.direction as ObserveTailDirection))
    return ["observe tail direction is invalid"];
  if (value.kind === "dispatch") {
    if (typeof value.dispatchId !== "string" || !/^dispatch_[a-f0-9]{24}$/u.test(value.dispatchId))
      return ["observe tail dispatch id is invalid"];
  } else if (value.dispatchId !== undefined) return ["observe tail dispatch id is only valid for dispatch tails"];
  if (value.cursor === undefined)
    return value.direction === "history" ? [] : ["observe tail follow request requires a cursor"];
  return validateObserveTailCursor(value.cursor, value.kind as ObserveTailKind)
    ? []
    : ["observe tail cursor is invalid for the requested kind"];
}

export function validateObserveTailResult(value: unknown): readonly string[] {
  if (
    !isJsonObject(value) ||
    value.schema !== "daemon.observe-tail/v3" ||
    value.ok !== true ||
    typeof value.repoId !== "string" ||
    !value.repoId ||
    !["local", "remote-center", "remote-edge"].includes(String(value.mode)) ||
    !observeTailKinds.includes(value.kind as ObserveTailKind) ||
    !observeTailDirections.includes(value.direction as ObserveTailDirection) ||
    !["ready", "pending", "unavailable", "gap"].includes(String(value.status)) ||
    !Array.isArray(value.items) ||
    value.items.length > 64 ||
    value.items.some((item) => !isJsonObject(item)) ||
    typeof value.done !== "boolean" ||
    !nullableObserveCursor(value.historyCursor, value.kind as ObserveTailKind) ||
    !nullableObserveCursor(value.liveCursor, value.kind as ObserveTailKind) ||
    !nullableObserveCursor(value.sourceCursor, value.kind as ObserveTailKind)
  )
    return ["daemon observe tail result is invalid"];
  return observeTailStatusValidators[String(value.status)]?.(value) === true
    ? []
    : ["daemon observe tail status result is invalid"];
}

export function validateObserveTailCursor(value: unknown, kind: ObserveTailKind): value is ObserveTailCursor {
  if (!isJsonObject(value) || value.kind !== kind) return false;
  if (kind === "events") return Object.keys(value).length === 2 && nonNegativeInteger(value.revision);
  return (
    Object.keys(value).length === 3 &&
    typeof value.fileId === "string" &&
    value.fileId.length > 0 &&
    nonNegativeInteger(value.offset)
  );
}

function nullableObserveCursor(value: unknown, kind: ObserveTailKind): boolean {
  return value === null || validateObserveTailCursor(value, kind);
}

const observeTailBaseFields = [
  "schema",
  "ok",
  "repoId",
  "mode",
  "kind",
  "direction",
  "status",
  "items",
  "historyCursor",
  "liveCursor",
  "sourceCursor",
  "done",
] as const;

function exactObserveResultFields(value: Readonly<Record<string, unknown>>, extra: readonly string[] = []): boolean {
  const allowed = new Set<string>([...observeTailBaseFields, ...extra]);
  return Object.keys(value).every((key) => allowed.has(key));
}

function availableObserveTailResult(value: JsonObject): boolean {
  return (
    exactObserveResultFields(value) &&
    (value.kind !== "events" || (value.liveCursor !== null && value.sourceCursor !== null))
  );
}

const observeTailStatusValidators: Readonly<Record<string, (value: JsonObject) => boolean>> = {
  ready: availableObserveTailResult,
  pending: (value) => availableObserveTailResult(value) && value.kind === "events" && value.done === false,
  unavailable: (value) => {
    const unavailable = value.unavailable,
      edgeUnavailable =
        value.mode === "remote-edge" &&
        value.kind === "events" &&
        isJsonObject(unavailable) &&
        unavailable.reason === "edge-mirror-has-no-events" &&
        (unavailable.centerRevision === null || nonNegativeInteger(unavailable.centerRevision)),
      centerUnavailable =
        value.mode === "remote-center" &&
        value.kind === "repo-log" &&
        isJsonObject(unavailable) &&
        unavailable.reason === "center-request-log-not-wired" &&
        unavailable.centerRevision === null;
    return (
      (edgeUnavailable || centerUnavailable) &&
      isJsonObject(unavailable) &&
      Object.keys(unavailable).every((key) => key === "reason" || key === "centerRevision") &&
      exactObserveResultFields(value, ["unavailable"]) &&
      Array.isArray(value.items) &&
      value.items.length === 0 &&
      value.historyCursor === null &&
      value.liveCursor === null &&
      value.sourceCursor === null &&
      value.done === false
    );
  },
  gap: (value) => {
    const gap = value.gap;
    return (
      value.kind !== "events" &&
      isJsonObject(gap) &&
      Object.keys(gap).every((key) => key === "reason" || key === "requestedFileId") &&
      ["cursor-file-not-retained", "cursor-offset-out-of-range"].includes(String(gap.reason)) &&
      typeof gap.requestedFileId === "string" &&
      gap.requestedFileId.length > 0 &&
      exactObserveResultFields(value, ["gap"]) &&
      Array.isArray(value.items) &&
      value.items.length === 0 &&
      value.historyCursor === null &&
      value.liveCursor === null &&
      value.sourceCursor === null &&
      value.done === false
    );
  },
};

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

type DaemonGuiReadDataMap = {
  readonly "daemon.gui.system.read": JsonObject;
  readonly "daemon.gui.home.read": DaemonHomeOverviewResult;
  readonly "daemon.gui.control.receipt": JsonObject;
  readonly "observe.tail": ObserveTailResult;
  readonly "repo.events.read": import("@harness-anything/kernel").CanonicalEventPage;
  readonly "repo.tasks.assignmentDirectory": TaskAssignmentDirectory;
  readonly "repo.tasks.claimable": TaskClaimableResult;
  readonly "repo.tasks.list": DaemonTaskSnapshotListResult;
  readonly "repo.tasks.wip": DaemonTaskWipResult;
  readonly "repo.works.index": ReturnType<
    typeof import("@harness-anything/application/queries").workIndexFromProjection
  >;
  readonly "repo.work.topology.read": import("@harness-anything/application/queries").WorkTopologyRead;
  readonly "repo.works.briefs.read": import("@harness-anything/application/queries").WorkBriefsReadResult;
  readonly "repo.projection.read": DaemonUseCaseProjectionResult;
  readonly "repo.entity.actions.explain": EntityActionExplanationSetV1;
  readonly "repo.entity.kinds.read": EntityKindCatalogV1;
  readonly "repo.vertical.declaration.read": {
    readonly schema: "repository-vertical-declaration-read/v1";
    readonly declarationRevision: number;
    readonly declaration: VerticalDefinition;
  };
  readonly "repo.entity.rows.read": import("../entity-rows-read.ts").EntityRowListV1;
  readonly "repo.entity.locator.read": import("../entity-locator-read.ts").EntityLocatorReadV1;
  readonly "repo.entity.content.read": import("../entity-content-read.ts").EntityContentReadV1;
  readonly "repo.dossier.status": import("@harness-anything/application/internal/queries/living-dossier.ts").DossierStatusResult;
  readonly "repo.dossier.read": import("@harness-anything/application/internal/queries/living-dossier.ts").DossierContentResult;
  readonly "repo.dossier.context.read": import("@harness-anything/application/internal/queries/living-dossier.ts").DossierContextResult;
  readonly "repo.settings.read": import("./daemon-settings-read-types.ts").DaemonSettingsRead;
  readonly "repo.reckoning.signals.read": import("@harness-anything/application/queries").ReckoningResult & {
    readonly ok: true;
  };
  readonly "repo.policy.metadata.read": Awaited<
    ReturnType<typeof import("@harness-anything/application/queries").readPolicyMetadata>
  >;
  readonly "repo.workspace.summary.read": DaemonWorkspaceSummaryResult;
  readonly "repo.workspace.scope.read": import("@harness-anything/application/queries").WorkspaceScopeRead;
  readonly "repo.agenda.read": DaemonAgendaResult;
  readonly "repo.triadic.relationGraph": DaemonRelationGraphResult;
  readonly "repo.decisions.list": DaemonDecisionListResult;
  readonly "repo.tasks.document.read": {
    readonly ok: true;
    readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
    readonly taskId: string;
    readonly path: string;
    /** The cut `body`/`blobSha256`/`size`/`mediaType`/`bytes` were read from. A read never mixes a
     * canonical digest with authored bytes: when the returned content is the live copy, `source`
     * says `authored-copy` (or `execution` for an execution workspace) and the digest is that copy's.
     * `unobservable` carries no content or digest at all. */
    readonly source: "canonical" | "authored-copy" | "execution" | "derived" | "unobservable";
    /** Whether the returned cut matches the accepted canonical cut. `unobservable` is absence of
     * evidence — a missing authored copy or unreadable execution workspace is not `false`. */
    readonly syncState: "synced" | "unsynced" | "unobservable" | "derived";
    readonly body: string;
    readonly blobSha256: string | null;
    /** `binary` = a raw task artifact: `body` is empty because the document is not text,
     * not because the file is. Renderers must branch on this before showing `body`. */
    readonly contentKind: "text" | "binary";
    readonly mediaType: string | null;
    readonly size: number | null;
    /** Bytes of the returned cut of a raw artifact, base64. Null for text, for an unreadable object,
     * and above the inline ceiling — then `repositoryPath` is the route to canonical bytes. */
    readonly bytes: string | null;
    /** Where this document materializes under the configured authored root. */
    readonly repositoryPath: string;
    /** Live worktree view (task_e5defe69): disk content now, and whether it diverges
     * from the committed projection. Null body = no such file on disk, or the file is
     * binary and has no text to show. */
    readonly worktreeBody: string | null;
    /** @deprecated A boolean cannot distinguish "same bytes" from "no file to compare". Read
     * `syncState`; this field remains for the previous protocol window only. */
    readonly uncommitted: boolean;
    /** The accepted canonical document this read was compared against; null when none exists. */
    readonly canonicalVersion: {
      readonly workspaceRevision: number;
      readonly blobSha256: string;
      readonly size: number;
    } | null;
    /** Present only when `source` is `execution`: the execution and effective lease the observation
     * was taken under. */
    readonly execution: {
      readonly executionId: string;
      readonly leaseVersion: number;
      readonly leaseExpiresAt: string;
      readonly observedAt: string;
    } | null;
    /** Why `source`/`syncState` is `unobservable`; null otherwise. */
    readonly unobservableReason: string | null;
    readonly watermark: number;
    readonly sourceRevision: number;
  };
  readonly "repo.tasks.completion.read": DaemonTaskCompletionResult;
  /** What a node that launches a task-bound dispatch needs from the center, assembled at the serving cut:
   * the bounded causal-context block the worker prompt carries, the task's frozen profile id, and its
   * worktree binding (dec_57370FF2021DADF04E3B21724D CH1). Fleet edges use the same
   * query against their authorized replica cut. */
  readonly "repo.tasks.runtimeContext.read": DaemonTaskRuntimeContextResult;
  readonly "repo.tasks.documents.list": DaemonTaskDocumentListResult;
  readonly "repo.tasks.deliveryDiff.read": DaemonTaskDeliveryDiffResult;
  readonly "repo.artifacts.list": ArtifactsListResult;
  readonly "repo.agentRuntime.overview": AgentRuntimeOverviewResult;
  readonly "repo.agentRuntime.sessions.read": AgentRuntimeSessionResult;
  readonly "repo.agentRuntime.events.read": AgentRuntimeEventsResult;
  readonly "repo.agentRuntime.tokenUsage":
    | AgentRuntimeTokenUsageResult
    | import("../collaborator-token-usage-read.ts").CollaboratorTokenUsageResult;
  readonly "repo.agentRuntime.tokenUsageDetail": AgentRuntimeTokenUsageDetailResult;
  readonly "repo.task.dispatches": DaemonTaskDispatchesResult;
  readonly "repo.agent.entities.list": Extract<AgentEntityGuiRead, { readonly schema: "agent-entity-catalog/v1" }>;
  readonly "repo.agent.entity.read": Extract<AgentEntityGuiRead, { readonly schema: "agent-entity-detail/v1" }>;
  readonly "repo.agent.history.read": import("../agent-version-read.ts").AgentHistoryRead;
  readonly "repo.agent.version.read": import("../agent-version-read.ts").AgentVersionRead;
  readonly "repo.agent.skills.list": AgentSkillGuiRead;
  readonly "repo.squad.entities.list": Extract<AgentEntityGuiRead, { readonly schema: "squad-entity-catalog/v1" }>;
  readonly "repo.squad.entity.read": Extract<AgentEntityGuiRead, { readonly schema: "squad-entity-detail/v1" }>;
  readonly "repo.squad.runs.list": SquadRunsListResult;
  readonly "repo.squad.run.read": SquadRunReadResult;
  readonly "repo.gui.catalog.snapshot": JsonObject;
  readonly "repo.gui.catalog.preset.read": JsonObject;
  readonly "repo.terminal.sessions.list": JsonObject;
  readonly "repo.fleet.overview.read": import("../fleet/fleet-overview-read.ts").FleetOverviewResult;
};

/** Replica answers retain the shared read shape and identify the cut that answered it. */
export type DaemonGuiReadResultMap = {
  readonly [M in keyof DaemonGuiReadDataMap]: DaemonGuiReadDataMap[M] &
    Partial<import("./repository-read-frame.ts").RepositoryReadFrame>;
};

/** Host-owned aggregate reads (fleet topology needs the center handle + daemon build facts). */
export type DaemonHostOnlyGuiReadMethod = "observe.tail" | "repo.fleet.overview.read" | "repo.policy.metadata.read";

/** Historical cell-routable read union. Host-owned aggregate reads use the full RPC union below. */
export type DaemonGuiReadMethod = Exclude<keyof DaemonGuiReadResultMap, DaemonHostOnlyGuiReadMethod>;

export type DaemonGuiRpcReadMethod = keyof DaemonGuiReadResultMap;

type CollaboratorScope = import("@harness-anything/kernel/internal/domain/collaborator-scope.ts").CollaboratorScope;

export type DaemonGuiReadPayloadMap = {
  readonly "daemon.gui.system.read": Readonly<Record<string, never>>;
  readonly "daemon.gui.home.read": Readonly<Record<string, never>>;
  readonly "daemon.gui.control.receipt": { readonly operationId: string };
  readonly "observe.tail": ObserveTailPayload;
  readonly "repo.events.read": import("@harness-anything/kernel").CanonicalEventReadRequest;
  readonly "repo.tasks.assignmentDirectory": { readonly taskId: string };
  readonly "repo.tasks.claimable": Readonly<Record<string, never>>;
  readonly "repo.tasks.list": DaemonTaskQueryPayload;
  readonly "repo.tasks.wip": Readonly<Record<string, never>>;
  readonly "repo.works.index": CollaboratorScope;
  readonly "repo.work.topology.read": { readonly workRootTaskId: string };
  readonly "repo.works.briefs.read": CollaboratorScope;
  readonly "repo.projection.read": DaemonUseCaseProjectionPayload;
  readonly "repo.entity.actions.explain": {
    readonly schema: "entity-action-explain-request/v1";
    readonly mode: "catalog" | "object";
    readonly entityKind: string | null;
    readonly refs: readonly string[];
    readonly executor?: Readonly<Record<string, unknown>>;
  };
  readonly "repo.entity.kinds.read": Readonly<Record<string, never>>;
  readonly "repo.vertical.declaration.read": Readonly<Record<string, never>>;
  readonly "repo.entity.rows.read": CollaboratorScope;
  readonly "repo.entity.locator.read": { readonly locatorKind: string; readonly locatorValue: string };
  readonly "repo.entity.content.read": {
    readonly entityKind: string;
    readonly entityId: string;
    readonly path?: string;
  };
  readonly "repo.dossier.status": Readonly<Record<string, never>>;
  readonly "repo.dossier.read": { readonly slotId: string };
  readonly "repo.dossier.context.read": {
    readonly slotId: string;
    readonly maxWatermark?: number;
    readonly afterWatermark?: number;
    readonly bootstrap?: boolean;
  };
  readonly "repo.settings.read": Readonly<Record<string, never>>;
  readonly "repo.reckoning.signals.read": { readonly generatedAt?: string; readonly windowHours?: number };
  readonly "repo.policy.metadata.read": Readonly<Record<string, never>>;
  readonly "repo.workspace.summary.read": Readonly<Record<string, never>>;
  readonly "repo.workspace.scope.read": CollaboratorScope & {
    readonly rootTaskId: string;
    readonly limit?: number;
    readonly cursor?: string;
  };
  readonly "repo.agenda.read": DaemonAgendaPayload;
  readonly "repo.triadic.relationGraph": DaemonRelationQueryPayload;
  readonly "repo.decisions.list": DaemonDecisionListPayload;
  readonly "repo.tasks.document.read": {
    readonly taskId: string;
    readonly path: string;
    /** Which cut to read: accepted canonical (default), the live authored copy, or one execution's
     * workspace. An execution view requires `executionId`. */
    readonly view?: "canonical" | "authored-copy" | "execution";
    readonly executionId?: string;
  };
  readonly "repo.tasks.completion.read": { readonly taskId: string };
  readonly "repo.tasks.runtimeContext.read": {
    readonly taskId: string;
    /** Settlement-time callers skip the dispatch they are closing so the seed is the prior stop. */
    readonly excludeDispatchId?: string;
  };
  readonly "repo.tasks.documents.list": { readonly taskId: string };
  readonly "repo.tasks.deliveryDiff.read": { readonly taskId: string };
  /** absent kind = html(时间线默认面);md 是显式 opt-in。 */
  readonly "repo.artifacts.list": CollaboratorScope & {
    readonly kind?: "html" | "md" | "raw";
    readonly limit?: number;
    readonly cursor?: string;
  };
  readonly "repo.agentRuntime.overview": Pick<CollaboratorScope, "scopePersonId" | "filterNodeId"> & {
    readonly taskId?: string;
    readonly limit?: number;
    readonly cursor?: string;
  };
  readonly "repo.agentRuntime.sessions.read": {
    readonly runtimeSessionId: string;
    readonly includeControlReceipts?: boolean;
    readonly controlReceiptRequestOpId?: string;
    readonly controlReceiptsCursor?: string;
    readonly controlReceiptsLimit?: number;
  };
  readonly "repo.agentRuntime.events.read": {
    readonly runtimeSessionId: string;
    readonly afterCursor: string;
  };
  readonly "repo.agentRuntime.tokenUsage": CollaboratorScope & {
    readonly range?: AgentRuntimeTokenUsageRange;
    readonly groupBy?: "person" | "node";
  };
  /** Exactly one of agentId/squadId scopes the member detail read. */
  readonly "repo.agentRuntime.tokenUsageDetail": {
    readonly range?: AgentRuntimeTokenUsageRange;
    readonly agentId?: string;
    readonly squadId?: string;
    readonly limit?: number;
    readonly cursor?: string;
  };
  readonly "repo.task.dispatches": DaemonTaskDispatchesPayload;
  readonly "repo.agent.entities.list": Readonly<Record<string, never>>;
  readonly "repo.agent.entity.read": { readonly agentId: string };
  readonly "repo.agent.history.read": {
    readonly agentId: string;
    readonly limit?: number;
    readonly cursor?: string;
    readonly noSummary?: boolean;
  };
  readonly "repo.agent.version.read": { readonly agentId: string; readonly revision: number };
  readonly "repo.agent.skills.list": Readonly<Record<string, never>>;
  readonly "repo.squad.entities.list": Readonly<Record<string, never>>;
  readonly "repo.squad.entity.read": { readonly squadId: string };
  readonly "repo.squad.runs.list": {
    readonly since?: string;
    readonly query?: string;
    readonly limit?: number;
    readonly personId?: string;
    readonly nodeId?: string;
  };
  readonly "repo.squad.run.read": {
    readonly squadRunId: string;
  };
  readonly "repo.gui.catalog.snapshot": Readonly<Record<string, never>>;
  readonly "repo.gui.catalog.preset.read": {
    readonly presetId: string;
    readonly profileId?: string;
    readonly locale?: string;
  };
  readonly "repo.terminal.sessions.list": Readonly<Record<string, never>>;
  readonly "repo.fleet.overview.read": Readonly<Record<string, never>>;
};

/** Optional narrow/paged query facets for the wide task reads. Absent fields keep the
 * unparameterized full-result behavior; every field is explicit — nothing truncates silently. */
export interface DaemonTaskQueryPayload extends CollaboratorScope {
  readonly involvement?: "all" | "mine";
  readonly attestationOnly?: boolean;
  readonly status?: string;
  readonly changedAfterRevision?: number;
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
  readonly limit?: number;
  readonly cursor?: string;
  /**
   * Lifecycle status is the default. `raw` skips the presentation-status derivation (which joins
   * a task's subtree and cannot be index-bounded) for aggregate reads that show current lifecycle
   * state, e.g. the fleet's in-flight leases and home's "completed in the last 24h" count.
   */
  readonly statusSource?: "raw";
  /** Only tasks holding a live lease; the fleet lease page starts from leases, not raw actives. */
  readonly leaseOnly?: boolean;
  readonly activePackagesOnly?: boolean;
}

export interface DaemonAgendaPayload {
  readonly scopePersonId?: string;
  readonly filterNodeId?: string;
  readonly limit?: number;
  readonly cursor?: string;
  /** Narrow the agenda to one work: the root task and its subtree. */
  readonly work?: string;
  /**
   * Home's aggregation: only awaitingYou / awaitingRework / awaitingAdjudication / underReview,
   * read by lifecycle status so the read is bounded by current work rather than task history.
   */
  readonly attentionOnly?: boolean;
}

export interface DaemonRelationQueryPayload {
  readonly entity?: string;
  readonly hops?: {
    readonly direction: "outgoing" | "incoming" | "both";
    readonly relationTypes: readonly string[];
    readonly maxDepth: number;
    readonly maxNodes: number;
  };
  readonly facet?: DaemonRelationGraphFacet;
  readonly relationType?: string;
  readonly state?: string;
  readonly direction?: "directed" | "undirected";
  readonly status?: string;
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** One selector per read. History and live-floor pages preserve their own bounded cursors. */
export type DaemonTaskDispatchesPayload = TaskDispatchesPayload;

export type DaemonTaskDispatchesResultBase = {
  readonly ok: true;
  /** Authored document rows stay canonical in daemon reads; the CLI uses this prefix at its output boundary. */
  readonly workspacePathPrefix?: string;
  readonly status: ProjectionStatus.ReadSetProjectionCut["status"];
  readonly dispatches: readonly TaskDispatchRow[];
  /** Daemon-authoritative aggregate terminal verdict over the returned dispatch rows. */
  readonly outcome: DispatchAttemptOutcome;
  readonly exitCode: number;
  readonly watermark: number;
  readonly sourceRevision: number;
};

export type DaemonTaskDispatchesResult = DaemonTaskDispatchesResultBase &
  (
    | {
        readonly floor: "active" | "ended";
        readonly page: ProjectionPage;
        readonly truncated: boolean;
      }
    | { readonly taskId: string }
    | {
        readonly taskIds: readonly string[];
        readonly unavailableTaskIds: readonly string[];
        readonly page: ProjectionPage;
      }
    | {
        /** The member selector: exactly one of agentId or squadId. */
        readonly agentId?: string;
        readonly squadId?: string;
        /** Task-group view of exactly the returned rows, newest first. */
        readonly groups: readonly (AgentRuntimeSessionGroupDto & {
          /** Optional on the previous center's wire format. Current centers supply canonical membership. */
          readonly runtimeSessionIds?: readonly string[];
        })[];
        /** Titles for the returned rows' task ids and the sessions' task bindings. */
        readonly taskLabels: readonly { readonly taskId: string; readonly title: string }[];
        /** Full-history distinct task-group and session counts for the member. */
        readonly totals: { readonly groups: number; readonly sessions: number };
        readonly truncated: boolean;
      }
  );

export type DaemonGuiActionResult = JsonObject & {
  readonly schema: "command-receipt/v2";
  readonly ok: boolean;
  readonly command: string;
  readonly outcome: WriteReceiptOutcome;
  readonly opId: string;
  readonly warnings?: import("@harness-anything/kernel").WriteReceipt["warnings"];
  readonly guidance?: import("@harness-anything/kernel").WriteReceipt["guidance"];
};

export type DaemonGuiActionMethod = (typeof daemonActionRoutes)[number]["method"];

export type DaemonStreamResultMap = {
  readonly "repo.agentRuntime.attach": AgentRuntimeAttachResult;
  readonly "repo.terminal.attach": JsonObject;
};

export type DaemonStreamMethod = keyof DaemonStreamResultMap;

export type DaemonStreamPayloadMap = {
  readonly "repo.agentRuntime.attach": {
    readonly runtimeSessionId: string;
    readonly afterCursor?: import("./stream-contract.ts").RuntimeStreamCursor;
  };
  readonly "repo.terminal.attach": {
    readonly sessionId: string;
    readonly afterSeq: number;
    readonly daemonGeneration?: number;
  };
};

export interface DaemonProtocolErrorResult {
  readonly schema: "command-receipt/v2";
  readonly ok: false;
  readonly command: string;
  readonly outcome: "op_rejected";
  readonly opId: "N/A";
  readonly origin: "daemon";
  readonly code: string;
  readonly evidence: string;
  readonly error: {
    readonly code: string;
    readonly errcode?: number;
    readonly errstr?: string;
    readonly syncProgress?: ReplicaSyncProgress;
  };
  readonly diagnostic?: ReceiptDiagnostic;
}

export {
  useCaseProjectionSchemaId,
  useCaseProjectionFacets,
  admitUseCaseProjectionSelector,
  isUseCaseProjectionName,
  isUseCaseProjectionFacet,
  type UseCaseProjectionName,
  type UseCaseProjectionFacet,
} from "./daemon-protocol-vocabulary.ts";

export type { DaemonUseCaseProjectionPayload, DaemonUseCaseProjectionResult };
