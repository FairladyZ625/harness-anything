import type { TaskAssignmentDirectory, TaskClaimableResult } from "./daemon-protocol-schema-ids.ts";
export type { TaskAssignmentDirectory, TaskClaimableResult } from "./daemon-protocol-schema-ids.ts";
import type { DaemonTaskCompletionResult } from "./daemon-protocol-task-completion.ts";
import type { TaskDispatchRow } from "./task-dispatch-contract.ts";
export type { TaskDispatchRow } from "./task-dispatch-contract.ts";
import type {
  CanonicalEventV1,
  DaemonRepoMode,
  DecisionAcceptReviewReadiness,
  DecisionProjectionRow,
  FreshnessReason,
  ProjectionPage,
  ProjectionWarning,
  RelationCoverageRow,
  RelationFactRow,
  RelationGraphEdgeRow,
  ReceiptDiagnostic,
  TaskProjection,
  TaskWipRootRow,
  TaskWorktreeBindingV1,
  EntityActionExplanationSetV1,
  EntityKindCatalogV1,
  VerticalDefinition,
} from "@harness-anything/kernel";
import type { AgentEntityGuiRead, AgentSkillGuiRead } from "../agent-entities.ts";
export type { AgentDeclarationV1, SquadDeclarationV1 } from "@harness-anything/kernel";
import type {
  AgentRuntimeEventsResult,
  AgentRuntimeOverviewResult,
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
import type { ArtifactsListResult } from "./artifacts-gui-contract.ts";
import type { daemonGuiActionMethods } from "./daemon-protocol-gui-actions.ts";
import {
  taskStatusWords,
  useCaseProjectionFacetWords,
  useCaseProjectionNameWords,
} from "./daemon-protocol-vocabulary.ts";
import { isJsonObject, unknownFieldViolation, type JsonObject } from "./json-rpc-types.ts";
import type { AgendaAttentionItem, AgendaRegionWeights } from "./daemon-protocol-agenda-attention.ts";
export type { AgendaAttentionItem, AgendaRegionWeights } from "./daemon-protocol-agenda-attention.ts";

type TaskProjectionListRow = ReturnType<TaskProjection["list"]>["rows"][number];
type TaskProjectionWarning = ReturnType<TaskProjection["list"]>["warnings"][number];

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
  | ObserveTailRequestFor<"events">
  | ObserveTailRequestFor<"repo-log">
  | ObserveTailRequestFor<"daemon-log">
  | ObserveTailRequestFor<"lifecycle">
  | (ObserveTailRequestFor<"dispatch"> & { readonly dispatchId: string });

type ObserveTailBase = {
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
  | (ObserveTailBase & { readonly status: "ready" | "pending" })
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
    Object.keys(value).some((key) => key !== "kind" && key !== "direction" && key !== "cursor" && key !== "dispatchId")
  )
    return ["observe tail payload contains an unknown field"];
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

export type DaemonGuiReadResultMap = {
  readonly "daemon.gui.system.read": JsonObject;
  readonly "daemon.gui.control.receipt": JsonObject;
  readonly "observe.tail": ObserveTailResult;
  readonly "repo.tasks.assignmentDirectory": TaskAssignmentDirectory;
  readonly "repo.tasks.claimable": TaskClaimableResult;
  readonly "repo.tasks.list": DaemonTaskSnapshotListResult;
  readonly "repo.tasks.wip": DaemonTaskWipResult;
  readonly "repo.works.index": ReturnType<typeof import("../work-read.ts").workIndexFromProjection>;
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
  readonly "repo.settings.read": import("./daemon-settings-read-types.ts").DaemonSettingsRead;
  readonly "repo.ci.observatory.read": import("../ci-observatory-read.ts").CiObservatoryRead;
  readonly "repo.workspace.summary.read": DaemonWorkspaceSummaryResult;
  readonly "repo.workspace.scope.read": import("../workspace-scope-read.ts").WorkspaceScopeRead;
  readonly "repo.agenda.read": DaemonAgendaResult;
  readonly "repo.triadic.relationGraph": DaemonRelationGraphResult;
  readonly "repo.decisions.list": DaemonDecisionListResult;
  readonly "repo.tasks.document.read": {
    readonly ok: true;
    readonly status: "ready" | "pending";
    readonly taskId: string;
    readonly path: string;
    readonly body: string;
    readonly blobSha256: string | null;
    /** `binary` = a raw task artifact: `body` is empty because the document is not text,
     * not because the file is. Renderers must branch on this before showing `body`. */
    readonly contentKind: "text" | "binary";
    readonly mediaType: string | null;
    readonly size: number | null;
    /** Canonical content-object bytes of a raw artifact, base64. Null for text, for an
     * unreadable object, and above the inline ceiling — then `repositoryPath` is the route. */
    readonly bytes: string | null;
    /** Where this document materializes under the configured authored root. */
    readonly repositoryPath: string;
    /** Live worktree view (task_e5defe69): disk content now, and whether it diverges
     * from the committed projection. Null body = no such file on disk, or the file is
     * binary and has no text to show. */
    readonly worktreeBody: string | null;
    readonly uncommitted: boolean;
    readonly watermark: number;
    readonly sourceRevision: number;
  };
  readonly "repo.tasks.completion.read": DaemonTaskCompletionResult;
  /** What a node that launches a task-bound dispatch needs from the center, assembled at the serving cut:
   * the bounded causal-context block the worker prompt carries, the task's frozen profile id, and its
   * worktree binding (dec_57370FF2021DADF04E3B21724D CH1) — fleet edges read it through
   * `fleet.runtime.read/v1`. */
  readonly "repo.tasks.runtimeContext.read": {
    readonly schema: "task-runtime-context-read/v1";
    readonly ok: true;
    readonly taskId: string;
    readonly causalContext: string | null;
    readonly profileId: string | null;
    readonly worktree: TaskWorktreeBindingV1 | null;
  };
  readonly "repo.tasks.documents.list": DaemonTaskDocumentListResult;
  readonly "repo.artifacts.list": ArtifactsListResult;
  readonly "repo.agentRuntime.overview": AgentRuntimeOverviewResult;
  readonly "repo.agentRuntime.sessions.read": AgentRuntimeSessionResult;
  readonly "repo.agentRuntime.events.read": AgentRuntimeEventsResult;
  readonly "repo.agentRuntime.tokenUsage": AgentRuntimeTokenUsageResult;
  readonly "repo.agentRuntime.tokenUsageDetail": AgentRuntimeTokenUsageDetailResult;
  readonly "repo.task.dispatches": DaemonTaskDispatchesResult;
  readonly "repo.agent.entities.list": Extract<AgentEntityGuiRead, { readonly schema: "agent-entity-catalog/v1" }>;
  readonly "repo.agent.entity.read": Extract<AgentEntityGuiRead, { readonly schema: "agent-entity-detail/v1" }>;
  readonly "repo.agent.skills.list": AgentSkillGuiRead;
  readonly "repo.squad.entities.list": Extract<AgentEntityGuiRead, { readonly schema: "squad-entity-catalog/v1" }>;
  readonly "repo.squad.entity.read": Extract<AgentEntityGuiRead, { readonly schema: "squad-entity-detail/v1" }>;
  readonly "repo.squad.runs.list": SquadRunsListResult;
  readonly "repo.squad.run.read": SquadRunReadResult;
  readonly "repo.gui.catalog.snapshot": JsonObject;
  readonly "repo.gui.catalog.preset.read": JsonObject;
  readonly "repo.terminal.sessions.list": JsonObject;
};

export type DaemonHostOnlyGuiReadMethod = "repo.workspace.summary.read" | "repo.workspace.scope.read" | "observe.tail";

/** Historical cell-routable read union. Host-owned aggregate reads use the full RPC union below. */
export type DaemonGuiReadMethod = Exclude<keyof DaemonGuiReadResultMap, DaemonHostOnlyGuiReadMethod>;

export type DaemonGuiRpcReadMethod = keyof DaemonGuiReadResultMap;

export type DaemonGuiReadPayloadMap = {
  readonly "daemon.gui.system.read": Readonly<Record<string, never>>;
  readonly "daemon.gui.control.receipt": { readonly operationId: string };
  readonly "observe.tail": ObserveTailPayload;
  readonly "repo.tasks.assignmentDirectory": { readonly taskId: string };
  readonly "repo.tasks.claimable": Readonly<Record<string, never>>;
  readonly "repo.tasks.list": DaemonTaskQueryPayload;
  readonly "repo.tasks.wip": Readonly<Record<string, never>>;
  readonly "repo.works.index": Readonly<Record<string, never>>;
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
  readonly "repo.entity.rows.read": Readonly<Record<string, never>>;
  readonly "repo.entity.locator.read": { readonly locatorKind: string; readonly locatorValue: string };
  readonly "repo.entity.content.read": {
    readonly entityKind: string;
    readonly entityId: string;
    readonly path?: string;
  };
  readonly "repo.settings.read": Readonly<Record<string, never>>;
  readonly "repo.ci.observatory.read": { readonly window?: number };
  readonly "repo.workspace.summary.read": Readonly<Record<string, never>>;
  readonly "repo.workspace.scope.read": {
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
  };
  readonly "repo.tasks.completion.read": { readonly taskId: string };
  readonly "repo.tasks.runtimeContext.read": { readonly taskId: string };
  readonly "repo.tasks.documents.list": { readonly taskId: string };
  /** absent kind = html(时间线默认面);md 是显式 opt-in。 */
  readonly "repo.artifacts.list": { readonly kind?: "html" | "md" | "raw" };
  readonly "repo.agentRuntime.overview": {
    readonly taskId?: string;
    readonly limit?: number;
    readonly cursor?: string;
  };
  readonly "repo.agentRuntime.sessions.read": {
    readonly runtimeSessionId: string;
  };
  readonly "repo.agentRuntime.events.read": {
    readonly runtimeSessionId: string;
    readonly afterCursor: string;
  };
  readonly "repo.agentRuntime.tokenUsage": { readonly range?: AgentRuntimeTokenUsageRange };
  /** Exactly one of agentId/squadId scopes the member detail read. */
  readonly "repo.agentRuntime.tokenUsageDetail": {
    readonly range?: AgentRuntimeTokenUsageRange;
    readonly agentId?: string;
    readonly squadId?: string;
  };
  readonly "repo.task.dispatches": DaemonTaskDispatchesPayload;
  readonly "repo.agent.entities.list": Readonly<Record<string, never>>;
  readonly "repo.agent.entity.read": { readonly agentId: string };
  readonly "repo.agent.skills.list": Readonly<Record<string, never>>;
  readonly "repo.squad.entities.list": Readonly<Record<string, never>>;
  readonly "repo.squad.entity.read": { readonly squadId: string };
  readonly "repo.squad.runs.list": {
    readonly since?: string;
    readonly query?: string;
    readonly limit?: number;
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
};

/** Optional narrow/paged query facets for the wide task reads. Absent fields keep the
 * unparameterized full-result behavior; every field is explicit — nothing truncates silently. */
export interface DaemonTaskQueryPayload {
  readonly status?: string;
  readonly changedAfterRevision?: number;
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface DaemonAgendaPayload {
  readonly limit?: number;
  readonly cursor?: string;
  /** Narrow the agenda to one work: the root task and its subtree. */
  readonly work?: string;
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

export type DaemonRelationGraphFacet = "edges" | "facts" | "coverageRows" | "runtimeEdges";

export interface DaemonRelationEdgeFacetPayload {
  readonly facet: "edges";
  readonly limit?: number;
  readonly cursor?: string;
  readonly relationType?: string;
  readonly state?: string;
  readonly direction?: "directed" | "undirected";
}

export type DaemonRelationGraphFacetPayload =
  | DaemonRelationEdgeFacetPayload
  | { readonly facet: "facts"; readonly limit?: number; readonly cursor?: string }
  | { readonly facet: "coverageRows" | "runtimeEdges" };

export interface DaemonFactSummaryRow {
  readonly anchor: string;
  readonly text: string;
  readonly category: "lesson" | "finding" | "progress";
  readonly taskId?: string;
  /** `fact_archived` 投影态(dec_62CAE6CA):读面如实携带,默认过滤在 GUI 消费端。 */
  readonly archived?: boolean;
}

type EventProjectionCut = Pick<
  ReturnType<TaskProjection["readRelationQuery"]>,
  "status" | "watermark" | "sourceRevision"
>;
type DaemonRelationGraphProjection = {
  readonly edges: readonly DaemonRelationGraphEdgeRow[];
  readonly factAnchors: ReturnType<TaskProjection["readFactAnchors"]>["rows"];
  readonly facts: readonly RelationFactRow[];
  readonly warnings: readonly ProjectionWarning[];
};

export type DaemonRelationGraphEdgeRow = RelationGraphEdgeRow & { readonly current: boolean };

type ServedCoverageRow = RelationCoverageRow & { readonly freshnessReason?: FreshnessReason };

export type DaemonRelationGraphFullResult = { readonly ok: true } & EventProjectionCut &
  DaemonRelationGraphProjection & {
    /** Coverage rows as served: the kernel row plus the optional uncovered-cause
     * classification (kernel `freshnessReasonOf`), attached only to uncovered rows.
     * Optional so older daemons and every persisted record shape stay valid. */
    readonly coverageRows: readonly ServedCoverageRow[];
    readonly page?: ProjectionPage;
    /** Set only on neighborhood reads: edges exist beyond the served depth window. */
    readonly truncated?: boolean;
  };

type EmptyRelationFacetRows = {
  readonly edges: readonly [];
  readonly coverageRows: readonly [];
  readonly factAnchors: readonly [];
  readonly facts: readonly [];
  readonly warnings: readonly ProjectionWarning[];
  readonly domainTypes: readonly [];
};

export type DaemonRelationGraphFacetResult =
  | ({ readonly ok: true; readonly facet: "edges" } & EventProjectionCut &
      Omit<EmptyRelationFacetRows, "edges"> & {
        readonly edges: DaemonRelationGraphProjection["edges"];
        readonly page: ProjectionPage;
      })
  | ({ readonly ok: true; readonly facet: "coverageRows" } & EventProjectionCut &
      Omit<EmptyRelationFacetRows, "coverageRows"> & {
        readonly coverageRows: readonly ServedCoverageRow[];
      })
  | ({ readonly ok: true; readonly facet: "facts" } & EventProjectionCut &
      Omit<EmptyRelationFacetRows, "facts" | "domainTypes"> & {
        readonly facts: readonly DaemonFactSummaryRow[];
        readonly page: ProjectionPage;
        readonly domainTypes: ReturnType<TaskProjection["listFactDomainTypes"]>["domainTypes"];
      })
  | ({ readonly ok: true; readonly facet: "runtimeEdges" } & Omit<EmptyRelationFacetRows, "edges"> & {
        readonly edges: readonly DaemonRelationGraphEdgeRow[];
      });

export type DaemonRelationGraphResult = DaemonRelationGraphFullResult | DaemonRelationGraphFacetResult;

export interface DaemonDecisionSummaryRow {
  readonly decisionId: string;
  readonly title: string;
  readonly state: DecisionProjectionRow["state"];
  readonly riskTier: DecisionProjectionRow["riskTier"];
  readonly urgency: DecisionProjectionRow["urgency"];
  readonly proposedAt: DecisionProjectionRow["proposedAt"];
}

export interface DaemonDecisionReviewDispatchRow {
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly status: "running" | "succeeded" | "failed" | "unknown";
  readonly reviewContentDigest: string;
  readonly reportRef: string | null;
  /** 评审人显示名:派工头的 agentName,缺名时为 agentId。 */
  readonly reviewer: string | null;
  /** 该派工登记的评审提出的意见数;评审尚未登记为 null。 */
  readonly findingCount: number | null;
}

export type DaemonDecisionFullRow = DecisionProjectionRow & {
  readonly currentReviewContentDigest: `sha256:${string}` | null;
  readonly acceptReviewReadiness: DecisionAcceptReviewReadiness | null;
  readonly reviewDispatches: readonly DaemonDecisionReviewDispatchRow[];
};

export interface DaemonDecisionListPayload {
  readonly projection?: "summary" | "full";
}

export type DaemonDecisionListResult =
  | {
      readonly ok: true;
      readonly projection?: "full";
      readonly decisions: readonly DaemonDecisionFullRow[];
      readonly warnings: readonly ProjectionWarning[];
    }
  | {
      readonly ok: true;
      readonly projection: "summary";
      readonly decisions: readonly DaemonDecisionSummaryRow[];
      readonly warnings: readonly ProjectionWarning[];
    };

/** The CLI-compatible single read and GUI batch read share the same stable method and
 * schema ids. Exactly one selector is allowed; pagination applies only to taskIds. */
export type DaemonTaskDispatchesPayload =
  | {
      readonly taskId: string;
      readonly taskIds?: never;
      readonly limit?: never;
      readonly cursor?: never;
    }
  | {
      readonly taskId?: never;
      readonly taskIds: readonly string[];
      readonly limit?: number;
      readonly cursor?: string;
    };

export interface TaskPlacementSupplement {
  readonly productLines: readonly string[];
  readonly spawningDecisionIds: readonly string[];
  readonly parentTaskId: string | null;
  readonly origin: "native" | "archival" | "external";
  readonly engine: string;
  readonly packageDisposition: "active" | "archived" | "tombstoned";
  readonly provenance: readonly {
    readonly kind: "l2" | "decision-relation" | "canonical-event";
    readonly ref: string;
  }[];
}

export interface ExecutionEvidenceProjection {
  readonly executionId: string;
  readonly origin: "native" | "archival";
  readonly outputs: readonly {
    readonly evidenceId: string;
    readonly locator: string;
    readonly substrate: "repository-path" | "uri" | "canonical-event" | "opaque";
    readonly checkerReceiptRef: string | null;
    readonly checkerResult: "pass" | "fail" | "unknown";
  }[];
}

export type GuiSubmissionV1 = import("@harness-anything/kernel").SubmissionV1;

/** One projected document under a task package (paths relative to the package root, e.g. artifacts/report.md). */
export interface TaskDocumentListEntryRow {
  readonly path: string;
  readonly blobSha256: string;
  readonly size: number;
  readonly mediaType: string;
  /** True when the worktree file diverges from the committed projection (or exists only
   * in the worktree): the GUI marks these documents as not yet committed. */
  readonly uncommitted: boolean;
}

export type DaemonTaskDocumentListResult = {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly taskId: string;
  readonly documents: readonly TaskDocumentListEntryRow[];
  readonly watermark: number;
  readonly sourceRevision: number;
};

export type DaemonTaskDispatchesResultBase = {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly dispatches: readonly TaskDispatchRow[];
  /** Daemon-authoritative aggregate terminal verdict over the returned dispatch rows. */
  readonly outcome: "succeeded" | "failed" | "cancelled" | "unknown";
  readonly exitCode: number;
  readonly watermark: number;
  readonly sourceRevision: number;
};

export type DaemonTaskDispatchesResult = DaemonTaskDispatchesResultBase &
  (
    | { readonly taskId: string }
    | {
        readonly taskIds: readonly string[];
        readonly unavailableTaskIds: readonly string[];
        readonly page: ProjectionPage;
      }
  );

export type DaemonTaskSnapshotListResult = {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly rows: readonly (TaskProjectionListRow & {
    readonly coordinationStatus:
      | import("@harness-anything/kernel/internal/domain/lifecycle-status").DomainStatus
      | "unknown";
    readonly snapshotAvailability: {
      readonly consents: "known" | "unknown";
      readonly codeDocWitnesses: "known" | "unknown";
      readonly gateWitnesses: "known" | "unknown";
    };
    readonly closeoutAssessment: import("@harness-anything/kernel/internal/domain/closeout-readiness").CloseoutAssessment;
    readonly blockingAssessment: import("@harness-anything/kernel/internal/domain/task-blocking").BlockingAssessment;
    readonly placement: TaskPlacementSupplement;
    readonly executionEvidence: readonly ExecutionEvidenceProjection[];
    readonly board: import("@harness-anything/kernel/internal/domain/task-board-projection").TaskBoardPlacement;
    readonly visibility: import("@harness-anything/kernel/internal/domain/task-board-projection").TaskVisibility;
    readonly capabilities: readonly import("@harness-anything/kernel/internal/domain/task-board-projection").TaskCapability[];
    readonly phase: import("@harness-anything/kernel/internal/domain/task-board-projection").TaskPhase;
    readonly risk: import("@harness-anything/kernel/internal/domain/task-board-projection").TaskRisk;
    readonly workspace: TaskWorkspaceView | null;
  })[];
  readonly invalidRows: readonly DaemonTaskSnapshotInvalidRow[];
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly TaskProjectionWarning[];
  readonly page?: ProjectionPage;
};

export type DaemonTaskWipResult = {
  readonly ok: true;
  readonly limit: number;
  readonly limitLabel: string;
  readonly counted: readonly {
    readonly taskId: string;
    readonly status: import("@harness-anything/kernel/internal/domain/task-wip-policy").TaskWipOccupyingStatus;
    readonly title: string;
  }[];
  readonly roots: readonly TaskWipRootRow[];
  readonly threshold: number;
};

export interface DaemonTaskSnapshotInvalidRow {
  readonly rowIndex: number;
  readonly taskId: string;
  readonly field: string;
  readonly message: string;
}

export type DaemonWorkspaceSummaryResult = {
  readonly schema: "daemon.workspace-summary/v1";
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly tasks: import("@harness-anything/kernel/internal/domain/workspace-summary").WorkspaceTaskSummary;
  readonly decisions: import("@harness-anything/kernel/internal/domain/workspace-summary").WorkspaceDecisionSummary;
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly ProjectionWarning[];
};

/**
 * Where a task works (dec_8B3FCCD256CAC5B0BF3CCEDE58 CH4): its worktree binding with what the answering node's
 * filesystem shows of it (dec_BBA713052997C3EF5F5D3DD952; a node that never ran the task reads "bound"), or, for a
 * task that does not change repository files, its own task package directory. Paths are repository-relative.
 */
export type TaskWorkspaceView =
  | {
      readonly kind: "worktree";
      readonly branch: string;
      readonly path: string;
      readonly state: "bound" | "materialized" | "reclaimed" | "retained";
    }
  | { readonly kind: "task-package"; readonly path: string };

/** The work an agenda row belongs to: its nearest work root (dec_5F7E74F1). */
export interface AgendaWorkRef {
  readonly taskId: string;
  readonly title: string;
}

export interface AgendaTaskRow {
  readonly taskId: string;
  readonly title: string;
  readonly work: AgendaWorkRef | null;
  readonly status: (typeof taskStatusWords)[number];
  readonly pinned: boolean;
  readonly updatedAt: string;
  readonly leaseExecutionId: string | null;
  readonly activeExecutionIds: readonly string[];
  readonly blockingAssessment: import("@harness-anything/kernel/internal/domain/task-blocking").BlockingAssessment;
  readonly workspace: TaskWorkspaceView | null;
}

/**
 * 待派审 / 评审中的 execution 行。task 状态决定分组(submitted → awaitingAdjudication,
 * in_review → underReview),组即类型,行内不再携带 kind 判别。
 */
export interface AgendaExecutionRow {
  readonly taskId: string;
  readonly title: string;
  readonly work: AgendaWorkRef | null;
  readonly pinned: boolean;
  readonly executionId: string;
  readonly submittedAt: string;
  readonly blockingAssessment: import("@harness-anything/kernel/internal/domain/task-blocking").BlockingAssessment;
}

export interface AgendaDecisionRow {
  readonly decisionId: string;
  readonly title: string;
  readonly riskTier: "low" | "medium" | "high";
  readonly urgency: "low" | "medium" | "high";
  readonly proposedAt: string;
}
/** 评审中的 Decision 行:另带当前切面上在飞的每位评审人与其已登记的意见数。 */
export interface AgendaDecisionReviewRow extends AgendaDecisionRow {
  readonly reviewers: readonly Pick<DaemonDecisionReviewDispatchRow, "dispatchId" | "reviewer" | "findingCount">[];
}
/**
 * 「等你处理」行:一条指向读者本人的 active awaits 边(dec_DF67F23066BAFE444190A191B5/CH2)。
 * 答复 = `ha relation unrelate <relationId> --reason <答复> --expected-version <relationRevision>`。
 */
export interface AgendaAwaitsRow {
  readonly relationId: string;
  readonly relationRevision: number;
  /** task/<id> 或 decision/<id>。 */
  readonly sourceRef: string;
  readonly title: string;
  readonly status: string;
  readonly personId: string;
  readonly askKind: import("@harness-anything/kernel/internal/domain/task-blocking").AwaitsAskKind;
  readonly question: string;
  readonly askedAt: string;
  /** 提问者:建边 actor 的 agent id,无 agent 时为其 person id。 */
  readonly askedBy: string;
}
/**
 * 「已答复,待你跟进」行:读者名下(task 创建者 / decision 提案者)源实体上已被答复退役的 awaits 边。
 * 退出条件:源实体在答复之后有任何写入(进度、状态、裁决等)即出列,不另存「已读」状态。
 */
export interface AgendaAnsweredRow {
  readonly relationId: string;
  /** task/<id> 或 decision/<id>。 */
  readonly sourceRef: string;
  readonly title: string;
  readonly status: string;
  /** 被问的人(awaits 目标)。 */
  readonly personId: string;
  readonly askKind: import("@harness-anything/kernel/internal/domain/task-blocking").AwaitsAskKind;
  readonly question: string;
  /** 答复原文 = retire 理由。 */
  readonly answer: string;
  readonly answeredAt: string;
  /** 答复者:retire actor 的 agent id,无 agent 时为其 person id。 */
  readonly answeredBy: string;
}
export interface AgendaPinnedEntityRow {
  readonly ref: string;
  readonly kind: string;
  readonly title: string;
  readonly status: string;
  readonly pinnedAt: string;
}

export type DaemonAgendaResult = {
  readonly schema: "daemon.agenda/v1";
  readonly ok: true;
  readonly command: "agenda";
  readonly status: "ready" | "pending";
  readonly pinnedEntities: readonly AgendaPinnedEntityRow[];
  readonly pinnedEntityOverflow: number;
  /** 等你处理:指向读者本人(读绑定的 principal)的 active awaits 边。 */
  readonly awaitingYou: readonly AgendaAwaitsRow[];
  /** 已答复,待你跟进:读者名下源实体上已答复、源实体此后尚无写入的 awaits 边。 */
  readonly answeredForYou: readonly AgendaAnsweredRow[];
  /** All actionable rows in canonical attention order. */
  readonly attentionItems: readonly AgendaAttentionItem[];
  /** Dashboard region weights derived from the same attention scores. */
  readonly regionWeights: AgendaRegionWeights;
  readonly inFlight: readonly AgendaTaskRow[];
  /** Active tasks with neither a live lease nor activity in the last seven days. */
  readonly stalled: readonly AgendaTaskRow[];
  /** 评审打回、等使用者修:active 且最新 execution=changes_requested、无 lease、无 active execution。 */
  readonly awaitingRework: readonly AgendaTaskRow[];
  /** 提交待派审:task 状态 submitted、未被 approved 评审了结的 execution 行;下一步 `ha task adjudicate --forward`。 */
  readonly awaitingAdjudication: readonly AgendaExecutionRow[];
  /** 评审中/等 consent:task 状态 in_review、未被 approved 评审了结的 execution 行;报告就绪后 `ha task review-consent`。 */
  readonly underReview: readonly AgendaExecutionRow[];
  /** 当前切面已有在飞 reviewer；下一步等待或查看 runtime。 */
  readonly decisionReviewInProgress: readonly AgendaDecisionReviewRow[];
  /** 当前策略要求独立评审且没有在飞 reviewer；下一步 `ha decision dispatch-review <id>`。 */
  readonly awaitingDecisionReview: readonly AgendaDecisionRow[];
  /** 待裁 decision 行;下一步 `ha decision accept|reject|defer`。 */
  readonly awaitingDecision: readonly AgendaDecisionRow[];
  readonly waitingOnOthers: readonly AgendaTaskRow[];
  readonly dispatchable: readonly AgendaTaskRow[];
  readonly page: {
    readonly sourceLimit: number;
    readonly cursor: string | null;
    readonly nextCursor: string | null;
  };
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly ProjectionWarning[];
  readonly summary: string;
};

export type DaemonGuiActionResult = JsonObject & {
  readonly schema: "command-receipt/v2";
  readonly ok: boolean;
  readonly command: string;
  readonly outcome: "applied" | "pending" | "no_changes" | "indeterminate" | "op_rejected";
  readonly opId: string;
};

export type DaemonGuiActionMethod = (typeof daemonGuiActionMethods)[number]["method"];

export type DaemonStreamResultMap = {
  readonly "repo.agentRuntime.attach": AgentRuntimeAttachResult;
  readonly "repo.terminal.attach": JsonObject;
};

export type DaemonStreamMethod = keyof DaemonStreamResultMap;

export type DaemonStreamPayloadMap = {
  readonly "repo.agentRuntime.attach": {
    readonly runtimeSessionId: string;
    readonly afterCursor: string;
  };
  readonly "repo.terminal.attach": {
    readonly sessionId: string;
    readonly afterSeq: number;
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
  };
  readonly diagnostic?: ReceiptDiagnostic;
}

/**
 * Use-case projection transport contract (dec_5B135F46 CH4 layer two).
 *
 * The kernel catalog says which named projections exist and which views consume them; this is the
 * wire half, and — the part that matters — the *single* boundary where a selector is admitted. The
 * precedent (`task_e75157a2d1538a71726603aeef`) shipped facet selectors whose vocabulary ended up
 * restated in five files, so adding a facet to only some of them failed asymmetrically instead of
 * fail-closed. `admitUseCaseProjectionSelector` is called by the RPC request validator, the
 * repo-cell handler and the GUI preload, so all three reject identically.
 *
 * This lives on the thin-CLI/daemon transport path, so it carries no runtime kernel import; the
 * name mirror in `daemon-protocol-vocabulary.ts` is pinned to the kernel type at compile time.
 */
export const useCaseProjectionSchemaId = "daemon.use-case-projection/v1" as const;

export type UseCaseProjectionName = (typeof useCaseProjectionNameWords)[number];

export const useCaseProjectionFacets = Object.freeze({
  "schedule-plane": Object.freeze(["plane"] as const),
  "schedule-run-history": Object.freeze(["runs"] as const),
  "runtime-session-groups": Object.freeze(["groups"] as const),
});

export type UseCaseProjectionFacet = (typeof useCaseProjectionFacetWords)[number];

/**
 * The closed field set a projection may carry, `name` and `facet` included. Anything else on the
 * payload is rejected at the boundary rather than silently ignored by one layer and honoured by
 * the next.
 */
function useCaseProjectionSelectorFields(name: UseCaseProjectionName): readonly string[] {
  const base = ["name", "facet"];
  if (name === "schedule-plane") return base;
  if (name === "schedule-run-history") return [...base, "scheduleId", "limit"];
  return [...base, "groupBy", "since", "query", "agentId", "squadId", "status", "sessionIds", "limit"];
}

export function isUseCaseProjectionName(value: unknown): value is UseCaseProjectionName {
  return typeof value === "string" && (useCaseProjectionNameWords as readonly string[]).includes(value);
}

export function isUseCaseProjectionFacet(name: UseCaseProjectionName, facet: unknown): facet is UseCaseProjectionFacet {
  return typeof facet === "string" && (useCaseProjectionFacets[name] as readonly string[]).includes(facet);
}

/**
 * The one admission routine. Returns the resolved `{name, facet}` or the reason it is inadmissible,
 * so every layer that guards this read rejects for the same reason with the same words.
 */
export function admitUseCaseProjectionSelector(
  payload: Readonly<Record<string, unknown>>,
): { readonly name: UseCaseProjectionName; readonly facet: UseCaseProjectionFacet } | string {
  const { name } = payload;
  if (!isUseCaseProjectionName(name)) return `Use-case projection name is unknown: ${String(name)}.`;
  const facet = payload.facet === undefined ? useCaseProjectionFacets[name][0] : payload.facet;
  if (!isUseCaseProjectionFacet(name, facet))
    return (
      `Use-case projection ${name} has no facet ${String(facet)}; ` +
      `expected ${useCaseProjectionFacets[name].join(", ")}.`
    );
  const allowed = useCaseProjectionSelectorFields(name);
  const unexpected = Object.keys(payload).filter((field) => !allowed.includes(field));
  if (unexpected.length > 0)
    return (
      `Use-case projection ${name}/${facet} does not accept ${unexpected.sort().join(", ")}; ` +
      `expected only ${allowed.join(", ")}.`
    );
  return { name, facet };
}

export type { DaemonUseCaseProjectionPayload, DaemonUseCaseProjectionResult };
