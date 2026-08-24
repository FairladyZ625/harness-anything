import { TextDecoder } from "node:util";
import { sha256Text, stableStringify } from "../../../kernel/src/index.ts";
import type { LedgerCutIdentity } from "../../../kernel/src/index.ts";

export const FLEET_FRAME_BYTES = 96 * 1024,
  FLEET_CHUNK_BYTES = 64 * 1024,
  FLEET_PAGE_ROWS = 128,
  FLEET_KEY_SEND_WINDOW_BYTES = 256 * 1024,
  FLEET_SESSION_SEND_WINDOW_BYTES = 512 * 1024;
export type FleetCut = Readonly<{ revision: number; headDigest: string }>;
// The edge names the exact cut its carried documents were based on — revision
// AND head digest — so a center rollback or same-revision rewrite can never
// pass the mirror gate on numbers alone.
export type FleetMirrorBaseCut = FleetCut;
export type FleetBlob = Readonly<{ sha256: string; size: number; mediaType: string }>;
export type FleetDescriptor = FleetBlob & Readonly<{ ref: string }>;
export const FLEET_TASK_COMMAND_KINDS = Object.freeze([
  "task-create",
  "task-start",
  "task-progress-append",
  "task-submit",
  "task-release",
] as const);
export type FleetTaskCommandKind = (typeof FLEET_TASK_COMMAND_KINDS)[number];
export type FleetTaskAction = Readonly<Record<string, unknown>> & { readonly kind: FleetTaskCommandKind };
// Closed per-kind action surface: every field of a fleet task command must be
// declared for its kind. The daemon re-binds principal authority server-side,
// so identity/origin fields are simply absent from every allowlist (the same
// posture as the mode enum in the daemon protocol contract).
export interface FleetAssignmentScope {
  readonly repoId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly paths: readonly string[];
}
export interface FleetAssignmentBinding extends FleetAssignmentScope {
  readonly nodeId: string;
  readonly assignmentId: string;
  readonly actor: {
    readonly principal: { readonly personId: string };
    readonly executor: { readonly kind: "agent"; readonly id: string } | null;
  };
}
type Msg<S extends string, P extends object = object> = Readonly<{ schema: S; messageId: string }> & Readonly<P>;
export type FleetFrameV1 =
  | Msg<"fleet.session.hello/v1", { protocolVersion: 1; nodeId: string; credential: string }>
  | Msg<"fleet.session.ready/v1", { inReplyTo: string; sessionId: string; maxFrameBytes: number; chunkBytes: number }>
  | Msg<"fleet.assignment.get/v1", { assignmentId: string }>
  | Msg<
      "fleet.assignment.result/v1",
      {
        inReplyTo: string;
        assignmentId: string;
        repoId: string;
        taskId: string;
        executionId: string;
        paths: readonly string[];
        baseLedgerSha: LedgerCutIdentity;
        expiresAt: string;
        writerEpoch: number;
      }
    >
  | Msg<"fleet.receipt.get/v1", { assignmentId: string; opId: string }>
  | Msg<"fleet.receipt.result/v1", { inReplyTo: string; opId: string; receipt: Readonly<Record<string, unknown>> }>
  | Msg<"fleet.upload.begin/v1", { assignmentId: string; content: FleetBlob }>
  | Msg<
      "fleet.upload.ready/v1",
      { inReplyTo: string; uploadId: string; resumeOffset: number; status: "receiving" | "already_staged" }
    >
  | Msg<"fleet.upload.chunk/v1", { uploadId: string; offset: number; dataBase64: string }>
  | Msg<"fleet.upload.finish/v1", { uploadId: string }>
  | Msg<
      "fleet.upload.result/v1",
      { inReplyTo: string; status: "staged" | "already_staged"; descriptor: FleetDescriptor }
    >
  | Msg<
      "fleet.doc.submit/v1",
      {
        assignmentId: string;
        executionId: string | null;
        writerEpoch: number;
        baseLedgerSha: LedgerCutIdentity;
        changes: readonly FleetDocChange[];
      }
    >
  | Msg<
      "fleet.doc.result/v1",
      {
        inReplyTo: string;
        outcome: "applied" | "pending" | "op_rejected" | "indeterminate";
        opId: string;
        revision: number | null;
        code: string | null;
      }
    >
  | Msg<
      "fleet.task.command/v1",
      {
        assignmentId: string;
        writerEpoch: number;
        opId: string;
        repoId: string;
        taskId: string | null;
        action: FleetTaskAction;
        waitMs: number;
        docChanges: readonly FleetDocChange[] | null;
        mirrorBaseCut: FleetMirrorBaseCut | null;
      }
    >
  | Msg<
      "fleet.task.result/v1",
      {
        inReplyTo: string;
        outcome: "applied" | "op_rejected" | "wait_expired";
        opId: string;
        revision: number | null;
        code: string | null;
        receipt: Readonly<Record<string, unknown>> | null;
        lease: {
          readonly taskId: string;
          readonly executionId: string | null;
          readonly assignmentId: string;
          readonly expiresAt: string;
        } | null;
        queuePosition: number | null;
      }
    >
  | Msg<
      "fleet.runtime.event/v1",
      {
        assignmentId: string;
        writerEpoch: number;
        repoId: string;
        opId: string;
        eventType: string;
        payload: Readonly<Record<string, unknown>>;
        result: FleetDescriptor | null;
      }
    >
  | Msg<
      "fleet.runtime.event.result/v1",
      { inReplyTo: string; event: Readonly<Record<string, unknown>>; receipt: Readonly<Record<string, unknown>> }
    >
  | Msg<
      "fleet.runtime.archive/v1",
      { assignmentId: string; writerEpoch: number; repoId: string; archive: Readonly<Record<string, unknown>> }
    >
  | Msg<"fleet.runtime.archive.result/v1", { inReplyTo: string; receipt: Readonly<Record<string, unknown>> }>
  | Msg<
      "fleet.runtime.read/v1",
      {
        assignmentId: string;
        repoId: string;
        method: "repo.agentRuntime.overview" | "repo.agentRuntime.sessions.read";
        payload: Readonly<Record<string, unknown>>;
      }
    >
  | Msg<"fleet.runtime.read.result/v1", { inReplyTo: string; result: Readonly<Record<string, unknown>> }>
  | Msg<"fleet.replica.pull/v1", { assignmentId: string }>
  | Msg<
      "fleet.replica.current/v1",
      { inReplyTo: string; repoId: string; viewId: string; cut: FleetCut; manifestDigest: string }
    >
  | Msg<
      "fleet.snapshot.begin/v1",
      { transferId: string; repoId: string; viewId: string; cut: FleetCut; manifest: FleetManifest }
    >
  | Msg<"fleet.snapshot.page/v1", { transferId: string; pageIndex: number; entries: readonly FleetEntry[] }>
  | Msg<"fleet.snapshot.chunk/v1", { transferId: string; blobSha256: string; offset: number; dataBase64: string }>
  | Msg<"fleet.snapshot.finish/v1", { transferId: string; manifestDigest: string }>
  | Msg<
      "fleet.delta.begin/v1",
      {
        transferId: string;
        repoId: string;
        viewId: string;
        fromCut: FleetCut;
        toCut: FleetCut;
        changeCount: number;
        resultManifestDigest: string;
      }
    >
  | Msg<"fleet.delta.page/v1", { transferId: string; pageIndex: number; changes: readonly FleetDeltaChange[] }>
  | Msg<"fleet.delta.chunk/v1", { transferId: string; blobSha256: string; offset: number; dataBase64: string }>
  | Msg<"fleet.delta.finish/v1", { transferId: string; resultManifestDigest: string }>
  | Msg<"fleet.ack/v1", { transferId: string; cut: FleetCut; manifestDigest: string }>
  | Msg<
      "fleet.ack.result/v1",
      {
        inReplyTo: string;
        outcome: "applied" | "current" | "op_rejected";
        viewId: string;
        ackCut: number;
        code: string | null;
      }
    >
  | Msg<
      "fleet.error/v1",
      { inReplyTo: string; code: string; retryable: boolean; resumeOffset: number | null; nextAction: string }
    >;
