import { randomUUID } from "node:crypto";
import { readFileSync, statfsSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import {
  abortCenterSwitchoverRollback,
  runCenterSwitchover,
  type CenterSwitchoverPorts,
  type CenterSwitchoverRollbackPorts,
  type SwitchoverCededFenceRecord,
} from "@harness-anything/application/internal/commands/center-switchover.ts";
import { writeDaemonRegistryRepo } from "@harness-anything/kernel/daemon-registry";
import { cliOperationalPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { localRuntimeStateFileSystem } from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";
import { canonicalLedgerCut } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import {
  switchoverTriggerSources,
  type SwitchoverFrozenCut,
  type SwitchoverPreflightInput,
  type SwitchoverReplicaCut,
  type SwitchoverTriggerSource,
} from "@harness-anything/kernel/internal/domain/center-switchover.ts";
import {
  DEFAULT_REPLICA_LOG_WINDOW_COMMITS,
  cedeCenterForSwitchover,
  clearCenterMigrating,
  enterCenterMigrating,
  invalidateTargetSwitchoverAttempt,
  markCenterSwitchoverFenceDemoted,
  openReplicationSlots,
  openSqliteEventStore,
  promoteReplicaForSwitchover,
  publishPendingSqliteGitOutbox,
  readCenterFrozenCut,
  readCenterSwitchoverFence,
  rollbackCenterSwitchover,
  writeFileDurably,
  type CenterReplicationLogRow,
} from "@harness-anything/storage";
import { daemonIdFromEnv } from "../client/local-daemon-target.ts";
import {
  fleetEdgeCaPath,
  readFleetEdgeConfig,
  removeFleetEdgeConfig,
  writeFleetEdgeConfig,
} from "../client/fleet-edge-config.ts";
import { createIdentitySession } from "../authorization-provider.ts";
import { localSystemBinding, resolveBoundAccessToken } from "../daemon-host-binding.ts";
import { readFleetCenterConfig } from "../fleet-center-config.ts";
import { requireAuthorizedHostAction } from "../host-action-authorization.ts";
import { oidcCenterSelections } from "../oidc-center-selection.ts";
import { systemCaCertificates } from "../tls-ca-certificate.ts";
import { readReplicaGeneration } from "../../fleet-sync/fleet/replica-generation.ts";
import { readReplicaHealth } from "../../fleet-sync/fleet/replica-health.ts";
import type { FleetCenterRelocationOutcome } from "./center-relocation-command.ts";
import {
  activateRemoteSwitchoverClient,
  centerSwitchoverCandidatePath,
  centerSymmetricIdentityPath,
  invalidateRemoteSwitchoverClient,
  prepareCenterSwitchoverCandidate,
  prepareCenterSymmetricIdentity,
  queryRemoteSwitchoverStatusClient,
  readCenterSwitchoverCandidate,
  readCenterSymmetricIdentity,
  signSwitchoverCededProof,
  measureSwitchoverRemoteActivationTransfer,
  type CenterSwitchoverCandidateV1,
  type CenterSwitchoverCededProofV1,
  type CenterSymmetricNodeIdentityV1,
  type SwitchoverReplicationSlotRow,
} from "./center-switchover-transport.ts";
import type { FleetPeerOptions } from "./peer.ts";
import { waitForFleetReplicaRevision } from "./replica-sync.ts";
import { requestFleetReplicaToken } from "./replica-token.ts";

export {
  centerSwitchoverCandidatePath,
  centerSymmetricIdentityPath,
  prepareCenterSwitchoverCandidate,
  prepareCenterSymmetricIdentity,
  readCenterSwitchoverCandidate,
  readCenterSymmetricIdentity,
  type CenterSwitchoverCandidateV1,
  type CenterSymmetricNodeIdentityV1,
};

function switchoverCommandError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

export interface FleetCenterSwitchoverCommandHelpers {
  readonly drainLocalDaemonRepoQueue?: (userRoot: string, daemonId: string, repoId: string) => Promise<boolean>;
  readonly reloadLocalDaemonRepoMode?: (input: {
    readonly userRoot: string;
    readonly daemonId: string;
    readonly repoId: string;
    readonly rootDir: string;
    readonly mode: "local" | "remote-edge";
  }) => Promise<boolean>;
  readonly rebindCenterRelocationRouting?: (input: {
    readonly userRoot: string;
    readonly daemonId: string;
    readonly stateRoot: string;
    readonly repoId: string;
    readonly writerEpoch: number;
    readonly externalUrl?: string;
    readonly loginUrl?: string;
  }) => unknown;
}

function isPositiveSafeByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export interface FleetCenterSwitchoverHooks {
  readonly now?: () => string;
  readonly probeTls?: (
    externalUrl: string,
    caPath?: string,
    servername?: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  readonly probeAuth?: (loginUrl: string, caPath?: string) => Promise<{ ok: boolean; error?: string }>;
  readonly freezeAndDrain?: (context: {
    readonly repoId: string;
    readonly rootDir: string;
    readonly userRoot: string;
    readonly daemonId: string;
    readonly oldEpoch: number;
  }) => void | Promise<void>;
  readonly awaitTargetCatchup?: (context: {
    readonly repoId: string;
    readonly targetNodeId: string;
    readonly frozenCut: SwitchoverFrozenCut;
    readonly timeoutMs: number;
  }) => Promise<SwitchoverReplicaCut>;
  readonly afterCededFencePersisted?: (context: {
    readonly repoId: string;
    readonly switchoverId: string;
    readonly oldEpoch: number;
    readonly cededEpoch: number;
  }) => void | Promise<void>;
  readonly beforeTargetActivation?: (context: {
    readonly repoId: string;
    readonly switchoverId: string;
    readonly expectedOldEpoch: number;
    readonly newEpoch: number;
    readonly targetNodeId: string;
  }) => void | Promise<void>;
  readonly afterTargetActivated?: (context: {
    readonly repoId: string;
    readonly switchoverId: string;
    readonly newEpoch: number;
    readonly targetRoot: string;
    readonly targetUserRoot: string;
  }) => void | Promise<void>;
  readonly afterDemotedToEdge?: (context: {
    readonly repoId: string;
    readonly switchoverId: string;
    readonly newEpoch: number;
    readonly sourceRoot: string;
    readonly sourceUserRoot: string;
    readonly sourceNodeId: string;
    readonly viewRoot: string;
  }) => void | Promise<void>;
  readonly invalidateTargetAttempt?: CenterSwitchoverRollbackPorts["invalidateTargetAttempt"];
}

export async function switchFleetCenter(
  argv: readonly string[],
  defaultUserRoot: string = path.join(os.homedir(), ".harness"),
  hooks?: FleetCenterSwitchoverHooks,
  helpers?: FleetCenterSwitchoverCommandHelpers,
): Promise<FleetCenterRelocationOutcome> {
  if (argv.includes("--abort-rollback")) return await runRollbackCommand(argv, defaultUserRoot, hooks);
  return await runForwardSwitchoverCommand(argv, defaultUserRoot, hooks, helpers);
}

async function runForwardSwitchoverCommand(
  argv: readonly string[],
  defaultUserRoot: string,
  hooks?: FleetCenterSwitchoverHooks,
  helpers?: FleetCenterSwitchoverCommandHelpers,
): Promise<FleetCenterRelocationOutcome> {
  const missing = missingFlags(argv, ["--root", "--repo", "--to"]);
  if (missing.length > 0)
    return failureOutcome(
      "fleet-center-switch",
      "missing_field",
      `Add ${missing.join(" ")} to run center switchover preflight or execution.`,
    );
  const triggerRaw = flagValue(argv, "--trigger-source") ?? "operator";
  if (!(switchoverTriggerSources as readonly string[]).includes(triggerRaw))
    return failureOutcome("fleet-center-switch", "invalid_field", "--trigger-source must be operator or sentinel.");
  const triggerSource = triggerRaw as SwitchoverTriggerSource,
    dryRun = argv.includes("--dry-run"),
    sourceRoot = path.resolve(flagValue(argv, "--root")!),
    repoId = flagValue(argv, "--repo")!,
    targetNodeId = flagValue(argv, "--to")!,
    sourceUserRoot = path.resolve(flagValue(argv, "--user-root") ?? defaultUserRoot),
    sourceStateRoot = path.resolve(flagValue(argv, "--state-root") ?? path.join(sourceUserRoot, "fleet")),
    daemonId = flagValue(argv, "--daemon-id") ?? daemonIdFromEnv(),
    candidate = readCenterSwitchoverCandidate(sourceUserRoot, repoId, targetNodeId),
    explicitTargetRoot = flagValue(argv, "--target-root"),
    explicitTargetUserRoot = flagValue(argv, "--target-user-root"),
    rawTargetRoot = explicitTargetRoot ?? candidate?.targetRoot ?? null,
    rawTargetUserRoot = explicitTargetUserRoot ?? candidate?.targetUserRoot ?? null,
    hasDistinctLocalTargetHost =
      rawTargetRoot !== null &&
      rawTargetUserRoot !== null &&
      !(path.resolve(rawTargetRoot) === sourceRoot && path.resolve(rawTargetUserRoot) === sourceUserRoot),
    useLegacyLocalTargetPaths = hasDistinctLocalTargetHost,
    targetRoot = useLegacyLocalTargetPaths ? path.resolve(rawTargetRoot!) : null,
    targetUserRoot = useLegacyLocalTargetPaths ? path.resolve(rawTargetUserRoot!) : null,
    targetStateRoot = useLegacyLocalTargetPaths
      ? flagValue(argv, "--target-state-root")
        ? path.resolve(flagValue(argv, "--target-state-root")!)
        : candidate?.targetStateRoot
          ? path.resolve(candidate.targetStateRoot)
          : path.join(targetUserRoot!, "fleet")
      : null,
    switchoverId = flagValue(argv, "--switchover-id") ?? `sw_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
    maxAllowedLagRevisions = parseNonnegativeInt(flagValue(argv, "--max-lag-revisions"), 1024),
    catchupTimeoutMs = parseNonnegativeInt(flagValue(argv, "--catchup-timeout-ms"), 30_000),
    requiredDiskBytes = parseNonnegativeInt(flagValue(argv, "--required-disk-bytes"), 1024 * 1024),
    retentionWindowCommits = parseNonnegativeInt(
      flagValue(argv, "--replication-log-window"),
      DEFAULT_REPLICA_LOG_WINDOW_COMMITS,
    );
  if (
    maxAllowedLagRevisions === null ||
    catchupTimeoutMs === null ||
    requiredDiskBytes === null ||
    retentionWindowCommits === null
  )
    return failureOutcome(
      "fleet-center-switch",
      "invalid_field",
      "Numeric switchover options must be nonnegative integers.",
    );

  const rawExternalUrl = flagValue(argv, "--target-external-url") ?? candidate?.targetExternalUrl ?? "",
    targetExternalUrl = rawExternalUrl ? safeParseExternalUrl(rawExternalUrl) : "",
    targetLoginUrl = flagValue(argv, "--target-login-url") ?? candidate?.targetLoginUrl ?? "",
    targetSpkiSha256 = flagValue(argv, "--target-spki-sha256") ?? candidate?.targetSpkiSha256 ?? "",
    targetCaPath = flagValue(argv, "--target-ca")
      ? path.resolve(flagValue(argv, "--target-ca")!)
      : candidate?.targetCaPath
        ? path.resolve(candidate.targetCaPath)
        : undefined,
    targetServername = flagValue(argv, "--target-servername") ?? candidate?.targetServername,
    targetLoginCaPath = flagValue(argv, "--target-login-ca")
      ? path.resolve(flagValue(argv, "--target-login-ca")!)
      : undefined,
    priorKnownAuthority = oidcCenterSelections(sourceUserRoot).read(sourceRoot)?.authority,
    loginSameOriginAsFleet = sameHttpOrigin(targetLoginUrl, targetExternalUrl),
    targetLoginCertificate =
      targetLoginCaPath && localRuntimeStateFileSystem.exists(targetLoginCaPath)
        ? localRuntimeStateFileSystem.readText(targetLoginCaPath)
        : (candidate?.targetLoginCertificate ??
          (priorKnownAuthority && sameHttpOrigin(priorKnownAuthority.url, targetLoginUrl)
            ? priorKnownAuthority.certificate
            : undefined)),
    targetLoginServername =
      flagValue(argv, "--target-login-servername") ??
      candidate?.targetLoginServername ??
      (priorKnownAuthority && sameHttpOrigin(priorKnownAuthority.url, targetLoginUrl)
        ? priorKnownAuthority.servername
        : undefined),
    explicitSourceKeyPath = flagValue(argv, "--source-key")
      ? path.resolve(flagValue(argv, "--source-key")!)
      : undefined,
    explicitSourceCertPath = flagValue(argv, "--source-cert")
      ? path.resolve(flagValue(argv, "--source-cert")!)
      : undefined;

  // Always resolve source symmetric identity strictly read-only up front so dry-run preflight
  // and unauthorized/rejected invocations never mutate disk or create directories (F4).
  const resolvedIdentity = resolveSourceSymmetricIdentity(argv, sourceUserRoot, repoId);
  const hasExplicitSourceIdentityFlags =
    flagValue(argv, "--source-node-id") !== undefined ||
    flagValue(argv, "--source-credential") !== undefined ||
    flagValue(argv, "--source-view-root") !== undefined ||
    flagValue(argv, "--source-quota-bytes") !== undefined;
  let capturedLogWindow: readonly CenterReplicationLogRow[] = [];
  let capturedReplicationSlots: readonly SwitchoverReplicationSlotRow[] = [];
  let capturedCededProof: CenterSwitchoverCededProofV1 | null = null;
  let capturedTargetCertPem: string | null = null;

  const buildRemotePeerOptions = (timeoutMs?: number): Omit<FleetPeerOptions, "repoId"> => {
    if (!resolvedIdentity)
      throw switchoverCommandError(
        "source_symmetric_identity_missing",
        "Source symmetric identity is required to authenticate with the remote switchover candidate.",
      );
    return buildSwitchoverPeerOptions({
      sourceUserRoot,
      sourceRoot,
      sourceIdentity: resolvedIdentity,
      targetExternalUrl,
      targetLoginUrl,
      targetSpkiSha256,
      targetCaPath,
      targetServername,
      targetLoginCertificate,
      targetLoginServername,
      timeoutMs,
    });
  };

  const ports: CenterSwitchoverPorts = {
    now: hooks?.now,
    authorize: async ({ repoId: targetRepo }) => {
      await requireAuthorizedHostAction({
        kind: "daemon-fleet-center-switch",
        binding: localSystemBinding(sourceRoot),
        actionId: `center-switch:${targetRepo}:${switchoverId}`,
        evaluatedAtCut: "host-local:current",
        repoId: targetRepo,
      });
    },
    inspectPreflight: async ({ repoId: targetRepo, targetNodeId: candidateNode, triggerSource: trigger }) => {
      const centerSnapshot = readCenterFrozenCut({ rootInput: sourceRoot, repoId: targetRepo });
      let tlsReachable: boolean;
      let tlsError: string | undefined;
      let replicaConnected: boolean;
      let replicaCut: SwitchoverReplicaCut | null = null;
      let replicaSyncFailureCode: string | null;
      let availableDiskBytes = 0;

      if (useLegacyLocalTargetPaths && targetRoot && targetUserRoot) {
        const targetEdge = readFleetEdgeConfig(targetUserRoot, targetRepo);
        const targetReplica = resolveTargetReplicaInfo(
          targetRoot,
          targetUserRoot,
          targetRepo,
          candidateNode,
          targetEdge,
        );
        const tlsProbe = hooks?.probeTls
          ? await hooks.probeTls(targetExternalUrl, targetCaPath, targetServername)
          : await defaultProbeTls(targetExternalUrl, targetCaPath, targetServername);
        tlsReachable = tlsProbe.ok;
        tlsError = tlsProbe.error;
        replicaConnected = targetReplica.connected;
        replicaCut = targetReplica.cut;
        replicaSyncFailureCode = targetReplica.syncFailureCode;
        availableDiskBytes = availableDiskBytesAt(targetRoot);
      } else if (!targetExternalUrl || !normalizeSpkiHex(targetSpkiSha256)) {
        tlsReachable = false;
        tlsError = "Target candidate endpoint or SPKI is unconfigured.";
        replicaConnected = false;
        replicaSyncFailureCode = "target_candidate_unconfigured";
        availableDiskBytes = 0;
      } else if (!resolvedIdentity) {
        const tlsProbe = hooks?.probeTls
          ? await hooks.probeTls(targetExternalUrl, targetCaPath, targetServername)
          : await defaultProbeTls(targetExternalUrl, targetCaPath, targetServername);
        tlsReachable = tlsProbe.ok;
        tlsError = tlsProbe.error;
        replicaConnected = false;
        replicaSyncFailureCode = "source_symmetric_identity_missing";
      } else {
        const probe = await probeRemoteSwitchoverStatus(
          buildRemotePeerOptions(cliOperationalPolicy.defaultValue.probe.timeoutMs),
          {
            repoId: targetRepo,
            expectedTargetNodeId: candidateNode,
          },
        );
        if (probe.ok) {
          tlsReachable = true;
          replicaConnected = probe.status.connected;
          replicaCut = probe.status.cut;
          replicaSyncFailureCode = probe.status.syncFailureCode;
          availableDiskBytes = probe.status.availableDiskBytes;
          capturedTargetCertPem = probe.status.peerCertificatePem ?? capturedTargetCertPem;
        } else {
          tlsReachable = false;
          tlsError = probe.message;
          replicaConnected = false;
          replicaSyncFailureCode = probe.code;
          availableDiskBytes = 0;
        }
      }

      // F9: Separate login surface TLS trust from Fleet TLS trust. Only fall back to Fleet CA/cert/servername
      // when targetLoginUrl explicitly shares the exact same origin as targetExternalUrl; independent HTTPS
      // IdPs use their own loginCertificate/loginServername or system CA + targetLoginUrl's own hostname.
      const effectiveLoginCaPem =
        targetLoginCertificate ??
        (loginSameOriginAsFleet
          ? targetCaPath && localRuntimeStateFileSystem.exists(targetCaPath)
            ? localRuntimeStateFileSystem.readText(targetCaPath)
            : (capturedTargetCertPem ?? undefined)
          : undefined);
      const effectiveLoginServername = targetLoginServername ?? (loginSameOriginAsFleet ? targetServername : undefined);
      const authProbe = hooks?.probeAuth
        ? await hooks.probeAuth(
            targetLoginUrl,
            targetLoginCaPath ?? (loginSameOriginAsFleet ? targetCaPath : undefined),
          )
        : await defaultProbeAuth(targetLoginUrl, effectiveLoginCaPem, effectiveLoginServername);
      const replicaLagRevisions =
        replicaCut === null ? null : Math.max(0, centerSnapshot.cut.finalRevision - replicaCut.revision);
      const input: SwitchoverPreflightInput = {
        repoId: targetRepo,
        triggerSource: trigger,
        sourceNodeId: resolvedIdentity?.nodeId ?? "",
        targetNodeId: candidateNode,
        oldEpoch: centerSnapshot.writerEpoch,
        centerHistory: centerSnapshot.cut.history,
        tlsReachable,
        ...(tlsError ? { tlsError } : {}),
        targetExternalUrl,
        targetSpkiSha256,
        replicaConnected,
        replicaHistory: replicaCut?.history ?? null,
        replicaSyncFailureCode,
        replicaLagRevisions,
        maxAllowedLagRevisions,
        availableDiskBytes,
        requiredDiskBytes,
        authReachable: authProbe.ok,
        ...(authProbe.error ? { authError: authProbe.error } : {}),
        targetLoginUrl,
        sourceSymmetricReady: resolvedIdentity !== null,
        ...(resolvedIdentity === null
          ? {
              sourceSymmetricIssue:
                "Prepare source symmetric identity (--source-node-id/--source-credential/--source-view-root or center-node-identity/<repoId>.json).",
            }
          : {}),
      };
      return input;
    },
    freezeAndDrainSource: async ({ repoId: targetRepo, oldEpoch }) => {
      enterCenterMigrating(sourceUserRoot, targetRepo, oldEpoch);
      if (hooks?.freezeAndDrain) {
        await hooks.freezeAndDrain({
          repoId: targetRepo,
          rootDir: sourceRoot,
          userRoot: sourceUserRoot,
          daemonId,
          oldEpoch,
        });
      } else {
        const drained = helpers?.drainLocalDaemonRepoQueue
          ? await helpers.drainLocalDaemonRepoQueue(sourceUserRoot, daemonId, targetRepo)
          : false;
        if (
          !drained &&
          localRuntimeStateFileSystem.exists(path.join(sourceRoot, ".git")) &&
          localRuntimeStateFileSystem.exists(
            path.join(sourceRoot, ".harness", "store", "generations", "3", "ledger.sqlite"),
          )
        ) {
          await publishPendingSqliteGitOutbox({ rootDir: sourceRoot, repoId: targetRepo });
        }
      }
      const frozen = readCenterFrozenCut({
        rootInput: sourceRoot,
        repoId: targetRepo,
        maxLogWindowCommits: retentionWindowCommits,
      });
      capturedLogWindow = frozen.replicationLogWindow;
      return frozen.cut;
    },
    unfreezeSource: async ({ repoId: targetRepo }) => {
      clearCenterMigrating(sourceUserRoot, targetRepo);
    },
    awaitTargetCatchup: async ({ repoId: targetRepo, targetNodeId: candidateNode, frozenCut, timeoutMs }) => {
      if (hooks?.awaitTargetCatchup) {
        return await hooks.awaitTargetCatchup({
          repoId: targetRepo,
          targetNodeId: candidateNode,
          frozenCut,
          timeoutMs,
        });
      }
      if (useLegacyLocalTargetPaths && targetRoot && targetUserRoot) {
        return await waitTargetReplicaCut({
          targetRoot,
          targetUserRoot,
          repoId: targetRepo,
          targetNodeId: candidateNode,
          frozenCut,
          timeoutMs,
        });
      }
      const status = await queryRemoteSwitchoverStatusClient(
        buildRemotePeerOptions(Math.max(15_000, timeoutMs + 5_000)),
        {
          repoId: targetRepo,
          expectedTargetNodeId: candidateNode,
          waitForCut: {
            finalRevision: frozenCut.finalRevision,
            tipHash: frozenCut.tipHash,
            history: frozenCut.history,
            sequence: frozenCut.sequence,
            timeoutMs,
          },
        },
      );
      capturedTargetCertPem = status.peerCertificatePem ?? capturedTargetCertPem;
      if (status.cut !== null) return status.cut;
      throw switchoverCommandError(
        "rpo_zero_catchup_timeout",
        `Target replica ${candidateNode} is unavailable for ${targetRepo} at RPO=0 barrier.`,
      );
    },
    persistCededFence: async (fenceInput) => {
      const fencedAt = (hooks?.now ?? (() => new Date().toISOString()))();
      let cededProof: CenterSwitchoverCededProofV1 | undefined;
      if (!useLegacyLocalTargetPaths) {
        const sourceTlsMaterial = resolveSourceCenterTlsMaterial({
          sourceUserRoot,
          daemonId,
          explicitKeyPath: explicitSourceKeyPath,
          explicitCertPath: explicitSourceCertPath,
        });
        if (!sourceTlsMaterial) {
          throw switchoverCommandError(
            "source_center_tls_key_missing",
            "Source center Fleet TLS key/certificate is required to sign the switchover ceded proof before Phase 1 fencing.",
          );
        }
        cededProof = signSwitchoverCededProof({
          repoId: fenceInput.repoId,
          switchoverId: fenceInput.switchoverId,
          sourceNodeId: fenceInput.sourceNodeId,
          targetNodeId: fenceInput.targetNodeId,
          oldEpoch: fenceInput.oldEpoch,
          cededEpoch: fenceInput.cededEpoch,
          finalRevision: fenceInput.frozenCut.finalRevision,
          tipHash: fenceInput.frozenCut.tipHash,
          fencedAt,
          sourceKeyPem: sourceTlsMaterial.keyPem,
          sourceCertificatePem: sourceTlsMaterial.certPem,
        });
        // F11: Validate complete replication slot batching & activation transfer payload BEFORE persisting Phase 1 fence!
        capturedReplicationSlots = readSourceReplicationSlotRows(sourceStateRoot, fenceInput.repoId);
        const transferCheck = measureSwitchoverRemoteActivationTransfer({
          repoId: fenceInput.repoId,
          switchoverId: fenceInput.switchoverId,
          expectedTargetNodeId: fenceInput.targetNodeId,
          expectedOldEpoch: fenceInput.oldEpoch,
          newEpoch: fenceInput.cededEpoch,
          frozenCut: fenceInput.frozenCut,
          sourceReplicationLogWindow: capturedLogWindow,
          retentionWindowCommits,
          replicationSlots: capturedReplicationSlots,
          cededProof,
          ...(targetExternalUrl ? { targetExternalUrl } : {}),
          ...(targetLoginUrl ? { targetLoginUrl } : {}),
        });
        if (!transferCheck.ok) {
          throw switchoverCommandError(
            "switchover_payload_untransferable",
            `Switchover activation payload cannot be transferred safely before ceding authority: ${transferCheck.detail}`,
          );
        }
        capturedCededProof = cededProof;
      }
      cedeCenterForSwitchover({
        userRoot: sourceUserRoot,
        stateRoot: sourceStateRoot,
        repoId: fenceInput.repoId,
        switchoverId: fenceInput.switchoverId,
        oldEpoch: fenceInput.oldEpoch,
        cededEpoch: fenceInput.cededEpoch,
        sourceNodeId: fenceInput.sourceNodeId,
        targetNodeId: fenceInput.targetNodeId,
        frozenCut: fenceInput.frozenCut,
        newExternalUrl: fenceInput.targetExternalUrl,
        newLoginUrl: fenceInput.targetLoginUrl,
        spkiSha256: fenceInput.targetSpkiSha256,
        ...(cededProof ? { cededProof } : {}),
        ...(targetCaPath ? { targetCaPath } : {}),
        ...(targetServername ? { targetServername } : {}),
        ...(useLegacyLocalTargetPaths && targetRoot ? { targetRoot } : {}),
        ...(useLegacyLocalTargetPaths && targetUserRoot ? { targetUserRoot } : {}),
        ...(useLegacyLocalTargetPaths && targetStateRoot ? { targetStateRoot } : {}),
        now: () => fencedAt,
      });
      await hooks?.afterCededFencePersisted?.({
        repoId: fenceInput.repoId,
        switchoverId: fenceInput.switchoverId,
        oldEpoch: fenceInput.oldEpoch,
        cededEpoch: fenceInput.cededEpoch,
      });
    },
    activateTargetCenter: async (activationInput) => {
      await hooks?.beforeTargetActivation?.({
        repoId: activationInput.repoId,
        switchoverId: activationInput.switchoverId,
        expectedOldEpoch: activationInput.expectedOldEpoch,
        newEpoch: activationInput.newEpoch,
        targetNodeId: activationInput.targetNodeId,
      });
      if (!useLegacyLocalTargetPaths) {
        if (!capturedCededProof) {
          throw switchoverCommandError(
            "switchover_ceded_proof_missing",
            "Missing signed Phase 1 ceded proof for remote switchover activation.",
          );
        }
        const remote = await activateRemoteSwitchoverClient(buildRemotePeerOptions(60_000), {
          repoId: activationInput.repoId,
          switchoverId: activationInput.switchoverId,
          expectedTargetNodeId: activationInput.targetNodeId,
          expectedOldEpoch: activationInput.expectedOldEpoch,
          newEpoch: activationInput.newEpoch,
          frozenCut: activationInput.frozenCut,
          sourceReplicationLogWindow: capturedLogWindow,
          retentionWindowCommits,
          ...(capturedReplicationSlots.length > 0 ? { replicationSlots: capturedReplicationSlots } : {}),
          cededProof: capturedCededProof,
          ...(targetExternalUrl ? { targetExternalUrl } : {}),
          ...(targetLoginUrl ? { targetLoginUrl } : {}),
        });
        capturedTargetCertPem = remote.peerCertificatePem ?? capturedTargetCertPem;
        await hooks?.afterTargetActivated?.({
          repoId: activationInput.repoId,
          switchoverId: activationInput.switchoverId,
          newEpoch: remote.activation.newEpoch,
          targetRoot: "",
          targetUserRoot: "",
        });
        return remote.activation;
      }
      if (!targetRoot || !targetUserRoot || !targetStateRoot)
        throw switchoverCommandError(
          "target_candidate_unconfigured",
          `No distinct target host configuration is registered for candidate ${activationInput.targetNodeId} on ${activationInput.repoId}.`,
        );
      const targetEdge = readFleetEdgeConfig(targetUserRoot, activationInput.repoId);
      const targetReplica = resolveTargetReplicaInfo(
        targetRoot,
        targetUserRoot,
        activationInput.repoId,
        activationInput.targetNodeId,
        targetEdge,
      );
      if (!targetReplica.generation)
        throw switchoverCommandError(
          "replica_unavailable",
          `Target replica generation is unavailable for ${activationInput.repoId} on ${activationInput.targetNodeId}.`,
        );
      if (targetEdge) {
        prepareCenterSymmetricIdentity(targetUserRoot, {
          repoId: activationInput.repoId,
          nodeId: targetEdge.nodeId,
          credential: targetEdge.credential,
          viewRoot: path.isAbsolute(targetEdge.viewRoot)
            ? targetEdge.viewRoot
            : path.resolve(targetRoot, targetEdge.viewRoot),
          quotaBytes: targetEdge.quotaBytes,
        });
      }
      const sourceSlotsPath = path.join(sourceStateRoot, "replication-slots.sqlite");
      const promoted = await promoteReplicaForSwitchover({
        rootInput: targetRoot,
        userRoot: targetUserRoot,
        stateRoot: targetStateRoot,
        repoId: activationInput.repoId,
        switchoverId: activationInput.switchoverId,
        replicaDatabasePath: targetReplica.generation.ledgerPath,
        replicaGeneration: targetReplica.generation.metadata.ledgerGeneration,
        replicaPosition: targetReplica.generation.metadata.position,
        expectedOldEpoch: activationInput.expectedOldEpoch,
        newEpoch: activationInput.newEpoch,
        expectedFrozenCut: activationInput.frozenCut,
        sourceReplicationLogWindow: capturedLogWindow,
        retentionWindowCommits,
        ...(localRuntimeStateFileSystem.exists(sourceSlotsPath) ? { replicationSlotsSourcePath: sourceSlotsPath } : {}),
        now: hooks?.now,
      });
      writeDaemonRegistryRepo({
        canonicalRoot: targetRoot,
        repoId: activationInput.repoId,
        mode: "local",
        userRoot: targetUserRoot,
        createConvenienceLinks: false,
      });
      removeFleetEdgeConfig(targetUserRoot, activationInput.repoId);
      helpers?.rebindCenterRelocationRouting?.({
        userRoot: targetUserRoot,
        daemonId,
        stateRoot: targetStateRoot,
        repoId: activationInput.repoId,
        writerEpoch: promoted.newEpoch,
        ...(targetExternalUrl ? { externalUrl: targetExternalUrl } : {}),
        ...(targetLoginUrl ? { loginUrl: targetLoginUrl } : {}),
      });
      await hooks?.afterTargetActivated?.({
        repoId: activationInput.repoId,
        switchoverId: activationInput.switchoverId,
        newEpoch: promoted.newEpoch,
        targetRoot,
        targetUserRoot,
      });
      return promoted;
    },
    demoteSourceToEdge: async (demoteInput) => {
      if (!resolvedIdentity) throw new Error("Symmetric source identity disappeared during switchover demotion.");
      if (hasExplicitSourceIdentityFlags || readCenterSymmetricIdentity(sourceUserRoot, demoteInput.repoId) === null) {
        prepareCenterSymmetricIdentity(sourceUserRoot, {
          repoId: demoteInput.repoId,
          nodeId: resolvedIdentity.nodeId,
          credential: resolvedIdentity.credential,
          viewRoot: resolvedIdentity.viewRoot,
          quotaBytes: resolvedIdentity.quotaBytes,
        });
      }
      const demotedAt = (hooks?.now ?? (() => new Date().toISOString()))();
      markCenterSwitchoverFenceDemoted(sourceUserRoot, demoteInput.repoId, demoteInput.switchoverId, demotedAt);
      clearCenterMigrating(sourceUserRoot, demoteInput.repoId);
      writeDaemonRegistryRepo({
        canonicalRoot: sourceRoot,
        repoId: demoteInput.repoId,
        mode: "remote-edge",
        userRoot: sourceUserRoot,
        createConvenienceLinks: false,
      });
      const parsedTarget = new URL(demoteInput.targetExternalUrl),
        normalizedSpki = normalizeSpkiHex(demoteInput.targetSpkiSha256),
        defaultEdgeCaPath = fleetEdgeCaPath(sourceUserRoot, demoteInput.repoId),
        hasLocalCaFile = targetCaPath !== undefined && localRuntimeStateFileSystem.exists(targetCaPath);
      let caPath = hasLocalCaFile ? targetCaPath : defaultEdgeCaPath;
      let spkiPinOnly = false;
      if (!hasLocalCaFile && capturedTargetCertPem && normalizedSpki) {
        writeFileDurably(defaultEdgeCaPath, capturedTargetCertPem, 0o600);
        caPath = defaultEdgeCaPath;
        spkiPinOnly = true;
      }
      let priorOidcSelection = oidcCenterSelections(sourceUserRoot).read(sourceRoot);
      if (!priorOidcSelection) {
        const refreshed = await tryRefreshPriorOidcSelection(sourceUserRoot, sourceRoot);
        if (refreshed.ok) priorOidcSelection = refreshed.selection;
      }
      const demotedLoginCertificate =
        targetLoginCertificate ??
        (priorOidcSelection &&
        demoteInput.targetLoginUrl &&
        sameHttpOrigin(priorOidcSelection.authority.url, demoteInput.targetLoginUrl)
          ? priorOidcSelection.authority.certificate
          : undefined) ??
        (sameHttpOrigin(demoteInput.targetLoginUrl, demoteInput.targetExternalUrl) &&
        spkiPinOnly &&
        capturedTargetCertPem
          ? capturedTargetCertPem
          : undefined);
      const demotedLoginServername =
        targetLoginServername ??
        (priorOidcSelection &&
        demoteInput.targetLoginUrl &&
        sameHttpOrigin(priorOidcSelection.authority.url, demoteInput.targetLoginUrl)
          ? priorOidcSelection.authority.servername
          : undefined);
      localRuntimeStateFileSystem.mkdirp(resolvedIdentity.viewRoot);
      writeFleetEdgeConfig(sourceUserRoot, demoteInput.repoId, {
        repoId: demoteInput.repoId,
        host: parsedTarget.hostname.replace(/^\[|\]$/gu, ""),
        port: parsedTarget.port ? Number(parsedTarget.port) : 443,
        caPath,
        ...(targetServername ? { servername: targetServername } : {}),
        ...(normalizedSpki ? { spkiSha256: normalizedSpki } : {}),
        ...(spkiPinOnly ? { spkiPinOnly: true } : {}),
        ...(demoteInput.targetLoginUrl ? { loginUrl: demoteInput.targetLoginUrl } : {}),
        ...(priorOidcSelection?.authority.realm ? { loginRealm: priorOidcSelection.authority.realm } : {}),
        ...(demotedLoginCertificate ? { loginCertificate: demotedLoginCertificate } : {}),
        ...(demotedLoginServername ? { loginServername: demotedLoginServername } : {}),
        nodeId: resolvedIdentity.nodeId,
        credential: resolvedIdentity.credential,
        writerEpoch: demoteInput.newEpoch,
        viewRoot: resolvedIdentity.viewRoot,
        quotaBytes: resolvedIdentity.quotaBytes,
      });
      if (
        priorOidcSelection &&
        demoteInput.targetLoginUrl &&
        priorOidcSelection.authority.url.replace(/\/$/u, "") === demoteInput.targetLoginUrl.replace(/\/$/u, "")
      ) {
        oidcCenterSelections(sourceUserRoot).carryOver(sourceRoot, priorOidcSelection);
      }
      if (helpers?.reloadLocalDaemonRepoMode) {
        await helpers.reloadLocalDaemonRepoMode({
          userRoot: sourceUserRoot,
          daemonId,
          repoId: demoteInput.repoId,
          rootDir: sourceRoot,
          mode: "remote-edge",
        });
      }
      await hooks?.afterDemotedToEdge?.({
        repoId: demoteInput.repoId,
        switchoverId: demoteInput.switchoverId,
        newEpoch: demoteInput.newEpoch,
        sourceRoot,
        sourceUserRoot,
        sourceNodeId: resolvedIdentity.nodeId,
        viewRoot: resolvedIdentity.viewRoot,
      });
      return {
        switchoverId: demoteInput.switchoverId,
        repoId: demoteInput.repoId,
        sourceNodeId: resolvedIdentity.nodeId,
        targetNodeId: demoteInput.targetNodeId,
        newEpoch: demoteInput.newEpoch,
        mode: "remote-edge",
        viewRoot: resolvedIdentity.viewRoot,
        demotedAt,
      };
    },
  };

  const result = await runCenterSwitchover(
    {
      switchoverId,
      repoId,
      targetNodeId,
      triggerSource,
      dryRun,
      catchupTimeoutMs,
    },
    ports,
  );
  if (!result.ok) {
    return {
      receipt: {
        schema: "command-receipt/v2",
        ok: false,
        command: "fleet-center-switch",
        outcome: "op_rejected",
        code: result.code,
        phase: result.phase,
        ...(result.preflight ? { preflight: result.preflight } : {}),
        ...(result.barrierIssues ? { barrierIssues: result.barrierIssues } : {}),
        ...(result.state ? { state: result.state } : {}),
        ...(result.fencedCeded ? { fencedCeded: true } : {}),
        error: { code: result.code, hint: result.detail },
      },
      exitCode: result.fencedCeded ? 1 : 2,
    };
  }
  return {
    receipt: {
      schema: "command-receipt/v2",
      ok: true,
      command: "fleet-center-switch",
      outcome: "applied",
      dryRun: result.dryRun,
      phase: result.phase,
      preflight: result.preflight,
      state: result.state,
      ...(result.dryRun
        ? {
            summary: `fleet-center-switch (dry-run): candidate ${targetNodeId} passed all preflight checks for ${repoId}`,
          }
        : {
            activation: result.activation,
            demotion: result.demotion,
            summary: `fleet-center-switch: switched ${repoId} to ${targetNodeId} at epoch ${String(result.activation.newEpoch)} (history preserved, old center demoted to remote-edge)`,
          }),
    },
    exitCode: 0,
  };
}

async function runRollbackCommand(
  argv: readonly string[],
  defaultUserRoot: string,
  hooks?: FleetCenterSwitchoverHooks,
): Promise<FleetCenterRelocationOutcome> {
  const missing = missingFlags(argv, ["--root", "--repo", "--switchover-id", "--reason"]);
  if (missing.length > 0)
    return failureOutcome(
      "fleet-center-switch",
      "missing_field",
      `Add ${missing.join(" ")} to run audited switchover rollback.`,
    );
  const sourceRoot = path.resolve(flagValue(argv, "--root")!),
    repoId = flagValue(argv, "--repo")!,
    switchoverId = flagValue(argv, "--switchover-id")!,
    reason = flagValue(argv, "--reason")!,
    sourceUserRoot = path.resolve(flagValue(argv, "--user-root") ?? defaultUserRoot),
    sourceStateRoot = path.resolve(flagValue(argv, "--state-root") ?? path.join(sourceUserRoot, "fleet")),
    explicitTargetUserRoot = flagValue(argv, "--target-user-root")
      ? path.resolve(flagValue(argv, "--target-user-root")!)
      : undefined,
    explicitTargetStateRoot = flagValue(argv, "--target-state-root")
      ? path.resolve(flagValue(argv, "--target-state-root")!)
      : explicitTargetUserRoot
        ? path.join(explicitTargetUserRoot, "fleet")
        : undefined,
    explicitTargetRoot = flagValue(argv, "--target-root") ? path.resolve(flagValue(argv, "--target-root")!) : undefined;

  const ports: CenterSwitchoverRollbackPorts = {
    now: hooks?.now,
    authorize: async ({ repoId: targetRepo }) => {
      await requireAuthorizedHostAction({
        kind: "daemon-fleet-center-switch",
        binding: localSystemBinding(sourceRoot),
        actionId: `center-switch-rollback:${targetRepo}:${switchoverId}`,
        evaluatedAtCut: "host-local:current",
        repoId: targetRepo,
      });
    },
    readCededFence: async (targetRepo): Promise<SwitchoverCededFenceRecord | null> =>
      readCenterSwitchoverFence(sourceUserRoot, targetRepo),
    invalidateTargetAttempt: async (input) => {
      if (hooks?.invalidateTargetAttempt) return await hooks.invalidateTargetAttempt(input);
      // F3: ALWAYS bind rollback invalidation to the immutable Phase 1 fence record, NEVER re-reading mutable candidate records.
      const fence = readCenterSwitchoverFence(sourceUserRoot, input.repoId);
      if (fence === null || fence.switchoverId !== input.switchoverId || fence.targetNodeId !== input.targetNodeId) {
        return { targetNeverActivated: false, targetInvalidated: false };
      }
      if (fence.targetStateRoot !== undefined) {
        // Legacy local-path CLI mode: caller must supply the exact matching target state root bound in Phase 1.
        if (!explicitTargetStateRoot || path.resolve(explicitTargetStateRoot) !== path.resolve(fence.targetStateRoot)) {
          return { targetNeverActivated: false, targetInvalidated: false };
        }
        if (
          explicitTargetRoot !== undefined &&
          fence.targetRoot !== undefined &&
          path.resolve(explicitTargetRoot) !== path.resolve(fence.targetRoot)
        ) {
          return { targetNeverActivated: false, targetInvalidated: false };
        }
        if (
          fence.targetUserRoot &&
          path.resolve(fence.targetUserRoot) === sourceUserRoot &&
          path.resolve(fence.targetStateRoot) === sourceStateRoot
        ) {
          return { targetNeverActivated: false, targetInvalidated: false };
        }
        return invalidateTargetSwitchoverAttempt({
          targetStateRoot: fence.targetStateRoot,
          ...(fence.targetRoot ? { targetRootInput: fence.targetRoot } : {}),
          expectedTargetNodeId: fence.targetNodeId,
          repoId: input.repoId,
          switchoverId: input.switchoverId,
          cededEpoch: input.cededEpoch,
          now: hooks?.now,
        });
      }
      // Cross-host remote mode: forbid redirecting rollback to a local directory; authenticate against the immutable fence TLS authority.
      if (
        explicitTargetStateRoot !== undefined ||
        explicitTargetRoot !== undefined ||
        explicitTargetUserRoot !== undefined
      ) {
        return { targetNeverActivated: false, targetInvalidated: false };
      }
      const sourceIdentity = readCenterSymmetricIdentity(sourceUserRoot, input.repoId);
      if (!sourceIdentity || !fence.cededProof) return { targetNeverActivated: false, targetInvalidated: false };
      try {
        const peerOptions = buildSwitchoverPeerOptions({
          sourceUserRoot,
          sourceRoot,
          sourceIdentity,
          targetExternalUrl: fence.newExternalUrl,
          targetLoginUrl: fence.newLoginUrl,
          targetSpkiSha256: fence.spkiSha256,
          targetCaPath: fence.targetCaPath,
          targetServername: fence.targetServername,
          timeoutMs: cliOperationalPolicy.defaultValue.probe.timeoutMs,
        });
        return await invalidateRemoteSwitchoverClient(peerOptions, {
          repoId: input.repoId,
          switchoverId: input.switchoverId,
          expectedTargetNodeId: fence.targetNodeId,
          cededEpoch: input.cededEpoch,
          cededProof: fence.cededProof,
        });
      } catch {
        return { targetNeverActivated: false, targetInvalidated: false };
      }
    },
    commitAuditedRollback: async (input) =>
      rollbackCenterSwitchover({
        rootInput: sourceRoot,
        userRoot: sourceUserRoot,
        stateRoot: sourceStateRoot,
        repoId: input.repoId,
        switchoverId: input.switchoverId,
        targetNeverActivated: true,
        targetInvalidated: true,
        reason: input.reason,
        now: hooks?.now,
      }),
  };

  const result = await abortCenterSwitchoverRollback({ repoId, switchoverId, reason }, ports);
  if (!result.ok) return failureOutcome("fleet-center-switch", result.code, result.detail);
  return {
    receipt: {
      schema: "command-receipt/v2",
      ok: true,
      command: "fleet-center-switch",
      outcome: "applied",
      phase: result.phase,
      rollback: result.rollback,
      summary: `fleet-center-switch (rollback): restored ${repoId} at epoch ${String(result.rollback.rollbackEpoch)} (oldEpoch + 2) after invalidating ${switchoverId}`,
    },
    exitCode: 0,
  };
}

function buildSwitchoverPeerOptions(input: {
  readonly sourceUserRoot: string;
  readonly sourceRoot: string;
  readonly sourceIdentity: CenterSymmetricNodeIdentityV1;
  readonly targetExternalUrl: string;
  readonly targetLoginUrl: string;
  readonly targetSpkiSha256: string;
  readonly targetCaPath?: string;
  readonly targetServername?: string;
  readonly targetLoginCertificate?: string;
  readonly targetLoginServername?: string;
  readonly timeoutMs?: number;
}): Omit<FleetPeerOptions, "repoId"> {
  if (!URL.canParse(input.targetExternalUrl))
    throw switchoverCommandError("target_tls_unreachable", `Invalid target external URL: ${input.targetExternalUrl}`);
  const parsed = new URL(input.targetExternalUrl),
    hostname = parsed.hostname.replace(/^\[|\]$/gu, ""),
    port = parsed.port ? Number(parsed.port) : 443,
    spkiSha256 = normalizeSpkiHex(input.targetSpkiSha256),
    hasLocalCa = input.targetCaPath !== undefined && localRuntimeStateFileSystem.exists(input.targetCaPath),
    caPem = hasLocalCa ? readFileSync(input.targetCaPath!, "utf8") : undefined;
  if (!spkiSha256)
    throw switchoverCommandError("target_tls_unreachable", "Target SPKI SHA-256 fingerprint is missing or invalid.");
  const servername = input.targetServername ?? hostname;
  return {
    hostname,
    port,
    ca: caPem ?? "",
    servername,
    spkiSha256,
    ...(!hasLocalCa ? { spkiPinOnly: true as const } : {}),
    nodeId: input.sourceIdentity.nodeId,
    credential: input.sourceIdentity.credential,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    readAccessToken: () =>
      resolveSwitchoverAccessToken({
        sourceUserRoot: input.sourceUserRoot,
        sourceRoot: input.sourceRoot,
        sourceIdentity: input.sourceIdentity,
        targetExternalUrl: input.targetExternalUrl,
        targetLoginUrl: input.targetLoginUrl,
        fleetCaPem: caPem,
        fleetServername: servername,
        loginCaPem: input.targetLoginCertificate,
        loginServername: input.targetLoginServername,
      }),
  };
}

async function probeRemoteSwitchoverStatus(
  peerOptions: Omit<FleetPeerOptions, "repoId">,
  payload: { readonly repoId: string; readonly expectedTargetNodeId: string },
): Promise<
  | { readonly ok: true; readonly status: Awaited<ReturnType<typeof queryRemoteSwitchoverStatusClient>> }
  | { readonly ok: false; readonly message: string; readonly code: string }
> {
  try {
    return { ok: true, status: await queryRemoteSwitchoverStatusClient(peerOptions, payload) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : "target_tls_unreachable";
    return { ok: false, message, code };
  }
}

async function tryRefreshPriorOidcSelection(
  sourceUserRoot: string,
  sourceRoot: string,
): Promise<
  | { readonly ok: true; readonly selection: ReturnType<ReturnType<typeof oidcCenterSelections>["read"]> }
  | { readonly ok: false; readonly reason: string }
> {
  try {
    await createIdentitySession(sourceUserRoot).status(sourceRoot);
    return { ok: true, selection: oidcCenterSelections(sourceUserRoot).read(sourceRoot) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason };
  }
}

async function tryResolveLocalIdentityToken(
  sourceUserRoot: string,
  sourceRoot: string,
): Promise<{ readonly ok: true; readonly token: string } | { readonly ok: false; readonly reason: string }> {
  try {
    const bound = await createIdentitySession(sourceUserRoot).bind({ transportKind: "unix-socket" }, sourceRoot);
    const token = await resolveBoundAccessToken(bound);
    return token ? { ok: true, token } : { ok: false, reason: "no_active_session_token" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason };
  }
}

async function tryRequestMachineReplicaToken(
  input: Parameters<typeof requestFleetReplicaToken>[0],
): Promise<{ readonly ok: true; readonly token: string } | { readonly ok: false; readonly reason: string }> {
  try {
    return { ok: true, token: await requestFleetReplicaToken(input) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason };
  }
}

async function resolveSwitchoverAccessToken(input: {
  readonly sourceUserRoot: string;
  readonly sourceRoot: string;
  readonly sourceIdentity: CenterSymmetricNodeIdentityV1;
  readonly targetExternalUrl: string;
  readonly targetLoginUrl: string;
  readonly fleetCaPem?: string;
  readonly fleetServername?: string;
  readonly loginCaPem?: string;
  readonly loginServername?: string;
}): Promise<string | undefined> {
  // 1. Prefer an active, unexpired local identity session through the canonical IdentitySessionPort.
  const localToken = await tryResolveLocalIdentityToken(input.sourceUserRoot, input.sourceRoot);
  if (localToken.ok) return localToken.token;
  // 2. Fall back to machine replica token when a persisted HTTPS authority is available (using login TLS trust, never Fleet TLS trust for independent IdPs).
  const discoveredAuthority = oidcCenterSelections(input.sourceUserRoot).read(input.sourceRoot)?.authority;
  if (
    discoveredAuthority &&
    URL.canParse(discoveredAuthority.url) &&
    new URL(discoveredAuthority.url).protocol === "https:"
  ) {
    const matchesTargetLogin = sameHttpOrigin(discoveredAuthority.url, input.targetLoginUrl);
    const matchesFleetOrigin = sameHttpOrigin(discoveredAuthority.url, input.targetExternalUrl);
    const ca =
      discoveredAuthority.certificate ??
      (matchesTargetLogin ? input.loginCaPem : undefined) ??
      (matchesFleetOrigin ? input.fleetCaPem : undefined) ??
      systemCaCertificates();
    const servername =
      discoveredAuthority.servername ??
      (matchesTargetLogin ? input.loginServername : undefined) ??
      (matchesFleetOrigin ? input.fleetServername : undefined);
    const machineToken = await tryRequestMachineReplicaToken({
      ...discoveredAuthority,
      nodeId: input.sourceIdentity.nodeId,
      credential: input.sourceIdentity.credential,
      ca,
      ...(servername ? { servername } : {}),
    });
    if (machineToken.ok) return machineToken.token;
  }
  return undefined;
}

function resolveSourceCenterTlsMaterial(input: {
  readonly sourceUserRoot: string;
  readonly daemonId: string;
  readonly explicitKeyPath?: string;
  readonly explicitCertPath?: string;
}): { readonly keyPem: string; readonly certPem: string } | null {
  const savedConfig = readFleetCenterConfig(input.sourceUserRoot, input.daemonId);
  const keyPath = input.explicitKeyPath ?? savedConfig?.keyPath;
  const certPath = input.explicitCertPath ?? savedConfig?.certPath;
  if (!keyPath || !certPath) return null;
  if (!localRuntimeStateFileSystem.exists(keyPath) || !localRuntimeStateFileSystem.exists(certPath)) return null;
  return {
    keyPem: readFileSync(keyPath, "utf8"),
    certPem: readFileSync(certPath, "utf8"),
  };
}

function sameHttpOrigin(left: string, right: string): boolean {
  if (!left || !right || !URL.canParse(left) || !URL.canParse(right)) return false;
  return new URL(left).origin === new URL(right).origin;
}

function readSourceReplicationSlotRows(
  sourceStateRoot: string,
  repoId: string,
): readonly SwitchoverReplicationSlotRow[] {
  const slotsPath = path.join(path.resolve(sourceStateRoot), "replication-slots.sqlite");
  if (!localRuntimeStateFileSystem.exists(slotsPath)) return [];
  const slots = openReplicationSlots(slotsPath);
  try {
    return slots
      .list()
      .filter((row) => row.repoId === repoId)
      .map((row) => ({ repoId: row.repoId, nodeId: row.nodeId, history: row.history, ack: row.ack }));
  } finally {
    slots.close();
  }
}

function resolveSourceSymmetricIdentity(
  argv: readonly string[],
  sourceUserRoot: string,
  repoId: string,
): CenterSymmetricNodeIdentityV1 | null {
  const existing = readCenterSymmetricIdentity(sourceUserRoot, repoId),
    nodeId = flagValue(argv, "--source-node-id") ?? existing?.nodeId,
    credential = flagValue(argv, "--source-credential") ?? existing?.credential,
    viewRoot = flagValue(argv, "--source-view-root") ?? existing?.viewRoot,
    rawBytes = flagValue(argv, "--source-quota-bytes"),
    storageBytes = rawBytes ? parseNonnegativeInt(rawBytes, 0) : (existing?.quotaBytes ?? 64 * 1024 * 1024);
  if (
    !nodeId ||
    !credential ||
    credential.trim().length === 0 ||
    !viewRoot ||
    !isPositiveSafeByteCount(storageBytes) ||
    !/^[a-z][a-z0-9-]{0,62}$/u.test(repoId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(nodeId)
  )
    return null;
  return {
    schema: "fleet-center-node-identity/v1",
    repoId,
    nodeId,
    credential,
    viewRoot: path.resolve(viewRoot),
    quotaBytes: storageBytes,
    updatedAt: existing?.updatedAt ?? "",
  };
}

function resolveTargetReplicaInfo(
  targetRoot: string,
  targetUserRoot: string,
  repoId: string,
  targetNodeId: string,
  edge: ReturnType<typeof readFleetEdgeConfig>,
): {
  readonly generation: ReturnType<typeof readReplicaGeneration>;
  readonly cut: SwitchoverReplicaCut | null;
  readonly connected: boolean;
  readonly syncFailureCode: string | null;
} {
  const viewRoot = edge
      ? path.isAbsolute(edge.viewRoot)
        ? edge.viewRoot
        : path.resolve(targetRoot, edge.viewRoot)
      : path.join(targetUserRoot, "fleet", "views"),
    viewDir = path.join(viewRoot, "repos", repoId, "views", targetNodeId),
    generation = readReplicaGeneration(viewDir);
  if (!generation) return { generation: null, cut: null, connected: false, syncFailureCode: "replica_unavailable" };
  const health = readReplicaHealth(viewDir);
  const ledger = openSqliteEventStore({
    databasePath: generation.ledgerPath,
    repoId,
    generation: generation.metadata.ledgerGeneration,
    readOnly: true,
  });
  try {
    const position = ledger.replicationPosition(),
      revision = ledger.revision(),
      tipHash = canonicalLedgerCut(repoId, ledger.eventIdentityAtRevision(revision)).headDigest;
    return {
      generation,
      cut: { repoId, revision, tipHash, history: position.history, sequence: position.sequence },
      connected: health.syncFailure === null,
      syncFailureCode: health.syncFailure?.code ?? null,
    };
  } finally {
    ledger.close();
  }
}

function resolveTargetViewRoot(
  targetRoot: string,
  targetUserRoot: string,
  edge: ReturnType<typeof readFleetEdgeConfig>,
): string {
  return edge
    ? path.isAbsolute(edge.viewRoot)
      ? edge.viewRoot
      : path.resolve(targetRoot, edge.viewRoot)
    : path.join(targetUserRoot, "fleet", "views");
}

function isReplicaCutCaughtUp(
  cut: SwitchoverReplicaCut | null,
  frozenCut: SwitchoverFrozenCut,
): cut is SwitchoverReplicaCut {
  return (
    cut !== null &&
    cut.revision === frozenCut.finalRevision &&
    cut.sequence === frozenCut.sequence &&
    cut.history === frozenCut.history &&
    cut.tipHash === frozenCut.tipHash
  );
}

async function waitTargetReplicaCut(input: {
  readonly targetRoot: string;
  readonly targetUserRoot: string;
  readonly repoId: string;
  readonly targetNodeId: string;
  readonly frozenCut: SwitchoverFrozenCut;
  readonly timeoutMs: number;
}): Promise<SwitchoverReplicaCut> {
  const edge = readFleetEdgeConfig(input.targetUserRoot, input.repoId),
    initial = resolveTargetReplicaInfo(input.targetRoot, input.targetUserRoot, input.repoId, input.targetNodeId, edge);
  if (isReplicaCutCaughtUp(initial.cut, input.frozenCut)) return initial.cut;
  const waitWindowMs = input.timeoutMs;
  if (waitWindowMs > 0) {
    const viewRoot = resolveTargetViewRoot(input.targetRoot, input.targetUserRoot, edge);
    await waitForFleetReplicaRevision(
      { viewRoot, repoId: input.repoId, nodeId: input.targetNodeId },
      input.frozenCut.finalRevision,
      AbortSignal.timeout(waitWindowMs),
    ).then(
      () => true,
      () => false,
    );
  }
  const latestEdge = readFleetEdgeConfig(input.targetUserRoot, input.repoId),
    latest = resolveTargetReplicaInfo(
      input.targetRoot,
      input.targetUserRoot,
      input.repoId,
      input.targetNodeId,
      latestEdge,
    );
  if (latest.cut !== null) return latest.cut;
  throw switchoverCommandError(
    "rpo_zero_catchup_timeout",
    `Target replica ${input.targetNodeId} is unavailable for ${input.repoId} at RPO=0 barrier.`,
  );
}

function availableDiskBytesAt(targetPath: string): number {
  let probe = path.resolve(targetPath);
  while (!localRuntimeStateFileSystem.exists(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return 0;
    probe = parent;
  }
  const stats = statfsSync(probe);
  return Number(stats.bavail) * Number(stats.bsize);
}

async function defaultProbeTls(
  externalUrl: string,
  caPath?: string,
  servername?: string,
): Promise<{ readonly ok: boolean; readonly error?: string }> {
  if (!externalUrl) return { ok: false, error: "Target --target-external-url is required." };
  if (!URL.canParse(externalUrl)) return { ok: false, error: `Invalid target external URL: ${externalUrl}` };
  const parsed = new URL(externalUrl),
    host = parsed.hostname.replace(/^\[|\]$/gu, ""),
    port = parsed.port ? Number(parsed.port) : 443,
    ca =
      caPath && localRuntimeStateFileSystem.exists(caPath) ? localRuntimeStateFileSystem.readText(caPath) : undefined;
  return await new Promise((resolve) => {
    const socket = tls.connect({
      host,
      port,
      ...(ca ? { ca } : {}),
      servername: servername ?? host,
      timeout: cliOperationalPolicy.defaultValue.probe.timeoutMs,
    });
    const finish = (result: { readonly ok: boolean; readonly error?: string }) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("secureConnect", () => finish({ ok: true }));
    socket.once("timeout", () => finish({ ok: false, error: `TLS probe timed out for ${externalUrl}.` }));
    socket.once("error", (error) => finish({ ok: false, error: error.message }));
  });
}

async function defaultProbeAuth(
  loginUrl: string,
  loginCaPem?: string,
  loginServername?: string,
): Promise<{ readonly ok: boolean; readonly error?: string }> {
  if (!loginUrl) return { ok: false, error: "Target --target-login-url is required." };
  if (!URL.canParse(loginUrl)) return { ok: false, error: `Invalid target login URL: ${loginUrl}` };
  const parsed = new URL(loginUrl);
  return await new Promise((resolve) => {
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(
      parsed,
      {
        method: "HEAD",
        timeout: cliOperationalPolicy.defaultValue.probe.timeoutMs,
        ...(parsed.protocol === "https:" && loginCaPem ? { ca: loginCaPem } : {}),
        ...(parsed.protocol === "https:" && loginServername ? { servername: loginServername } : {}),
      },
      (res) => {
        res.resume();
        resolve({ ok: (res.statusCode ?? 500) < 500 });
      },
    );
    req.once("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: `Auth probe timed out for ${loginUrl}.` });
    });
    req.once("error", (error) => resolve({ ok: false, error: error.message }));
    req.end();
  });
}

function safeParseExternalUrl(value: string): string {
  if (!URL.canParse(value)) return value;
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return value;
  return parsed.origin;
}

function normalizeSpkiHex(value: string): string | undefined {
  const trimmed = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  return /^[0-9a-f]{64}$/u.test(trimmed) ? trimmed : undefined;
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag),
    value = index < 0 ? undefined : argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function missingFlags(argv: readonly string[], flags: readonly string[]): readonly string[] {
  return flags.filter((flag) => flagValue(argv, flag) === undefined);
}

function parseNonnegativeInt(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function failureOutcome(command: string, code: string, hint: string): FleetCenterRelocationOutcome {
  return {
    receipt: {
      schema: "command-receipt/v2",
      ok: false,
      command,
      outcome: "op_rejected",
      code,
      error: { code, hint },
    },
    exitCode: 2,
  };
}
