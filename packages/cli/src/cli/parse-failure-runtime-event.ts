import { randomUUID } from "node:crypto";
import path from "node:path";
import { Effect, Schema } from "effect";
import { makeEnvironmentCurrentSessionProbe } from "../../../application/src/index.ts";
import {
  makeOperationalJournaledWriteCoordinator,
  moduleEntityId,
  resolveHarnessLayout,
  RuntimeEventRecordSchema,
  stablePayloadHash
} from "../../../kernel/src/index.ts";
import type { CommandFailureReceipt } from "./receipt.ts";
import { stripGlobalOptions } from "./parse-options.ts";

type ParseFailureError = CommandFailureReceipt["error"];

interface ParseFailureRuntimeEventDependencies {
  readonly append?: (argv: ReadonlyArray<string>, error: ParseFailureError) => Promise<void>;
  readonly warn?: (message: string) => void;
}

export async function appendParseFailureRuntimeEvent(
  argv: ReadonlyArray<string>,
  error: ParseFailureError,
  dependencies: ParseFailureRuntimeEventDependencies = {}
): Promise<void> {
  try {
    await (dependencies.append ?? appendOperationalParseFailureRuntimeEvent)(argv, error);
  } catch (diagnosticError) {
    try {
      (dependencies.warn ?? console.error)(
        `warning: unable to append CLI parse-failure diagnostic: ${errorMessage(diagnosticError)}`
      );
    } catch {
      // A broken stderr must not turn best-effort diagnostics into the primary failure.
    }
  }
}

async function appendOperationalParseFailureRuntimeEvent(
  argv: ReadonlyArray<string>,
  error: ParseFailureError
): Promise<void> {
  const stripped = stripGlobalOptions(argv);
  const layoutOverrides = stripped.authoredRoot ? { authoredRoot: stripped.authoredRoot } : undefined;
  const rootInput = layoutOverrides ? { rootDir: stripped.rootDir, layoutOverrides } : stripped.rootDir;
  const layout = resolveHarnessLayout(rootInput);
  const session = await Effect.runPromise(makeEnvironmentCurrentSessionProbe().currentSession);
  const recordedAt = new Date().toISOString();
  const eventId = `evt_${randomUUID()}`;
  const event = Schema.decodeUnknownSync(RuntimeEventRecordSchema)({
    schema: "runtime-event/v1",
    eventId,
    recordedAt,
    kind: "result",
    session: {
      sessionId: session.sessionId,
      runtime: session.runtime,
      executionId: null,
      reviewId: null
    },
    turn: null,
    step: null,
    tool: {
      toolName: "parse",
      ...(error?.code ? { errorCode: error.code } : {})
    },
    approval: null,
    interrupt: null,
    result: {
      status: "failed",
      summary: "CLI parse failed",
      ...(error?.code ? { errorCode: error.code } : {})
    },
    cost: null
  });
  const payload = {
    boundary: "runtime-event-ledger",
    path: path.relative(layout.rootDir, layout.runtimeEventLedgerPath(session.sessionId)).split(path.sep).join("/"),
    value: event
  };
  const coordinator = makeOperationalJournaledWriteCoordinator({
    rootDir: stripped.rootDir,
    ...(layoutOverrides ? { layoutOverrides } : {}),
    operationalActor: { scope: "operational", kind: "agent", id: "runtime-event-cli" }
  });
  const opId = `runtime-event-${eventId}-${stablePayloadHash(payload).slice(0, 16)}`;

  await Effect.runPromise(Effect.gen(function* () {
    yield* coordinator.enqueue({
      opId,
      entityId: moduleEntityId("runtime-event-ledger"),
      kind: "machine_artifact_append_jsonl",
      payload
    });
    yield* coordinator.flush("explicit");
  }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
