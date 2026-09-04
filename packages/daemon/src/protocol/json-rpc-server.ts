import { randomUUID } from "node:crypto";
import type { DaemonHost } from "../daemon-host.ts";
import type { DaemonRequestLogEntry } from "../request-log.ts";
import type { DaemonTrafficLogEntry } from "../conn-log.ts";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import {
  actionForDaemonMethod,
  daemonStreamFacets,
  daemonProtocolError,
  invalidParamsReceipt,
  isDaemonGuiActionMethod,
  jsonRpcMethodContracts,
  makeDaemonCommandReceipt,
  parseDaemonRpcParams,
  type DaemonFleetTaskAction,
  type DaemonBuildDrainStatus,
  type DaemonRpcMethod,
  type DaemonRpcResult,
} from "./daemon-protocol.contract.ts";
import {
  declaredExecutorOrNull,
  isDaemonStreamCall,
  isRepoGuiReadCall,
  isRuntimeInstanceAuthCall,
  isRuntimeInstanceCall,
  isTerminalActionCall,
  daemonStopRefusal,
  daemonStoppingRefusal,
  protocolErrorMessage,
  repoIdFromParams,
  resultErrorCode,
  resultErrorDetail,
  resultOk,
  rpcError,
  rpcServerErrorCode,
  type DaemonRepoPayloadCall,
} from "./json-rpc-dispatch-support.ts";
import {
  parseDaemonGuiActionResult,
  parseDaemonGuiReadResult,
  parseDaemonStreamResult,
} from "./gui-result-validation.ts";
import { isJsonObject, type JsonObject, type JsonRpcRequest, type JsonRpcResponse } from "./json-rpc-types.ts";
import { currentDaemonProtocolVersion } from "./version.ts";
import { isContractVersionCompatible } from "../../../kernel/src/domain/contract-version.ts";
import type { CoreDomainError } from "../../../kernel/src/index.ts";
import type { DaemonBuildObserver, DaemonBuildStamp } from "../build-identity.ts";
import { diagnosticForError } from "../receipt-guidance.ts";
import { remoteProxyEventMethod } from "../remote-proxy.ts";
import { daemonBuildStaleNotice, withDaemonDrainSummary } from "../daemon-build-drain.ts";
export interface JsonRpcProtocolServer {
  readonly handle: (
    message: JsonRpcRequest | JsonRpcRequest[],
    timing?: { readonly frameReceivedAt: number },
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
  readonly buildDrainStatus?: () => DaemonBuildDrainStatus;
  readonly stopping?: () => boolean;
  readonly onRequestStarted?: (method: string) => void;
  readonly onRequestSettled?: (method: string) => void;
  readonly onBuildDriftObserved?: () => void;
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
  const run = async (request: JsonRpcRequest, frameReceivedAt = Date.now()): Promise<JsonRpcResponse | undefined> => {
    const id = request.id ?? null,
      startedAt = Date.now(),
      dispatchDelayMs = Math.max(0, startedAt - frameReceivedAt);
    let observed: ObservedRequest = {
      repoId: "",
      command: typeof request.method === "string" ? request.method : "",
      executor: null,
    };
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      traffic(
        typeof request.method === "string" ? request.method : null,
        frameReceivedAt,
        startedAt,
        Date.now(),
        false,
        "-32600",
        "Invalid Request",
      );
      return rpcError(id, -32600, "Invalid Request");
    }
    if (!isContractedDaemonRpcMethod(request.method)) {
      traffic(request.method, frameReceivedAt, startedAt, Date.now(), false, "-32601", "Method not found");
      return rpcError(id, -32601, "Method not found");
    }
    const reply = <Method extends DaemonRpcMethod>(
      method: Method,
      result: DaemonRpcResult<Method>,
    ): JsonRpcResponse | undefined => {
      const repliedAt = Date.now(),
        serviceMs = repliedAt - startedAt;
      recordRequest(method, observed, result, dispatchDelayMs, serviceMs);
      traffic(
        method,
        frameReceivedAt,
        startedAt,
        repliedAt,
        resultOk(result),
        resultErrorCode(result),
        resultErrorDetail(result),
      );
      return request.id === undefined ? undefined : { jsonrpc: "2.0", id, result };
    };
    const parsed = parseDaemonRpcParams(request.method, request.params);
    if (!parsed.ok) return reply(request.method, invalidParamsReceipt(request.method, parsed.errors));
    const call = parsed.call,
      { method, params } = call;
    observed = { ...observed, repoId: repoIdFromParams(params) };
    if (request.method === "protocol.hello" && method === request.method) {
      if (!isContractVersionCompatible(params.protocolVersion, currentDaemonProtocolVersion)) {
        const mismatch = {
          _tag: "ProtocolVersionMismatchError",
          code: "incompatible_protocol_version",
          message: "Use the daemon protocol version reported by this binary.",
        } satisfies Extract<CoreDomainError, { readonly _tag: "ProtocolVersionMismatchError" }>;
        return reply(method, daemonProtocolError("protocol.hello", mismatch.code, mismatch.message));
      }
      if (params.sessionEnvironment === undefined) Reflect.deleteProperty(options.authContext, "sessionEnvironment");
      else
        Object.assign(options.authContext, {
          sessionEnvironment: params.sessionEnvironment,
        });
      const warning = daemonBuildStaleNotice(options.buildObserver, options.buildDrainStatus);
      if (warning && params.reportStaleBuild) options.onBuildDriftObserved?.();
      handshaken = true;
      return reply(method, {
        ok: true,
        protocolVersion: currentDaemonProtocolVersion,
        methods: jsonRpcMethodContracts.map((entry) => entry.method),
        build: { ...options.build },
        ...(warning ? { warning } : {}),
      });
    }
    if (!handshaken) return reply(method, daemonProtocolError(method, "hello_required", "Call protocol.hello first."));
    const stoppingRefusal = daemonStoppingRefusal(method, options.stopping?.() === true);
    if (stoppingRefusal) return reply(method, stoppingRefusal);
    const remoteProxy = options.host.remoteProxy;
    if (method === "daemon.repo.bootstrap" && remoteProxy?.route(params.repoId))
      return reply(
        method,
        daemonProtocolError(
          method,
          "repo_mode_remote_proxy",
          "This repository has no local workspace; bootstrap is unavailable in remote-proxy mode.",
        ),
      );
    const remoteRepoId = repoIdFromParams(params);
    if (remoteRepoId && remoteProxy?.route(remoteRepoId)) {
      try {
        if (isDaemonStreamCall(call)) {
          const subscription = await remoteProxy.stream(remoteRepoId, call.method, call.params.payload);
          subscriptions.add(subscription);
          setImmediate(() => pump(subscription, remoteProxyEventMethod(call.method)));
          return reply(call.method, subscription.initial);
        }
        const result = await remoteProxy.request(remoteRepoId, method, params);
        return reply(method, result as DaemonRpcResult<typeof method>);
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (request.method === "daemon.status") {
      const warning = daemonBuildStaleNotice(options.buildObserver, options.buildDrainStatus);
      return reply("daemon.status", { ok: true, ...withDaemonDrainSummary(options.host.status(), warning, options) });
    }
    if (request.method === "daemon.stop" && method === request.method) {
      const refusal = daemonStopRefusal(options.authContext, options.requestShutdown);
      if (refusal) return reply(method, refusal);
      const response = reply(method, { ok: true, command: "daemon-stop", pid: process.pid });
      options.requestShutdown?.();
      return response;
    }
    if (request.method === "daemon.repo.bootstrap" && method === request.method) {
      try {
        return reply(method, await options.host.bootstrap(params, options.authContext));
      } catch (error) {
        return reply(method, protocolFailure("init", error));
      }
    }
    switch (call.method) {
      case "daemon.repo.register":
        try {
          return reply(
            call.method,
            await options.host.admin({ kind: "register", ...call.params }, options.authContext),
          );
        } catch (error) {
          return reply(call.method, protocolFailure(call.method, error));
        }
      case "daemon.repo.update":
        try {
          return reply(call.method, await options.host.admin({ kind: "update", ...call.params }, options.authContext));
        } catch (error) {
          return reply(call.method, protocolFailure(call.method, error));
        }
      case "daemon.repo.unregister":
        try {
          return reply(
            call.method,
            await options.host.admin({ kind: "unregister", repoId: call.params.repoId }, options.authContext),
          );
        } catch (error) {
          return reply(call.method, protocolFailure(call.method, error));
        }
      case "daemon.connection.register":
        try {
          return reply(
            call.method,
            await options.host.admin({ kind: "connection-register", ...call.params }, options.authContext),
          );
        } catch (error) {
          return reply(call.method, protocolFailure(call.method, error));
        }
      case "daemon.connection.update":
        try {
          return reply(
            call.method,
            await options.host.admin({ kind: "connection-update", ...call.params }, options.authContext),
          );
        } catch (error) {
          return reply(call.method, protocolFailure(call.method, error));
        }
      case "daemon.connection.unregister":
        try {
          return reply(
            call.method,
            await options.host.admin(
              { kind: "connection-unregister", connectionId: call.params.connectionId },
              options.authContext,
            ),
          );
        } catch (error) {
          return reply(call.method, protocolFailure(call.method, error));
        }
      case "daemon.connection.probe":
        try {
          return reply(
            call.method,
            await options.host.admin({ kind: "connection-probe", endpoint: call.params.endpoint }, options.authContext),
          );
        } catch (error) {
          return reply(call.method, protocolFailure(call.method, error));
        }
    }
    if (isRuntimeInstanceCall(call)) {
      const { method, params } = call;
      try {
        return reply(method, await options.host.runtimeInstance(method, params.payload, options.authContext));
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (isRuntimeInstanceAuthCall(call)) {
      const { method, params } = call,
        repo = params.repo.repoId;
      try {
        return reply(method, await options.host.runtimeInstanceAuth(repo, method, params.payload, options.authContext));
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (method === "daemon.fleet.center.start" || method === "daemon.fleet.edge.sync") {
      try {
        return reply(
          method,
          await (method === "daemon.fleet.center.start" ? options.host.fleet.startCenter : options.host.fleet.edgeSync)(
            params.payload,
            options.authContext,
          ),
        );
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (method === "daemon.fleet.task.run") {
      // Loaded lazily: schema-closure imports this module in a zero-dependency checkout, and the fleet edge stack reaches the kernel barrel.
      try {
        if (options.authContext.transportKind !== "unix-socket" || options.authContext.assignmentBinding)
          throw Object.assign(new Error("This control is available only through the local session token."), {
            code: "local_transport_required",
          });
        const fleetPayload = params.payload,
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
            method,
            await options.host.fleet.edgeRuntime(
              { ...fleetPayload, method: fleetAction.method, action: fleetAction.payload },
              options.authContext,
            ),
          );
        }
        if (isJsonObject(fleetAction) && fleetAction.kind === "fleet-schedule") {
          if (!isJsonObject(fleetAction.payload))
            throw Object.assign(new Error("Fleet Schedule envelope must carry one closed action payload."), {
              code: "invalid_field",
            });
          return reply(
            method,
            await options.host.fleet.edgeRuntime(
              { ...fleetPayload, method: "repo.schedule.run", action: fleetAction.payload },
              options.authContext,
            ),
          );
        }
        const { runFleetEdgeTask } = await import("../fleet-edge-task.ts");
        return reply(
          method,
          await runFleetEdgeTask({
            payload: {
              ...params.payload,
              // The two non-task discriminants return above; the remainder is FleetTaskAction.
              action: fleetAction as DaemonFleetTaskAction,
            },
          }),
        );
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (method === "daemon.fleet.doc.sync" || method === "daemon.fleet.conflict.exit") {
      try {
        if (options.authContext.transportKind !== "unix-socket" || options.authContext.assignmentBinding)
          throw Object.assign(new Error("This control is available only through the local session token."), {
            code: "local_transport_required",
          }); // Lazy for the same schema-closure reason as the task channel.
        const { runFleetEdgeDocSync, runFleetEdgeConflictExit } = await import("../fleet-edge-doc-sync.ts");
        return reply(
          method,
          await (method === "daemon.fleet.doc.sync"
            ? runFleetEdgeDocSync({ payload: params.payload })
            : runFleetEdgeConflictExit({
                payload: params.payload,
              })),
        );
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (method === "daemon.gui.system.read") {
      try {
        return reply(method, parseDaemonGuiReadResult(method, options.host.system(options.authContext)));
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (method === "daemon.gui.control.receipt") {
      try {
        return reply(
          method,
          parseDaemonGuiReadResult(
            method,
            options.host.controlReceipt(params.payload.operationId, options.authContext),
          ),
        );
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (method === "daemon.gui.control.request") {
      try {
        return reply(
          method,
          parseDaemonGuiActionResult(method, await options.host.requestControl(params.payload, options.authContext)),
        );
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (isDaemonStreamCall(call)) {
      const { method, params } = call,
        repo = params.repo.repoId;
      try {
        const subscription: Subscription =
            method === "repo.agentRuntime.attach"
              ? await options.host.attach(
                  repo,
                  params.payload.runtimeSessionId,
                  params.payload.afterCursor,
                  options.authContext,
                )
              : await options.host.terminalAttach(
                  repo,
                  params.payload.sessionId,
                  params.payload.afterSeq,
                  options.authContext,
                ),
          initial = parseDaemonStreamResult(method, subscription.initial);
        if (initial.ok) {
          subscriptions.add(subscription);
          const eventMethod = daemonStreamFacets.find((facet) => facet.method === method)!.eventMethod;
          setImmediate(() => pump(subscription, eventMethod));
        }
        return reply(method, initial);
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (isRepoGuiReadCall(call)) {
      const { method, params } = call,
        repo = params.repo.repoId;
      try {
        return reply(
          method,
          parseDaemonGuiReadResult(
            method,
            await options.host.read(
              repo,
              method,
              (params.payload as JsonObject | undefined) ?? {},
              options.authContext,
            ),
          ),
        );
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (method === "repo.agentRuntime.spawn") {
      const repo = params.repo.repoId;
      try {
        return reply(
          method,
          parseDaemonGuiActionResult(
            method,
            await options.host.spawnRuntime(repo, params.payload, options.authContext),
          ),
        );
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (method === "repo.agentRuntime.cancel") {
      const repo = params.repo.repoId;
      try {
        return reply(
          method,
          parseDaemonGuiActionResult(
            method,
            await options.host.cancelRuntime(repo, params.payload, options.authContext),
          ),
        );
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (isTerminalActionCall(call)) {
      const { method, params } = call,
        repo = params.repo.repoId;
      try {
        return reply(
          method,
          parseDaemonGuiActionResult(
            method,
            await options.host.terminalAction(repo, method, params.payload, options.authContext),
          ),
        );
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    // All non-repository branches above return. The remaining discriminants are the
    // contracted repo command family, whose params always carry repo + payload.
    const commandCall = call as DaemonRepoPayloadCall,
      { method: commandMethod, params: commandParams } = commandCall,
      repo = commandParams.repo.repoId;
    let action: JsonObject & { readonly kind: string };
    try {
      action = actionForDaemonMethod(commandMethod, commandParams.payload);
    } catch (error) {
      return reply(commandMethod, protocolFailure(commandMethod, error));
    }
    observed = { ...observed, command: action.kind, executor: declaredExecutorOrNull(action) };
    if (action.kind === "preset-run-start" || action.kind === "preset-run-status")
      return reply(commandMethod, await options.host.presetRun(repo, action, options.authContext));
    const receipt = await options.host.run(repo, action, options.authContext),
      result = makeDaemonCommandReceipt(action.kind, receipt);
    return reply(
      commandMethod,
      isDaemonGuiActionMethod(commandMethod) ? parseDaemonGuiActionResult(commandMethod, result) : result,
    );
  };
  const one = async (request: JsonRpcRequest, frameReceivedAt = Date.now()): Promise<JsonRpcResponse | undefined> => {
    const method = typeof request.method === "string" ? request.method : "";
    options.onRequestStarted?.(method);
    try {
      return await run(request, frameReceivedAt);
    } finally {
      options.onRequestSettled?.(method);
    }
  };
  return {
    handle: async (message, timing) =>
      Array.isArray(message)
        ? (await Promise.all(message.map((request) => one(request, timing?.frameReceivedAt)))).filter(
            (item): item is JsonRpcResponse => item !== undefined,
          )
        : one(message, timing?.frameReceivedAt),
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
  function recordRequest(
    method: string,
    observed: ObservedRequest,
    result: object,
    dispatchDelayMs: number,
    serviceMs: number,
  ): void {
    if (!options.recordRequest || !observed.repoId) return;
    options.recordRequest({
      method,
      repoId: observed.repoId,
      command: observed.command,
      connectionId,
      auth: options.authContext,
      executor: observed.executor,
      ok: resultOk(result),
      outcome: "outcome" in result && typeof result.outcome === "string" ? result.outcome : null,
      code: resultErrorCode(result),
      opId: "opId" in result && typeof result.opId === "string" ? result.opId : null,
      dispatchDelayMs,
      serviceMs,
      durationMs: serviceMs,
    });
  }
  // Daemon-scoped counterpart: every request including hello and pre-dispatch rejections gets one
  // line, so connection-level forensics never depends on repo binding.
  function traffic(
    method: string | null,
    frameReceivedAt: number,
    handlerStartedAt: number,
    repliedAt: number,
    ok: boolean,
    code: string | null,
    detail: string | null,
  ): void {
    if (!options.recordTraffic) return;
    options.recordTraffic({
      conn: connectionId,
      transport: options.authContext.transportKind,
      method,
      frameReceivedAt,
      handlerStartedAt,
      repliedAt,
      startedAt: handlerStartedAt,
      dispatchDelayMs: Math.max(0, handlerStartedAt - frameReceivedAt),
      serviceMs: Math.max(0, repliedAt - handlerStartedAt),
      durationMs: Math.max(0, repliedAt - handlerStartedAt),
      ok,
      code,
      detail,
    });
  }
}

function protocolFailure(command: string, error: unknown) {
  return daemonProtocolError(
    command,
    rpcServerErrorCode(error),
    protocolErrorMessage(error),
    diagnosticForError(error),
  );
}

function isContractedDaemonRpcMethod(method: string): method is DaemonRpcMethod {
  return jsonRpcMethodContracts.some((entry) => entry.method === method);
}
