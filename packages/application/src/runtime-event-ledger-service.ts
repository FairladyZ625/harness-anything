import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { Effect, Schema } from "effect";
import {
  RuntimeEventRecordSchema,
  type RuntimeEventApprovalDecision,
  type RuntimeEventInterruptAction,
  type RuntimeEventKind,
  type RuntimeEventRecord,
  type RuntimeEventRuntime,
  type RuntimeEventResultStatus
} from "../../kernel/src/index.ts";
import { moduleEntityId, resolveHarnessLayout, stablePayloadHash, type EntityId, type HarnessLayoutInput, type WriteCoordinator, type WriteError, type WriteOpKind } from "../../kernel/src/index.ts";
import { isNodeErrorCode } from "./node-errors.ts";

export interface RuntimeEventLedgerServiceOptions {
  readonly rootInput: HarnessLayoutInput;
  readonly coordinator?: WriteCoordinator;
  readonly now?: () => string;
  readonly makeEventId?: () => string;
}

export interface RuntimeEventAppendInput {
  readonly eventId?: string;
  readonly recordedAt?: string;
  readonly kind: RuntimeEventKind;
  readonly actor?: RuntimeEventRecord["actor"];
  readonly actorAxes?: RuntimeEventRecord["actorAxes"];
  readonly session: {
    readonly sessionId: string;
    readonly runtime?: RuntimeEventRuntime | "unknown";
    readonly taskId?: string;
    readonly decisionId?: string;
    readonly factRef?: string;
  };
  readonly turn?: RuntimeEventRecord["turn"];
  readonly step?: RuntimeEventRecord["step"];
  readonly tool?: RuntimeEventRecord["tool"];
  readonly approval?: {
    readonly approvalId?: string;
    readonly decision: RuntimeEventApprovalDecision;
    readonly scope?: string;
  } | null;
  readonly interrupt?: {
    readonly interruptId?: string;
    readonly action: RuntimeEventInterruptAction;
    readonly reason?: string;
  } | null;
  readonly result?: {
    readonly status: RuntimeEventResultStatus;
    readonly summary?: string;
    readonly errorCode?: string;
  } | null;
  readonly cost?: RuntimeEventRecord["cost"];
}

export interface RuntimeEventLedgerAppendResult {
  readonly event: RuntimeEventRecord;
  readonly path: string;
}

export interface RuntimeEventLedgerReadResult {
  readonly sessionId: string;
  readonly path: string;
  readonly events: ReadonlyArray<RuntimeEventRecord>;
}

export interface RuntimeEventLedgerRejected {
  readonly _tag: "RuntimeEventLedgerRejected";
  readonly sessionId: string;
  readonly reason: string;
}

export interface RuntimeEventExportPort {
  readonly exportEvents: (events: ReadonlyArray<RuntimeEventRecord>) => Effect.Effect<void, RuntimeEventLedgerRejected>;
}

export interface RuntimeEventLedgerService {
  readonly append: (input: RuntimeEventAppendInput) => Effect.Effect<RuntimeEventLedgerAppendResult, RuntimeEventLedgerRejected>;
  readonly readSession: (sessionId: string) => Effect.Effect<RuntimeEventLedgerReadResult, RuntimeEventLedgerRejected>;
}

export function makeRuntimeEventAppendPromise(
  service: RuntimeEventLedgerService
): (input: RuntimeEventAppendInput) => Promise<void> {
  return async (input) => {
    await Effect.runPromise(service.append(input));
  };
}

export function makeRuntimeEventLedgerService(options: RuntimeEventLedgerServiceOptions): RuntimeEventLedgerService {
  const timestamp = () => options.now?.() ?? new Date().toISOString();
  const eventId = () => options.makeEventId?.() ?? makeRuntimeEventId(timestamp());
  return {
    append: (input) => appendRuntimeEvent(options.rootInput, toRuntimeEventRecord(input, timestamp, eventId), options.coordinator),
    readSession: (sessionId) => readRuntimeEventSession(options.rootInput, sessionId)
  };
}

function toRuntimeEventRecord(
  input: RuntimeEventAppendInput,
  timestamp: () => string,
  eventId: () => string
): RuntimeEventRecord {
  const id = input.eventId ?? eventId();
  return {
    schema: "runtime-event/v1",
    eventId: id,
    recordedAt: input.recordedAt ?? timestamp(),
    kind: input.kind,
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.actorAxes ? { actorAxes: input.actorAxes } : {}),
    session: {
      sessionId: input.session.sessionId,
      runtime: input.session.runtime ?? "unknown",
      ...(input.session.taskId ? { taskId: input.session.taskId } : {}),
      ...(input.session.decisionId ? { decisionId: input.session.decisionId } : {}),
      ...(input.session.factRef ? { factRef: input.session.factRef } : {})
    },
    turn: input.turn ?? null,
    step: input.step ?? null,
    tool: input.tool ?? null,
    approval: input.approval
      ? { approvalId: input.approval.approvalId ?? id, decision: input.approval.decision, ...(input.approval.scope ? { scope: input.approval.scope } : {}) }
      : null,
    interrupt: input.interrupt
      ? { interruptId: input.interrupt.interruptId ?? id, action: input.interrupt.action, ...(input.interrupt.reason ? { reason: input.interrupt.reason } : {}) }
      : null,
    result: input.result ?? null,
    cost: input.cost ?? null
  };
}

