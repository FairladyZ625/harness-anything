import type {
  CanonicalEventV1,
  DaemonRepoMode,
  DecisionProjectionRow,
  FreshnessReason,
  ProjectionPage,
  ProjectionWarning,
  RelationCoverageRow,
  RelationFactRow,
  RelationGraphEdgeRow,
  ReceiptDiagnostic,
  TaskProjection,
  SettingsV1,
  EntityActionExplanationSetV1,
} from "../../../kernel/src/index.ts";
import type { AgentEntityGuiRead, AgentSkillGuiRead } from "../agent-entities.ts";
import type {
  AgentRuntimeEventsResult,
  AgentRuntimeOverviewResult,
  AgentRuntimeSessionResult,
} from "../agent-runtime-contract.ts";
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
      rule === "string-null?" ||
      rule === "number" ||
      rule === "number?" ||
      rule === "boolean?"
    ) {
      const type = rule.startsWith("string") ? "string" : rule === "boolean?" ? "boolean" : "number";
      if (typeof item !== type || (type === "string" && !item)) errors.push(`${prefix}.${field} must be ${type}`);
    } else errors.push(...validateShape(item, rule as RpcShape, `${prefix}.${field}`));
  }
  return errors;
}

export const observeTailKinds = ["events", "repo-log", "daemon-log", "dispatch"] as const;
export type ObserveTailKind = (typeof observeTailKinds)[number];
export const observeTailDirections = ["history", "follow"] as const;
export type ObserveTailDirection = (typeof observeTailDirections)[number];

export type ObserveTailCursor =
  | { readonly kind: "events"; readonly revision: number }
  | { readonly kind: "repo-log"; readonly fileId: string; readonly offset: number }
  | { readonly kind: "daemon-log"; readonly fileId: string; readonly offset: number }
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
  readonly "repo.tasks.list": DaemonTaskSnapshotListResult;
  readonly "repo.projection.read": DaemonUseCaseProjectionResult;
  readonly "repo.entity.actions.explain": EntityActionExplanationSetV1;
  readonly "repo.settings.read": {
    readonly schema: "daemon.settings-read/v1";
    readonly ok: true;
    readonly settings: SettingsV1;
  };
  readonly "repo.ci.observatory.read": import("../ci-observatory-read.ts").CiObservatoryRead;
  readonly "repo.workspace.summary.read": DaemonWorkspaceSummaryResult;
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
    /** Live worktree view (task_e5defe69): disk content now, and whether it diverges
     * from the committed projection. Null body = no such file on disk. */
    readonly worktreeBody: string | null;
    readonly uncommitted: boolean;
    readonly watermark: number;
    readonly sourceRevision: number;
  };
  readonly "repo.tasks.documents.list": DaemonTaskDocumentListResult;
  readonly "repo.artifacts.list": ArtifactsListResult;
  readonly "repo.agentRuntime.overview": AgentRuntimeOverviewResult;
  readonly "repo.agentRuntime.sessions.read": AgentRuntimeSessionResult;
  readonly "repo.agentRuntime.events.read": AgentRuntimeEventsResult;
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

export type DaemonHostOnlyGuiReadMethod = "repo.workspace.summary.read" | "observe.tail";

/** Historical cell-routable read union. Host-owned aggregate reads use the full RPC union below. */
export type DaemonGuiReadMethod = Exclude<keyof DaemonGuiReadResultMap, DaemonHostOnlyGuiReadMethod>;

export type DaemonGuiRpcReadMethod = keyof DaemonGuiReadResultMap;

export type DaemonGuiReadPayloadMap = {
  readonly "daemon.gui.system.read": Readonly<Record<string, never>>;
  readonly "daemon.gui.control.receipt": { readonly operationId: string };
  readonly "observe.tail": ObserveTailPayload;
  readonly "repo.tasks.list": DaemonTaskQueryPayload;
  readonly "repo.projection.read": DaemonUseCaseProjectionPayload;
  readonly "repo.entity.actions.explain": {
    readonly schema: "entity-action-explain-request/v1";
    readonly mode: "catalog" | "object";
    readonly entityKind: string | null;
    readonly refs: readonly string[];
  };
  readonly "repo.settings.read": Readonly<Record<string, never>>;
  readonly "repo.ci.observatory.read": { readonly window?: number };
  readonly "repo.workspace.summary.read": Readonly<Record<string, never>>;
  readonly "repo.agenda.read": DaemonAgendaPayload;
  readonly "repo.triadic.relationGraph": DaemonRelationQueryPayload;
  readonly "repo.decisions.list": DaemonDecisionListPayload;
  readonly "repo.tasks.document.read": {
    readonly taskId: string;
    readonly path: string;
  };
  readonly "repo.tasks.documents.list": { readonly taskId: string };
  /** absent kind = html(时间线默认面);md 是显式 opt-in。 */
  readonly "repo.artifacts.list": { readonly kind?: "html" | "md" };
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
}

