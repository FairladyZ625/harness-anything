import type {
  CanonicalEventV1,
  DaemonRepoMode,
  DecisionProjectionRow,
  FreshnessReason,
  ProjectionPage,
  ProjectionWarning,
  RelationCoverageRow,
  TaskProjection,
} from "../../../kernel/src/index.ts";
import type { AgentEntityGuiRead, AgentSkillGuiRead } from "../agent-entities.ts";
import type {
  AgentRuntimeEventsResult,
  AgentRuntimeOverviewResult,
  AgentRuntimeSessionGroupsResult,
  AgentRuntimeSessionResult,
} from "../agent-runtime-contract.ts";
import type { AgentRuntimeAttachResult } from "../agent-runtime-stream.ts";
import type { SquadRunsListResult } from "../squad-run-contract.ts";
import type { daemonGuiActionMethods } from "./daemon-protocol-gui-actions.ts";
import { taskStatusWords } from "./daemon-protocol-vocabulary.ts";
import { isJsonObject, type JsonObject } from "./json-rpc-types.ts";

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

export const shape = (fields: RpcShape["fields"], open = false): RpcShape => ({
  fields,
  open,
});

export const optionalEnum = (values: readonly string[]): RpcEnumRule => ({
  values,
  optional: true,
});

export const observeTailKinds = ["events", "repo-log", "daemon-log"] as const;
export type ObserveTailKind = (typeof observeTailKinds)[number];

export type ObserveTailCursor =
  | { readonly kind: "events"; readonly revision: number }
  | { readonly kind: "repo-log"; readonly fileId: string; readonly offset: number }
  | { readonly kind: "daemon-log"; readonly fileId: string; readonly offset: number };

export type ObserveTailPayload =
  | {
      readonly kind: "events";
      readonly cursor?: Extract<ObserveTailCursor, { readonly kind: "events" }>;
    }
  | {
      readonly kind: "repo-log";
      readonly cursor?: Extract<ObserveTailCursor, { readonly kind: "repo-log" }>;
    }
  | {
      readonly kind: "daemon-log";
      readonly cursor?: Extract<ObserveTailCursor, { readonly kind: "daemon-log" }>;
    };

type ObserveTailBase = {
  readonly schema: "daemon.observe-tail/v1";
  readonly ok: true;
  readonly repoId: string;
  readonly mode: DaemonRepoMode;
  readonly kind: ObserveTailKind;
  readonly items: readonly (CanonicalEventV1 | Readonly<Record<string, unknown>>)[];
  readonly cursor: ObserveTailCursor | null;
  readonly sourceCursor: ObserveTailCursor | null;
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
  if (Object.keys(value).some((key) => key !== "kind" && key !== "cursor"))
    return ["observe tail payload contains an unknown field"];
  if (!observeTailKinds.includes(value.kind as ObserveTailKind)) return ["observe tail kind is invalid"];
  if (value.cursor === undefined) return [];
  return validateObserveTailCursor(value.cursor, value.kind as ObserveTailKind)
    ? []
    : ["observe tail cursor is invalid for the requested kind"];
}