export type FleetManifest = Readonly<{ digest: string; entryCount: number; totalBytes: number }>;
export type FleetEntry = Readonly<{ path: string; blob: FleetBlob }>;
export type FleetDocChange = Readonly<{
  path: string;
  baseBlobSha256: string | null;
  policyId: string;
  candidate: FleetDescriptor;
}>;
export type FleetDeltaChange = Readonly<{ op: "put"; path: string; blob: FleetBlob } | { op: "delete"; path: string }>;
export function fleetManifestDigest(entries: readonly FleetEntry[]): string {
  return sha256Text(
    stableStringify(entries.map(({ path, blob }) => ({ path, blob })).sort((a, b) => a.path.localeCompare(b.path))),
  );
}

export class FleetContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FleetContractError";
  }
}
export class FleetUtf8LineDecoder {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  #buffer = "";
  push(chunk: Uint8Array): readonly string[] {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    for (;;) {
      const end = this.#buffer.indexOf("\n");
      if (end < 0) break;
      lines.push(this.#buffer.slice(0, end));
      this.#buffer = this.#buffer.slice(end + 1);
    }
    if (Buffer.byteLength(this.#buffer) > FLEET_FRAME_BYTES)
      throw new FleetContractError("Fleet frame exceeds 98304 bytes");
    return lines;
  }
  finish(): readonly string[] {
    this.#buffer += this.#decoder.decode();
    if (this.#buffer.length) throw new FleetContractError("Fleet stream ended mid-frame");
    return [];
  }
}
type RecordValue = Readonly<Record<string, unknown>>;
type Check = (value: unknown) => boolean;
const id: Check = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,96}$/u.test(value),
  text: Check = (value) => typeof value === "string" && value.length > 0 && value.length <= 512;
const uint: Check = (value) => Number.isSafeInteger(value) && Number(value) >= 0,
  sha64: Check = (value) => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const nullable =
    (check: Check): Check =>
    (value) =>
      value === null || check(value),
  one =
    (...values: readonly unknown[]): Check =>
    (value) =>
      values.includes(value);
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const shape =
  (fields: Readonly<Record<string, Check>>): Check =>
  (value) =>
    record(value) &&
    Object.keys(value).length === Object.keys(fields).length &&
    Object.entries(fields).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]));