export interface DaemonRelationQueryPayload {
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

export type DaemonRelationGraphFacet = "edges" | "facts" | "coverageRows" | "factAnchors" | "runtimeEdges";

export interface DaemonRelationEdgeFacetPayload {
  readonly facet: "edges";
  readonly relationType?: string;
  readonly state?: string;
  readonly direction?: "directed" | "undirected";
}

export type DaemonRelationGraphFacetPayload =
  | DaemonRelationEdgeFacetPayload
  | { readonly facet: Exclude<DaemonRelationGraphFacet, "edges"> };

export interface DaemonFactSummaryRow {
  readonly anchor: string;
  readonly text: string;
  readonly category: "lesson" | "finding" | "progress";
  readonly taskId?: string;
}

type EventProjectionCut = Pick<
  ReturnType<TaskProjection["readRelationQuery"]>,
  "status" | "watermark" | "sourceRevision"
>;
type DaemonRelationGraphProjection = {
  readonly edges: ReturnType<TaskProjection["readRelationQuery"]>["rows"];
  readonly factAnchors: ReturnType<TaskProjection["readFactAnchors"]>["rows"];
  readonly facts: readonly RelationFactRow[];
  readonly warnings: readonly ProjectionWarning[];
};

type ServedCoverageRow = RelationCoverageRow & { readonly freshnessReason?: FreshnessReason };

export type DaemonRelationGraphFullResult = { readonly ok: true } & EventProjectionCut &
  DaemonRelationGraphProjection & {
    /** Coverage rows as served: the kernel row plus the optional uncovered-cause
     * classification (kernel `freshnessReasonOf`), attached only to uncovered rows.
     * Optional so older daemons and every persisted record shape stay valid. */
    readonly coverageRows: readonly ServedCoverageRow[];
    readonly page?: ProjectionPage;
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
      })
  | ({ readonly ok: true; readonly facet: "coverageRows" } & EventProjectionCut &
      Omit<EmptyRelationFacetRows, "coverageRows"> & {
        readonly coverageRows: readonly ServedCoverageRow[];
      })
  | ({ readonly ok: true; readonly facet: "factAnchors" } & EventProjectionCut &
      Omit<EmptyRelationFacetRows, "factAnchors"> & {
        readonly factAnchors: DaemonRelationGraphProjection["factAnchors"];
      })
  | ({ readonly ok: true; readonly facet: "facts" } & EventProjectionCut &
      Omit<EmptyRelationFacetRows, "facts" | "domainTypes"> & {
        readonly facts: readonly DaemonFactSummaryRow[];
        readonly domainTypes: ReturnType<TaskProjection["listFactDomainTypes"]>["domainTypes"];
      })
  | ({ readonly ok: true; readonly facet: "runtimeEdges" } & Omit<EmptyRelationFacetRows, "edges"> & {
        readonly edges: readonly RelationGraphEdgeRow[];
      });

export type DaemonRelationGraphResult = DaemonRelationGraphFullResult | DaemonRelationGraphFacetResult;

export interface DaemonDecisionSummaryRow {
  readonly decisionId: string;
  readonly title: string;
  readonly state: DecisionProjectionRow["state"];
  readonly appliesTo: DecisionProjectionRow["appliesTo"];
}

export interface DaemonDecisionListPayload {
  readonly projection?: "summary" | "full";
}

