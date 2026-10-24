// dec_9284BD6119D453EEECEED62450: command frames only; replica frames live in protocol.ts.
import { TextDecoder } from "node:util";
import {
  actionDeclarations,
  CONTRACT_VERSION_1_0,
  getExecutableEntityAction,
  isContractVersion,
  type ContractVersion,
  type LedgerCutIdentity,
  type EntityActionInputField,
} from "@harness-anything/kernel";
import { runtimeEffortValues } from "@harness-anything/kernel/runtime-effort";
import { daemonProtocolCommands } from "../protocol/daemon-protocol-commands.ts";
import { isUtcTimestamp } from "../protocol/json-rpc-types.ts";

export const currentFleetProtocolVersion = CONTRACT_VERSION_1_0;

export const FLEET_FRAME_BYTES = 96 * 1024,
  FLEET_CHUNK_BYTES = 64 * 1024,
  /** An upload declaration larger than this is an invalid frame; chunks may never write past it. */
  FLEET_UPLOAD_MAX_BYTES = 64 * 1024 * 1024,
  /** An unauthenticated connection is cut when its hello has not been admitted within this window. */
  FLEET_HELLO_TIMEOUT_MS = 30_000,
  /** Failed hello authentications one connection source may produce before its next hello is refused locally. */
  FLEET_HELLO_FAILURE_LIMIT = 5,
  FLEET_HELLO_FAILURE_WINDOW_MS = 60_000,
  FLEET_PAGE_ROWS = 128,
  FLEET_KEY_SEND_WINDOW_BYTES = 256 * 1024,
  FLEET_SESSION_SEND_WINDOW_BYTES = 512 * 1024;
export type FleetCut = Readonly<{ revision: number; headDigest: string; schemaGeneration: number }>;
// The edge names the exact cut its carried documents were based on — revision
// AND head digest — so a center rollback or same-revision rewrite can never
// pass the mirror gate on numbers alone.
export type FleetMirrorBaseCut = Readonly<{ revision: number; headDigest: string }>;
export type FleetBlob = Readonly<{ sha256: string; size: number; mediaType: string }>;
export type FleetDescriptor = FleetBlob & Readonly<{ ref: string }>;
export type FleetTaskCommandKind = string;
export interface FleetLoginAuthority {
  readonly url: string;
  readonly realm: string;
  readonly clientId: string;
  readonly certificate?: string;
}
export type FleetTaskAction = Readonly<Record<string, unknown>> & { readonly kind: FleetTaskCommandKind };
// Closed per-kind action surface: every field of a fleet task command must be
// declared for its kind. The daemon re-binds principal authority server-side,
// so identity/origin fields are simply absent from every allowlist (the same
// posture as the mode enum in the daemon protocol contract).
/** Transient center admission context; it is validated but never copied into the canonical event. */
export interface FleetRuntimeDispatchContext {
  readonly role: string | null;
  readonly taskId: string | null;
  readonly executionId: string | null;
}
type Msg<S extends string, P extends object = object> = S extends string
  ? Readonly<{ schema: S; messageId: string; accessToken?: string; humanClientId?: string }> & Readonly<P>
  : never;
export interface FleetDeviceLoginNotice {
  readonly userCode: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly pending: boolean;
}