const array =
  (check: Check, maximum = FLEET_PAGE_ROWS): Check =>
  (value) =>
    Array.isArray(value) && value.length <= maximum && value.every(check);
const logicalPath: Check = (value) =>
  typeof value === "string" &&
  value === value.normalize("NFC") &&
  value.length <= 512 &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
const base64: Check = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.from(value, "base64").byteLength <= FLEET_CHUNK_BYTES &&
  Buffer.from(value, "base64").toString("base64") === value;
const cut = shape({
    revision: uint,
    headDigest: (value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value),
  }),
  ledgerCut = shape({
    repoId: id,
    revision: uint,
    headDigest: (value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value),
  }),
  mirrorBaseCutShape = cut;
const blob = shape({ sha256: sha64, size: uint, mediaType: text }),
  descriptor = shape({
    ref: (value) => typeof value === "string" && /^doc-sync-claims\/[A-Za-z0-9_-]{1,96}$/u.test(value),
    sha256: sha64,
    size: uint,
    mediaType: text,
  });
const boolean: Check = (value) => typeof value === "boolean",
  positiveInt: Check = (value) => Number.isSafeInteger(value) && Number(value) > 0;
const optionalShape =
  (fields: Readonly<Record<string, Check>>, required: readonly string[]): Check =>
  (value) =>
    record(value) &&
    required.every((field) => Object.hasOwn(value, field)) &&
    Object.entries(value).every(([field, entry]) => Object.hasOwn(fields, field) && fields[field]!(entry));
