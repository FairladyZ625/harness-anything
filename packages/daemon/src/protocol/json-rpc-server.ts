import { randomUUID } from "node:crypto";
import { accessAdminOperations } from "./daemon-protocol.contract.ts";
import { executionCredentialRejected } from "../runtime-execution-credential.ts";
import { localDefaultBinding } from "../daemon-host-binding.ts";
import type { DaemonHost } from "../daemon-host.ts";
import { agentActorForLog, type DaemonRequestLogEntry } from "../request-log.ts";
import type { DaemonTrafficLogEntry } from "../conn-log.ts";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import {
  actionForDaemonMethod,
  commandIdForDaemonMethod,
  daemonProtocolError,
  invalidParamsReceipt,
  isDaemonGuiOnlyActionMethod,
  jsonRpcMethodContracts,
  makeDaemonCommandReceipt,
  parseDaemonRpcParams,
  type DaemonFleetTaskAction,
  type DaemonBuildDrainStatus,
  type DaemonRpcMethod,
  type DaemonRpcResult,
} from "./daemon-protocol.contract.ts";
import { daemonStreamFacetByMethod } from "./daemon-protocol-gui-actions.ts";
import {
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
import { currentDaemonProtocolVersion } from "./version.ts";
import { isContractVersionCompatible } from "@harness-anything/kernel/contract-version";
import { consumeKnownError, type CoreDomainError } from "@harness-anything/kernel";
import type { DaemonBuildObserver, DaemonBuildStamp } from "../build-identity.ts";
import { diagnosticForError } from "../receipt-guidance.ts";
import { remoteProxyEventMethod } from "../remote-proxy.ts";
import { daemonBuildStaleNotice, withDaemonDrainSummary } from "../daemon-build-drain.ts";
import type { SkillEvalCaseDraft } from "../skill-eval-runner.ts";
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
  readonly edgeExecutionPrincipal?: (
    credential: string,
  ) => Promise<NonNullable<DaemonAuthenticationContext["executionPrincipal"]>>;
  /** The daemon's signed-in OIDC principal as of now; read on every request, not once per connection. */
  readonly sessionPrincipal?: (
    method: string,
    params: JsonObject,
  ) => Promise<DaemonAuthenticationContext["oidcPrincipal"]>;
  readonly emit: (method: string, params: JsonObject) => Promise<void>;
  readonly connectionId?: string;
  readonly recordRequest?: (entry: DaemonRequestLogEntry) => void;
  readonly recordTraffic?: (entry: DaemonTrafficLogEntry) => void;
  readonly requestShutdown?: () => void;
  readonly buildDrainStatus?: () => DaemonBuildDrainStatus;
  /** True after build drift closes normal RPC admission and until the old daemon exits. */
  readonly buildDraining?: () => boolean;
  readonly stopping?: () => boolean;
  readonly onRequestStarted?: (method: string) => void;
  readonly onRequestSettled?: (method: string) => void;
  readonly onBuildDriftObserved?: () => void;
}): JsonRpcProtocolServer {
  let handshaken = false;
  // Hello and its next frame are one admitted exchange. A host status callback can request
  // supersession in the wire gap between them, so retain the work until the frame or disconnect.
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
      traffic(
        method,
        observed.repoId || null,
        frameReceivedAt,
        startedAt,
        repliedAt,
        resultOk(result),
        resultErrorCode(result),
        resultErrorDetail(result),
        invokingCommand ?? observedCommand(method, observed.command),
        observed.wait,
        observed.executor,
      );
      return request.id === undefined ? undefined : { jsonrpc: "2.0", id, result };
    };
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
      invokingCommand = params.invokingCommand ?? null;
      executionCredential = params.executionCredential;
      Reflect.deleteProperty(options.authContext, "executionPrincipal");
      const warning = daemonBuildStaleNotice(options.buildObserver, options.buildDrainStatus);
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
    const stoppingRefusal = daemonStoppingRefusal(
      method,
      options.stopping?.() === true || (options.buildDraining?.() === true && !admittedBeforeBuildDrain),
    );
    if (stoppingRefusal) return reply(method, stoppingRefusal);
    // These daemon controls use the transport boundary, so center startup cannot block them.
    const daemonControl = method === "daemon.status" || method === "daemon.stop";
    if (daemonControl && executionCredential !== undefined)
      return reply(method, protocolFailure(method, executionCredentialRejected()));
    const relayExecution =
      executionCredential !== undefined &&
      method === "daemon.fleet.task.run" &&
      isJsonObject(params.payload) &&
      isJsonObject(params.payload.action) &&
      params.payload.action.kind !== "fleet-runtime" &&
      params.payload.action.kind !== "fleet-schedule";
    if (!daemonControl && executionCredential !== undefined && !relayExecution) {
      try {
        if (!options.executionPrincipal)
          throw Object.assign(new Error("Execution authentication is unavailable."), {
            code: "authentication_required",
          });
        const principal = await options.executionPrincipal(executionCredential, method, params as JsonObject);
        Object.assign(options.authContext, { executionPrincipal: principal, oidcPrincipal: undefined });
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    } else if (
      !daemonControl &&
      !sessionIndependentRbacOperation(method, params as JsonObject) &&
      !sessionIndependentFleetRuntimeRead(method, params as JsonObject) &&
      !relayExecution &&
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
    if (request.method === "daemon.rbac.manage" && method === request.method) {
      try {
        return reply(method, await options.host.manageRbac(params, options.authContext));
      } catch (error) {
        return reply(method, protocolFailure("bootstrap", error));
      }
    }
    if (method === "daemon.skillEval.case.add") {
      try {
        const draft: SkillEvalCaseDraft = {
          id: params.id,
          input: params.input,
          ...(params.hidden === undefined ? {} : { hidden: params.hidden }),
          ...(params.expect === undefined ? {} : { expect: params.expect as SkillEvalCaseDraft["expect"] }),
        };
        return reply(method, {
          ok: true,
          case: await options.host.skillEval.addCase(options.authContext, params.skillId, draft),
        });
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (method === "daemon.skillEval.cases.list") {
      try {
        return reply(method, {
          ok: true,
          cases: await options.host.skillEval.listCases(options.authContext, params.skillId),
        });
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (method === "daemon.skillEval.run") {
      try {
        return reply(method, {
          ok: true,
          evaluation: await options.host.skillEval.run(options.authContext, params.skillId, params.version, {
            ...(params.threshold === undefined ? {} : { threshold: params.threshold }),
          }),
        });
      } catch (error) {
        return reply(method, protocolFailure(method, error));
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
    if (method === "daemon.fleet.task.run") {
      // Loaded lazily: schema-closure imports this module in a zero-dependency checkout, and the fleet edge stack reaches the kernel barrel.
      try {
        if (options.authContext.transportKind !== "unix-socket" || options.authContext.nodePrincipal)
          throw Object.assign(new Error("This control is available only through the local session token."), {
            code: "local_transport_required",
          });
        const fleetPayload = params.payload,
          fleetAction = fleetPayload.action;
        if (isJsonObject(fleetAction) && fleetAction.kind === "fleet-runtime") {
          if (
            ![
              "repo.squad.control",
              "repo.agentRuntime.spawn",
              "repo.agentRuntime.cancel",
              "repo.agentRuntime.steer",
              "repo.agentRuntime.handoff",
              "repo.agentRuntime.overview",
              "repo.agentRuntime.sessions.read",
              "repo.agentRuntime.sessions.await",
            ].includes(String(fleetAction.method)) ||
            !isJsonObject(fleetAction.payload)
          )
            throw Object.assign(new Error("Fleet runtime envelope must carry one closed runtime method and payload."), {
              code: "invalid_field",
            });
          const result = await options.host.fleet.edgeRuntime(
            { ...fleetPayload, method: fleetAction.method, action: fleetAction.payload },
            options.authContext,
          );
          return reply(method, result);
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
        const { runFleetEdgeTask, runFleetEdgeRepositoryRead, isFleetEdgeRepositoryRead } = await import(
          "../fleet-edge-task.ts"
        );
        if (executionCredential !== undefined)
          localDefaultBinding({
            ...options.authContext,
            oidcPrincipal: await options.sessionPrincipal?.(method, params as JsonObject),
          });
        const relayedExecutionPrincipal =
          executionCredential === undefined
            ? undefined
            : options.edgeExecutionPrincipal
              ? await options.edgeExecutionPrincipal(executionCredential)
              : (() => {
                  throw Object.assign(new Error("Edge execution identity is unavailable."), {
                    code: "authorization_denied",
                  });
                })();
        // Frozen submission blobs are center-owned; an edge replica may only hold the latest document.
        if (
          isFleetEdgeRepositoryRead(fleetAction as DaemonFleetTaskAction) &&
          !(executionCredential && fleetAction.kind === "doc-show")
        ) {
          // The edge cell answers from its replica under the same principal the local daemon binds.
          const readAuth = relayedExecutionPrincipal
            ? { ...options.authContext, executionPrincipal: relayedExecutionPrincipal }
            : options.authContext;
          return reply(
            method,
            await runFleetEdgeRepositoryRead(
              { payload: { ...params.payload, action: fleetAction as DaemonFleetTaskAction } as never },
              async () =>
                (await options.host.run(String(fleetPayload.repoId), fleetAction as never, readAuth)) as never,
              async () => (await options.sessionPrincipal?.(method, params as JsonObject))?.accessToken,
            ),
          );
        }
        const result = await runFleetEdgeTask(
          {
            payload: {
              ...params.payload,
              ...(executionCredential ? { executionCredential } : {}),
              ...(options.authContext.executionPrincipal
                ? { principalId: options.authContext.executionPrincipal.personId }
                : relayedExecutionPrincipal
                  ? { principalId: relayedExecutionPrincipal.personId }
                  : !executionCredential && options.authContext.oidcPrincipal
                    ? { principalId: options.authContext.oidcPrincipal.personId }
                    : {}),
              // The two non-task discriminants return above; the remainder is FleetTaskAction.
              action: fleetAction as DaemonFleetTaskAction,
            },
          },
          async () => (await options.sessionPrincipal?.(method, params as JsonObject))?.accessToken,
        );
        // The center accepts the escalation artifact, but the edge owns the worker process. Close
        // that owner through the existing edge runtime route before reporting command success.
        if (
          fleetAction.kind === "task-escalate" &&
          relayedExecutionPrincipal !== undefined &&
          result.outcome === "applied"
        ) {
          const cancel = await options.host.fleet.edgeRuntime(
            {
              ...fleetPayload,
              method: "repo.agentRuntime.cancel",
              action: { runtimeSessionId: relayedExecutionPrincipal.runtimeSessionId, escalation: true },
            },
            options.authContext,
          );
          return reply(method, { ...result, edgeCancellation: cancel });
        }
        return reply(method, result);
      } catch (error) {
        return reply(method, protocolFailure(method, error));
      }
    }
    if (method === "daemon.fleet.doc.sync" || method === "daemon.fleet.conflict.exit") {
      try {
        if (options.authContext.transportKind !== "unix-socket" || options.authContext.nodePrincipal)
          throw Object.assign(new Error("This control is available only through the local session token."), {
            code: "local_transport_required",
          }); // Lazy for the same schema-closure reason as the task channel.
        return reply(
          method,
          protocolFailure(method, new Error("Fleet document sync is handled by the unified document-submit path.")),
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
    if (method === "daemon.gui.home.read") {
      try {
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
    if (action.kind === "preset-run-start" || action.kind === "preset-run-status")
      return reply(commandMethod, await options.host.presetRun(repo, action, options.authContext));
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
  const one = async (request: JsonRpcRequest, frameReceivedAt = Date.now()): Promise<JsonRpcResponse | undefined> => {
    const method = typeof request.method === "string" ? request.method : "";
    // Parked waits are observations, not work: counting one would pin a superseded daemon resident
    // for as long as any --wait client cares to watch, which is exactly what the drain exists to end.
    const fleetAction =
      isJsonObject(request.params) && isJsonObject(request.params.payload) ? request.params.payload.action : undefined;
    const fleetAwait =
      method === "daemon.fleet.task.run" &&
      isJsonObject(fleetAction) &&
      fleetAction.kind === "fleet-runtime" &&
      fleetAction.method === "repo.agentRuntime.sessions.await";
    if (method === "protocol.hello") {
      if (!helloPending) {
        const admitted = !drainActive();
        helloPending = true;
        helloReservationHeld = admitted;
        helloContinuationAdmitted = admitted;
        if (admitted) options.onRequestStarted?.(method);
      }
      try {
        return await run(request, frameReceivedAt);
      } finally {
        if (!handshaken || options.authContext.connectionSignal?.aborted) releaseHello();
      }
    }
    if (isDaemonParkedWaitMethod(method) || fleetAwait) {
      const admitted = !drainActive() || (helloPending && helloContinuationAdmitted);
      releaseHello();
      // Register abandonment around authentication as well as the host read: neither phase owns work.
      const response = await raceParkedWait(
        run(request, frameReceivedAt, admitted),
        parkedWaitAborts,
        options.authContext.connectionSignal,
        options.host.parkedWaitSignal,
      );
      return response === parkedWaitAbandoned ? undefined : response;
    }
    // Transfer the reservation without a zero-work interval before dispatching the next frame.
    const admittedHelloContinuation = helloPending && helloContinuationAdmitted,
      admitted = !drainActive() || admittedHelloContinuation;
    if (admitted) options.onRequestStarted?.(method);
    releaseHello();
    try {
      return await run(request, frameReceivedAt, admitted);
    } finally {
      if (admitted) options.onRequestSettled?.(method);
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
      }),
    );
  }
  // Command attribution in one place: the caller's own CLI declaration wins (it is exact even for
  // alias commands); an action-resolved kind follows; a request that resolved no action is keyed by
  // its sole owning CLI command when one exists (repo.agenda.read → agenda), else by method.
  function observedCommand(method: string | null, actionCommand: string): string {
    if (method === null || actionCommand !== method) return actionCommand;
    return commandIdForDaemonMethod(method) ?? method;
  }
  // Daemon-scoped counterpart: every request including hello and pre-dispatch rejections gets one
  // line, so connection-level forensics never depends on repo binding.
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
  ): void {
    if (!options.recordTraffic) return;
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

function sessionIndependentFleetRuntimeRead(method: string, params: JsonObject): boolean {
  if (method !== "daemon.fleet.task.run" || !isJsonObject(params.payload)) return false;
  const action = params.payload.action;
  return (
    isJsonObject(action) &&
    action.kind === "fleet-runtime" &&
    ["repo.agentRuntime.overview", "repo.agentRuntime.sessions.read", "repo.agentRuntime.sessions.await"].includes(
      String(action.method),
    )
  );
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
