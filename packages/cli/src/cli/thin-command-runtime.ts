import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import {
  accepted,
  nonEmpty,
  promptInput,
  readFlags,
  rejectInput,
  rejected,
} from "./thin-command-flags.ts";
import { parseRuntimeStatus } from "./thin-command-runtime-status.ts";
import type {
  ProtocolCommand,
  ThinCliInputDirectory,
  ThinParseResult,
} from "./thin-command-types.ts";

export function parseRuntime(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const kind = route.id,
    optional = kind === "runtime-status",
    id = args[2]?.startsWith("--") ? undefined : args[2],
    f = readFlags(kind, args.slice(id ? 3 : 2), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  if (!optional && !nonEmpty(id))
    return rejected(
      "missing_field",
      `Run ha runtime ${kind.slice(8)} <${runtimeTarget(kind)}>.`,
      json,
    );
  if (kind === "runtime-batch")
    return accepted(
      rootDir,
      repoId,
      json,
      { kind, batchFile: id },
      route.method,
    );
  if (kind === "runtime-status")
    return parseRuntimeStatus(route, rootDir, repoId, json, id, f, inputs);
  if (kind === "runtime-cancel")
    return accepted(
      rootDir,
      repoId,
      json,
      { kind, runtimeSessionId: id },
      route.method,
    );
  const prompt = promptInput(f.one),
    taskId = f.one.get("--task"),
    promptFlagPresent = f.one.has("--prompt") || f.one.has("--prompt-file"),
    detach = f.booleans.has("--detach"),
    onExitCommand = f.one.get("--on-exit");
  if (!prompt && (promptFlagPresent || !taskId))
    return rejectInput(
      inputs,
      kind,
      f.one.has("--prompt") ? "--prompt-file" : "--prompt",
      json,
    );
  if (onExitCommand && !detach)
    return rejectInput(inputs, kind, "--on-exit", json);
  const cwd = f.one.get("--cwd"),
    agentId = f.one.get("--agent"),
    targetAgentId = f.one.get("--to");
  if (targetAgentId && !agentId)
    return rejected(
      "invalid_field",
      "Use --to <worker-agent-id> only with --agent <leader-agent-id>.",
      json,
    );
  return accepted(
    rootDir,
    repoId,
    json,
    {
      kind,
      runtimeInstanceId: id,
      ...(agentId ? { agentId } : {}),
      ...(targetAgentId ? { targetAgentId } : {}),
      ...(f.one.get("--model") ? { model: f.one.get("--model") } : {}),
      ...(f.one.get("--effort") ? { effort: f.one.get("--effort") } : {}),
      ...(f.one.get("--permission-mode")
        ? { permissionMode: f.one.get("--permission-mode") }
        : {}),
      ...(prompt ?? {}),
      cwd:
        cwd && cwd !== "."
          ? { scope: "repo-relative", path: cwd }
          : { scope: "repo-root" },
      taskId: taskId ?? null,
      ...(f.one.get("--resume")
        ? { providerSessionId: f.one.get("--resume") }
        : {}),
      ...(f.one.get("--resume-dispatch")
        ? { dispatchId: f.one.get("--resume-dispatch") }
        : {}),
      ...(f.one.get("--idempotency-key")
        ? { idempotencyKey: f.one.get("--idempotency-key") }
        : {}),
      ...(detach ? { detach: true } : {}),
      ...(onExitCommand ? { onExitCommand } : {}),
      ...(f.booleans.has("--no-stream") ? { noStream: true } : {}),
    },
    route.method,
  );
}

function runtimeTarget(kind: string): string {
  return kind === "runtime-run"
    ? "instance-id"
    : kind === "runtime-batch"
      ? "batch-file"
      : "runtime-session-id";
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
  const prompt = promptInput(f.one),
    detach = f.booleans.has("--detach"),
    onExitCommand = f.one.get("--on-exit");
  if (!prompt)
    return rejectInput(
      inputs,
      "runtime-run",
      f.one.has("--prompt") ? "--prompt-file" : "--prompt",
      json,
    );
  if (onExitCommand && !detach)
    return rejectInput(inputs, "runtime-run", "--on-exit", json);
  const cwd = f.one.get("--cwd"),
    agentId = f.one.get("--agent"),
    targetAgentId = f.one.get("--to");
  if (targetAgentId && !agentId)
    return rejected(
      "invalid_field",
      "Use --to <worker-agent-id> only with --agent <leader-agent-id>.",
      json,
    );
  return accepted(
    rootDir,
    repoId,
    json,
    {
      kind: "runtime-run",
      dispatchId: f.one.get("--resume-dispatch"),
      ...(f.one.get("--effort") ? { effort: f.one.get("--effort") } : {}),
      ...(f.one.get("--permission-mode")
        ? { permissionMode: f.one.get("--permission-mode") }
        : {}),
      ...prompt,
      cwd:
        cwd && cwd !== "."
          ? { scope: "repo-relative", path: cwd }
          : { scope: "repo-root" },
      taskId: f.one.get("--task") ?? null,
      ...(agentId ? { agentId } : {}),
      ...(targetAgentId ? { targetAgentId } : {}),
      ...(f.one.get("--idempotency-key")
        ? { idempotencyKey: f.one.get("--idempotency-key") }
        : {}),
      ...(detach ? { detach: true } : {}),
      ...(onExitCommand ? { onExitCommand } : {}),
      ...(f.booleans.has("--no-stream") ? { noStream: true } : {}),
    },
    "repo.agentRuntime.spawn",
  );
}
