import { getExecutableEntityAction, readDaemonRegistry, type IdentitySessionPort } from "@harness-anything/kernel";
import path from "node:path";
import type { JsonObject } from "../protocol/json-rpc-types.ts";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import { readFleetEdgeConfig } from "../client/fleet-edge-config.ts";
import { localDefaultBinding } from "../daemon-host-binding.ts";
import { executionCredentialRejected } from "../runtime-execution-credential.ts";
import type { RepoTaskAction } from "../repo-cell-types.ts";
import type { FleetEdgeRuntimeRequest } from "../fleet-edge-runtime.ts";
import { FleetEdgeTaskError, runFleetEdgeTask } from "../fleet-edge-task.ts";
import { forwardingIntentIssue, type ForwardingIntent } from "./forwarding-intent.ts";

export async function forward(input: {
  readonly userRoot?: string;
  readonly repoId: string;
  readonly rootDir?: string;
  readonly intent: ForwardingIntent;
  readonly auth: DaemonAuthenticationContext;
  readonly oidc: IdentitySessionPort;
  readonly runRuntime: (
    payload: JsonObject,
    auth: DaemonAuthenticationContext,
    operation?: "run" | "reconcile",
  ) => Promise<Record<string, unknown>>;
  readonly decorateRuntime?: (
    payload: FleetEdgeRuntimeRequest["payload"],
    receipt: JsonObject,
  ) => JsonObject | Promise<JsonObject>;
}): Promise<Record<string, unknown> | null> {
  if (input.intent.kind === "runtime") {
    if (input.auth.transportKind !== "unix-socket" || input.auth.nodePrincipal) return null;
    const edge = registeredRemoteEdge(input.userRoot, input.repoId);
    if (!edge) return null;
    const { workspaceRoot, config: storedConfig } = edge;
    if (
      !storedConfig ||
      storedConfig.repoId !== input.repoId ||
      (input.intent.inputs.requiredNodeId !== undefined && storedConfig.nodeId !== input.intent.inputs.requiredNodeId)
    )
      throw new FleetEdgeTaskError(
        "fleet_edge_config_invalid",
        "The registered remote-edge configuration is unavailable.",
      );
    const payload: FleetEdgeRuntimeRequest["payload"] = {
        ...storedConfig,
        caPath: path.resolve(workspaceRoot, storedConfig.caPath),
        viewRoot: path.resolve(workspaceRoot, storedConfig.viewRoot),
        workspaceRoot,
        method: input.intent.method,
        action: input.intent.inputs.action,
      },
      receipt = (await input.runRuntime(
        payload as unknown as JsonObject,
        input.auth,
        input.intent.inputs.operation ?? "run",
      )) as JsonObject;
    return input.decorateRuntime ? input.decorateRuntime(payload, receipt) : receipt;
  }
  const issue = forwardingIntentIssue(input.intent);
  if (issue) throw new FleetEdgeTaskError("invalid_field", issue);
  if (input.auth.transportKind !== "unix-socket" || input.auth.nodePrincipal) return null;
  const edge = registeredRemoteEdge(input.userRoot, input.repoId);
  if (!edge || (input.rootDir && edge.workspaceRoot !== input.rootDir)) return null;
  const { workspaceRoot, config: storedConfig } = edge;
  if (
    !storedConfig ||
    storedConfig.repoId !== input.repoId ||
    (input.intent.executionContext.requiredNodeId !== undefined &&
      storedConfig.nodeId !== input.intent.executionContext.requiredNodeId)
  )
    return null;
  const config = {
      ...storedConfig,
      caPath: path.resolve(workspaceRoot, storedConfig.caPath),
    },
    action = input.intent.inputs as RepoTaskAction;
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
        viewRoot: path.resolve(workspaceRoot, config.viewRoot),
        workspaceRoot,
        method: scheduleAction ? "repo.schedule.run" : "repo.squad.control",
        action: { ...runtimeAction, kind: action.kind } as JsonObject,
      },
      { ...input.auth, ...bound },
    );
  }
  if (input.auth.executionPrincipal && !input.auth.executionCredential) throw executionCredentialRejected();
  // Execution identity is rebuilt from the credential at the center. Match the CLI serializer's
  // declared Fleet action by excluding executor and the local command-line metadata.
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

function registeredRemoteEdge(userRoot: string | undefined, repoId: string) {
  const repo = readDaemonRegistry({ userRoot }).repos.find(
    (candidate) => candidate.repoId === repoId && candidate.state === "enabled" && candidate.mode === "remote-edge",
  );
  if (!repo?.canonicalRoot) return null;
  return { workspaceRoot: repo.canonicalRoot, config: readFleetEdgeConfig(repo.canonicalRoot) };
}

async function bindPersonSession(
  input: { readonly auth: DaemonAuthenticationContext; readonly oidc: IdentitySessionPort },
  workspaceRoot: string,
) {
  // Admission already selected the request's edge session. Rebinding by the
  // workspace root can consult the edge's intentionally secret-less provider
  // configuration and turn a valid device session into rbac_admin_unavailable.
  if (input.auth.oidcPrincipal) return input.auth;
  return input.oidc.bind(input.auth, workspaceRoot);
}
