import { randomUUID } from "node:crypto";
import { consumeKnownError } from "@harness-anything/kernel";
import type { AgentRuntimeSessionResult, AgentRuntimeSettlement } from "./agent-runtime-contract.ts";
import { taskDispatchRowSettled, taskDispatchRowsSettled } from "./dispatch-read.ts";
import { daemonProtocolCommands } from "./protocol/daemon-protocol-commands.ts";
import type { DaemonTaskDispatchesResult } from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { RepoTaskAction } from "./repo-cell-types.ts";

export const runtimeBatchDefaultConcurrency = 2,
  runtimeBatchMaxConcurrency = 32;

const runtimeRunEntryFields = Object.freeze([
  "instance",
  ...(
    (daemonProtocolCommands.find((command) => command.id === "runtime-run")?.inputs ?? []) as readonly {
      readonly name: string;
    }[]
  )
    .filter(
      (input) =>
        !["--resume", "--resume-dispatch", "--idempotency-key", "--detach", "--on-exit", "--no-stream"].includes(
          input.name,
        ),
    )
    .map((input) => input.name.slice(2)),
]);
const runtimeRunEfforts = Object.freeze(
  (
    (daemonProtocolCommands.find((command) => command.id === "runtime-run")?.inputs ?? []) as readonly {
      readonly name: string;
      readonly enum?: readonly string[];
    }[]
  ).find((input) => input.name === "--effort")?.enum ?? [],
);

export interface RuntimeBatchDeclaration {
  readonly maxConcurrency: number;
  readonly dispatches: readonly RuntimeBatchEntry[];
}
export interface RuntimeBatchEntry {
  readonly instance: string;
  readonly agent?: string;
  readonly to?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly fast?: boolean;
  readonly permissionMode?: string;
  readonly prompt?: string;
  readonly mission?: string;
  readonly cwd?: string;
  readonly task?: string;
}

export interface RuntimeOrchestrationContext {
  readonly spawnRuntime: (payload: JsonObject) => Promise<JsonObject>;
  readonly run: (action: RepoTaskAction) => Promise<JsonObject>;
  readonly awaitRuntimeOutcome: (runtimeSessionId: string) => Promise<void>;
  readonly readSession: (runtimeSessionId: string) => Promise<AgentRuntimeSessionResult>;
  readonly codedError: (code: string, message: string) => Error;
}

export interface RuntimeAwaitContext {
  readonly readSession: (runtimeSessionId: string) => Promise<AgentRuntimeSessionResult>;
  readonly readTaskDispatches: (taskIds: readonly string[]) => Promise<DaemonTaskDispatchesResult>;
  /** Resolves on the next runtime signal/outcome notification or the settlement grace backstop. */
  readonly awaitSignal: () => Promise<void>;
  /** Aborts when the connection that parked the wait closes; the wait holds no work, so it ends
   *  instead of keeping its settle re-reads alive for the runtime's whole life. */
  readonly connectionSignal?: AbortSignal;
  readonly codedError: (code: string, message: string) => Error;
}

function unknownFieldViolation(value: Record<string, unknown>, allowed: readonly string[]): string | null {
  const unknown = Object.keys(value).find((field) => !allowed.includes(field));
  return unknown ? `unknown field: ${unknown}.` : null;
}