export type DaemonDecisionListResult =
  | {
      readonly ok: true;
      readonly projection?: "full";
      readonly decisions: readonly DecisionProjectionRow[];
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
  readonly moduleKeys: readonly string[];
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

export interface GuiSubmissionV1 {
  readonly completionClaim: string;
  readonly deliverables: readonly string[];
  readonly outputs: readonly string[];
  readonly verificationNotes: readonly string[];
  readonly knownGaps: readonly string[];
  readonly residualRisks: readonly string[];
  readonly commitSha: string;
}

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

export interface TaskDispatchRow {
  readonly dispatchId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly runtimeSessionId: string;
  readonly instanceId: string;
  readonly attemptGroupId: string;
  readonly attemptIndex: number;
  readonly provider: { readonly instance: string; readonly model: string | null };
  readonly classification: "provider_fault" | "worker_stop" | "gate_red" | null;
  readonly reason: string | null;
  readonly fallbackState: "scheduled" | "dispatched" | "exhausted" | null;
  readonly nextDispatchId: string | null;
  readonly agentId?: string;
  readonly agentName?: string;
  readonly delegatedByAgentId?: string;
  readonly delegatedByAgentName?: string;
  readonly squadId?: string;
  readonly parentRuntimeSessionId?: string;
  readonly providerSessionId: string | null;
  readonly eventStreamRef: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled" | null;
  readonly status: "running" | "succeeded" | "failed" | "unknown" | "cancelled" | "lost";
  /** Terminal result and durable task-package artifact locations, when settled. */
  readonly resultRef?: string | null;
  readonly exitCode?: number | null;
  readonly dispatchPath?: string | null;
  readonly reportPath?: string | null;
}

export type DaemonTaskDispatchesResultBase = {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly dispatches: readonly TaskDispatchRow[];
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
    readonly coordinationStatus: import("../../../kernel/src/domain/lifecycle-status.ts").DomainStatus | "unknown";
    readonly snapshotAvailability: {
      readonly consents: "known" | "unknown";
      readonly codeDocWitnesses: "known" | "unknown";
      readonly gateWitnesses: "known" | "unknown";
    };
    readonly closeoutAssessment: import("../../../kernel/src/domain/closeout-readiness.ts").CloseoutAssessment;
    readonly blockingAssessment: import("../../../kernel/src/domain/task-blocking.ts").BlockingAssessment;
    readonly placement: TaskPlacementSupplement;
    readonly executionEvidence: readonly ExecutionEvidenceProjection[];
  })[];
  readonly invalidRows: readonly DaemonTaskSnapshotInvalidRow[];
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly TaskProjectionWarning[];
  readonly page?: ProjectionPage;
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
  readonly tasks: import("../../../kernel/src/domain/workspace-summary.ts").WorkspaceTaskSummary;
  readonly decisions: import("../../../kernel/src/domain/workspace-summary.ts").WorkspaceDecisionSummary;
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly ProjectionWarning[];
};

export interface AgendaTaskRow {
  readonly taskId: string;
  readonly title: string;
  readonly status: (typeof taskStatusWords)[number];
  readonly pinned: boolean;
  readonly updatedAt: string;
  readonly leaseExecutionId: string | null;
  readonly activeExecutionIds: readonly string[];
  readonly blockingAssessment: import("../../../kernel/src/domain/task-blocking.ts").BlockingAssessment;
}

export type AgendaAwaitingRow =
  | {
      readonly kind: "execution";
      readonly taskId: string;
      readonly title: string;
      readonly pinned: boolean;
      readonly executionId: string;
      readonly submittedAt: string;
      readonly blockingAssessment: import("../../../kernel/src/domain/task-blocking.ts").BlockingAssessment;
    }
  | {
      readonly kind: "decision";
      readonly decisionId: string;
      readonly title: string;
      readonly riskTier: "low" | "medium" | "high";
      readonly urgency: "low" | "medium" | "high";
      readonly proposedAt: string;
    };

export type DaemonAgendaResult = {
  readonly schema: "daemon.agenda/v1";
  readonly ok: true;
  readonly command: "agenda";
  readonly status: "ready" | "pending";
  readonly inFlight: readonly AgendaTaskRow[];
  readonly awaitingDecision: readonly AgendaAwaitingRow[];
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
  readonly error: { readonly code: string; readonly hint: string };
  readonly nextAction: string;
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
  return [...base, "groupBy", "since", "query", "agentId", "squadId", "limit"];
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

export interface DaemonUseCaseProjectionResult {
  readonly schema: typeof useCaseProjectionSchemaId;
  readonly ok: true;
  readonly name: UseCaseProjectionName;
  readonly facet: UseCaseProjectionFacet;
  readonly version: number;
  /** Derived from `entityKindContracts` at read time, never restated on the wire declaration. */
  readonly inputs: { readonly entityKinds: readonly string[]; readonly relationTypes: readonly string[] };
  readonly projection: unknown;
}

export interface DaemonUseCaseProjectionPayload {
  readonly name: UseCaseProjectionName;
  readonly facet?: UseCaseProjectionFacet;
  readonly scheduleId?: string;
  readonly groupBy?: "task" | "squad" | "agent" | "day";
  readonly agentId?: string;
  readonly squadId?: string;
  readonly since?: string;
  readonly query?: string;
  readonly limit?: number;
}