function appendRuntimeEvent(
  rootInput: HarnessLayoutInput,
  event: RuntimeEventRecord,
  coordinator?: WriteCoordinator
): Effect.Effect<RuntimeEventLedgerAppendResult, RuntimeEventLedgerRejected> {
  return Effect.try({
    try: () => {
      const decoded = Schema.decodeUnknownSync(RuntimeEventRecordSchema)(event);
      const target = resolveRuntimeEventLedgerPath(rootInput, decoded.session.sessionId);
      return {
        decoded,
        target,
        result: {
          event: decoded,
          path: target.relativePath
        }
      };
    },
    catch: (error) => runtimeEventRejection(event.session.sessionId, runtimeEventErrorMessage(error))
  }).pipe(
    Effect.flatMap(({ decoded, target, result }) => {
      const payload = {
          boundary: "runtime-event-ledger",
          path: path.relative(resolveHarnessLayout(rootInput).rootDir, target.absolutePath).split(path.sep).join("/"),
          value: decoded
        };
      return coordinator
        ? writeCoordinatedPayloadLocal(coordinator, {
          entityId: moduleEntityId("runtime-event-ledger"),
          kind: "machine_artifact_append_jsonl",
          opIdPrefix: `runtime-event-${decoded.eventId}`,
          payload
        }).pipe(
        Effect.map(() => result),
        Effect.mapError((error) => runtimeEventRejection(decoded.session.sessionId, runtimeLedgerWriteErrorMessage(error)))
      )
        : Effect.tryPromise({
        try: async () => {
          await fs.promises.mkdir(path.dirname(target.absolutePath), { recursive: true });
          await appendJsonlWithFsync(target.absolutePath, decoded);
          return result;
        },
        catch: (error) => runtimeEventRejection(decoded.session.sessionId, runtimeEventErrorMessage(error))
      });
    })
  );
}

function readRuntimeEventSession(
  rootInput: HarnessLayoutInput,
  sessionId: string
): Effect.Effect<RuntimeEventLedgerReadResult, RuntimeEventLedgerRejected> {
  return Effect.tryPromise({
    try: async () => {
      const target = resolveRuntimeEventLedgerPath(rootInput, sessionId);
      const body = await fs.promises.readFile(target.absolutePath, "utf8").catch((error: unknown) => {
        if (isNodeErrorCode(error, "ENOENT")) return "";
        throw error;
      });
      const events = body
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line, index) => decodeRuntimeEventLine(line, sessionId, index + 1));
      return { sessionId, path: target.relativePath, events };
    },
    catch: (error) => runtimeEventRejection(sessionId, runtimeEventErrorMessage(error))
  });
}

function decodeRuntimeEventLine(line: string, sessionId: string, lineNumber: number): RuntimeEventRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`invalid JSONL line ${lineNumber}: ${runtimeEventErrorMessage(error)}`);
  }
  const decoded = Schema.decodeUnknownSync(RuntimeEventRecordSchema)(parsed);
  if (decoded.session.sessionId !== sessionId) {
    throw new Error(`event line ${lineNumber} belongs to session ${decoded.session.sessionId}`);
  }
  return decoded;
}

function resolveRuntimeEventLedgerPath(rootInput: HarnessLayoutInput, sessionId: string): { readonly absolutePath: string; readonly relativePath: string } {
  const layout = resolveHarnessLayout(rootInput);
  const absolutePath = layout.runtimeEventLedgerPath(sessionId);
  return {
    absolutePath,
    relativePath: path.relative(layout.localRoot, absolutePath).split(path.sep).join("/")
  };
}

async function appendJsonlWithFsync(filePath: string, event: RuntimeEventRecord): Promise<void> {
  const handle = await fs.promises.open(filePath, "a");
  try {
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function makeRuntimeEventId(recordedAt: string): string {
  return `evt_${recordedAt.replace(/[^0-9A-Za-z]/gu, "").slice(0, 32)}_${randomBytes(5).toString("hex")}`;
}

function runtimeEventRejection(sessionId: string, reason: string): RuntimeEventLedgerRejected {
  return { _tag: "RuntimeEventLedgerRejected", sessionId, reason };
}

function runtimeEventErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runtimeLedgerWriteErrorMessage(error: WriteError): string {
  if (error._tag === "WriteRejected") return error.reason;
  if (error._tag === "WriteConflict") return `write conflict for ${error.taskId}`;
  if (error._tag === "GlobalWriteConflict") return "global write conflict";
  return runtimeEventErrorMessage(error.cause);
}

function writeCoordinatedPayloadLocal(
  coordinator: WriteCoordinator,
  input: {
    readonly entityId: EntityId;
    readonly kind: WriteOpKind;
    readonly payload: Record<string, unknown>;
    readonly opIdPrefix: string;
  }
): Effect.Effect<void, WriteError> {
  const opId = `${input.opIdPrefix}-${stablePayloadHash({
    entityId: input.entityId,
    kind: input.kind,
    payload: input.payload
  }).slice(0, 16)}`;
  return Effect.gen(function* () {
    yield* coordinator.enqueue({
      opId,
      entityId: input.entityId,
      kind: input.kind,
      payload: input.payload
    });
    yield* coordinator.flush("explicit");
  });
}