export function parseRuntimeBatchDeclaration(value: unknown, label: string): RuntimeBatchDeclaration {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} declaration must be a JSON object.`);
  const record = value as Record<string, unknown>,
    allowed = ["schema", "maxConcurrency", "dispatches"],
    unknownField = unknownFieldViolation(record, allowed);
  if (unknownField) throw new Error(`${label} declaration contains an ${unknownField}`);
  if (record.schema !== "runtime-batch/v1") throw new Error(`${label} declaration schema must be runtime-batch/v1.`);
  const maxConcurrency = record.maxConcurrency === undefined ? runtimeBatchDefaultConcurrency : record.maxConcurrency;
  if (
    !Number.isSafeInteger(maxConcurrency) ||
    Number(maxConcurrency) < 1 ||
    Number(maxConcurrency) > runtimeBatchMaxConcurrency
  )
    throw new Error(`${label} maxConcurrency must be an integer from 1 to ${runtimeBatchMaxConcurrency}.`);
  if (!Array.isArray(record.dispatches) || record.dispatches.length === 0)
    throw new Error(`${label} declaration dispatches must be a non-empty array.`);
  return {
    maxConcurrency: Number(maxConcurrency),
    dispatches: record.dispatches.map((entry, index) => parseRuntimeBatchEntry(entry, index)),
  };
}

export function parseRuntimeBatchEntry(value: unknown, index: number): RuntimeBatchEntry {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Batch dispatch ${index} must be an object.`);
  const record = value as Record<string, unknown>,
    unknownField = unknownFieldViolation(record, runtimeRunEntryFields);
  if (unknownField) throw new Error(`Batch dispatch ${index} contains an ${unknownField}`);
  const text = (field: string): string | undefined => {
    const item = record[field];
    if (item === undefined) return undefined;
    if (typeof item !== "string" || item.trim().length === 0)
      throw new Error(`Batch dispatch ${index} field ${field} must be a non-empty string.`);
    return item;
  };
  const instance = text("instance"),
    prompt = text("prompt"),
    mission = text("mission"),
    agent = text("agent"),
    to = text("to"),
    model = text("model"),
    effort = text("effort"),
    fast = record.fast,
    permissionMode = text("permission-mode"),
    cwd = text("cwd"),
    task = text("task");
  if (!instance) throw new Error(`Batch dispatch ${index} requires instance.`);
  if (prompt && mission) throw new Error(`Batch dispatch ${index} cannot combine prompt and mission.`);
  if (!prompt && !mission && !task) throw new Error(`Batch dispatch ${index} requires prompt, mission, or task.`);
  if (mission && !task) throw new Error(`Batch dispatch ${index} uses mission without task.`);
  if (to && !agent) throw new Error(`Batch dispatch ${index} uses to without agent.`);
  if (effort && !(runtimeRunEfforts as readonly string[]).includes(effort))
    throw new Error(`Batch dispatch ${index} effort must be minimal, low, medium, high, xhigh, or max.`);
  if (fast !== undefined && typeof fast !== "boolean")
    throw new Error(`Batch dispatch ${index} field fast must be a boolean.`);
  if (permissionMode && !["bypass", "workspace-write", "read-only"].includes(permissionMode))
    throw new Error(`Batch dispatch ${index} permission-mode must be bypass, workspace-write, or read-only.`);
  return {
    instance,
    ...(agent ? { agent } : {}),
    ...(to ? { to } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(fast === undefined ? {} : { fast }),
    ...(permissionMode ? { permissionMode } : {}),
    ...(prompt ? { prompt } : {}),
    ...(mission ? { mission } : {}),
    ...(cwd ? { cwd } : {}),
    ...(task ? { task } : {}),
  };
}

export function runtimeBatchSpawnPayload(
  entry: RuntimeBatchEntry,
  idempotencyKey: string,
  executor?: unknown,
): JsonObject {
  return {
    runtimeInstanceId: entry.instance,
    ...(entry.agent ? { agentId: entry.agent } : {}),
    ...(entry.to ? { targetAgentId: entry.to } : {}),
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.effort ? { effort: entry.effort } : {}),
    ...(entry.fast === undefined ? {} : { fast: entry.fast }),
    ...(entry.permissionMode ? { permissionMode: entry.permissionMode } : {}),
    ...(entry.prompt ? { prompt: entry.prompt } : entry.mission ? { missionName: entry.mission } : {}),
    cwd: entry.cwd && entry.cwd !== "." ? { scope: "repo-relative", path: entry.cwd } : { scope: "repo-root" },
    taskId: entry.task ?? null,
    idempotencyKey,
    ...(executor !== undefined ? { executor } : {}),
  } as JsonObject;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && typeof (error as { readonly code?: unknown }).code === "string"
    ? String((error as { readonly code: string }).code)
    : null;
}

function receiptError(receipt: JsonObject): { readonly code: string | null; readonly hint: string | null } {
  const error = receipt.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    return {
      code: typeof record.code === "string" ? record.code : null,
      hint: typeof record.hint === "string" ? record.hint : typeof record.message === "string" ? record.message : null,
    };
  }
  return {
    code: typeof receipt.code === "string" ? receipt.code : null,
    hint:
      typeof receipt.reason === "string"
        ? receipt.reason
        : typeof receipt.summary === "string"
          ? receipt.summary
          : null,
  };
}

