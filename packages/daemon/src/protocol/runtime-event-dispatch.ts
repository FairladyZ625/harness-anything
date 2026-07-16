import {
  runtimeEventActorFromTaskHolderPrincipal,
  taskHolderPrincipalFromActor
} from "../../../application/src/index.ts";
import type { RuntimeEventAppendInput } from "../../../application/src/runtime-event-ledger-service.ts";
import type { AuthenticatedActor } from "../identity/types.ts";
import { isJsonObject, type JsonObject } from "./json-rpc-types.ts";
import type { JsonRpcMethodContract } from "./method-registry.ts";
import { readTaskHolderExecutorForEvent } from "./task-holder-payload.ts";

interface RuntimeEventDispatchOptions {
  readonly daemonId: string;
  readonly appendRuntimeEvent?: (
    input: RuntimeEventAppendInput,
    context?: { readonly repo: DaemonRepoEventNamespace }
  ) => Promise<void>;
}

interface DaemonRepoEventNamespace {
  readonly repoId: string;
  readonly canonicalRoot: string;
}

export async function appendJsonRpcWriteEventIfNeeded(
  options: RuntimeEventDispatchOptions,
  params: JsonObject,
  contract: JsonRpcMethodContract,
  status: "succeeded" | "failed",
  summary: string,
  errorCode: string | undefined,
  actor: AuthenticatedActor | undefined,
  repo: DaemonRepoEventNamespace | undefined
): Promise<void> {
  if (contract.commandClass === "repo-read" || contract.method === "repo.command.run") return;
  await appendJsonRpcCommandEvent(options, params, contract, status, summary, errorCode, actor, repo);
}

export async function appendJsonRpcCommandEvent(
  options: RuntimeEventDispatchOptions,
  params: JsonObject,
  contract: JsonRpcMethodContract,
  status: "succeeded" | "failed",
  summary: string,
  errorCode?: string,
  actor?: AuthenticatedActor,
  repo?: DaemonRepoEventNamespace
): Promise<void> {
  if (!options.appendRuntimeEvent) return;
  const command = commandEventDetails(params);
  const session = runtimeSession(params, options.daemonId, command.taskId);
  const executor = readTaskHolderExecutorForEvent(isJsonObject(params.payload) ? params.payload : undefined);
  const eventActor = actor
    ? runtimeEventActorFromTaskHolderPrincipal(taskHolderPrincipalFromActor(actor, { executor }))
    : undefined;
  if (!eventActor) return;
  await options.appendRuntimeEvent({
    kind: "result",
    actor: eventActor,
    session,
    tool: {
      toolName: command.toolName ?? contract.method,
      ...(errorCode ? { errorCode } : {})
    },
    result: {
      status,
      summary,
      ...(errorCode ? { errorCode } : {})
    }
  }, repo ? { repo } : undefined).catch(() => undefined);
}

function commandEventDetails(params: JsonObject): { readonly toolName?: string; readonly taskId?: string } {
  const payload = isJsonObject(params.payload) ? params.payload : {};
  const command = isJsonObject(payload.command) ? payload.command : {};
  const action = isJsonObject(command.action) ? command.action : {};
  const toolName = typeof action.kind === "string" && action.kind.trim() ? action.kind : undefined;
  const taskId = typeof payload.taskId === "string"
    ? payload.taskId
    : typeof action.taskId === "string"
    ? action.taskId
    : typeof action.oldTaskId === "string"
      ? action.oldTaskId
      : typeof action.sourceTaskId === "string"
        ? action.sourceTaskId
        : undefined;
  return {
    ...(toolName ? { toolName } : {}),
    ...(taskId ? { taskId } : {})
  };
}

function runtimeSession(
  params: JsonObject,
  daemonId: string,
  taskId?: string
): { readonly sessionId: string; readonly runtime: "human" | "claude-code" | "codex" | "zcode" | "antigravity" | "unknown"; readonly taskId?: string } {
  const session = isJsonObject(params.session) ? params.session : {};
  const runtime = typeof session.runtime === "string" && ["human", "claude-code", "codex", "zcode", "antigravity"].includes(session.runtime)
    ? session.runtime as "human" | "claude-code" | "codex" | "zcode" | "antigravity"
    : "unknown";
  return {
    sessionId: typeof session.sessionId === "string" && session.sessionId.trim() ? session.sessionId : `daemon-${daemonId}`,
    runtime,
    ...(taskId ? { taskId } : {})
  };
}
