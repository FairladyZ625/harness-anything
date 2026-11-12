import { randomUUID } from "node:crypto";
import {
  currentDaemonOperationTrace,
  markDaemonOperationPhase,
  observeDaemonRequest,
  updateDaemonOperation,
  type DaemonOperationObserver,
  type DaemonOperationQueueHead,
} from "../daemon-operation.ts";
import { accessAdminOperations } from "./daemon-protocol.contract.ts";
import { executionCredentialRejected } from "../runtime-execution-credential.ts";
import type { DaemonHost } from "../daemon-host.ts";
import { agentActorForLog, type DaemonRequestLogEntry } from "../request-log.ts";
import type { DaemonTrafficLogEntry } from "../conn-log.ts";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import {
  actionForDaemonMethod,
  commandClassForAction,
  commandIdForDaemonMethod,
  daemonProtocolError,
  invalidParamsReceipt,
  isDaemonGuiOnlyActionMethod,
  jsonRpcMethodContracts,
  makeDaemonCommandReceipt,
  parseDaemonRpcParams,
  type DaemonBuildDrainStatus,
  type DaemonRpcMethod,
  type DaemonRpcResult,
} from "./daemon-protocol.contract.ts";
import { daemonStreamFacetByMethod } from "./daemon-protocol-gui-actions.ts";
import {
  previousDispatchLifecycleReadResult,
  declaredExecutorOrNull,
  daemonRequestLogEntry,
  isDaemonParkedWaitMethod,
  isDaemonStreamCall,
  isRepoGuiReadCall,
  isRuntimeInstanceAuthCall,
  isRuntimeInstanceCall,
  isProviderCall,
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
import { daemonHelloMismatch } from "../client/daemon-hello.ts";
import { consumeKnownError } from "@harness-anything/kernel";
import type { DaemonBuildObserver, DaemonBuildStamp } from "../build-identity.ts";
import { diagnosticForError } from "../receipt-guidance.ts";
import { remoteProxyEventMethod } from "../remote-proxy.ts";
import { daemonBuildStaleNotice, withDaemonDrainSummary } from "../daemon-build-drain.ts";
import { quoteAgentRuntimeBudget } from "../runtime/cloud-dispatch-relay.ts";
import { isSkillEvalCall, dispatchSkillEvalCall } from "./skill-eval-rpc.ts";
import { attachEncodedJsonRpcFrame, encodeJsonRpcFrame, encodedFrameBytes } from "./json-rpc-encoding.ts";
export interface JsonRpcProtocolServer {
  readonly handle: (
    message: JsonRpcRequest | JsonRpcRequest[],
    timing?: {
      readonly frameReceivedAt: number;
      readonly frameBytes?: number;
      /** Main-thread scheduling delay observed when the frame was first read. */
      readonly eventLoopStallMs?: number;
      /** Production transport write, so the reply stage covers encoding and the socket write. */
      readonly writeResponse?: (response: JsonRpcResponse) => number;
    },
  ) => Promise<JsonRpcResponse | JsonRpcResponse[] | undefined>;
  readonly close: () => void;
}
interface ObservedRequest {
  readonly repoId: string;
  readonly command: string;
  readonly executor: DaemonRequestLogEntry["executor"];
  readonly wait: boolean;
}
export function createJsonRpcProtocolServer(options: {
  readonly host: DaemonHost;
  readonly build: DaemonBuildStamp;
  readonly buildObserver?: DaemonBuildObserver;
  readonly authContext: DaemonAuthenticationContext;
  /** Authenticate and scope a dispatch credential on every request, independently of interactive login. */
  readonly executionPrincipal?: (
    credential: string,
    method: string,
    params: JsonObject,
  ) => Promise<NonNullable<DaemonAuthenticationContext["executionPrincipal"]>>;
  /** Read-only runtime queries on an edge replica use the persisted replica identity. */
  readonly sessionIndependentRead?: (method: string, params: JsonObject) => boolean;
  /** The daemon's signed-in OIDC principal as of now; read on every request, not once per connection. */
  readonly sessionPrincipal?: (
    method: string,
    params: JsonObject,
  ) => Promise<DaemonAuthenticationContext["oidcPrincipal"]>;
  readonly emit: (method: string, params: JsonObject) => Promise<void>;
  readonly connectionId?: string;
  readonly recordRequest?: (entry: DaemonRequestLogEntry) => void;
  readonly recordTraffic?: (entry: DaemonTrafficLogEntry) => void;
  readonly operationObserver?: DaemonOperationObserver;
  readonly requestShutdown?: () => void;
  readonly buildDrainStatus?: () => DaemonBuildDrainStatus;
  /** True after build drift closes normal RPC admission and until the old daemon exits. */
  readonly buildDraining?: () => boolean;
  readonly stopping?: () => boolean;
  readonly onRequestStarted?: (method: string) => void;
  readonly onRequestSettled?: (method: string) => void;
  readonly onBuildDriftObserved?: () => void;
}): JsonRpcProtocolServer {
  let handshaken = false,
    lifecycleReadsEnabled = false;
  // Hello, lifecycle negotiation and the first business frame are one admitted exchange.
  // Retain its reservation across negotiation so build drain cannot strand the business frame.
  let helloPending = false,
    helloReservationHeld = false,
    helloContinuationAdmitted = false;
  const drainActive = (): boolean => options.stopping?.() === true || options.buildDraining?.() === true;
  const releaseHello = (): void => {
    if (!helloPending) return;
    helloPending = false;
    const reservationHeld = helloReservationHeld;
    helloReservationHeld = false;
    helloContinuationAdmitted = false;
    if (reservationHeld) options.onRequestSettled?.("protocol.hello");
  };
  options.authContext.connectionSignal?.addEventListener("abort", releaseHello);
  let executionCredential: string | undefined;
  // The CLI dedicates one connection per invocation and names the command in hello; GUI and fleet
  // connections declare none, so their traffic stays keyed by action kind or transport method.
  let invokingCommand: string | null = null;
  // Every client — CLI, GUI, fleet — converges on this server, and every dispatched response is
  // built by the reply() below, so one hook there observes the whole request surface.
  const connectionId = options.connectionId ?? randomUUID();
  type Subscription = {
    readonly initial: unknown;
    readonly next: () => Promise<JsonObject | null>;
    readonly detach: () => void;
  };
  const subscriptions = new Set<Subscription>();
  // Abandonment hooks for parked waits: called when this server closes, so a parked reply never
  // holds the shutdown drain window open.
  const parkedWaitAborts = new Set<() => void>();
  const run = async (
    request: JsonRpcRequest,
    frameReceivedAt = Date.now(),
    admittedBeforeBuildDrain = false,
    requestBytes = 0,
    eventLoopStallMs = 0,
    timing?: { readonly writeResponse?: (response: JsonRpcResponse) => number },
  ): Promise<JsonRpcResponse | undefined> => {
    const id = request.id ?? null,
      startedAt = Date.now(),
      dispatchDelayMs = Math.max(0, startedAt - frameReceivedAt);
    let observed: ObservedRequest = {
      repoId: "",
      command: typeof request.method === "string" ? request.method : "",
      executor: null,
      wait: false,
    };
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      traffic(
        typeof request.method === "string" ? request.method : null,
        null,
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
      traffic(request.method, null, frameReceivedAt, startedAt, Date.now(), false, "-32601", "Method not found");
      return rpcError(id, -32601, "Method not found");
    }
    const reply = <Method extends DaemonRpcMethod>(
      method: Method,
      result: DaemonRpcResult<Method>,
    ): JsonRpcResponse | undefined => {
      markDaemonOperationPhase("serialization");
      if (!lifecycleReadsEnabled) result = previousDispatchLifecycleReadResult(method, result);
      const response = request.id === undefined ? undefined : { jsonrpc: "2.0" as const, id, result },
        replyBytes = response === undefined ? 0 : encodeAndAttach(response);
      // The reply stage starts after serialization and includes the transport's socket write; the
      // service/duration sample therefore never ends before the bytes were handed to the socket.
      markDaemonOperationPhase("reply");
      if (response !== undefined) timing?.writeResponse?.(response);
      const repliedAt = Date.now(),
        serviceMs = repliedAt - startedAt;
      // Reading retained request history must not append itself to that history. Transport
      // traffic still records this diagnostic, including failures, through the separate sink.
      const payload = isJsonObject(request.params) ? request.params.payload : undefined;
      if (
        !(
          method === "observe.tail" &&
          isJsonObject(payload) &&
          payload.kind === "repo-log" &&
          payload.direction === "history"
        )
      )
        recordRequest(method, observed, result, dispatchDelayMs, serviceMs);
      const ok = resultOk(result);
      updateDaemonOperation({ outcome: ok ? "ok" : "error", requestBytes, replyBytes });
      traffic(
        method,
        observed.repoId || null,
        frameReceivedAt,
        startedAt,
        repliedAt,
        ok,
        resultErrorCode(result),
        resultErrorDetail(result),
        invokingCommand ?? observedCommand(method, observed.command),
        observed.wait,
        observed.executor,
        requestBytes,
        replyBytes,
        eventLoopStallMs,
      );
      return response;
    };
    if (request.method === "protocol.hello") {
      handshaken = false;
      lifecycleReadsEnabled = false;
    }
    const parsed = parseDaemonRpcParams(request.method, request.params);
    if (!parsed.ok) return reply(request.method, invalidParamsReceipt(request.method, parsed.errors));
    const call = parsed.call,
      { method, params } = call;
    // Build drift is a daemon lifecycle signal, not an opt-in client diagnostic. Long-lived
    // GUI/read connections perform their hello once and then issue ordinary requests, so waiting
    // for reportStaleBuild on hello can leave a superseded daemon serving indefinitely.
    // The runtime callback is idempotent; observing it per request keeps long-lived connections
    // covered without adding a timer or another lifecycle state machine here.
    if (options.buildObserver?.status().drifted) options.onBuildDriftObserved?.();
    // The parked-wait predicate is the same one that parks the reply in one(): direct methods
    // resolve to no action here, so this is the only place their wait classification is set.
    observed = {
      ...observed,
      repoId:
        method === "daemon.rbac.manage" && typeof params.repoId === "string" ? params.repoId : repoIdFromParams(params),
      wait: isDaemonParkedWaitMethod(method),
    };
    if (request.method === "protocol.hello" && method === request.method) {
      const mismatch = daemonHelloMismatch(params.protocolVersion);
      if (mismatch) return reply(method, daemonProtocolError(method, mismatch.code, mismatch.message));
      if (params.sessionEnvironment === undefined) Reflect.deleteProperty(options.authContext, "sessionEnvironment");
      else
        Object.assign(options.authContext, {
          sessionEnvironment: params.sessionEnvironment,
        });
      invokingCommand = params.invokingCommand ?? null;
      executionCredential = params.executionCredential;
      Reflect.deleteProperty(options.authContext, "executionPrincipal");
      Reflect.deleteProperty(options.authContext, "executionCredential");
      const warning = daemonBuildStaleNotice(options.buildObserver, options.buildDrainStatus);
      handshaken = true;
      return reply(method, {
        ok: true,
        protocolVersion: params.protocolVersion,
        methods: jsonRpcMethodContracts.map((entry) => entry.method),
        build: { ...options.build },
        ...(warning ? { warning } : {}),
      });
    }
    if (!handshaken) return reply(method, daemonProtocolError(method, "hello_required", "Call protocol.hello first."));
    // Advertised by hello, so a new client never sends this method to the previous daemon.
    // Previous clients do not opt in and receive their original closed DTO shape.
    if (method === "protocol.dispatchLifecycle.enable") {
      lifecycleReadsEnabled = true;
      return reply(method, { ok: true });
    }
    const stoppingRefusal = daemonStoppingRefusal(
      method,
      options.stopping?.() === true || (options.buildDraining?.() === true && !admittedBeforeBuildDrain),
    );
    if (stoppingRefusal) return reply(method, stoppingRefusal);
    // These daemon controls use the transport boundary, so center startup cannot block them.
    const daemonControl =
      method === "daemon.status" || method === "daemon.stop" || method === "daemon.nodeAutoClaim.configure";
    if (daemonControl && executionCredential !== undefined)
      return reply(method, protocolFailure(method, executionCredentialRejected()));
    markDaemonOperationPhase("authorization");
    if (!daemonControl && executionCredential !== undefined) {
      try {
        if (!options.executionPrincipal)
          throw Object.assign(new Error("Execution authentication is unavailable."), {
            code: "authentication_required",
          });
        const principal = await options.executionPrincipal(executionCredential, method, params as JsonObject);
        Object.assign(options.authContext, {
          executionPrincipal: principal,
          executionCredential,
          oidcPrincipal: undefined,
        });
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    } else if (
      !daemonControl &&
      !sessionIndependentRbacOperation(method, params as JsonObject) &&
      !options.sessionIndependentRead?.(method, params as JsonObject) &&
      options.sessionPrincipal
    ) {
      // A connection outlives access tokens: each request carries the session as it is now, renewed or ended.
      try {
        Object.assign(options.authContext, {
          oidcPrincipal: await options.sessionPrincipal(method, params as JsonObject),
        });
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    markDaemonOperationPhase("repository-admission");
    updateDaemonOperation({
      actor: trafficActorForLog(observed.executor, options.authContext),
      nodeId: options.authContext.nodePrincipal?.nodeId ?? null,
    });
    const remoteProxy = options.host.remoteProxy;
    if (method === "daemon.repo.bootstrap" && typeof params.repoId === "string" && remoteProxy?.route(params.repoId))
      return reply(
        method,
        daemonProtocolError(
          method,
          "repo_mode_remote_proxy",
          "This repository has no local workspace; bootstrap is unavailable in remote-proxy mode.",
        ),
      );
    const remoteRepoId =
      method === "daemon.rbac.manage" && typeof params.repoId === "string" ? params.repoId : repoIdFromParams(params);
    if (remoteRepoId && remoteProxy?.route(remoteRepoId)) {
      try {
        if (method === "daemon.rbac.manage") {
          const permitted = [
            "login",
            "login-poll",
            "login-begin",
            "login-complete",
            "session",
            "logout",
            "health",
            "bootstrap-status",
            "invite",
            ...accessAdminOperations,
          ];
          if (params.mode === "external" || !permitted.includes(String(params.operation)))
            throw Object.assign(new Error("This RBAC operation requires the center's original local socket."), {
              code: "local_transport_required",
            });
          const { repoId: _target, rootDir: _root, ...remoteParams } = params;
          const result = await remoteProxy.request(remoteRepoId, method, remoteParams);
          return reply(
            method,
            (params.operation === "bootstrap-status" && result.ok !== false
              ? { ...result, required: false }
              : result) as DaemonRpcResult<typeof method>,
          );
        }
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
    if (method === "repo.agentRuntime.quote") {
      try {
        // Pricing is a daemon-local authority. Fleet TLS callers must use their local daemon
        // rather than asking an edge to invent a second price-table cut.
        if (options.authContext.transportKind !== "unix-socket" || options.authContext.nodePrincipal)
          throw Object.assign(new Error("Runtime quotes are available only through the local daemon socket."), {
            code: "local_transport_required",
          });
        return reply(method, quoteAgentRuntimeBudget(params as Parameters<typeof quoteAgentRuntimeBudget>[0]));
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (request.method === "daemon.status") {
      const warning = daemonBuildStaleNotice(options.buildObserver, options.buildDrainStatus);
      return reply("daemon.status", { ok: true, ...withDaemonDrainSummary(options.host.status(), warning, options) });
    }
    if (request.method === "daemon.nodeAutoClaim.configure" && method === request.method) {
      try {
        return reply(method, await options.host.configureNodeAutoClaim(params.policy, options.authContext));
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
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
    if (request.method === "daemon.rbac.manage" && method === request.method) {
      try {
        return reply(method, await options.host.manageRbac(params, options.authContext));
      } catch (error) {
        return reply(method, protocolFailure("bootstrap", error));
      }
    }
    if (isSkillEvalCall(call)) {
      try {
        return reply(call.method, await dispatchSkillEvalCall(call, options.host.skillEval, options.authContext));
      } catch (error) {
        return reply(call.method, protocolFailure(call.method, error));
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
      case "daemon.repo.unbind":
        try {
          return reply(
            call.method,
            await options.host.admin({ kind: "unbind", repoId: call.params.repoId }, options.authContext),
          );
        } catch (error) {
          return reply(call.method, protocolFailure(call.method, error));
        }
      case "daemon.repo.backup":
        try {
          return reply(call.method, await options.host.admin({ kind: "backup", ...call.params }, options.authContext));
        } catch (error) {
          return reply(call.method, protocolFailure(call.method, error));
        }
      case "daemon.repo.restoreDrill":
        try {
          return reply(
            call.method,
            await options.host.admin({ kind: "restore-drill", ...call.params }, options.authContext),
          );
        } catch (error) {
          return reply(call.method, protocolFailure(call.method, error));
        }
      case "daemon.repo.purge":
        try {
          return reply(
            call.method,
            await options.host.admin(
              {
                kind: "purge",
                repoId: call.params.repoId,
                scope: call.params.scope,
                ...(call.params.backup ? { backup: call.params.backup } : {}),
                ...(call.params.confirm ? { confirm: call.params.confirm } : {}),
              },
              options.authContext,
            ),
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
        if (params.repo !== undefined) {
          const repoId = repoIdFromParams(params);
          if (
            !repoId ||
            !options.host
              .status()
              .repos.some((repo) => repo.repoId === repoId && repo.state !== "closed" && repo.mode !== "remote-proxy")
          )
            throw Object.assign(new Error("The selected runtime target is not registered on this daemon."), {
              code: "repo_namespace_unknown",
            });
        }
        return reply(method, await options.host.runtimeInstance(method, params.payload, options.authContext));
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (isProviderCall(call)) {
      try {
        return reply(
          call.method,
          await options.host.decisionProvider(call.method, call.params.payload, options.authContext),
        );
      } catch (error) {
        return reply(call.method, protocolFailure(call.method, error));
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
    if (
      method === "daemon.fleet.center.start" ||
      method === "daemon.fleet.center.read" ||
      method === "daemon.fleet.center.external-address.read" ||
      method === "daemon.fleet.center.external-address.set" ||
      method === "daemon.fleet.edge.sync"
    ) {
      try {
        const result =
          method === "daemon.fleet.center.start"
            ? await options.host.fleet.startCenter(params.payload, options.authContext)
            : method === "daemon.fleet.center.read"
              ? await options.host.fleet.readCenterState(options.authContext)
              : method === "daemon.fleet.center.external-address.read"
                ? await options.host.fleet.readCenterExternalAddress(options.authContext)
                : method === "daemon.fleet.center.external-address.set"
                  ? await options.host.fleet.setCenterExternalAddress(params.payload, options.authContext)
                  : await options.host.fleet.edgeSync(params.payload, options.authContext);
        return reply(method, result);
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (method === "daemon.gui.system.read") {
      try {
        markDaemonOperationPhase("projection-read");
        return reply(method, parseDaemonGuiReadResult(method, options.host.system(options.authContext)));
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (method === "daemon.gui.home.read") {
      try {
        markDaemonOperationPhase("projection-read");
        return reply(method, parseDaemonGuiReadResult(method, await options.host.home(options.authContext)));
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
          const eventMethod = daemonStreamFacetByMethod.get(method)!.eventMethod;
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
        markDaemonOperationPhase("projection-read");
        // host.read is the single exit validator for repo GUI reads; re-validating its return
        // here would walk every result a second time in the same process.
        return reply(
          method,
          await options.host.read(repo, method, (params.payload as JsonObject | undefined) ?? {}, options.authContext),
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
    if (method === "repo.agentRuntime.steer") {
      const repo = params.repo.repoId;
      try {
        return reply(
          method,
          parseDaemonGuiActionResult(
            method,
            await options.host.steerRuntime(repo, params.payload, options.authContext),
          ),
        );
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (method === "repo.agentRuntime.handoff") {
      const repo = params.repo.repoId;
      try {
        return reply(
          method,
          parseDaemonGuiActionResult(
            method,
            await options.host.handoffRuntime(repo, params.payload, options.authContext),
          ),
        );
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (method === "repo.agentRuntime.batch") {
      const repo = params.repo.repoId;
      try {
        return reply(method, await options.host.batchRuntime(repo, params.payload, options.authContext));
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (method === "repo.agentRuntime.sessions.await") {
      const repo = params.repo.repoId;
      try {
        const settled = await options.host.awaitRuntimeSessions(repo, params.payload, options.authContext);
        return reply(method, settled);
      } catch (error) {
        // A parked wait that wakes while this daemon drains re-reads through a RepoCell that close()
        // already shut — the drain closes cells before the transport. That repo_unavailable is the
        // handoff, not a verdict about the awaited sessions, and answering it ended real waits with
        // an error receipt before the transport closed. Silence keeps the abandonment contract: the
        // connection teardown is the signal, and the client's reconnect budget re-issues this
        // idempotent read on the daemon that survives.
        if (options.stopping?.() === true && rpcServerErrorCode(error) === "repo_unavailable") {
          consumeKnownError(error);
          return undefined;
        }
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
      // The CLI's artifact destination coordinate is transport metadata, not a Task Action field.
      // Attach it only after the closed RPC/action validators have accepted the request so the
      // daemon's internal doc writer can render the caller-facing workspace spelling.
      if (
        commandParams.payload.pathCoordinate === "workspace" ||
        commandParams.payload.pathCoordinate === "task-artifact"
      )
        action = { ...action, pathCoordinate: commandParams.payload.pathCoordinate };
      // The CLI-read plan file's path is a diagnostic label, not a declared action field. Attach it
      // after validation exactly like pathCoordinate; the task-create action strips it before the
      // create plan is compiled.
      if (action.kind === "task-create" && typeof commandParams.planSource === "string")
        action = { ...action, planSource: commandParams.planSource };
    } catch (error) {
      return reply(commandMethod, protocolFailure(commandMethod, error));
    }
    observed = {
      ...observed,
      command: action.kind,
      executor: declaredExecutorOrNull(action),
      // Only the client-declared --wait reaches here: the parked sessions.await method answers in
      // its own direct branch above and never resolves to this command family.
      wait: action.wait === true,
    };
    if (action.kind === "preset-run-start" || action.kind === "preset-run-status") {
      markDaemonOperationPhase(action.kind === "preset-run-status" ? "projection-read" : "write-queue");
      return reply(commandMethod, await options.host.presetRun(repo, action, options.authContext));
    }
    markDaemonOperationPhase(commandClassForAction(action.kind) === "repo-read" ? "projection-read" : "write-queue");
    const receipt = await options.host.run(repo, action, options.authContext);
    try {
      // Receipt assembly is result validation too: a squad-control result naming another
      // command must answer on this request id, not tear the connection down past the handler.
      const result = makeDaemonCommandReceipt(action.kind, receipt);
      return reply(
        commandMethod,
        isDaemonGuiOnlyActionMethod(commandMethod) ? parseDaemonGuiActionResult(commandMethod, result) : result,
      );
    } catch (error) {
      return reply(
        commandMethod,
        daemonProtocolError(
          commandMethod,
          rpcServerErrorCode(error),
          `The write result failed contract validation: ${protocolErrorMessage(error)}. ` +
            "The write may already have taken effect; refresh to confirm.",
          diagnosticForError(error),
          error,
        ),
      );
    }
  };
  const one = async (
    request: JsonRpcRequest,
    frameReceivedAt = Date.now(),
    frameBytes = 0,
    eventLoopStallMs = 0,
    writeResponse?: (response: JsonRpcResponse) => number,
  ): Promise<JsonRpcResponse | undefined> => {
    const method = typeof request.method === "string" ? request.method : "";
    // Parked waits are observations, not work: counting one would pin a superseded daemon resident
    // for as long as any --wait client cares to watch, which is exactly what the drain exists to end.
    if (method === "protocol.hello") {
      if (!helloPending) {
        const admitted = !drainActive();
        helloPending = true;
        helloReservationHeld = admitted;
        helloContinuationAdmitted = admitted;
        if (admitted) options.onRequestStarted?.(method);
      }
      try {
        return await run(
          request,
          frameReceivedAt,
          false,
          frameBytes,
          eventLoopStallMs,
          writeResponse === undefined ? undefined : { writeResponse },
        );
      } finally {
        if (!handshaken || options.authContext.connectionSignal?.aborted) releaseHello();
      }
    }
    if (isDaemonParkedWaitMethod(method)) {
      const admitted = !drainActive() || (helloPending && helloContinuationAdmitted);
      releaseHello();
      let abandoned = false;
      // A reply has no receiver once the parked wait is abandoned. Gate the transport write on
      // that fact so a late host read cannot write into a closed or superseded exchange.
      const guardedWrite =
        writeResponse === undefined
          ? undefined
          : (response: JsonRpcResponse) => (abandoned ? 0 : writeResponse(response));
      // Register abandonment around authentication as well as the host read: neither phase owns work.
      const response = await raceParkedWait(
        run(
          request,
          frameReceivedAt,
          admitted,
          frameBytes,
          eventLoopStallMs,
          guardedWrite === undefined ? undefined : { writeResponse: guardedWrite },
        ),
        parkedWaitAborts,
        options.authContext.connectionSignal,
        options.host.parkedWaitSignal,
        () => {
          abandoned = true;
        },
      );
      return response === parkedWaitAbandoned ? undefined : response;
    }
    // Transfer the reservation without a zero-work interval before dispatching the next frame.
    const negotiatingHello = method === "protocol.dispatchLifecycle.enable" && helloPending,
      admittedHelloContinuation = helloPending && helloContinuationAdmitted,
      admitted = !drainActive() || admittedHelloContinuation;
    if (admitted && !negotiatingHello) options.onRequestStarted?.(method);
    if (!negotiatingHello) releaseHello();
    try {
      return await run(
        request,
        frameReceivedAt,
        admitted,
        frameBytes,
        eventLoopStallMs,
        writeResponse === undefined ? undefined : { writeResponse },
      );
    } finally {
      if (admitted && !negotiatingHello) options.onRequestSettled?.(method);
    }
  };
  return {
    handle: async (message, timing) => {
      const single = !Array.isArray(message),
        writeResponse = single ? timing?.writeResponse : undefined,
        observedOne = (request: JsonRpcRequest) =>
          observeDaemonRequest(
            request,
            options.authContext,
            () => one(request, timing?.frameReceivedAt, timing?.frameBytes, timing?.eventLoopStallMs, writeResponse),
            options.operationObserver,
          );
      if (single) return observedOne(message);
      const responses = (await Promise.all(message.map(observedOne))).filter(
        (item): item is JsonRpcResponse => item !== undefined,
      );
      // Batch replies are one transport frame; pre-encoded items keep this the only serialization.
      if (responses.length > 0) attachEncodedJsonRpcFrame(responses, encodeJsonRpcFrame(responses));
      return responses;
    },
    close: () => {
      options.authContext.connectionSignal?.removeEventListener("abort", releaseHello);
      releaseHello();
      for (const subscription of subscriptions) subscription.detach();
      subscriptions.clear();
      // Parked waits hold no work, so teardown owes them no drain window: settle them now, in
      // silence, instead of parking each one through the shutdown drain deadline.
      const abandoned = [...parkedWaitAborts];
      parkedWaitAborts.clear();
      for (const abort of abandoned) abort();
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
    options.recordRequest(
      daemonRequestLogEntry({
        method,
        repoId: observed.repoId,
        command: invokingCommand ?? observedCommand(method, observed.command),
        connectionId,
        auth: options.authContext,
        executor: observed.executor,
        wait: observed.wait,
        result,
        dispatchDelayMs,
        serviceMs,
        ...writeQueueWait(serviceMs),
      }),
    );
  }
  // Attribute commands to the CLI declaration, resolved action, or sole owning CLI command.
  function observedCommand(method: string | null, actionCommand: string): string {
    if (method === null || actionCommand !== method) return actionCommand;
    return commandIdForDaemonMethod(method) ?? method;
  }
  // Traffic includes hello and pre-dispatch rejections, independently of repository binding.
  function traffic(
    method: string | null,
    repoId: string | null,
    frameReceivedAt: number,
    handlerStartedAt: number,
    repliedAt: number,
    ok: boolean,
    code: string | null,
    detail: string | null,
    command = method,
    wait = false,
    executor: DaemonRequestLogEntry["executor"] = null,
    requestBytes = 0,
    replyBytes = 0,
    eventLoopStallMs = 0,
  ): void {
    if (!options.recordTraffic) return;
    const trace = currentDaemonOperationTrace();
    options.recordTraffic({
      conn: connectionId,
      transport: options.authContext.transportKind,
      method,
      repoId,
      frameReceivedAt,
      handlerStartedAt,
      repliedAt,
      startedAt: handlerStartedAt,
      dispatchDelayMs: Math.max(0, handlerStartedAt - frameReceivedAt),
      ...(eventLoopStallMs > 0 ? { eventLoopStallMs } : {}),
      requestBytes,
      replyBytes,
      nodeId: trace?.nodeId ?? options.authContext.nodePrincipal?.nodeId ?? null,
      ...(trace === null
        ? {}
        : {
            traceId: trace.traceId,
            spanId: trace.spanId,
            phases: trace.phases,
          }),
      serviceMs: Math.max(0, repliedAt - handlerStartedAt),
      durationMs: Math.max(0, repliedAt - handlerStartedAt),
      ok,
      code,
      detail,
      command,
      wait,
      actor: trafficActorForLog(executor, options.authContext),
    });
  }
}

// The same write-queue phase the connection log records, so request statistics can split a slow
// write into queueing behind another write and its own execution. The writer receipt also reports
// which write was at the head while this one waited; both come from the same operation trace.
// Phases run on the monotonic clock and serviceMs on wall-clock milliseconds; clamp so the wait
// never reads longer than the service time it is part of.
function writeQueueWait(serviceMs: number): {
  readonly queueMs?: number;
  readonly queueHead?: DaemonOperationQueueHead;
} {
  const trace = currentDaemonOperationTrace();
  if (trace === null) return {};
  const phase = trace.phases.find(({ name }) => name === "write-queue");
  return {
    ...(phase === undefined
      ? {}
      : { queueMs: Math.min(serviceMs, Math.max(0, Math.round(phase.endedAtMs - phase.startedAtMs))) }),
    ...(trace.queueHead === undefined ? {} : { queueHead: trace.queueHead }),
  };
}

function encodeAndAttach(response: JsonRpcResponse): number {
  const encoded = encodeJsonRpcFrame(response);
  attachEncodedJsonRpcFrame(response, encoded);
  return encodedFrameBytes(encoded);
}

function trafficActorForLog(
  executor: DaemonRequestLogEntry["executor"],
  auth: DaemonAuthenticationContext,
): string | null {
  return (
    agentActorForLog(executor, auth.sessionEnvironment) ??
    auth.executionPrincipal?.personId ??
    auth.oidcPrincipal?.personId ??
    auth.nodePrincipal?.personId ??
    auth.replicaReadPrincipal?.personId ??
    (auth.unixSocketOwnerBoundary ? `local-user-${auth.unixSocketOwnerBoundary.ownerUid}` : null)
  );
}

function sessionIndependentRbacOperation(method: string, params: JsonObject): boolean {
  if (method !== "daemon.rbac.manage") return false;
  if (params.mode === "external") return true;
  return [
    "bootstrap",
    "bootstrap-admin",
    "bootstrap-status",
    "device-approval",
    "edge-join",
    "edge-join-progress",
    "health",
    "login",
    "login-begin",
    "login-complete",
    "login-poll",
    "logout",
    "session",
  ].includes(String(params.operation));
}

function protocolFailure(command: string, error: unknown) {
  const code = rpcServerErrorCode(error),
    message = protocolErrorMessage(error);
  return daemonProtocolError(command, code, message, diagnosticForError(error), error);
}

/** Sentinel resolution for a parked wait the server gave up on: the connection that asked for it
 *  closed (the reply has nowhere to land) or this server is tearing down (the daemon is going away
 *  by design). Either way the wait holds no daemon-side work that a drain must protect, and the
 *  abandonment answers with silence — the transport close is the signal, and the client re-issues
 *  this idempotent read after reconnecting. */
const parkedWaitAbandoned: unique symbol = Symbol("parked-wait-abandoned");

function raceParkedWait<T>(
  parked: Promise<T>,
  abandonments: Set<() => void>,
  connectionSignal: AbortSignal | undefined,
  hostSignal: AbortSignal | undefined,
  onAbandon?: () => void,
): Promise<T | typeof parkedWaitAbandoned> {
  // The abandoned park can still reject later — its settle loop wakes against a closing host — and
  // nobody observes that outcome anymore; the abandonment already settled the request.
  parked.catch(consumeKnownError);
  return new Promise<T | typeof parkedWaitAbandoned>((resolve, reject) => {
    const release = () => {
      abandonments.delete(abandon);
      connectionSignal?.removeEventListener("abort", onConnectionAbort);
      hostSignal?.removeEventListener("abort", onConnectionAbort);
    };
    const onConnectionAbort = () => abandon();
    const abandon = () => {
      release();
      onAbandon?.();
      resolve(parkedWaitAbandoned);
    };
    abandonments.add(abandon);
    connectionSignal?.addEventListener("abort", onConnectionAbort, { once: true });
    hostSignal?.addEventListener("abort", onConnectionAbort, { once: true });
    if (connectionSignal?.aborted || hostSignal?.aborted) abandon();
    parked.then(
      (value) => {
        release();
        resolve(value);
      },
      (error) => {
        release();
        reject(error);
      },
    );
  });
}

function isContractedDaemonRpcMethod(method: string): method is DaemonRpcMethod {
  return jsonRpcMethodContracts.some((entry) => entry.method === method);
}