export type FleetFrameV1 =
  | Msg<"fleet.edge.join/v1", { joinId: string; inviteToken: string }>
  | Msg<
      "fleet.edge.join.result/v1",
      {
        inReplyTo: string;
        joinId: string;
        nodeId: string;
        personId: string;
        credential: string;
        repositories: readonly { readonly repoId: string; readonly harnessYaml: string }[];
      }
    >
  | Msg<"fleet.device.sessions.revoke/v1">
  | Msg<"fleet.device.sessions.revoked/v1", { inReplyTo: string }>
  | Msg<"fleet.device.login/v1", FleetDeviceLoginNotice>
  | Msg<"fleet.device.login.result/v1", { inReplyTo: string }>
  | Msg<"fleet.session.hello/v1", { protocolVersion: ContractVersion; nodeId: string; credential: string }>
  | Msg<
      "fleet.session.ready/v1",
      {
        inReplyTo: string;
        sessionId: string;
        maxFrameBytes: number;
        chunkBytes: number;
        loginAuthority?: FleetLoginAuthority | null;
      }
    >
  | Msg<
      "fleet.repo.metadata.get/v1",
      { executionCredential?: string; repoId: string; actionKind?: string; taskId?: string }
    >
  | Msg<
      "fleet.repo.metadata.result/v1",
      {
        inReplyTo: string;
        repoId: string;
        baseLedgerSha: LedgerCutIdentity;
        writerEpoch: number;
        /** The center's replication head when it answered; an edge sync waits for its stream to reach it. */
        replicationSequence: number | null;
        personId: string;
        actionAllowed: boolean | null;
      }
    >
  | Msg<"fleet.receipt.get/v1", { repoId: string; opId: string }>
  | Msg<"fleet.receipt.result/v1", { inReplyTo: string; opId: string; receipt: Readonly<Record<string, unknown>> }>
  | Msg<"fleet.upload.begin/v1", { repoId: string; opId: string; content: FleetBlob }>
  | Msg<
      "fleet.upload.ready/v1",
      {
        inReplyTo: string;
        uploadId: string;
        resumeOffset: number;
        status: "receiving" | "already_staged";
        replicationSequence: number | null;
      }
    >
  | Msg<"fleet.upload.chunk/v1", { uploadId: string; opId: string; offset: number; dataBase64: string }>
  | Msg<"fleet.upload.finish/v1", { uploadId: string; opId: string }>
  | Msg<
      "fleet.upload.result/v1",
      {
        inReplyTo: string;
        status: "staged" | "already_staged";
        descriptor: FleetDescriptor;
        replicationSequence: number | null;
      }
    >
  | Msg<
      "fleet.doc.submit/v1",
      {
        opId: string;
        executionCredential?: string;
        taskId?: string;
        repoId: string;
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
        outcome: "applied" | "pending" | "no_changes" | "op_rejected" | "indeterminate";
        opId: string;
        revision: number | null;
        replicationSequence: number | null;
        code: string | null;
        receipt: Readonly<Record<string, unknown>>;
      }
    >
  | Msg<
      "fleet.task.command/v1",
      {
        executionCredential?: string;
        artifact?: FleetDescriptor;
        writerEpoch: number;
        opId: string;
        repoId: string;
        taskId: string | null;
        action: FleetTaskAction;
        docChanges: readonly FleetDocChange[] | null;
        mirrorBaseCut: FleetMirrorBaseCut | null;
      }
    >
  | Msg<"fleet.task.evidence/v1", { inReplyTo: string; dataBase64: string }>
  | Msg<
      "fleet.task.result/v1",
      {
        inReplyTo: string;
        outcome: "applied" | "op_rejected";
        opId: string;
        revision: number | null;
        /** Center replication head after this command; a write-then-read waits for the edge to apply it. */
        replicationSequence: number | null;
        appliedCut?: FleetCut | null;
        code: string | null;
        receipt: Readonly<Record<string, unknown>> | null;
      }
    >
  | Msg<
      "fleet.schedule.command/v1",
      {
        writerEpoch: number;
        opId: string;
        repoId: string;
        scheduleId: string;
        action: Readonly<Record<string, unknown>> & { readonly kind: string };
      }
    >
  | Msg<
      "fleet.schedule.result/v1",
      {
        inReplyTo: string;
        opId: string;
        outcome: "applied" | "pending" | "no_changes" | "op_rejected" | "indeterminate";
        revision: number | null;
        /** Center replication head after this command; applied edge writes wait until it is local. */
        replicationSequence: number | null;
        code: string | null;
        receipt: Readonly<Record<string, unknown>>;
      }
    >
  | Msg<
      "fleet.runtime.event/v1",
      {
        writerEpoch: number;
        repoId: string;
        opId: string;
        eventType: string;
        payload: Readonly<Record<string, unknown>>;
        result: FleetDescriptor | null;
        dispatchContext: FleetRuntimeDispatchContext | null;
      }
    >
  | Msg<
      "fleet.runtime.event.result/v1",
      {
        inReplyTo: string;
        replicationSequence: number | null;
        event: Readonly<Record<string, unknown>> | null;
        receipt: Readonly<Record<string, unknown>>;
      }
    >
  | Msg<
      "fleet.runtime.archive/v1",
      { writerEpoch: number; repoId: string; opId: string; archive: Readonly<Record<string, unknown>> }
    >
  | Msg<
      "fleet.runtime.archive.result/v1",
      { inReplyTo: string; replicationSequence: number | null; receipt: Readonly<Record<string, unknown>> }
    >
  | Msg<
      "fleet.operational.read/v1",
      {
        repoId: string;
        method: "repo.agentRuntime.sessions.await" | "repo.task.dispatches";
        payload: Readonly<Record<string, unknown>>;
      }
    >
  | Msg<"fleet.operational.read.result/v1", { inReplyTo: string; result: Readonly<Record<string, unknown>> }>
  | Msg<
      "fleet.error/v1",
      { inReplyTo: string; code: string; message: string; retryable: boolean; resumeOffset: number | null }
    >;
