import { getExecutableEntityAction, readDaemonRegistry, type IdentitySessionPort } from "@harness-anything/kernel";
import type { JsonObject } from "../protocol/json-rpc-types.ts";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import { readFleetEdgeConfig } from "../client/fleet-edge-config.ts";
import { localDefaultBinding } from "../daemon-host-binding.ts";
import { executionCredentialRejected } from "../runtime-execution-credential.ts";
import type { RepoTaskAction } from "../repo-cell-types.ts";
import { FleetEdgeTaskError, runFleetEdgeTask } from "../fleet-edge-task.ts";
import { commandDescriptorForAction } from "../protocol/daemon-protocol.contract.ts";
import { forwardingIntentIssue, type ForwardingIntent } from "./forwarding-intent.ts";

export async function forward(input: {
  readonly userRoot?: string;
  readonly repoId: string;
  readonly rootDir?: string;
  readonly intent: ForwardingIntent;
  readonly auth: DaemonAuthenticationContext;
  readonly oidc: IdentitySessionPort;
  readonly runRuntime: (payload: JsonObject, auth: DaemonAuthenticationContext) => Promise<Record<string, unknown>>;
}): Promise<Record<string, unknown> | null> {
  const issue = forwardingIntentIssue(input.intent);
  if (issue) throw new FleetEdgeTaskError("invalid_field", issue);
  if (input.auth.transportKind !== "unix-socket" || input.auth.nodePrincipal) return null;
  const edge = readDaemonRegistry({ userRoot: input.userRoot }).repos.find(
    (repo) => repo.repoId === input.repoId && repo.state === "enabled" && repo.mode === "remote-edge",
  );
  if (!edge?.canonicalRoot || (input.rootDir && edge.canonicalRoot !== input.rootDir)) return null;
  const workspaceRoot = edge.canonicalRoot,
    config = readFleetEdgeConfig(workspaceRoot);
  if (
    !config ||
    config.repoId !== input.repoId ||
    (input.intent.executionContext.requiredNodeId !== undefined &&
      config.nodeId !== input.intent.executionContext.requiredNodeId)
  )
    return null;
  const action = input.intent.inputs as RepoTaskAction,
    descriptor = commandDescriptorForAction(input.intent.commandId);
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
        workspaceRoot,
        method: scheduleAction ? "repo.schedule.run" : "repo.squad.control",
        action: { ...runtimeAction, kind: action.kind } as JsonObject,
      },
      { ...input.auth, ...bound },
    );
  }
  if (descriptor.method !== input.intent.method)
    throw new FleetEdgeTaskError("invalid_field", "Forwarding method changed during dispatch.");
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
  const bindPersonSessionNow = () => bindPersonSessionForRoot(input.auth, input.oidc, workspaceRoot),
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

async function bindPersonSession(
  input: { readonly auth: DaemonAuthenticationContext; readonly oidc: IdentitySessionPort },
  workspaceRoot: string,
) {
  return bindPersonSessionForRoot(input.auth, input.oidc, workspaceRoot);
}

async function bindPersonSessionForRoot(
  auth: DaemonAuthenticationContext,
  oidc: IdentitySessionPort,
  workspaceRoot: string,
) {
  // Admission already selected the request's edge session. Rebinding by the
  // workspace root can consult the edge's intentionally secret-less provider
  // configuration and turn a valid device session into rbac_admin_unavailable.
  if (auth.oidcPrincipal) return auth;
  const session = await oidc.bind(auth, workspaceRoot),
    personId = localDefaultBinding(session).actor.principal.personId;
  if (auth.executionPrincipal && auth.executionPrincipal.personId !== personId) throw executionCredentialRejected();
  return session;
}