type BatchRow = {
  readonly index: number;
  readonly instance: string;
  readonly agent: string | null;
  readonly to: string | null;
  readonly status: "succeeded" | "failed" | "unknown" | "rejected";
  readonly outcome: string | null;
  readonly dispatchId: string | null;
  readonly runtimeSessionId: string | null;
  readonly code: string | null;
  readonly reason: string | null;
  readonly reportPath: null;
  readonly resultText: string | null;
};

async function settleSpawnedSession(
  context: RuntimeOrchestrationContext,
  runtimeSessionId: string,
): Promise<{ readonly session: AgentRuntimeSessionResult; readonly settlement: AgentRuntimeSettlement }> {
  for (;;) {
    const session = await context.readSession(runtimeSessionId),
      settlement = session.settlement;
    if (settlement !== null) return { session, settlement };
    // The cell wakes the saga on runtime signals, outcome events, and the grace backstop; each
    // wake re-reads the daemon-stamped settlement instead of polling on a fixed cadence.
    await context.awaitRuntimeOutcome(runtimeSessionId);
  }
}

export async function orchestrateRuntimeBatch(
  payload: Readonly<Record<string, unknown>>,
  context: RuntimeOrchestrationContext,
): Promise<JsonObject> {
  let declaration: RuntimeBatchDeclaration;
  try {
    declaration = parseRuntimeBatchDeclaration(JSON.parse(String(payload.declaration)), "Batch");
  } catch (error) {
    consumeKnownError(error);
    const rejection = context.codedError(
      "batch_file_invalid",
      `Could not read batch declaration: ${errorText(error)}`,
    ) as Error & { diagnostic: JsonObject };
    rejection.diagnostic = {
      kind: "validation",
      entity: "repo.agentRuntime.batch",
      field: "declaration",
      actual: "batch_file_invalid",
      expectation: rejection.message,
    };
    throw rejection;
  }
  const results: (BatchRow | undefined)[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= declaration.dispatches.length) return;
      const entry = declaration.dispatches[index]!;
      let receipt: JsonObject | null = null,
        failure: { readonly code: string | null; readonly hint: string | null } | null = null;
      try {
        receipt = await context.spawnRuntime(
          runtimeBatchSpawnPayload(entry, `runtime-batch-${randomUUID()}`, payload.executor),
        );
      } catch (error) {
        consumeKnownError(error);
        failure = { code: errorCode(error), hint: errorText(error) };
      }
      const runtimeSessionId =
          receipt && typeof receipt.runtimeSessionId === "string" ? receipt.runtimeSessionId : null,
        dispatchId = receipt && typeof receipt.dispatchId === "string" ? receipt.dispatchId : null;
      let row: BatchRow;
      if (receipt === null || receipt.ok !== true || runtimeSessionId === null) {
        const rejected = failure ?? receiptError(receipt ?? {});
        row = {
          index,
          instance: entry.instance,
          agent: entry.agent ?? null,
          to: entry.to ?? null,
          status: "rejected",
          outcome: null,
          dispatchId,
          runtimeSessionId,
          code: rejected.code ?? "batch_dispatch_failed",
          reason: rejected.hint,
          reportPath: null,
          resultText: null,
        };
      } else {
        const settled = await settleSpawnedSession(context, runtimeSessionId),
          { settlement } = settled,
          status =
            settlement.outcome === "succeeded" ? "succeeded" : settlement.outcome === "unknown" ? "unknown" : "failed";
        row = {
          index,
          instance: entry.instance,
          agent: entry.agent ?? null,
          to: entry.to ?? null,
          status,
          outcome: settlement.outcome,
          dispatchId,
          runtimeSessionId,
          code: settlement.code ?? (status === "succeeded" ? null : "runtime_failed"),
          reason: settlement.reason,
          reportPath: null,
          resultText: settled.session.result?.text ?? null,
        };
      }
      results[index] = row;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(declaration.maxConcurrency, declaration.dispatches.length) }, () => worker()),
  );
  const rows = results as readonly BatchRow[],
    failed = rows.filter((row) => row.status !== "succeeded"),
    unknown = rows.some((row) => row.status === "unknown"),
    outcome = failed.length === 0 ? "succeeded" : unknown ? "unknown" : "partial_failure";
  return {
    schema: "command-receipt/v2",
    ok: true,
    command: "runtime-batch",
    outcome,
    dispatches: rows as unknown as JsonObject[],
    maxConcurrency: declaration.maxConcurrency,
    summary: `runtime-batch: ${rows.length - failed.length} succeeded, ${failed.length} failed`,
    exitCode: failed.length ? 1 : 0,
  };
}