export type FleetDocChange = Readonly<{
  path: string;
  baseBlobSha256: string | null;
  policyId: string;
  candidate: FleetDescriptor;
}>;
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
// Document bodies (task plans, schedule missions) cross the wire whole; their
// upper bound is the body budget, with the frame cap as the outer limit.
const bodyText: Check = (value) => typeof value === "string" && value.length > 0 && value.length <= 32 * 1024;
const accessToken: Check = (value) =>
  typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 16 * 1024;
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
const loginAuthority: Check = (value) =>
  record(value) &&
  (Object.keys(value).length === 3 || Object.keys(value).length === 4) &&
  typeof value.url === "string" &&
  typeof value.realm === "string" &&
  typeof value.clientId === "string" &&
  (Object.keys(value).length === 3 || (Object.hasOwn(value, "certificate") && typeof value.certificate === "string"));
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
    schemaGeneration: uint,
  }),
  ledgerCut = shape({
    repoId: id,
    revision: uint,
    headDigest: (value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value),
  }),
  mirrorBaseCutShape = shape({
    revision: uint,
    headDigest: (value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value),
  });
const uploadSize: Check = (value) => uint(value) && Number(value) <= FLEET_UPLOAD_MAX_BYTES,
  blob = shape({ sha256: sha64, size: uploadSize, mediaType: text }),
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
/* The command declaration is the fleet surface: admission chooses the route and
 * its input contract closes the wire object. Adding a command never requires a
 * second fleet list or validator. */
const fieldName = (name: string) => name.slice(2).replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase()),
  fleetCommand = (kind: string) =>
    daemonProtocolCommands.find(
      (command) =>
        ("actionKind" in command ? command.actionKind : command.id) === kind &&
        ((command.admission["remote-edge"] === "via-center-forward" &&
          command.path[0] !== "doc" &&
          command.path[0] !== "schedule") ||
          // Execution-bound doc-show resolves frozen submission blobs at the center.
          command.id === "doc-show"),
    ),
  declaredActionFields = (kind: string): readonly EntityActionInputField[] | null => {
    const command = fleetCommand(kind);
    if (!command) return null;
    const fields = new Map<string, EntityActionInputField>(),
      entity = getExecutableEntityAction(kind);
    const add = (field: EntityActionInputField) => {
      if (field.wire?.omit) {
        fields.set(field.field, field);
        return;
      }
      if (field.cli?.jsonSchema) {
        fields.delete(field.field);
        for (const nested of field.cli.jsonSchema.fields) fields.set(nested.field, nested);
      } else {
        const prior = fields.get(field.field);
        fields.set(field.field, { ...prior, ...field, wire: { ...prior?.wire, ...field.wire } });
      }
    };
    for (const input of command.inputs) {
      const declaration = input as typeof input & {
        readonly field?: string;
        readonly projection?: string;
        readonly maxLength?: number;
        readonly wire?: EntityActionInputField["wire"];
      };
      if (declaration.jsonAllowedFields) {
        add({
          field: declaration.field ?? fieldName(input.name),
          type: "string",
          required: false,
          wire: { omit: true },
        });
        continue;
      }
      add({
        field: declaration.field ?? fieldName(input.name),
        type:
          input.kind === "boolean" || declaration.projection === "boolean"
            ? "boolean"
            : declaration.projection === "number"
              ? "number"
              : input.kind === "repeated"
                ? "string-array"
                : declaration.projection === "json-object"
                  ? "json-object"
                  : "string",
        required: input.required,
        ...(input.enum ? { enum: input.enum } : {}),
        ...(input.regex && declaration.projection !== "number" ? { regex: input.regex } : {}),
        wire: {
          ...(declaration.maxLength === undefined ? {} : { maxLength: declaration.maxLength }),
          ...declaration.wire,
        },
      });
    }
    for (const input of entity?.input.fields ?? []) add(input);
    if ("payloadFields" in command)
      for (const field of command.payloadFields as readonly EntityActionInputField[]) add(field);
    for (const token of command.syntaxPath ?? command.path) {
      const match = token.match(/^<([a-z][a-z0-9-]*)>$/u);
      if (match) {
        const name = fieldName(`--${match[1]}`);
        if (!fields.has(name)) add({ field: name, type: "string", required: true });
      }
    }
    if ("actionDefaults" in command && command.actionDefaults)
      for (const [field, value] of Object.entries(command.actionDefaults))
        if (typeof value === "string") add({ field, type: "string", required: false, enum: [value] });
    return [...fields.values()].filter((field) => !field.wire?.omit);
  };
