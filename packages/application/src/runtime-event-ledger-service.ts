import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
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
import { resolveHarnessLayout, type HarnessLayoutInput } from "../../kernel/src/layout/index.ts";

export interface RuntimeEventLedgerServiceOptions {
  readonly rootInput: HarnessLayoutInput;
  readonly now?: () => string;
  readonly makeEventId?: () => string;
}

export interface RuntimeEventAppendInput {
  readonly eventId?: string;
  readonly recordedAt?: string;
  readonly kind: RuntimeEventKind;
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

export function makeRuntimeEventLedgerService(options: RuntimeEventLedgerServiceOptions): RuntimeEventLedgerService {
  const timestamp = () => options.now?.() ?? new Date().toISOString();
  const eventId = () => options.makeEventId?.() ?? makeRuntimeEventId(timestamp());
  return {
    append: (input) => appendRuntimeEvent(options.rootInput, toRuntimeEventRecord(input, timestamp, eventId)),
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
  event: RuntimeEventRecord
): Effect.Effect<RuntimeEventLedgerAppendResult, RuntimeEventLedgerRejected> {
  return Effect.try({
    try: () => {
      const decoded = Schema.decodeUnknownSync(RuntimeEventRecordSchema)(event);
      const target = resolveRuntimeEventLedgerPath(rootInput, decoded.session.sessionId);
      mkdirSync(path.dirname(target.absolutePath), { recursive: true });
      appendJsonlWithFsync(target.absolutePath, decoded);
      return {
        event: decoded,
        path: target.relativePath
      };
    },
    catch: (error) => runtimeEventRejection(event.session.sessionId, runtimeEventErrorMessage(error))
  });
}

function readRuntimeEventSession(
  rootInput: HarnessLayoutInput,
  sessionId: string
): Effect.Effect<RuntimeEventLedgerReadResult, RuntimeEventLedgerRejected> {
  return Effect.try({
    try: () => {
      const target = resolveRuntimeEventLedgerPath(rootInput, sessionId);
      if (!existsSync(target.absolutePath)) {
        return { sessionId, path: target.relativePath, events: [] };
      }
      const events = readFileSync(target.absolutePath, "utf8")
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

function appendJsonlWithFsync(filePath: string, event: RuntimeEventRecord): void {
  const fd = openSync(filePath, "a");
  try {
    writeSync(fd, `${JSON.stringify(event)}\n`, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
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