function agentDesignerPrompt(requirement: string): string {
  return [
    `# Agent declaration protocol`,
    `Return exactly one JSON object and no Markdown, code fences, or prose.`,
    `The object must contain schema exactly "agent-declaration/v1", plus id, name, instructions, ` +
      `runtimes (an array of {type, model?} targets; empty array accepts any compatible runtime kind), ` +
      `and optional role (worker or commander). Do not omit schema.`,
    `The harness will validate and install the declaration; do not run commands or install it yourself.`,
    `# Agent requirement`,
    requirement,
  ].join("\n\n");
}

function orchestrationRejected(command: string, code: string, hint: string): JsonObject {
  return {
    schema: "command-receipt/v2",
    ok: false,
    command,
    outcome: "op_rejected",
    origin: "daemon",
    code,
    error: { code, hint },
    nextAction: hint,
    summary: `${command}: ${code}`,
    exitCode: 1,
  };
}

export async function orchestrateAgentCreate(
  payload: Readonly<Record<string, unknown>>,
  context: RuntimeOrchestrationContext,
): Promise<JsonObject> {
  const spawnPayload: Record<string, unknown> = {
    runtimeInstanceId: payload.runtimeInstanceId,
    agentId: payload.agentId,
    prompt: agentDesignerPrompt(String(payload.prompt)),
    cwd: payload.cwd,
    taskId: payload.taskId ?? null,
    ...(payload.effort !== undefined ? { effort: payload.effort } : {}),
    ...(payload.model !== undefined ? { model: payload.model } : {}),
    ...(payload.executor !== undefined ? { executor: payload.executor } : {}),
    idempotencyKey: `agent-create-${randomUUID()}`,
  };
  const spawned = await context.spawnRuntime(spawnPayload as JsonObject);
  if (spawned.ok !== true || typeof spawned.runtimeSessionId !== "string") return spawned;
  const runtimeSessionId = spawned.runtimeSessionId,
    settled = await settleSpawnedSession(context, runtimeSessionId);
  if (settled.settlement.outcome !== "succeeded" || typeof settled.session.result?.text !== "string")
    return orchestrationRejected(
      "agent-create",
      settled.settlement.code ?? "agent_declaration_missing",
      settled.settlement.reason ??
        "The designer did not return a succeeded structured declaration; rerun ha agent create " +
          "with a requirement that asks for one JSON object.",
    );
  let declaration: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(settled.session.result.text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("declaration must be a JSON object");
    declaration = parsed as Record<string, unknown>;
  } catch (error) {
    consumeKnownError(error);
    throw context.codedError(
      "agent_declaration_invalid",
      "The designer result was not one JSON object; rerun ha agent create and require exactly " +
        "one agent-declaration/v1 JSON object.",
    );
  }
  const validation = (await context.run({
    kind: "agent-validate",
    declaration,
    declarationSource: "runtime-result",
    ...(payload.executor !== undefined ? { executor: payload.executor } : {}),
  } as RepoTaskAction)) as unknown as JsonObject;
  if (validation.ok !== true || typeof validation.evidence !== "string")
    return orchestrationRejected(
      "agent-create",
      "agent_validation_failed",
      "ha agent validate could not produce a validation report; rerun ha agent create after checking the daemon.",
    );
  const validationReport = JSON.parse(validation.evidence) as Record<string, unknown>;
  if (validationReport.valid !== true)
    return orchestrationRejected(
      "agent-create",
      "agent_declaration_invalid",
      `ha agent validate rejected the declaration; fix the reported fields and rerun ha agent ` +
        `create. ${JSON.stringify(validationReport.issues ?? [])}`,
    );
  const installation = (await context.run({
    kind: "agent-install",
    declaration,
    declarationSource: "runtime-result",
    generatedOnly: true,
    validated: true,
    ...(payload.executor !== undefined ? { executor: payload.executor } : {}),
  } as RepoTaskAction)) as unknown as JsonObject;
  if (installation.ok !== true) return installation;
  return {
    schema: "command-receipt/v2",
    ok: true,
    command: "agent-create",
    outcome: "succeeded",
    designerAgentId: String(payload.agentId),
    runtimeSessionId,
    dispatchId: spawned.dispatchId,
    declaration: declaration as JsonObject,
    validation: validationReport as JsonObject,
    installation,
    result: settled.session.result,
    summary: `agent-create: installed ${String(declaration.id)}`,
    exitCode: 0,
  };
}

