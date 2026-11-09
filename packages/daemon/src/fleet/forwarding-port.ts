import { getExecutableEntityAction, readDaemonRegistry, type IdentitySessionPort } from "@harness-anything/kernel";
import path from "node:path";
import { readFileSync } from "node:fs";
import type { FleetPeerOptions } from "./peer.ts";
import type { JsonObject } from "../protocol/json-rpc-types.ts";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import { readFleetEdgeConfig } from "../client/fleet-edge-config.ts";
import { localDefaultBinding } from "../daemon-host-binding.ts";
import { executionCredentialRejected } from "../runtime-execution-credential.ts";
import type { RepoTaskAction } from "../repo-cell-types.ts";
import type { FleetEdgeRuntimeRequest } from "../fleet-edge-runtime.ts";
import { FleetEdgeTaskError, runFleetEdgeTask } from "../fleet-edge-task.ts";
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
      input.intent.kind === "runtime"
        ? input.intent.inputs.requiredNodeId
        : input.intent.executionContext.requiredNodeId,
    config = runtimeLocation(edge, input.repoId, requiredNodeId);
  if (!config) return null;
  const { workspaceRoot } = config;
  if (input.intent.kind === "runtime") {
    const payload = { ...config, method: input.intent.method, action: input.intent.inputs.action },
      receipt = (await input.runRuntime(
        payload as unknown as JsonObject,
        input.auth,
        input.intent.inputs.operation,
      )) as JsonObject;
    return receipt;
  }
  const action = input.intent.inputs as RepoTaskAction;
  const scheduleAction = getExecutableEntityAction(action.kind)?.target.kind === "schedule",
    squadControl = action.kind === "squad-run" || action.kind === "squad-cancel";
  if (scheduleAction || squadControl) {
    if (scheduleAction && (input.auth.executionPrincipal || input.auth.executionCredential))
      throw executionCredentialRejected();
    const bound = scheduleAction ? await bindPersonSession(input, workspaceRoot) : input.auth,
      {
        kind: _kind,
        executor: _executor,
        wait: _wait,
        noStream: _noStream,
        detach: _detach,
        ...runtimeAction
      } = action;
    return input.runRuntime(
      {
        ...config,
        method: scheduleAction ? "repo.schedule.run" : "repo.squad.control",
        action: { ...runtimeAction, kind: action.kind } as JsonObject,
      },
      { ...input.auth, ...bound },
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
  const bindPersonSessionNow = () => bindPersonSession(input, workspaceRoot),
    bound = await bindPersonSessionNow(),
    personId = input.auth.executionPrincipal?.personId ?? localDefaultBinding(bound).actor.principal.personId;
  if (input.auth.executionPrincipal && personId !== localDefaultBinding(bound).actor.principal.personId)
    throw executionCredentialRejected();
  return runFleetEdgeTask(
    {
      payload: {
        ...config,
        workspaceRoot,
        principalId: personId,
        ...(input.auth.executionCredential ? { executionCredential: input.auth.executionCredential } : {}),
        action: wireAction as never,
      },
    },
    async () => {
      const session = await bindPersonSessionNow();
      return session.localSessionAccessToken ? session.localSessionAccessToken() : session.oidcPrincipal?.accessToken;
    },
    "domain",
  );
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