// Declaration-derived patterns are static, so each compiles once per module instance.
const patternCache = new Map<string, RegExp>();
const patternMatches = (pattern: string, value: string): boolean => {
  let compiled = patternCache.get(pattern);
  if (compiled === undefined) {
    compiled = new RegExp(pattern, "u");
    patternCache.set(pattern, compiled);
  }
  return compiled.test(value);
};
const fieldCheck = (field: EntityActionInputField, value: unknown): boolean => {
  if (field.wire?.nullable && value === null) return true;
  const type = field.type;
  if (type === "boolean") return boolean(value);
  if (type === "number") return Number.isSafeInteger(value) && Number(value) >= (field.wire?.minimum ?? 0);
  if (type === "json-object") {
    if (!record(value)) return false;
    return !field.fields || checkFields(field.fields, value);
  }
  if (type === "string-array" || type === "fact-hold-array" || type === "json-object-array") {
    if (!Array.isArray(value) || value.length > FLEET_PAGE_ROWS) return false;
    return value.every((item) =>
      fieldCheck(
        field.items ?? {
          field: field.field,
          type: type === "string-array" ? "string" : "json-object",
          required: true,
          regex: field.regex,
          enum: field.enum,
          wire: field.wire,
          ...(field.fields ? { fields: field.fields } : {}),
        },
        item,
      ),
    );
  }
  return (
    typeof value === "string" &&
    (!field.wire?.normalization || value === value.normalize(field.wire.normalization)) &&
    value.length > 0 &&
    value.length <= (field.wire?.maxLength ?? 512) &&
    (!(field.wire?.enum ?? field.enum) || (field.wire?.enum ?? field.enum)!.includes(value)) &&
    (!(field.wire?.pattern ?? field.regex) || patternMatches((field.wire?.pattern ?? field.regex)!, value))
  );
};
const checkFields = (fields: readonly EntityActionInputField[], value: RecordValue): boolean =>
  fields.every((field) => !(field.wire?.required ?? field.required) || Object.hasOwn(value, field.field)) &&
  Object.entries(value).every(([name, entry]) => {
    const field = fields.find((candidate) => candidate.field === name);
    return field !== undefined && fieldCheck(field, entry);
  });