/** One parked long wait over a set of runtime sessions or task dispatches. The daemon owns the
 * settle decision: each wake re-reads the authoritative projection verdicts (session settlement,
 * dispatch rows) and the CLI only renders what comes back — no client-side polling or outcome
 * derivation. Read-only: the wait takes no lease and writes no ledger entries. */
export async function orchestrateRuntimeSessionsAwait(
  payload: Readonly<Record<string, unknown>>,
  context: RuntimeAwaitContext,
): Promise<JsonObject> {
  const mode = payload.mode === undefined ? undefined : String(payload.mode);
  if (mode !== undefined && mode !== "any" && mode !== "all")
    throw context.codedError("invalid_field", "sessions.await mode must be any or all.");
  const runtimeSessionIds = requiredIdList(payload.runtimeSessionIds, "runtimeSessionIds", context),
    taskIds = requiredIdList(payload.taskIds, "taskIds", context);
  if (runtimeSessionIds !== null && taskIds !== null)
    throw context.codedError("invalid_field", "sessions.await accepts runtimeSessionIds or taskIds, not both.");
  if (runtimeSessionIds === null && taskIds === null)
    throw context.codedError("invalid_field", "sessions.await requires runtimeSessionIds or taskIds.");
  if (taskIds !== null) return awaitTaskDispatches(taskIds, mode ?? "all", context);
  return awaitSessionSet(runtimeSessionIds!, mode ?? "any", context);
}

function requiredIdList(
  value: unknown,
  field: string,
  context: Pick<RuntimeAwaitContext, "codedError">,
): readonly string[] | null {
  if (value === undefined) return null;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 500 ||
    value.some((item) => typeof item !== "string" || item.length === 0) ||
    new Set(value).size !== value.length
  )
    throw context.codedError("invalid_field", `sessions.await ${field} must be 1..500 unique non-empty strings.`);
  return value as readonly string[];
}

type AwaitedSessionRow = {
  readonly runtimeSessionId: string;
  readonly outcome: string;
  readonly exitCode: number;
  readonly code: string | null;
  readonly reason: string | null;
  readonly resultText: string | null;
};

