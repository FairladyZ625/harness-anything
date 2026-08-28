import { randomUUID } from "node:crypto";
import type { DaemonHost } from "../daemon-host.ts";
import type { FleetEdgeTaskRequest } from "../fleet-edge-task.ts";
import type { FleetEdgeConflictExitRequest, FleetEdgeDocSyncRequest } from "../fleet-edge-doc-sync.ts";
import type { DaemonRequestLogEntry } from "../request-log.ts";
import type { DaemonTrafficLogEntry } from "../conn-log.ts";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import {
  actionForDaemonMethod,
  daemonStreamFacets,
  daemonProtocolError,
  isDaemonGuiActionMethod,
  isDaemonGuiReadMethod,
  isDaemonStreamMethod,
  jsonRpcMethodContracts,
  makeDaemonCommandReceipt,
  parseDaemonRpcParams,
  type DaemonSessionEnvironment,
} from "./daemon-protocol.contract.ts";
import {
  parseDaemonGuiActionResult,
  parseDaemonGuiReadResult,
  parseDaemonStreamResult,
} from "./gui-result-validation.ts";
import {
  isJsonObject,
  type JsonObject,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./json-rpc-types.ts";
import { currentDaemonProtocolVersion } from "./version.ts";
import { isContractVersionCompatible } from "../../../kernel/src/domain/contract-version.ts";
import type { DaemonBuildObserver, DaemonBuildStamp } from "../build-identity.ts";
export interface JsonRpcProtocolServer {
  readonly handle: (
    message: JsonRpcRequest | JsonRpcRequest[],
  ) => Promise<JsonRpcResponse | JsonRpcResponse[] | undefined>;
  readonly close: () => void;
}
interface ObservedRequest {
  readonly repoId: string;
  readonly command: string;
  readonly executor: DaemonRequestLogEntry["executor"];
}
export function createJsonRpcProtocolServer(options: {
  readonly host: DaemonHost;
  readonly build: DaemonBuildStamp;
  readonly buildObserver?: DaemonBuildObserver;
  readonly authContext: DaemonAuthenticationContext;
  readonly emit: (method: string, params: JsonObject) => Promise<void>;
  readonly connectionId?: string;
  readonly recordRequest?: (entry: DaemonRequestLogEntry) => void;
  readonly recordTraffic?: (entry: DaemonTrafficLogEntry) => void;
  readonly requestShutdown?: () => void;
}): JsonRpcProtocolServer {
  let handshaken = false;
  // Every client — CLI, GUI, fleet — converges on this server, and every dispatched response is
  // built by the reply() below, so one hook there observes the whole request surface.
  const connectionId = options.connectionId ?? randomUUID();
  type Subscription = {
    readonly initial: unknown;
    readonly next: () => Promise<JsonObject | null>;
    readonly detach: () => void;
  };
  const subscriptions = new Set<Subscription>();
  const one = async (request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> => {
    const id = request.id ?? null,
      startedAt = Date.now();
    let observed: ObservedRequest = {
      repoId: "",
      command: typeof request.method === "string" ? request.method : "",
      executor: null,
    };
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      traffic(typeof request.method === "string" ? request.method : null, startedAt, 0, false, "-32600");
      return rpcError(id, -32600, "Invalid Request");
    }
    if (!jsonRpcMethodContracts.some((entry) => entry.method === request.method)) {
      traffic(request.method, startedAt, 0, false, "-32601");
      return rpcError(id, -32601, "Method not found");
    }
    const reply = (result: JsonObject): JsonRpcResponse | undefined => {
      const durationMs = Date.now() - startedAt;
      record(request.method, observed, result, durationMs);
      traffic(request.method, startedAt, durationMs, result.ok === true, resultErrorCode(result));
      return request.id === undefined ? undefined : { jsonrpc: "2.0", id, result };
    };
    const parsed = parseDaemonRpcParams(request.method, request.params);
    if (!parsed.ok)
      return reply(
        daemonProtocolError(request.method, "invalid_request", parsed.errors.join("; ")) as unknown as JsonObject,
      );
    const params = parsed.params;
    observed = { ...observed, repoId: repoIdFromParams(params) };
    if (request.method === "protocol.hello") {
      if (!isContractVersionCompatible(params.protocolVersion, currentDaemonProtocolVersion))
        return reply(
          daemonProtocolError(
            "protocol.hello",
            "incompatible_protocol_version",
            "Use the daemon protocol version reported by this binary.",
          ) as unknown as JsonObject,
        );
      if (params.sessionEnvironment === undefined) Reflect.deleteProperty(options.authContext, "sessionEnvironment");
      else
        Object.assign(options.authContext, {
          sessionEnvironment: params.sessionEnvironment as DaemonSessionEnvironment,
        });
      const buildStatus = options.buildObserver?.status();
      if (buildStatus?.drifted) {
        const stale = daemonProtocolError(
          "protocol.hello",
          "daemon_build_stale",
          `Daemon build is stale: loaded ${buildStatus.loadedBuildId ?? "missing"}, ` +
            `disk ${buildStatus.diskBuildId ?? "missing"}. Restarting once to load the disk build.`,
        ) as unknown as JsonObject;
        const response = reply({
          ...stale,
          loadedBuildId: buildStatus.loadedBuildId,
          diskBuildId: buildStatus.diskBuildId,
        });
        setImmediate(() => options.requestShutdown?.());
        return response;
      }
      handshaken = true;
      return reply({
        ok: true,
        protocolVersion: currentDaemonProtocolVersion,
        methods: jsonRpcMethodContracts.map((entry) => entry.method),
        build: { ...options.build },
      });
    }
    if (!handshaken)
      return reply(
        daemonProtocolError(request.method, "hello_required", "Call protocol.hello first.") as unknown as JsonObject,
      );
    if (request.method === "daemon.status")
      return reply({ ok: true, ...options.host.status() } as unknown as JsonObject);
    if (request.method === "daemon.stop") {
      if (options.authContext.transportKind !== "unix-socket" || options.authContext.assignmentBinding)
        return reply(
          daemonProtocolError(
            "daemon-stop",
            "local_transport_required",
            "Stop is available only through the local session token.",
          ) as unknown as JsonObject,
        );
      if (!options.requestShutdown)
        return reply(
          daemonProtocolError(
            "daemon-stop",
            "shutdown_unavailable",
            "This daemon composition has no shutdown owner.",
          ) as unknown as JsonObject,
        );
      const response = reply({ ok: true, command: "daemon-stop", pid: process.pid });
      options.requestShutdown();
      return response;
    }
    if (request.method === "daemon.repo.bootstrap") {
      try {
        return reply(
          (await options.host.bootstrap(
            params as unknown as Parameters<DaemonHost["bootstrap"]>[0],
            options.authContext,
          )) as JsonObject,
        );
      } catch (error) {
        return reply(
          daemonProtocolError(
            "init",
            rpcServerErrorCode(error),
            error instanceof Error ? error.message : String(error),
          ) as unknown as JsonObject,
        );
      }
    }
    if (request.method === "daemon.repo.register" || request.method === "daemon.repo.unregister") {
      try {
        return reply(
          (await options.host.admin(
            request.method.endsWith("unregister")
              ? { kind: "unregister", repoId: params.repoId as string }
              : {
                  kind: "register",
                  repoId: params.repoId as string,
                  rootDir: params.rootDir as string,
                  ...(typeof params.mode === "string"
                    ? { mode: params.mode as "local" | "remote-center" | "remote-edge" }
                    : {}),
                },
            options.authContext,
          )) as JsonObject,
        );
      } catch (error) {
        return reply(
          daemonProtocolError(
            request.method,
            rpcServerErrorCode(error),
            error instanceof Error ? error.message : String(error),
          ) as unknown as JsonObject,
        );
      }
    }
    if (request.method.startsWith("daemon.runtimeInstance.")) {
      try {
        return reply(
          await options.host.runtimeInstance(request.method, params.payload as JsonObject, options.authContext),
        );
      } catch (error) {
        return reply(
          daemonProtocolError(
            request.method,
            rpcServerErrorCode(error),
            error instanceof Error ? error.message : String(error),
          ) as unknown as JsonObject,
        );
      }
    }
    if (request.method.startsWith("repo.runtimeInstance.auth.")) {
      const repo = (params.repo as JsonObject).repoId as string;
      try {
        return reply(
          await options.host.runtimeInstanceAuth(
            repo,
            request.method,
            params.payload as JsonObject,
            options.authContext,
          ),
        );
      } catch (error) {
        return reply(
          daemonProtocolError(
            request.method,
            rpcServerErrorCode(error),
            error instanceof Error ? error.message : String(error),
          ) as unknown as JsonObject,
        );
      }
    }
    if (request.method === "daemon.fleet.center.start" || request.method === "daemon.fleet.edge.sync") {
      try {
        return reply(
          (await (
            request.method === "daemon.fleet.center.start"
              ? options.host.fleet.startCenter
              : options.host.fleet.edgeSync
          )(params.payload as JsonObject, options.authContext)) as unknown as JsonObject,
        );
      } catch (error) {
        return reply(
          daemonProtocolError(
            request.method,
            rpcServerErrorCode(error),
            error instanceof Error ? error.message : String(error),
          ) as unknown as JsonObject,
        );
      }
    }
    if (request.method === "daemon.fleet.task.run") {
      // Loaded lazily: schema-closure imports this module in a zero-dependency checkout, and the fleet edge stack reaches the kernel barrel.
      try {
        if (options.authContext.transportKind !== "unix-socket" || options.authContext.assignmentBinding)
          throw Object.assign(new Error("This control is available only through the local session token."), {
            code: "local_transport_required",
          });
        const fleetPayload = params.payload as JsonObject,
          fleetAction = fleetPayload.action;
        if (isJsonObject(fleetAction) && fleetAction.kind === "fleet-runtime") {
          if (
            ![
              "repo.agentRuntime.spawn",
              "repo.agentRuntime.cancel",
              "repo.agentRuntime.overview",
              "repo.agentRuntime.sessions.read",
            ].includes(String(fleetAction.method)) ||
            !isJsonObject(fleetAction.payload)
          )
            throw Object.assign(new Error("Fleet runtime envelope must carry one closed runtime method and payload."), {
              code: "invalid_field",
            });
          return reply(
            (await options.host.fleet.edgeRuntime(
              { ...fleetPayload, method: fleetAction.method, action: fleetAction.payload } as JsonObject,
              options.authContext,
            )) as unknown as JsonObject,
          );
        }
        if (isJsonObject(fleetAction) && fleetAction.kind === "fleet-schedule") {
          if (!isJsonObject(fleetAction.payload))
            throw Object.assign(new Error("Fleet Schedule envelope must carry one closed action payload."), {
              code: "invalid_field",
            });
          return reply(
            (await options.host.fleet.edgeRuntime(
              { ...fleetPayload, method: "repo.schedule.run", action: fleetAction.payload } as JsonObject,
              options.authContext,
            )) as unknown as JsonObject,
          );
        }
        const { runFleetEdgeTask } = await import("../fleet-edge-task.ts");
        return reply(
          (await runFleetEdgeTask({
            payload: params.payload as unknown as FleetEdgeTaskRequest["payload"],
          })) as unknown as JsonObject,
        );
      } catch (error) {
        return reply(
          daemonProtocolError(
            request.method,
            rpcServerErrorCode(error),
            error instanceof Error ? error.message : String(error),
          ) as unknown as JsonObject,
        );
      }
    }
    if (request.method === "daemon.fleet.doc.sync" || request.method === "daemon.fleet.conflict.exit") {
      try {
        if (options.authContext.transportKind !== "unix-socket" || options.authContext.assignmentBinding)
          throw Object.assign(new Error("This control is available only through the local session token."), {
            code: "local_transport_required",
          }); // Lazy for the same schema-closure reason as the task channel.
        const { runFleetEdgeDocSync, runFleetEdgeConflictExit } = await import("../fleet-edge-doc-sync.ts");
        return reply(
          (await (request.method === "daemon.fleet.doc.sync"
            ? runFleetEdgeDocSync({ payload: params.payload as unknown as FleetEdgeDocSyncRequest["payload"] })
            : runFleetEdgeConflictExit({
                payload: params.payload as unknown as FleetEdgeConflictExitRequest["payload"],
              }))) as unknown as JsonObject,
        );
      } catch (error) {
        return reply(
          daemonProtocolError(
            request.method,
            rpcServerErrorCode(error),
            error instanceof Error ? error.message : String(error),
          ) as unknown as JsonObject,
        );
      }
    }
    if (request.method === "daemon.gui.system.read") {
      try {
        return reply(
          parseDaemonGuiReadResult(request.method, options.host.system(options.authContext)) as unknown as JsonObject,
        );
      } catch (error) {
        return reply(
          daemonProtocolError(
            request.method,
            rpcServerErrorCode(error),
            error instanceof Error ? error.message : String(error),
          ) as unknown as JsonObject,
        );
      }
    }
    if (request.method === "daemon.gui.control.receipt") {
      try {
        return reply(
          parseDaemonGuiReadResult(
            request.method,
            options.host.controlReceipt(String((params.payload as JsonObject).operationId), options.authContext),
          ) as unknown as JsonObject,
        );
      } catch (error) {
        return reply(
          daemonProtocolError(
            request.method,
            rpcServerErrorCode(error),
            error instanceof Error ? error.message : String(error),
          ) as unknown as JsonObject,
        );
      }
    }
    if (request.method === "daemon.gui.control.request") {
      try {
        return reply(
          parseDaemonGuiActionResult(
            request.method,
            await options.host.requestControl(params.payload as JsonObject, options.authContext),
          ) as unknown as JsonObject,
        );
      } catch (error) {
        return reply(
          daemonProtocolError(
            request.method,
            rpcServerErrorCode(error),
            error instanceof Error ? error.message : String(error),
          ) as unknown as JsonObject,
        );
      }
    }
    if (isDaemonStreamMethod(request.method)) {
      const repo = (params.repo as JsonObject).repoId as string,
        payload = params.payload as JsonObject;
      try {
        const subscription: Subscription =
            request.method === "repo.agentRuntime.attach"
              ? await options.host.attach(
                  repo,
                  payload.runtimeSessionId as string,
                  payload.afterCursor as string,
                  options.authContext,
                )
              : await options.host.terminalAttach(
                  repo,
                  payload.sessionId as string,
                  payload.afterSeq as number,
                  options.authContext,
                ),
          initial = parseDaemonStreamResult(request.method, subscription.initial);
        if (initial.ok) {
          subscriptions.add(subscription);
          const eventMethod = daemonStreamFacets.find((facet) => facet.method === request.method)!.eventMethod;
          setImmediate(() => pump(subscription, eventMethod));
        }
        return reply(initial as unknown as JsonObject);
      } catch (error) {
        return reply(
          daemonProtocolError(
            request.method,
            rpcServerErrorCode(error),
            error instanceof Error ? error.message : String(error),
          ) as unknown as JsonObject,
        );
      }
    }
    if (isDaemonGuiReadMethod(request.method)) {
      const repo = (params.repo as JsonObject).repoId as string;
      try {
        return reply(
          parseDaemonGuiReadResult(
            request.method,
            await options.host.read(
              repo,
              request.method,
              (params.payload as JsonObject | undefined) ?? {},
              options.authContext,
            ),
          ) as unknown as JsonObject,
        );
      } catch (error) {
        return reply(
          daemonProtocolError(
            request.method,
            rpcServerErrorCode(error),
            error instanceof Error ? error.message : String(error),
          ) as unknown as JsonObject,
        );
      }
    }
    if (request.method === "repo.agentRuntime.spawn") {
      const repo = (params.repo as JsonObject).repoId as string;
      try {
        return reply(
          parseDaemonGuiActionResult(
            request.method,
            await options.host.spawnRuntime(repo, params.payload as JsonObject, options.authContext),
          ) as unknown as JsonObject,
        );
      } catch (error) {
        return reply(
          daemonProtocolError(
            request.method,
            rpcServerErrorCode(error),
            error instanceof Error ? error.message : String(error),
          ) as unknown as JsonObject,
        );
      }
    }
    if (request.method === "repo.agentRuntime.cancel") {
      const repo = (params.repo as JsonObject).repoId as string;
      try {
        return reply(
          parseDaemonGuiActionResult(
            request.method,
            await options.host.cancelRuntime(repo, params.payload as JsonObject, options.authContext),
          ) as unknown as JsonObject,
        );
      } catch (error) {
        return reply(
          daemonProtocolError(
            request.method,
            rpcServerErrorCode(error),
            error instanceof Error ? error.message : String(error),
          ) as unknown as JsonObject,
        );
      }
    }
    if (request.method === "repo.gui.catalog.reread" || request.method.startsWith("repo.terminal.")) {
      const repo = (params.repo as JsonObject).repoId as string;
      try {
        return reply(
          parseDaemonGuiActionResult(
            request.method as import("./daemon-protocol.contract.ts").DaemonGuiActionMethod,
            await options.host.terminalAction(repo, request.method, params.payload as JsonObject, options.authContext),
          ) as unknown as JsonObject,
        );
      } catch (error) {
        return reply(
          daemonProtocolError(
            request.method,
            rpcServerErrorCode(error),
            error instanceof Error ? error.message : String(error),
          ) as unknown as JsonObject,
        );
      }
    }
    const repo = (params.repo as JsonObject).repoId as string;
    let action: JsonObject & { readonly kind: string };
    try {
      action = actionForDaemonMethod(request.method, params.payload as JsonObject);
    } catch (error) {
      return reply(
        daemonProtocolError(
          request.method,
          rpcServerErrorCode(error),
          error instanceof Error ? error.message : String(error),
        ) as unknown as JsonObject,
      );
    }
    observed = { ...observed, command: action.kind, executor: declaredExecutorOrNull(action) };
    if (action.kind === "preset-run-start" || action.kind === "preset-run-status")
      return reply((await options.host.presetRun(repo, action, options.authContext)) as unknown as JsonObject);
    const receipt = await options.host.run(repo, action, options.authContext),
      result = makeDaemonCommandReceipt(action.kind, receipt);
    return reply(
      isDaemonGuiActionMethod(request.method)
        ? (parseDaemonGuiActionResult(request.method, result) as unknown as JsonObject)
        : result,
    );
  };
  return {
    handle: async (message) =>
      Array.isArray(message)
        ? (await Promise.all(message.map(one))).filter((item): item is JsonRpcResponse => item !== undefined)
        : one(message),
    close: () => {
      for (const subscription of subscriptions) subscription.detach();
      subscriptions.clear();
    },
  };
  async function pump(subscription: Subscription, eventMethod: string): Promise<void> {
    try {
      for (;;) {
        const event = await subscription.next();
        if (!event) break;
        await options.emit(eventMethod, event);
      }
    } finally {
      subscription.detach();
      subscriptions.delete(subscription);
    }
  }
  // Repo-scoped by design: the log lives in the repository's local root, so a request that binds no
  // repository (protocol.hello, daemon.status, registry admin) has nowhere to be filed and is skipped.
  function record(method: string, observed: ObservedRequest, result: JsonObject, durationMs: number): void {
    if (!options.recordRequest || !observed.repoId) return;
    options.recordRequest({
      method,
      repoId: observed.repoId,
      command: observed.command,
      connectionId,
      auth: options.authContext,
      executor: observed.executor,
      ok: result.ok === true,
      outcome: typeof result.outcome === "string" ? result.outcome : null,
      code: resultErrorCode(result),
      opId: typeof result.opId === "string" ? result.opId : null,
      durationMs,
    });
  }
  // Daemon-scoped counterpart: every request including hello and pre-dispatch rejections gets one
  // line, so connection-level forensics never depends on repo binding.
  function traffic(
    method: string | null,
    startedAt: number,
    durationMs: number,
    ok: boolean,
    code: string | null,
  ): void {
    if (!options.recordTraffic) return;
    options.recordTraffic({
      conn: connectionId,
      transport: options.authContext.transportKind,
      method,
      startedAt,
      durationMs,
      ok,
      code,
    });
  }
}

function repoIdFromParams(params: JsonObject): string {
  const repo = params.repo;
  return isJsonObject(repo) && typeof repo.repoId === "string" ? repo.repoId : "";
}
// The executor rides on the resolved action, which is where the daemon reads it for attribution:
// repo.task.run carries it inside payload.action, every other method merges payload into the action.
function declaredExecutorOrNull(action: JsonObject): DaemonRequestLogEntry["executor"] {
  const executor = action.executor;
  return isJsonObject(executor) && executor.kind === "agent" && typeof executor.id === "string"
    ? { kind: "agent", id: executor.id }
    : null;
}
function resultErrorCode(result: JsonObject): string | null {
  if (typeof result.code === "string") return result.code;
  const error = result.error;
  return isJsonObject(error) && typeof error.code === "string" ? error.code : null;
}
function rpcError(id: JsonRpcId, errorCode: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code: errorCode, message } };
}
function rpcServerErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "bootstrap_failed";
}
