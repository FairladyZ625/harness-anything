import { preflightNodeReviewDispatch } from "@harness-anything/application/internal/commands/node-review-dispatch-preflight.ts";
import {
  reviewDispatchDiagnostic,
  withReviewDispatchFailures,
} from "@harness-anything/application/internal/queries/review-dispatch-failure-read.ts";
import { assertFleetEdgeRepositoryGit } from "../fleet-edge-git-preflight.ts";
import { parseNodeAutoDispatchSnapshot } from "../node-auto-dispatch.ts";
import { runtimeErrorCode, runtimeErrorMessage, runtimeSpawnError } from "../../runtime-engine/runtime-spawn-errors.ts";
import { getExecutableEntityAction, readDaemonRegistry, type IdentitySessionPort } from "@harness-anything/kernel";
import path from "node:path";
import { readFileSync } from "node:fs";
import type { FleetPeerOptions } from "./peer.ts";
import { unregisterFleetNodeClient } from "./peer.ts";
import { text } from "../access-admin-utils.ts";
import type { JsonObject } from "../protocol/json-rpc-types.ts";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import { readFleetEdgeConfig } from "../client/fleet-edge-config.ts";
import { localDefaultBinding } from "../daemon-host-binding.ts";
import { executionCredentialRejected } from "../runtime-execution-credential.ts";
import type { RepoTaskAction } from "../repo-cell-types.ts";
import type { FleetEdgeRuntimeRequest } from "../fleet-edge-runtime.ts";
import { FleetEdgeTaskError, runFleetEdgeTask } from "../fleet-edge-task.ts";
import { readFleetOperationalClient, readFleetRepositoryMetadataClient, raceLifetime } from "../fleet-edge-write.ts";
import { forwardingIntentIssue, type ForwardingIntent } from "./forwarding-intent.ts";

export type RuntimeForwardingRequest = {
  readonly repoId: string;
  readonly requiredNodeId?: string;
  readonly method: FleetEdgeRuntimeRequest["payload"]["method"];
  readonly action: JsonObject;
  readonly operation?: "run" | "reconcile";
  readonly decorate?: (
    payload: FleetEdgeRuntimeRequest["payload"],
    receipt: JsonObject,
  ) => JsonObject | Promise<JsonObject>;
  readonly auth: DaemonAuthenticationContext;
};