const registerModule = shape({ key: text, title: text, prefix: text, scope: text });
const taskRelation = shape({ type: text, target: text, rationale: text });
const taskEvidence = shape({ type: text, path: logicalPath, summary: text });
const taskActionShapes: Readonly<Record<FleetTaskCommandKind, Check>> = {
  "task-create": optionalShape(
    {
      kind: one("task-create"),
      title: text,
      taskId: id,
      idempotencyKey: text,
      parentTaskId: id,
      workKind: one("feat", "fix", "refactor", "docs", "test", "chore"),
      riskTier: one("low", "medium", "high"),
      urgency: one("low", "medium", "high"),
      verticalId: text,
      presetId: id,
      profileId: id,
      moduleKey: id,
      registerModule,
      slug: (value) => typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,70}[a-z0-9])?$/u.test(value),
      surfaces: array(text),
      relations: array(taskRelation),
      taskClass: one("standard", "milestone", "epic", "long_running"),
      locale: one("zh-CN", "en-US"),
      dryRun: boolean,
    },
    ["kind"],
  ),
  "task-start": optionalShape(
    { kind: one("task-start"), taskId: id, executionId: id, ttlMs: positiveInt, dryRun: boolean },
    ["kind"],
  ),
  "task-progress-append": optionalShape(
    {
      kind: one("task-progress-append"),
      taskId: id,
      executionId: id,
      text,
      evidence: array(taskEvidence),
      baseDocumentSha256: nullable(sha64),
    },
    ["kind"],
  ),
  "task-submit": optionalShape({ kind: one("task-submit"), taskId: id, executionId: id, submission: record }, ["kind"]),
  "task-release": optionalShape({ kind: one("task-release"), taskId: id, reason: text }, ["kind"]),
};
const taskAction: Check = (value) =>
  record(value) &&
  typeof value.kind === "string" &&
  Object.hasOwn(taskActionShapes, value.kind) &&
  taskActionShapes[value.kind as FleetTaskCommandKind]!(value);
const taskLease = shape({
  taskId: id,
  executionId: nullable(id),
  assignmentId: id,
  expiresAt: (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)),
});
// Liveness is deliberately absent: the edge daemon derives exit/outcome from
// its local process, and no parallel heartbeat or client-reported liveness is
// admitted on the Fleet wire.
const runtimeEventType = one(
  "runtime_installation_observed",
  "runtime_dispatch_requested",
  "runtime_session_started",
  "runtime_session_provider_bound",
  "runtime_session_task_bound",
  "runtime_session_cancelled",
  "runtime_session_exited",
  "runtime_session_outcome_observed",
  "runtime_dispatch_outcome_unknown",
);
const manifest = shape({ digest: sha64, entryCount: uint, totalBytes: uint }),
  entry = shape({ path: logicalPath, blob }),
  put = shape({ op: one("put"), path: logicalPath, blob }),
  del = shape({ op: one("delete"), path: logicalPath });
const docChange = shape({ path: logicalPath, baseBlobSha256: nullable(sha64), policyId: text, candidate: descriptor });
const common = { schema: text, messageId: id } as const,
  reply = { ...common, inReplyTo: id } as const;