export function validateObserveTailResult(value: unknown): readonly string[] {
  if (
    !isJsonObject(value) ||
    value.schema !== "daemon.observe-tail/v1" ||
    value.ok !== true ||
    typeof value.repoId !== "string" ||
    !value.repoId ||
    !["local", "remote-center", "remote-edge"].includes(String(value.mode)) ||
    !observeTailKinds.includes(value.kind as ObserveTailKind) ||
    !["ready", "pending", "unavailable", "gap"].includes(String(value.status)) ||
    !Array.isArray(value.items) ||
    value.items.length > 64 ||
    value.items.some((item) => !isJsonObject(item)) ||
    typeof value.done !== "boolean" ||
    !nullableObserveCursor(value.cursor, value.kind as ObserveTailKind) ||
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
  "status",
  "items",
  "cursor",
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
    (value.kind !== "events" || (value.cursor !== null && value.sourceCursor !== null))
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
      value.cursor === null &&
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
      value.cursor === null &&
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
  readonly "repo.workspace.summary.read": DaemonWorkspaceSummaryResult;
  readonly "repo.agenda.read": DaemonAgendaResult;
  readonly "repo.triadic.relationGraph": { readonly ok: true } & Omit<
    ReturnType<typeof import("../../../kernel/src/projection/sqlite-task-projection.ts").readRelationGraphProjection>,
    "taskRows" | "coverageRows"
  > & {
      /** Coverage rows as served: the kernel row plus the optional uncovered-cause
       * classification (kernel `freshnessReasonOf`), attached only to uncovered rows.
       * Optional so older daemons and every persisted record shape stay valid. */
      readonly coverageRows: readonly (RelationCoverageRow & { readonly freshnessReason?: FreshnessReason })[];
      readonly page?: ProjectionPage;
    };
  readonly "repo.decisions.list": {
    readonly ok: true;
    readonly decisions: readonly DecisionProjectionRow[];
    readonly warnings: readonly ProjectionWarning[];
  };
  readonly "repo.tasks.document.read": {
    readonly ok: true;
    readonly status: "ready" | "pending";
    readonly taskId: string;
    readonly path: string;
    readonly body: string;
    readonly blobSha256: string | null;
    readonly watermark: number;
    readonly sourceRevision: number;
  };
  readonly "repo.tasks.documents.list": DaemonTaskDocumentListResult;
  readonly "repo.agentRuntime.overview": AgentRuntimeOverviewResult;
  readonly "repo.agentRuntime.sessionGroups": AgentRuntimeSessionGroupsResult;
  readonly "repo.agentRuntime.sessions.read": AgentRuntimeSessionResult;
  readonly "repo.agentRuntime.events.read": AgentRuntimeEventsResult;
  readonly "repo.task.dispatches": DaemonTaskDispatchesResult;
  readonly "repo.agent.entities.list": Extract<AgentEntityGuiRead, { readonly schema: "agent-entity-catalog/v1" }>;
  readonly "repo.agent.entity.read": Extract<AgentEntityGuiRead, { readonly schema: "agent-entity-detail/v1" }>;
  readonly "repo.agent.skills.list": AgentSkillGuiRead;
  readonly "repo.squad.entities.list": Extract<AgentEntityGuiRead, { readonly schema: "squad-entity-catalog/v1" }>;
  readonly "repo.squad.entity.read": Extract<AgentEntityGuiRead, { readonly schema: "squad-entity-detail/v1" }>;
  readonly "repo.squad.runs.list": SquadRunsListResult;
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
  readonly "repo.workspace.summary.read": Readonly<Record<string, never>>;
  readonly "repo.agenda.read": DaemonAgendaPayload;
  readonly "repo.triadic.relationGraph": DaemonRelationQueryPayload;
  readonly "repo.decisions.list": Readonly<Record<string, never>>;
  readonly "repo.tasks.document.read": {
    readonly taskId: string;
    readonly path: string;
  };
  readonly "repo.tasks.documents.list": { readonly taskId: string };
  readonly "repo.agentRuntime.overview": {
    readonly taskId?: string;
    readonly limit?: number;
    readonly cursor?: string;
  };
  readonly "repo.agentRuntime.sessionGroups": {
    readonly groupBy?: "task" | "squad" | "agent" | "day";
    readonly since?: string;
    readonly query?: string;
    readonly limit?: number;
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
  readonly status?: string;
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

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
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly TaskProjectionWarning[];
  readonly page?: ProjectionPage;
};

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

export type DaemonGuiStreamResultMap = {
  readonly "repo.agentRuntime.attach": AgentRuntimeAttachResult;
  readonly "repo.terminal.attach": JsonObject;
};

export type DaemonGuiStreamMethod = keyof DaemonGuiStreamResultMap;

export type DaemonGuiStreamPayloadMap = {
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
}