async function awaitSessionSet(
  runtimeSessionIds: readonly string[],
  mode: "any" | "all",
  context: RuntimeAwaitContext,
): Promise<JsonObject> {
  const unavailable: string[] = [];
  let settled: readonly AwaitedSessionRow[],
    inFlight: readonly { readonly runtimeSessionId: string; readonly liveness: string }[],
    lastRead: AgentRuntimeSessionResult | undefined;
  for (;;) {
    const reads = await Promise.allSettled(runtimeSessionIds.map((id) => context.readSession(id))),
      settledNext: AwaitedSessionRow[] = [],
      inFlightNext: { readonly runtimeSessionId: string; readonly liveness: string }[] = [];
    reads.forEach((read, index) => {
      const runtimeSessionId = runtimeSessionIds[index]!;
      if (!("value" in read)) {
        if (errorCode(read.reason) !== "runtime_session_not_found") throw read.reason;
        if (!unavailable.includes(runtimeSessionId)) unavailable.push(runtimeSessionId);
        return;
      }
      const result = read.value,
        settlement = result.settlement;
      lastRead = result;
      if (settlement === null) {
        inFlightNext.push({ runtimeSessionId, liveness: result.session.liveness });
        return;
      }
      settledNext.push({
        runtimeSessionId,
        outcome: settlement.outcome,
        exitCode: settlement.exitCode,
        code: settlement.code,
        reason: settlement.reason,
        resultText: result.result?.text ?? null,
      });
    });
    settled = settledNext;
    inFlight = inFlightNext;
    // any: the first settled session answers; all: every known session must settle. Sessions
    // absent from this node's projection are reported, never waited on — otherwise the request
    // would hang on a session only another edge node can see.
    if (inFlight.length === 0 || (mode === "any" && settled.length > 0)) break;
    await parkAwait(context);
  }
  const winner = settled[0],
    outcome =
      mode === "any"
        ? (winner?.outcome ?? "unknown")
        : unavailable.length === 0 && settled.length > 0 && settled.every((row) => row.outcome === "succeeded")
          ? "succeeded"
          : settled.some((row) => row.outcome === "unknown") || settled.length === 0
            ? "unknown"
            : "failed",
    exitCode = mode === "any" ? (winner?.exitCode ?? 1) : outcome === "succeeded" ? 0 : 1,
    hint =
      unavailable.length > 0
        ? `${unavailable.length} session${unavailable.length === 1 ? " is" : "s are"} not in this ` +
          "node's runtime projection; wait on the node that owns them or check the session ids."
        : null,
    diagnosed = settled.find((row) => row.reason !== null),
    // The N=1 receipt keeps the old sessions.read fields (session/result/settlement/watermark)
    // alongside the multi-target split, so a single-session wait reads exactly like before.
    single = runtimeSessionIds.length === 1 ? lastRead : undefined;
  return {
    ...(single as unknown as JsonObject | undefined),
    schema: "command-receipt/v2",
    ok: true,
    command: "runtime-status",
    mode,
    outcome,
    ...(single ? { runtimeSessionId: runtimeSessionIds[0] } : {}),
    ...(diagnosed ? { code: diagnosed.code, reason: diagnosed.reason } : {}),
    sessions: settled as unknown as JsonObject[],
    inFlight: inFlight as unknown as JsonObject[],
    unavailable: unavailable.map((runtimeSessionId) => ({
      runtimeSessionId,
      code: "runtime_session_not_found",
    })) as unknown as JsonObject[],
    ...(hint ? { nextAction: hint } : {}),
    summary:
      // A single-target wait keeps the old receipt's text-first summary; multi-target waits name
      // the settled session and count what is still outstanding.
      winner && runtimeSessionIds.length === 1
        ? (winner.resultText ?? winner.reason ?? `runtime-status: ${winner.outcome}`)
        : mode === "any" && winner
          ? `runtime-status: ${winner.runtimeSessionId} settled ${winner.outcome}` +
            (inFlight.length ? `; ${inFlight.length} still in flight` : "")
          : `runtime-status: ${settled.length} settled, ${inFlight.length} in flight` +
            (unavailable.length ? `, ${unavailable.length} unavailable` : ""),
    exitCode,
  };
}

async function awaitTaskDispatches(
  taskIds: readonly string[],
  mode: "any" | "all",
  context: RuntimeAwaitContext,
): Promise<JsonObject> {
  for (;;) {
    const read = await context.readTaskDispatches(taskIds);
    if (read.ok !== true) return read as unknown as JsonObject;
    const rows = read.dispatches,
      dispatchIds = rows.map((row) => row.dispatchId),
      settled = rows.filter((row) => taskDispatchRowSettled(row, dispatchIds)),
      // The batch projection reporting "pending" is still catching up; keep waiting for it.
      projectionReady = read.status === "ready",
      done =
        projectionReady && (mode === "all" ? taskDispatchRowsSettled(rows) : settled.length > 0 || rows.length === 0);
    if (done) {
      const winner = settled[0];
      return {
        ...(read as unknown as JsonObject),
        command: "runtime-status",
        mode,
        taskIds: taskIds as unknown as JsonObject[],
        summary:
          `runtime-status task ${taskIds.join(",")}: ${rows.length} ` +
          `dispatch${rows.length === 1 ? "" : "es"}, ${String(read.outcome)}`,
        exitCode: mode === "all" ? (read.exitCode ?? 0) : (winner?.exitCode ?? read.exitCode ?? 0),
      };
    }
    await parkAwait(context);
  }
}

/** The park between settle re-reads. The connection signal is not a settle input: it ends the wait
 *  outright, because a reply to a closed connection has nowhere to land. */
async function parkAwait(context: RuntimeAwaitContext): Promise<void> {
  const signal = context.connectionSignal;
  if (signal?.aborted) throw context.codedError("client_disconnected", "The connection that parked this wait closed.");
  if (!signal) return context.awaitSignal();
  const wake = context.awaitSignal();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(context.codedError("client_disconnected", "The connection that parked this wait closed."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    wake.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
