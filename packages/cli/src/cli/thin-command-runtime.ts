import { daemonMethodPayloadFields } from "@harness-anything/daemon/internal/protocol/daemon-protocol-commands";
import type { SafePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { accepted, nonEmpty, promptInput, readFlags, rejectInput, rejected } from "./thin-command-flags.ts";
import { parseRuntimeStatus } from "./thin-command-runtime-status.ts";
import type { ProtocolCommand, ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

export function parseRuntime(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const kind = route.id;
  if (kind.startsWith("runtime-handoff-")) return parseRuntimeHandoff(route, args, rootDir, repoId, json, inputs);
  if (kind === "runtime-status") {
    // runtime-status is the one runtime surface with an optional positional — and the only one that
    // accepts several: --wait turns consecutive session ids into one multi-target await request.
    const runtimeSessionIds: string[] = [];
    let index = 2;
    while (index < args.length && !args[index]!.startsWith("--")) {
      runtimeSessionIds.push(args[index]!);
      index += 1;
    }
    const f = readFlags(kind, args.slice(index), inputs);
    if (!f.ok) return rejected(f.code, f.nextAction, json);
    return parseRuntimeStatus(route, rootDir, repoId, json, runtimeSessionIds, f);
  }
  if (kind === "runtime-incident-dismiss") return parseIncidentDismiss(route, rootDir, repoId, json, inputs, args);
  if (kind === "runtime-report") return parseRuntimeReport(route, rootDir, repoId, json, inputs, args);
  if (kind === "runtime-collect") return parseRuntimeCollect(route, rootDir, repoId, json, inputs, args);
  const id = args[2]?.startsWith("--") ? undefined : args[2],
    f = readFlags(kind, args.slice(id ? 3 : 2), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  if (!nonEmpty(id))
    return rejected("missing_field", `Run ha runtime ${kind.slice(8)} <${runtimeTarget(kind)}>.`, json);
  if (["runtime-batch", "runtime-cancel", "runtime-steer"].includes(kind))
    return parseRuntimeControl(route, rootDir, repoId, json, inputs, id, f);
  const prompt = promptInput(f.one),
    taskId = f.one.get("--task"),
    missionName = f.one.get("--mission"),
    promptFlagPresent = f.one.has("--prompt"),
    detach = f.booleans.has("--detach"),
    onExitCommand = f.one.get("--on-exit");
  if (taskId || f.one.has("--agent") || f.one.has("--to") || f.one.has("--squad"))
    return rejected("invalid_field", "Use ha agent run <agent-id> --task <task-id> for task-bound work.", json);
  if (!prompt && (promptFlagPresent || !taskId)) return rejectInput(inputs, kind, "--prompt", json);
  const cwd = f.one.get("--cwd"),
    agentId = f.one.get("--agent"),
    targetAgentId = f.one.get("--to"),
    squadId = f.one.get("--squad");
  if (targetAgentId && !agentId)
    return rejected("invalid_field", "Use --to <worker-agent-id> only with --agent <leader-agent-id>.", json);
  if (squadId && !agentId)
    return rejected("invalid_field", "Use --squad <squad-id> only with --agent <leader-agent-id>.", json);
  return accepted(
    rootDir,
    repoId,
    json,
    {
      kind,
      runtimeInstanceId: id,
      ...(agentId ? { agentId } : {}),
      ...(targetAgentId ? { targetAgentId } : {}),
      ...(squadId ? { squadId } : {}),
      ...(f.one.get("--model") ? { model: f.one.get("--model") } : {}),
      ...(f.one.get("--effort") ? { effort: f.one.get("--effort") } : {}),
      ...(f.booleans.has("--fast") ? { fast: true } : {}),
      ...(f.one.get("--permission-mode") ? { permissionMode: f.one.get("--permission-mode") } : {}),
      ...(f.one.get("--mcp-policy") ? { mcpPolicy: f.one.get("--mcp-policy") } : {}),
      ...(prompt ?? {}),
      ...(missionName ? { missionName } : {}),
      cwd: cwd && cwd !== "." ? { scope: "repo-relative", path: cwd } : { scope: "repo-root" },
      taskId: taskId ?? null,
      ...(f.one.get("--resume") ? { providerSessionId: f.one.get("--resume") } : {}),
      ...(f.one.get("--resume-dispatch") ? { dispatchId: f.one.get("--resume-dispatch") } : {}),
      ...(detach ? { detach: true } : {}),
      ...(onExitCommand ? { onExitCommand } : {}),
      ...(f.booleans.has("--no-stream") ? { noStream: true } : {}),
    },
    route.method,
  );
}

function parseRuntimeHandoff(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const kind = route.id,
    dispatchId = args[3],
    f = readFlags(kind, args.slice(4), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  if (!nonEmpty(dispatchId)) return rejected("missing_field", "A source dispatch ID is required.", json);
  return accepted(
    rootDir,
    repoId,
    json,
    {
      kind,
      dispatchId,
      operation: kind.slice("runtime-handoff-".length),
      ...(f.one.get("--instance") ? { runtimeInstanceId: f.one.get("--instance") } : {}),
      ...(f.one.get("--prompt") ? { prompt: f.one.get("--prompt") } : {}),
      ...(f.one.get("--idempotency-key") ? { dispatchKey: f.one.get("--idempotency-key") } : {}),
    },
    route.method,
  );
}

function parseIncidentDismiss(
  route: ProtocolCommand,
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
  args: readonly string[],
): ThinParseResult {
  const kind = route.id,
    dispatchId = args[2],
    f = readFlags(kind, args.slice(3), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  if (!nonEmpty(dispatchId))
    return rejected("missing_field", "Use ha runtime incident-dismiss <dispatch-id> --reason <text>.", json);
  const reason = f.one.get("--reason");
  if (!nonEmpty(reason)) return rejectInput(inputs, kind, "--reason", json);
  return accepted(rootDir, repoId, json, { kind, dispatchId, reason: reason! }, route.method);
}

function parseRuntimeReport(
  route: ProtocolCommand,
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
  args: readonly string[],
): ThinParseResult {
  const kind = route.id,
    f = readFlags(kind, args.slice(2), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const taskId = f.one.get("--task"),
    reportKind = f.one.get("--kind"),
    summary = f.one.get("--summary"),
    idempotencyKey = f.one.get("--idempotency-key");
  if (!nonEmpty(taskId)) return rejectInput(inputs, kind, "--task", json);
  if (!nonEmpty(reportKind)) return rejectInput(inputs, kind, "--kind", json);
  if (!nonEmpty(summary)) return rejectInput(inputs, kind, "--summary", json);
  return accepted(
    rootDir,
    repoId,
    json,
    {
      kind,
      taskId: taskId!,
      reportKind: reportKind!,
      summary: summary!,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
    route.method,
  );
}

function parseRuntimeCollect(
  route: ProtocolCommand,
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
  args: readonly string[],
): ThinParseResult {
  const kind = route.id,
    id = args[2]?.startsWith("--") ? undefined : args[2],
    f = readFlags(kind, args.slice(id ? 3 : 2), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  if (!nonEmpty(id))
    return rejected(
      "missing_field",
      "Use ha runtime collect <task-id|runtime-session-id> [--since <rev>] [--wait-event].",
      json,
    );
  const since = f.one.get("--since"),
    waitEvent = f.booleans.has("--wait-event"),
    timeoutMs = f.one.get("--timeout-ms");
  const target = id!.startsWith("dispatch_")
    ? { dispatchId: id! }
    : id!.startsWith("task_")
      ? { taskId: id! }
      : { runtimeSessionId: id! };
  return accepted(
    rootDir,
    repoId,
    json,
    {
      kind,
      ...target,
      ...(since !== undefined ? { since: Number(since) } : {}),
      ...(waitEvent ? { waitEvent: true } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs: Number(timeoutMs) } : {}),
    },
    route.method,
  );
}

function parseRuntimeControl(
  route: ProtocolCommand,
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
  id: string,
  flags: ReturnType<typeof readFlags> & { readonly ok: true },
): ThinParseResult {
  const kind = route.id;
  if (kind === "runtime-batch") return accepted(rootDir, repoId, json, { kind, batchFile: id }, route.method);
  if (kind === "runtime-cancel")
    return accepted(
      rootDir,
      repoId,
      json,
      {
        kind,
        runtimeSessionId: id,
        ...(flags.one.has("--ruling") ? { ruling: flags.one.get("--ruling") } : {}),
        ...(flags.one.has("--reason") ? { reason: flags.one.get("--reason") } : {}),
        ...(flags.one.has("--idempotency-key") ? { idempotencyKey: flags.one.get("--idempotency-key") } : {}),
      },
      route.method,
    );
  // Like agent run, --prompt-file rides the action and is materialized into
  // prompt client-side before the RPC; the daemon only ever sees prompt.
  const prompt =
      promptInput(flags.one) ?? (flags.one.get("--message")?.trim() ? { prompt: flags.one.get("--message")! } : null),
    promptFile = flags.one.get("--prompt-file"),
    mode = flags.one.get("--mode");
  if (!prompt && !promptFile)
    return rejected(
      "missing_field",
      `Use one non-empty value for --prompt or --prompt-file (or --message). Run ${inputs.get(kind)?.helpCommand ?? `ha ${kind} --help`} for accepted inputs.`,
      json,
    );
  const expected = steerExpectation(flags);
  if (typeof expected === "string") return rejected("invalid_field", expected, json);
  const target = id.startsWith("dispatch_")
    ? { dispatchId: id }
    : id.startsWith("task_")
      ? { taskId: id }
      : { runtimeSessionId: id };
  return accepted(
    rootDir,
    repoId,
    json,
    {
      kind,
      ...target,
      ...prompt,
      ...(promptFile ? { promptFile } : {}),
      ...(mode ? { mode } : {}),
      ...(expected ? { expected } : {}),
      ...(flags.one.has("--idempotency-key") ? { idempotencyKey: flags.one.get("--idempotency-key") } : {}),
    },
    route.method,
  );
}

/** The daemon compares these against the target in the same section that appends the steer. */
function steerExpectation(
  flags: ReturnType<typeof readFlags> & { readonly ok: true },
): Readonly<Record<string, string | number | true>> | null | string {
  const version = flags.one.get("--expect-version");
  if (version !== undefined && !/^\d+$/u.test(version))
    return "--expect-version must be a non-negative integer steer version.";
  const expected = {
    ...(flags.one.get("--expect-task") ? { taskId: flags.one.get("--expect-task")! } : {}),
    ...(flags.one.get("--expect-execution") ? { executionId: flags.one.get("--expect-execution")! } : {}),
    ...(flags.booleans.has("--expect-taskless") ? { taskless: true as const } : {}),
    ...(flags.one.get("--expect-dispatch") ? { dispatchId: flags.one.get("--expect-dispatch")! } : {}),
    ...(version !== undefined ? { version: Number(version) } : {}),
  };
  return Object.keys(expected).length ? expected : null;
}

function runtimeTarget(kind: string): string {
  return kind === "runtime-run" ? "instance-id" : kind === "runtime-batch" ? "batch-file" : "runtime-session-id";
}

export function parseResumeDispatch(
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  args: readonly string[],
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const f = readFlags("runtime-run", args.slice(2), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  if (f.one.has("--mission"))
    return rejected("invalid_field", "A resumed dispatch keeps its original task mission.", json);
  const prompt = promptInput(f.one),
    detach = f.booleans.has("--detach"),
    onExitCommand = f.one.get("--on-exit");
  if (!prompt) return rejectInput(inputs, "runtime-run", "--prompt", json);
  const cwd = f.one.get("--cwd"),
    agentId = f.one.get("--agent"),
    targetAgentId = f.one.get("--to"),
    squadId = f.one.get("--squad");
  if (targetAgentId && !agentId)
    return rejected("invalid_field", "Use --to <worker-agent-id> only with --agent <leader-agent-id>.", json);
  if (squadId && !agentId)
    return rejected("invalid_field", "Use --squad <squad-id> only with --agent <leader-agent-id>.", json);
  return accepted(
    rootDir,
    repoId,
    json,
    {
      kind: "runtime-run",
      dispatchId: f.one.get("--resume-dispatch"),
      ...(f.one.get("--effort") ? { effort: f.one.get("--effort") } : {}),
      ...(f.booleans.has("--fast") ? { fast: true } : {}),
      ...(f.one.get("--permission-mode") ? { permissionMode: f.one.get("--permission-mode") } : {}),
      ...(f.one.get("--mcp-policy") ? { mcpPolicy: f.one.get("--mcp-policy") } : {}),
      ...prompt,
      ...(cwd ? { cwd: cwd !== "." ? { scope: "repo-relative", path: cwd } : { scope: "repo-root" } } : {}),
      ...(f.one.has("--task") ? { taskId: f.one.get("--task") } : {}),
      ...(agentId ? { agentId } : {}),
      ...(targetAgentId ? { targetAgentId } : {}),
      ...(squadId ? { squadId } : {}),
      ...(f.one.get("--model") ? { model: f.one.get("--model") } : {}),
      ...(detach ? { detach: true } : {}),
      ...(onExitCommand ? { onExitCommand } : {}),
      ...(f.booleans.has("--no-stream") ? { noStream: true } : {}),
    },
    "repo.agentRuntime.spawn",
  );
}

/** `ha agent run --recover-dispatch`: the compare values of the fenced recovery and the caller key. */
export function agentRunRecovery(one: ReadonlyMap<string, string>): Record<string, unknown> {
  const dispatchId = one.get("--recover-dispatch");
  if (!dispatchId) return {};
  return {
    recovery: {
      dispatchId,
      executionId: one.get("--execution-id"),
      expectedVersion: Number(one.get("--expected-version")),
    },
    dispatchKey: one.get("--idempotency-key"),
  };
}

export const runtimeSpawnCliOnlyFields = Object.freeze(["claimNext", "detach", "noStream", "promptFile"] as const);

/** Project parsed CLI runtime-run actions strictly onto the daemon-declared `repo.agentRuntime.spawn` payload surface. */
export function projectRuntimeSpawnRpcPayload(
  action: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const allowed = daemonMethodPayloadFields("repo.agentRuntime.spawn"),
    projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(action)) {
    if (key === "kind" || (runtimeSpawnCliOnlyFields as readonly string[]).includes(key)) {
      if (key === "promptFile" && value !== undefined) projected[key] = value;
      continue;
    }
    if (!allowed.includes(key)) throw new Error(`CLI runtime spawn action emitted undeclared protocol field: ${key}`);
    if (value !== undefined) projected[key] = value;
  }
  return projected;
}
