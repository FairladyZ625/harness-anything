import { readDaemonRegistry, type FleetDeviceLoginNotice } from "@harness-anything/kernel";
import type { DaemonHostApiContext } from "./daemon-host-context.ts";
import { hostCodedError } from "./daemon-host-errors.ts";
import {
  keycloakNodeRegistry,
  prepareFleetCenterAdmission,
  startFleetCenterAdmission,
} from "./fleet-center-admission.ts";
import { readFleetCenterConfig } from "./fleet-center-config.ts";
import { rebindCenterRelocationRouting } from "./fleet/center-relocation-command.ts";
import { createHostContextSwitchoverControl } from "./fleet/center-switchover-transport.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";

export interface SavedFleetCenterRestoreOutcome {
  readonly restoreFailed: boolean;
}

export async function restoreSavedFleetCenter(
  hostContext: DaemonHostApiContext,
  announceStandbyIfReady: (repoId: string, rootDir: string) => void,
): Promise<SavedFleetCenterRestoreOutcome> {
  const { input, host, oidc, accessAdmin, triggerCenterReviewFallback } = hostContext;
  try {
    const config = readFleetCenterConfig(input.userRoot, input.daemonId);
    if (!config) return { restoreFailed: false };
    const authorityRepo = readDaemonRegistry({ userRoot: input.userRoot }).repos.find(
      (repo) =>
        repo.repoId === config.repoId &&
        repo.state === "enabled" &&
        repo.mode !== "remote-proxy" &&
        repo.canonicalRoot !== null,
    );
    if (!authorityRepo)
      throw hostCodedError("repo_namespace_unknown", "Saved fleet center authority repository is not enabled.");
    const started = await startFleetCenterAdmission(
      await prepareFleetCenterAdmission({
        host,
        storage: input.storage,
        buildDraining: input.buildDraining,
        onDeliverySettled: input.onRepoStatusChange,
        onNodeDisconnected: () => triggerCenterReviewFallback?.("fleet-node-disconnected"),
        recordTraffic: input.recordTraffic,
        onRequestStarted: input.onFleetRequestStarted,
        onRequestSettled: input.onFleetRequestSettled,
        ...(input.authenticateExecutionPrincipal && {
          authenticateExecutionPrincipal: input.authenticateExecutionPrincipal,
        }),
        userRoot: input.userRoot,
        writerEpochLease: hostContext.writerEpochLease,
        onSwitchoverControl: createHostContextSwitchoverControl(
          hostContext,
          config.stateRoot,
          rebindCenterRelocationRouting,
        ),
        payload: config,
        nodes: {
          ...keycloakNodeRegistry(hostContext.keycloakCenter),
          loginAuthority: (nodeId) => oidc.discovery(nodeId),
          ...(oidc.revokeDeviceSessions && {
            revokeDeviceSessions: (nodeId: string) => oidc.revokeDeviceSessions!(nodeId),
          }),
          ...(oidc.receiveDeviceNotice && {
            deviceLoginNotice: (nodeId: string, personId: string, notice: FleetDeviceLoginNotice) =>
              oidc.receiveDeviceNotice!(nodeId, personId, notice),
          }),
          verifyHuman: (auth) => oidc.bind(auth),
          ...(oidc.bindReplica && { verifyReplica: (auth: DaemonAuthenticationContext) => oidc.bindReplica!(auth) }),
          createMemberEdgeJoin: (repos, person, token) => accessAdmin.createMemberEdgeJoin(repos, person, token),
          edgeJoinStatus: (edgeJoinInput) => accessAdmin.edgeJoinStatus(edgeJoinInput),
          edgeJoin: (edgeJoinInput) =>
            accessAdmin.admitEdgeJoin({
              joinId: edgeJoinInput.joinId,
              inviteToken: edgeJoinInput.inviteToken,
              ...(edgeJoinInput.recovery ? { recovery: edgeJoinInput.recovery } : {}),
              accessToken: edgeJoinInput.accessToken,
            }),
        },
      }),
    );
    hostContext.fleetCenter = started.center;
    void host.attachmentsSettled().then(() => {
      triggerCenterReviewFallback?.("fleet-center-restored");
      if (authorityRepo.mode === "remote-edge" && authorityRepo.canonicalRoot)
        announceStandbyIfReady(authorityRepo.repoId, authorityRepo.canonicalRoot);
    });
    await accessAdmin.resumeEdgeJoinTunnels(started.center.port);
    return { restoreFailed: false };
  } catch (error) {
    input.recordLifecycle?.({
      event: "fleet_center_restore_failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return { restoreFailed: true };
  }
}