export async function forward(input: {
  readonly userRoot?: string;
  readonly repoId: string;
  readonly intent: ForwardingIntent;
  readonly auth: DaemonAuthenticationContext;
  readonly oidc: IdentitySessionPort;
  /** Daemon-close lifetime; combined with the request connection lifetime and carried into retries. */
  readonly signal?: AbortSignal;
  readonly runRuntime: (
    payload: JsonObject,
    auth: DaemonAuthenticationContext,
    operation?: "run" | "reconcile",
  ) => Promise<Record<string, unknown>>;
}): Promise<Record<string, unknown> | null> {
  if (input.intent.kind === "command") {
    const issue = forwardingIntentIssue(input.intent);
    if (issue) throw new FleetEdgeTaskError("invalid_field", issue);
  }
  const edge = registeredRemoteEdge(input.userRoot, input.repoId);
  if (!edge) return null;
  if (input.auth.transportKind !== "unix-socket" || input.auth.nodePrincipal)
    throw new FleetEdgeTaskError("local_transport_required", "Local session transport required.");
  const requiredNodeId =
      input.intent.kind === "command"
        ? input.intent.executionContext.requiredNodeId
        : input.intent.kind === "runtime"
          ? input.intent.inputs.requiredNodeId
          : undefined,
    config = runtimeLocation(edge, input.repoId, requiredNodeId);
  if (!config) invalidRuntimeLocation();
  const { workspaceRoot } = config;
  const signal =
      input.signal && input.auth.connectionSignal
        ? AbortSignal.any([input.signal, input.auth.connectionSignal])
        : (input.signal ?? input.auth.connectionSignal),
    runtimeAuth = signal ? { ...input.auth, connectionSignal: signal } : input.auth;
  const readAccessToken = async () => {
    const bound = await bindPersonSession(input, workspaceRoot);
    return bound.localSessionAccessToken ? bound.localSessionAccessToken() : bound.oidcPrincipal?.accessToken;
  };
  signal?.throwIfAborted();
  if (input.intent.kind === "node-unregister") {
    const { writePeer } = runtimeForwardingContext(config, readAccessToken);
    return raceLifetime(
      unregisterFleetNodeClient(
        { ...writePeer, signal },
        {
          ...input.intent.inputs,
          nodeId: text(input.intent.inputs.nodeId, "nodeId"),
        },
      ),
      signal,
    );
  }
  if (input.intent.kind === "operational-read") {
    const { runtimeReadPeer } = runtimeForwardingContext(config, readAccessToken);
    return raceLifetime(
      readFleetOperationalClient({
        ...runtimeReadPeer,
        method: input.intent.method,
        payload: input.intent.inputs,
        connectionSignal: signal,
      }),
      signal,
    );
  }
  if (input.intent.kind === "runtime") {
    const payload = { ...config, method: input.intent.method, action: input.intent.inputs.action },
      receipt = (await raceLifetime(
        input.runRuntime(payload as unknown as JsonObject, runtimeAuth, input.intent.inputs.operation),
        signal,
      )) as JsonObject;
    return receipt;
  }
  const action = input.intent.inputs as RepoTaskAction;
  const scheduleAction = getExecutableEntityAction(action.kind)?.target.kind === "schedule",
    squadControl = action.kind === "squad-run" || action.kind === "squad-cancel";
  if (scheduleAction || squadControl) {
    if (scheduleAction && (input.auth.executionPrincipal || input.auth.executionCredential))
      throw executionCredentialRejected();
    const bound = scheduleAction ? await bindPersonSession(input, workspaceRoot) : runtimeAuth,
      {
        kind: _kind,
        executor: _executor,
        wait: _wait,
        noStream: _noStream,
        detach: _detach,
        ...runtimeAction
      } = action;
    return raceLifetime(
      input.runRuntime(
        {
          ...config,
          method: scheduleAction ? "repo.schedule.run" : "repo.squad.control",
          action: { ...runtimeAction, kind: action.kind } as JsonObject,
        },
        { ...bound, ...(signal ? { connectionSignal: signal } : {}) },
      ),
      signal,
    );
  }
  if (input.auth.executionPrincipal && !input.auth.executionCredential) throw executionCredentialRejected();
  const {
    executor: _executor,
    createMode: _createMode,
    verb: _verb,
    commandType: _commandType,
    planSource: _planSource,
    ...wireAction
  } = action;
  const bound = await bindPersonSession(input, workspaceRoot),
    personId = input.auth.executionPrincipal?.personId ?? localDefaultBinding(bound).actor.principal.personId;
  if (input.auth.executionPrincipal && personId !== localDefaultBinding(bound).actor.principal.personId)
    throw executionCredentialRejected();
  const receipt = await runFleetEdgeTask(
    {
      ...(signal ? { signal } : {}),
      payload: {
        ...config,
        principalId: personId,
        ...(input.auth.executionCredential ? { executionCredential: input.auth.executionCredential } : {}),
        action: wireAction as never,
      },
    },
    readAccessToken,
    "domain",
  );
  if (
    action.kind === "task-escalate" &&
    input.auth.executionPrincipal &&
    (receipt.outcome === "applied" || receipt.outcome === "no_changes")
  ) {
    const edgeCancellation = await input.runRuntime(
      {
        ...config,
        method: "repo.agentRuntime.cancel",
        action: {
          runtimeSessionId: input.auth.executionPrincipal.runtimeSessionId,
          escalation: true,
        },
      },
      runtimeAuth,
    );
    return { ...receipt, edgeCancellation };
  }
  if (
    ["task-submit", "task-dispatch-review"].includes(action.kind) &&
    ["applied", "no_changes", "pending"].includes(String(receipt.outcome))
  ) {
    const { runtimeReadPeer } = runtimeForwardingContext(config, readAccessToken);
    return observeForwardedReviewReadiness({
      receipt,
      config,
      principalId: personId,
      readAccessToken,
      peer: { ...runtimeReadPeer, signal },
      taskIds: action.kind === "task-submit" ? [String(action.taskId)] : (action.taskIds as readonly string[]),
    });
  }
  return receipt;
}

export function resolveRuntimeLocation(userRoot: string | undefined, repoId: string, requiredNodeId?: string) {
  const edge = registeredRemoteEdge(userRoot, repoId);
  return edge ? (runtimeLocation(edge, repoId, requiredNodeId) ?? invalidRuntimeLocation()) : invalidRuntimeLocation();
}

function runtimeLocation(
  edge: NonNullable<ReturnType<typeof registeredRemoteEdge>>,
  repoId: string,
  requiredNodeId?: string,
) {
  const { config } = edge;
  if (!config || config.repoId !== repoId || (requiredNodeId !== undefined && config.nodeId !== requiredNodeId))
    return null;
  const workspaceRoot = edge.workspaceRoot;
  return {
    ...config,
    workspaceRoot,
    caPath: path.resolve(workspaceRoot, config.caPath),
    viewRoot: path.resolve(workspaceRoot, config.viewRoot),
  };
}