const taskAction: Check = (value) => {
  if (!record(value) || typeof value.kind !== "string") return false;
  const fields = declaredActionFields(value.kind);
  const { kind: _kind, ...payload } = value;
  return fields !== null && checkFields(fields, payload);
};
export const isFleetTaskAction = taskAction;
const scheduleActionShapes: Readonly<Record<string, Check>> = {
    "schedule-create": (value) =>
      optionalShape(
        {
          kind: one("schedule-create"),
          scheduleId: id,
          name: text,
          mode: one("detect", "remediate"),
          everyMs: (item) => positiveInt(item) && Number(item) >= 60_000,
          cronExpression: text,
          timezone: text,
          agentId: id,
          mission: bodyText,
          reasoningEffort: one(...runtimeEffortValues),
          fast: boolean,
          cwd: logicalPath,
          disabled: boolean,
          idempotencyKey: text,
        },
        ["kind", "scheduleId", "name", "mode", "agentId", "mission"],
      )(value) &&
      record(value) &&
      Object.hasOwn(value, "everyMs") !== Object.hasOwn(value, "cronExpression") &&
      Object.hasOwn(value, "cronExpression") === Object.hasOwn(value, "timezone"),
    "schedule-enable": optionalShape({ kind: one("schedule-enable"), scheduleId: id, idempotencyKey: text }, [
      "kind",
      "scheduleId",
    ]),
    "schedule-update": (value) =>
      optionalShape(
        {
          kind: one("schedule-update"),
          scheduleId: id,
          name: text,
          mode: one("detect", "remediate"),
          everyMs: (item) => positiveInt(item) && Number(item) >= 60_000,
          cronExpression: text,
          timezone: text,
          agentId: id,
          mission: bodyText,
          reasoningEffort: nullable(one(...runtimeEffortValues)),
          fast: boolean,
          keepDays: positiveInt,
          keepMonthly: boolean,
          cwd: nullable(logicalPath),
          idempotencyKey: text,
        },
        ["kind", "scheduleId"],
      )(value) &&
      record(value) &&
      [
        "name",
        "mode",
        "everyMs",
        "cronExpression",
        "timezone",
        "agentId",
        "mission",
        "reasoningEffort",
        "fast",
        "keepDays",
        "keepMonthly",
        "cwd",
      ].some((field) => Object.hasOwn(value, field)) &&
      !(
        Object.hasOwn(value, "everyMs") &&
        (Object.hasOwn(value, "cronExpression") || Object.hasOwn(value, "timezone"))
      ) &&
      (!Object.hasOwn(value, "cronExpression") || Object.hasOwn(value, "timezone")),
    "schedule-delete": optionalShape(
      { kind: one("schedule-delete"), scheduleId: id, reason: text, idempotencyKey: text },
      ["kind", "scheduleId"],
    ),
    "schedule-disable": optionalShape({ kind: one("schedule-disable"), scheduleId: id, idempotencyKey: text }, [
      "kind",
      "scheduleId",
    ]),
    "schedule-run-now": optionalShape(
      {
        kind: one("schedule-run-now"),
        scheduleId: id,
        idempotencyKey: text,
        observedDefinitionRevision: uint,
        scheduledFor: isUtcTimestamp,
      },
      ["kind", "scheduleId"],
    ),
    "schedule-dispatch-link": (value) =>
      optionalShape(
        {
          kind: one("schedule-dispatch-link"),
          scheduleId: id,
          claimFence: id,
          dispatchId: id,
          runtimeSessionId: id,
          idempotencyKey: text,
        },
        ["kind", "scheduleId", "claimFence", "dispatchId", "runtimeSessionId"],
      )(value),
    "schedule-settle": (value) =>
      optionalShape(
        {
          kind: one("schedule-settle"),
          scheduleId: id,
          claimFence: id,
          outcome: one("succeeded", "failed", "unknown", "cancelled"),
          endedAt: isUtcTimestamp,
          detail: bodyText,
          idempotencyKey: text,
        },
        ["kind", "scheduleId", "claimFence", "outcome", "endedAt"],
      )(value),
    "schedule-missed": (value) =>
      optionalShape(
        {
          kind: one("schedule-missed"),
          scheduleId: id,
          from: isUtcTimestamp,
          to: isUtcTimestamp,
          count: positiveInt,
          reason: one("scheduler_unavailable", "single_flight"),
          observedDefinitionRevision: uint,
          idempotencyKey: text,
        },
        ["kind", "scheduleId", "from", "to", "count", "reason", "observedDefinitionRevision"],
      )(value),
  },
  scheduleAction: Check = (value) =>
    record(value) && typeof value.kind === "string" && !!scheduleActionShapes[value.kind]?.(value);