const schemas: Readonly<Record<string, Check>> = {
  "fleet.session.hello/v1": shape({ ...common, protocolVersion: one(1), nodeId: id, credential: text }),
  "fleet.session.ready/v1": shape({
    ...reply,
    sessionId: id,
    maxFrameBytes: one(FLEET_FRAME_BYTES),
    chunkBytes: one(FLEET_CHUNK_BYTES),
  }),
  "fleet.assignment.get/v1": shape({ ...common, assignmentId: id }),
  "fleet.assignment.result/v1": shape({
    ...reply,
    assignmentId: id,
    repoId: id,
    taskId: id,
    executionId: id,
    paths: array(logicalPath),
    baseLedgerSha: ledgerCut,
    expiresAt: (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)),
    writerEpoch: uint,
  }),
  "fleet.receipt.get/v1": shape({ ...common, assignmentId: id, opId: id }),
  "fleet.receipt.result/v1": shape({ ...reply, opId: id, receipt: record }),
  "fleet.upload.begin/v1": shape({ ...common, assignmentId: id, content: blob }),
  "fleet.upload.ready/v1": shape({
    ...reply,
    uploadId: id,
    resumeOffset: uint,
    status: one("receiving", "already_staged"),
  }),
  "fleet.upload.chunk/v1": shape({ ...common, uploadId: id, offset: uint, dataBase64: base64 }),
  "fleet.upload.finish/v1": shape({ ...common, uploadId: id }),
  "fleet.upload.result/v1": shape({ ...reply, status: one("staged", "already_staged"), descriptor }),
  "fleet.doc.submit/v1": shape({
    ...common,
    assignmentId: id,
    executionId: nullable(id),
    writerEpoch: uint,
    baseLedgerSha: ledgerCut,
    changes: array(docChange),
  }),
  "fleet.doc.result/v1": shape({
    ...reply,
    outcome: one("applied", "pending", "op_rejected", "indeterminate"),
    opId: text,
    revision: nullable(uint),
    code: nullable(text),
  }),
  "fleet.task.command/v1": shape({
    ...common,
    assignmentId: id,
    writerEpoch: uint,
    opId: id,
    repoId: id,
    taskId: nullable(id),
    action: taskAction,
    waitMs: uint,
    docChanges: nullable(array(docChange, 128)),
    mirrorBaseCut: nullable(mirrorBaseCutShape),
  }),
  "fleet.task.result/v1": shape({
    ...reply,
    outcome: one("applied", "op_rejected", "wait_expired"),
    opId: id,
    revision: nullable(uint),
    code: nullable(text),
    receipt: nullable(record),
    lease: nullable(taskLease),
    queuePosition: nullable(uint),
  }),
  "fleet.runtime.event/v1": shape({
    ...common,
    assignmentId: id,
    writerEpoch: uint,
    repoId: id,
    opId: id,
    eventType: runtimeEventType,
    payload: record,
    result: nullable(descriptor),
  }),
  "fleet.runtime.event.result/v1": shape({ ...reply, event: record, receipt: record }),
  "fleet.runtime.archive/v1": shape({ ...common, assignmentId: id, writerEpoch: uint, repoId: id, archive: record }),
  "fleet.runtime.archive.result/v1": shape({ ...reply, receipt: record }),
  "fleet.runtime.read/v1": shape({
    ...common,
    assignmentId: id,
    repoId: id,
    method: one("repo.agentRuntime.overview", "repo.agentRuntime.sessions.read"),
    payload: record,
  }),
  "fleet.runtime.read.result/v1": shape({ ...reply, result: record }),
  "fleet.replica.pull/v1": shape({ ...common, assignmentId: id }),
  "fleet.replica.current/v1": shape({ ...reply, repoId: id, viewId: id, cut, manifestDigest: sha64 }),
  "fleet.snapshot.begin/v1": shape({ ...common, transferId: id, repoId: id, viewId: id, cut, manifest }),
  "fleet.snapshot.page/v1": shape({ ...common, transferId: id, pageIndex: uint, entries: array(entry) }),
  "fleet.snapshot.chunk/v1": shape({ ...common, transferId: id, blobSha256: sha64, offset: uint, dataBase64: base64 }),
  "fleet.snapshot.finish/v1": shape({ ...common, transferId: id, manifestDigest: sha64 }),
  "fleet.delta.begin/v1": shape({
    ...common,
    transferId: id,
    repoId: id,
    viewId: id,
    fromCut: cut,
    toCut: cut,
    changeCount: uint,
    resultManifestDigest: sha64,
  }),
  "fleet.delta.page/v1": shape({
    ...common,
    transferId: id,
    pageIndex: uint,
    changes: array((value) => put(value) || del(value)),
  }),
  "fleet.delta.chunk/v1": shape({ ...common, transferId: id, blobSha256: sha64, offset: uint, dataBase64: base64 }),
  "fleet.delta.finish/v1": shape({ ...common, transferId: id, resultManifestDigest: sha64 }),
  "fleet.ack/v1": shape({ ...common, transferId: id, cut, manifestDigest: sha64 }),
  "fleet.ack.result/v1": shape({
    ...reply,
    outcome: one("applied", "current", "op_rejected"),
    viewId: id,
    ackCut: uint,
    code: nullable(text),
  }),
  "fleet.error/v1": shape({
    ...reply,
    code: text,
    retryable: (value) => typeof value === "boolean",
    resumeOffset: nullable(uint),
    nextAction: text,
  }),
};
export function parseFleetFrame(input: string | unknown): FleetFrameV1 {
  if (typeof input === "string" && Buffer.byteLength(input) > FLEET_FRAME_BYTES)
    throw new FleetContractError("Fleet frame exceeds 98304 bytes");
  let value: unknown;
  try {
    value = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    throw new FleetContractError("Fleet frame is not valid JSON");
  }
  if (!record(value) || typeof value.schema !== "string" || !schemas[value.schema]?.(value))
    throw new FleetContractError(
      `Fleet frame violates closed schema ${record(value) ? String(value.schema) : "unknown"}`,
    );
  if (Buffer.byteLength(JSON.stringify(value)) > FLEET_FRAME_BYTES)
    throw new FleetContractError("Fleet frame exceeds 98304 bytes");
  return value as FleetFrameV1;
}
export function serializeFleetFrame(value: unknown): string {
  return `${JSON.stringify(parseFleetFrame(value))}\n`;
}