function invalidRuntimeLocation(): never {
  throw new FleetEdgeTaskError("fleet_edge_config_invalid", "The registered remote-edge configuration is unavailable.");
}

export function runtimeForwardingContext(
  request: Omit<FleetEdgeRuntimeRequest["payload"], "method" | "action">,
  readAccessToken: () => Promise<string | undefined>,
) {
  const centerWriteWaitMs = request.waitTimeoutMs ?? 30_000,
    peer: FleetPeerOptions = {
      hostname: request.host,
      port: request.port,
      ca: readFileSync(request.caPath, "utf8"),
      servername: request.servername,
      nodeId: request.nodeId,
      credential: request.credential,
      repoId: request.repoId,
      readAccessToken,
    };
  return {
    request,
    centerWriteWaitMs,
    runtimeReadPeer: { ...peer, timeoutMs: request.waitTimeoutMs },
    writePeer: { ...peer, timeoutMs: centerWriteWaitMs + 10_000 },
  };
}

function registeredRemoteEdge(userRoot: string | undefined, repoId: string) {
  const repo = readDaemonRegistry({ userRoot }).repos.find(
    (candidate) => candidate.repoId === repoId && candidate.state === "enabled" && candidate.mode === "remote-edge",
  );
  return repo?.canonicalRoot
    ? { workspaceRoot: repo.canonicalRoot, config: readFleetEdgeConfig(repo.canonicalRoot) }
    : null;
}

async function bindPersonSession(
  input: { readonly auth: DaemonAuthenticationContext; readonly oidc: IdentitySessionPort },
  workspaceRoot: string,
) {
  if (input.auth.oidcPrincipal) return input.auth;
  return input.oidc.bind(input.auth, workspaceRoot);
}

/** Physical readiness observation uses exactly the metadata and Git validator used by runtime spawn. */
async function observeForwardedReviewReadiness(input: {
  readonly receipt: Record<string, unknown>;
  readonly taskIds: readonly string[];
  readonly config: Omit<FleetEdgeRuntimeRequest["payload"], "method" | "action">;
  readonly principalId: string;
  readonly peer: FleetPeerOptions;
  readonly readAccessToken: () => Promise<string | undefined>;
}): Promise<Record<string, unknown>> {
  const diagnostic = (error: unknown) =>
      reviewDispatchDiagnostic({
        code: runtimeErrorCode(error),
        message: `Node ${input.config.nodeId}: ${runtimeErrorMessage(error)}`,
      }),
    taskIds = new Set(input.taskIds);
  let candidates;
  try {
    candidates = parseNodeAutoDispatchSnapshot(
      await readFleetOperationalClient({
        ...input.peer,
        method: "repo.tasks.autoDispatchCandidates",
        payload: {},
      }),
    ).candidates.filter(
      (row) => row.kind === "review" && row.requiredNodeId === input.config.nodeId && taskIds.has(row.taskId),
    );
  } catch (error) {
    const failure = diagnostic(error);
    return {
      ...input.receipt,
      reviewDispatchError: failure,
      warnings: [
        ...(Array.isArray(input.receipt.warnings) ? input.receipt.warnings : []),
        `Review dispatch readiness could not be checked: ${failure.code}; ${failure.message}`,
      ],
    };
  }
  const observed = await preflightNodeReviewDispatch({
    candidates,
    diagnostic,
    now: () => new Date().toISOString(),
    preflight: async () =>
      assertFleetEdgeRepositoryGit({
        rootDir: input.config.workspaceRoot,
        center: await readFleetRepositoryMetadataClient({ ...input.peer, includeGitMetadata: true }),
        operation: "runtime dispatch",
      }),
    writeFailure: async (candidate, failure) => {
      const receipt = await runFleetEdgeTask(
        {
          payload: {
            ...input.config,
            principalId: input.principalId,
            action: {
              kind: "task-amend",
              taskId: candidate.taskId,
              patches: [{ field: "reviewDispatchFailure", value: JSON.stringify(failure) }],
            },
          },
        },
        input.readAccessToken,
        "domain",
      );
      if (!["applied", "no_changes"].includes(String(receipt.outcome)))
        throw runtimeSpawnError(
          typeof receipt.code === "string" ? receipt.code : "review_dispatch_state_rejected",
          String(receipt.rejectionExplanation ?? receipt.summary ?? receipt.code),
        );
    },
  });
  const receipt = withReviewDispatchFailures(input.receipt, observed.failures);
  return observed.publicationWarnings.length === 0
    ? receipt
    : {
        ...receipt,
        warnings: [...(Array.isArray(receipt.warnings) ? receipt.warnings : []), ...observed.publicationWarnings],
      };
}