const runtimeEventType = one(
  "runtime_installation_observed",
  "runtime_dispatch_requested",
  "runtime_squad_run_observed",
  "runtime_session_started",
  "runtime_session_provider_bound",
  "runtime_session_task_bound",
  "runtime_session_liveness_changed",
  "runtime_session_cancelled",
  "runtime_session_exited",
  "runtime_session_outcome_observed",
  "runtime_dispatch_outcome_unknown",
);
const runtimeDispatchContext = shape({ role: nullable(text), taskId: nullable(id), executionId: nullable(id) });
const docChange = shape({ path: logicalPath, baseBlobSha256: nullable(sha64), policyId: text, candidate: descriptor });
const common = { schema: text, messageId: id } as const,
  reply = { ...common, inReplyTo: id } as const;
const schemas: Readonly<Record<string, Check>> = {
  "fleet.edge.join/v1": shape({ ...common, joinId: id, inviteToken: text }),
  "fleet.edge.join.result/v1": shape({
    ...reply,
    joinId: id,
    nodeId: id,
    personId: id,
    credential: text,
    repositories: array(shape({ repoId: id, harnessYaml: bodyText }), 64),
  }),
  "fleet.device.sessions.revoke/v1": shape(common),
  "fleet.device.sessions.revoked/v1": shape(reply),
  "fleet.device.login/v1": shape({ ...common, userCode: text, createdAt: uint, expiresAt: uint, pending: boolean }),
  "fleet.device.login.result/v1": shape(reply),
  "fleet.session.hello/v1": shape({ ...common, protocolVersion: isContractVersion, nodeId: id, credential: text }),
  "fleet.session.ready/v1": optionalShape(
    {
      ...reply,
      sessionId: id,
      maxFrameBytes: one(FLEET_FRAME_BYTES),
      chunkBytes: one(FLEET_CHUNK_BYTES),
      loginAuthority: nullable(loginAuthority),
    },
    ["schema", "messageId", "inReplyTo", "sessionId", "maxFrameBytes", "chunkBytes"],
  ),
  "fleet.repo.metadata.get/v1": optionalShape(
    {
      ...common,
      repoId: id,
      executionCredential: text,
      actionKind: (value) => typeof value === "string" && actionDeclarations.some((action) => action.kind === value),
      taskId: id,
    },
    ["schema", "messageId", "repoId"],
  ),
  "fleet.repo.metadata.result/v1": shape({
    ...reply,
    personId: id,
    actionAllowed: nullable(boolean),
    repoId: id,
    baseLedgerSha: ledgerCut,
    writerEpoch: uint,
    replicationSequence: uint,
  }),
  "fleet.receipt.get/v1": shape({ ...common, repoId: id, opId: id }),
  "fleet.receipt.result/v1": shape({ ...reply, opId: id, receipt: record }),
  "fleet.upload.begin/v1": shape({ ...common, repoId: id, opId: id, content: blob }),
  "fleet.upload.ready/v1": shape({
    ...reply,
    uploadId: id,
    resumeOffset: uint,
    status: one("receiving", "already_staged"),
    replicationSequence: nullable(uint),
  }),
  "fleet.upload.chunk/v1": shape({ ...common, uploadId: id, opId: id, offset: uint, dataBase64: base64 }),
  "fleet.upload.finish/v1": shape({ ...common, uploadId: id, opId: id }),
  "fleet.upload.result/v1": shape({
    ...reply,
    status: one("staged", "already_staged"),
    descriptor,
    replicationSequence: nullable(uint),
  }),
  "fleet.doc.submit/v1": optionalShape(
    {
      ...common,
      opId: id,
      executionCredential: text,
      taskId: id,
      repoId: id,
      executionId: nullable(id),
      writerEpoch: uint,
      baseLedgerSha: ledgerCut,
      changes: array(docChange),
    },
    ["schema", "messageId", "opId", "repoId", "executionId", "writerEpoch", "baseLedgerSha", "changes"],
  ),
  "fleet.doc.result/v1": shape({
    ...reply,
    outcome: one("applied", "pending", "no_changes", "op_rejected", "indeterminate"),
    opId: text,
    revision: nullable(uint),
    replicationSequence: nullable(uint),
    code: nullable(text),
    receipt: record,
  }),
  "fleet.task.command/v1": optionalShape(
    {
      ...common,
      writerEpoch: uint,
      opId: id,
      repoId: id,
      taskId: nullable(id),
      action: taskAction,
      artifact: descriptor,
      docChanges: nullable(array(docChange, 128)),
      mirrorBaseCut: nullable(mirrorBaseCutShape),
      executionCredential: text,
    },
    ["schema", "messageId", "writerEpoch", "opId", "repoId", "taskId", "action", "docChanges", "mirrorBaseCut"],
  ),
  "fleet.task.evidence/v1": shape({ ...common, inReplyTo: id, dataBase64: base64 }),
  "fleet.task.result/v1": optionalShape(
    {
      ...reply,
      outcome: one("applied", "op_rejected"),
      opId: id,
      revision: nullable(uint),
      replicationSequence: nullable(uint),
      appliedCut: nullable(cut),
      code: nullable(text),
      receipt: nullable(record),
    },
    ["schema", "messageId", "inReplyTo", "outcome", "opId", "revision", "replicationSequence", "code", "receipt"],
  ),
  "fleet.schedule.command/v1": shape({
    ...common,
    writerEpoch: uint,
    opId: id,
    repoId: id,
    scheduleId: id,
    action: scheduleAction,
  }),
  "fleet.schedule.result/v1": shape({
    ...reply,
    opId: id,
    outcome: one("applied", "pending", "no_changes", "op_rejected", "indeterminate"),
    revision: nullable(uint),
    replicationSequence: nullable(uint),
    code: nullable(text),
    receipt: record,
  }),
  "fleet.runtime.event/v1": shape({
    ...common,
    writerEpoch: uint,
    repoId: id,
    opId: id,
    eventType: runtimeEventType,
    payload: record,
    result: nullable(descriptor),
    dispatchContext: nullable(runtimeDispatchContext),
  }),
  "fleet.runtime.event.result/v1": shape({
    ...reply,
    replicationSequence: nullable(uint),
    event: nullable(record),
    receipt: record,
  }),
  "fleet.runtime.archive/v1": shape({ ...common, writerEpoch: uint, repoId: id, opId: id, archive: record }),
  "fleet.runtime.archive.result/v1": shape({ ...reply, replicationSequence: nullable(uint), receipt: record }),
  "fleet.operational.read/v1": shape({
    ...common,
    repoId: id,
    method: one("repo.agentRuntime.sessions.await", "repo.task.dispatches"),
    payload: record,
  }),
  "fleet.operational.read.result/v1": shape({ ...reply, result: record }),
  "fleet.error/v1": shape({
    ...reply,
    code: text,
    message: bodyText,
    retryable: (value) => typeof value === "boolean",
    resumeOffset: nullable(uint),
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
  const payload = record(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "accessToken" && key !== "humanClientId"))
    : value;
  if (
    !record(value) ||
    (value.accessToken !== undefined && !accessToken(value.accessToken)) ||
    (value.humanClientId !== undefined &&
      (typeof value.humanClientId !== "string" || value.humanClientId.length === 0)) ||
    typeof value.schema !== "string" ||
    !schemas[value.schema]?.(payload)
  )
    throw new FleetContractError(
      `Fleet frame violates closed schema ${record(value) ? String(value.schema) : "unknown"}`,
    );
  if (Buffer.byteLength(JSON.stringify(value)) > FLEET_FRAME_BYTES)
    throw new FleetContractError("Fleet frame exceeds 98304 bytes");
  if (
    record(value) &&
    [
      "fleet.doc.result/v1",
      "fleet.task.result/v1",
      "fleet.schedule.result/v1",
      "fleet.runtime.event.result/v1",
      "fleet.runtime.archive.result/v1",
    ].includes(value.schema)
  ) {
    const outcome =
      record(value.receipt) && typeof value.receipt.outcome === "string" ? value.receipt.outcome : value.outcome;
    const applied = outcome === "applied";
    if ((applied && typeof value.replicationSequence !== "number") || (!applied && value.replicationSequence !== null))
      throw new FleetContractError("Fleet write result replicationSequence does not match outcome");
  }
  return value as FleetFrameV1;
}
export function serializeFleetFrame(value: unknown): string {
  return `${JSON.stringify(parseFleetFrame(value))}\n`;
}
