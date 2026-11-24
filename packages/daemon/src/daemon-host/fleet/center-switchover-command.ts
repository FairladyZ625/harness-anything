import { randomUUID } from "node:crypto";
import { statfsSync } from "node:fs";
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
} from "@harness-anything/application/commands";
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
import { readFleetEdgeConfig, removeFleetEdgeConfig, writeFleetEdgeConfig } from "../client/fleet-edge-config.ts";
import { localSystemBinding } from "../daemon-host-binding.ts";
import { requireAuthorizedHostAction } from "../host-action-authorization.ts";
import { readReplicaGeneration } from "../../fleet-sync/fleet/replica-generation.ts";
import { readReplicaHealth } from "../../fleet-sync/fleet/replica-health.ts";
import type { FleetCenterRelocationOutcome } from "./center-relocation-command.ts";
import { waitForFleetReplicaRevision } from "./replica-sync.ts";

class SwitchoverCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SwitchoverCommandError";
    this.code = code;
  }
}

export interface FleetCenterSwitchoverCommandHelpers {
  readonly drainLocalDaemonRepoQueue?: (userRoot: string, daemonId: string, repoId: string) => Promise<boolean>;
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

export interface CenterSymmetricNodeIdentityV1 {
  readonly schema: "fleet-center-node-identity/v1";
  readonly repoId: string;
  readonly nodeId: string;
  readonly credential: string;
  readonly viewRoot: string;
  readonly quotaBytes: number;
  readonly updatedAt: string;
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

export function centerSymmetricIdentityPath(userRoot: string, repoId: string): string {
  return path.join(path.resolve(userRoot), "fleet", "center-node-identity", `${repoId}.json`);
}

export function prepareCenterSymmetricIdentity(
  userRoot: string,
  input: Omit<CenterSymmetricNodeIdentityV1, "schema" | "updatedAt"> & { readonly updatedAt?: string },
): CenterSymmetricNodeIdentityV1 {
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(input.repoId))
    throw new Error(`Invalid repoId for symmetric center identity: ${input.repoId}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.nodeId))
    throw new Error(`Invalid nodeId for symmetric center identity: ${input.nodeId}`);
  if (!input.credential || input.credential.trim().length === 0)
    throw new Error("Symmetric center identity requires a non-empty machine credential.");
  const storageBytes = input.quotaBytes;
  if (!isPositiveSafeByteCount(storageBytes))
    throw new Error("Symmetric center identity requires a positive quotaBytes.");
  const resolvedViewRoot = path.resolve(input.viewRoot);
  localRuntimeStateFileSystem.mkdirp(resolvedViewRoot);
  const record: CenterSymmetricNodeIdentityV1 = {
    schema: "fleet-center-node-identity/v1",
    repoId: input.repoId,
    nodeId: input.nodeId,
    credential: input.credential,
    viewRoot: resolvedViewRoot,
    quotaBytes: storageBytes,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
  writeFileDurably(centerSymmetricIdentityPath(userRoot, input.repoId), `${JSON.stringify(record, null, 2)}\n`, 0o600);
  return record;
}

export function readCenterSymmetricIdentity(userRoot: string, repoId: string): CenterSymmetricNodeIdentityV1 | null {
  const file = centerSymmetricIdentityPath(userRoot, repoId);
  if (!localRuntimeStateFileSystem.exists(file)) return null;
  const parsed = JSON.parse(localRuntimeStateFileSystem.readText(file)) as Partial<CenterSymmetricNodeIdentityV1>,
    storageBytes = parsed.quotaBytes;
  if (
    parsed.schema !== "fleet-center-node-identity/v1" ||
    parsed.repoId !== repoId ||
    typeof parsed.nodeId !== "string" ||
    typeof parsed.credential !== "string" ||
    typeof parsed.viewRoot !== "string" ||
    !isPositiveSafeByteCount(storageBytes) ||
    typeof parsed.updatedAt !== "string"
  )
    return null;
  return parsed as CenterSymmetricNodeIdentityV1;
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
    targetRoot = path.resolve(flagValue(argv, "--target-root") ?? sourceRoot),
    targetUserRoot = path.resolve(flagValue(argv, "--target-user-root") ?? sourceUserRoot),
    targetStateRoot = path.resolve(flagValue(argv, "--target-state-root") ?? path.join(targetUserRoot, "fleet")),
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

  const rawExternalUrl = flagValue(argv, "--target-external-url") ?? "",
    targetExternalUrl = rawExternalUrl ? safeParseExternalUrl(rawExternalUrl) : "",
    targetLoginUrl = flagValue(argv, "--target-login-url") ?? "",
    targetSpkiSha256 = flagValue(argv, "--target-spki-sha256") ?? "",
    targetCaPath = flagValue(argv, "--target-ca") ? path.resolve(flagValue(argv, "--target-ca")!) : undefined,
    targetServername = flagValue(argv, "--target-servername");

  const resolvedIdentity = resolveSourceSymmetricIdentity(argv, sourceUserRoot, repoId);
  let capturedLogWindow: readonly CenterReplicationLogRow[] = [];

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
      const targetEdge = readFleetEdgeConfig(targetUserRoot, targetRepo);
      const targetReplica = resolveTargetReplicaInfo(targetRoot, targetUserRoot, targetRepo, candidateNode, targetEdge);
      const tlsProbe = hooks?.probeTls
        ? await hooks.probeTls(targetExternalUrl, targetCaPath, targetServername)
        : await defaultProbeTls(targetExternalUrl, targetCaPath, targetServername);
      const authProbe = hooks?.probeAuth
        ? await hooks.probeAuth(targetLoginUrl, targetCaPath)
        : await defaultProbeAuth(targetLoginUrl, targetCaPath);
      const availableDiskBytes = availableDiskBytesAt(targetRoot);
      const replicaLagRevisions =
        targetReplica.cut === null ? null : Math.max(0, centerSnapshot.cut.finalRevision - targetReplica.cut.revision);
      const input: SwitchoverPreflightInput = {
        repoId: targetRepo,
        triggerSource: trigger,
        sourceNodeId: resolvedIdentity?.nodeId ?? "",
        targetNodeId: candidateNode,
        oldEpoch: centerSnapshot.writerEpoch,
        centerHistory: centerSnapshot.cut.history,
        tlsReachable: tlsProbe.ok,
        ...(tlsProbe.error ? { tlsError: tlsProbe.error } : {}),
        targetExternalUrl,
        targetSpkiSha256,
        replicaConnected: targetReplica.connected,
        replicaHistory: targetReplica.cut?.history ?? null,
        replicaSyncFailureCode: targetReplica.syncFailureCode,
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
      return await waitTargetReplicaCut({
        targetRoot,
        targetUserRoot,
        repoId: targetRepo,
        targetNodeId: candidateNode,
        frozenCut,
        timeoutMs,
      });
    },
    persistCededFence: async (fenceInput) => {
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
        now: hooks?.now,
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
      const targetEdge = readFleetEdgeConfig(targetUserRoot, activationInput.repoId);
      const targetReplica = resolveTargetReplicaInfo(
        targetRoot,
        targetUserRoot,
        activationInput.repoId,
        activationInput.targetNodeId,
        targetEdge,
      );
      if (!targetReplica.generation)
        throw new SwitchoverCommandError(
          "replica_unavailable",
          `Target replica generation is unavailable for ${activationInput.repoId} on ${activationInput.targetNodeId}.`,
        );
      // Persist target's own nodeId/credential/viewRoot as symmetric identity before removing its edge config,
      // so a later reverse switchover (B -> A) automatically knows how to demote B back to remote-edge.
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
        caPath = targetCaPath ?? path.join(sourceUserRoot, "fleet", "edge", demoteInput.repoId, "fleet-center-ca.pem");
      localRuntimeStateFileSystem.mkdirp(resolvedIdentity.viewRoot);
      writeFleetEdgeConfig(sourceUserRoot, demoteInput.repoId, {
        repoId: demoteInput.repoId,
        host: parsedTarget.hostname.replace(/^\[|\]$/gu, ""),
        port: parsedTarget.port ? Number(parsedTarget.port) : 443,
        caPath,
        ...(targetServername ? { servername: targetServername } : {}),
        ...(normalizedSpki ? { spkiSha256: normalizedSpki } : {}),
        ...(demoteInput.targetLoginUrl ? { loginUrl: demoteInput.targetLoginUrl } : {}),
        nodeId: resolvedIdentity.nodeId,
        credential: resolvedIdentity.credential,
        writerEpoch: demoteInput.newEpoch,
        viewRoot: resolvedIdentity.viewRoot,
        quotaBytes: resolvedIdentity.quotaBytes,
      });
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
    targetUserRoot = flagValue(argv, "--target-user-root")
      ? path.resolve(flagValue(argv, "--target-user-root")!)
      : undefined,
    targetStateRoot = flagValue(argv, "--target-state-root")
      ? path.resolve(flagValue(argv, "--target-state-root")!)
      : targetUserRoot
        ? path.join(targetUserRoot, "fleet")
        : undefined,
    targetRoot = flagValue(argv, "--target-root") ? path.resolve(flagValue(argv, "--target-root")!) : undefined;

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
      if (!targetStateRoot) return { targetNeverActivated: false, targetInvalidated: false };
      return invalidateTargetSwitchoverAttempt({
        targetStateRoot,
        ...(targetRoot ? { targetRootInput: targetRoot } : {}),
        repoId: input.repoId,
        switchoverId: input.switchoverId,
        cededEpoch: input.cededEpoch,
        now: hooks?.now,
      });
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
  if (!nodeId || !credential || !viewRoot || !isPositiveSafeByteCount(storageBytes)) return null;
  return prepareCenterSymmetricIdentity(sourceUserRoot, {
    repoId,
    nodeId,
    credential,
    viewRoot,
    quotaBytes: storageBytes,
  });
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
  throw new SwitchoverCommandError(
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
  caPath?: string,
): Promise<{ readonly ok: boolean; readonly error?: string }> {
  if (!loginUrl) return { ok: false, error: "Target --target-login-url is required." };
  if (!URL.canParse(loginUrl)) return { ok: false, error: `Invalid target login URL: ${loginUrl}` };
  const parsed = new URL(loginUrl),
    ca =
      caPath && localRuntimeStateFileSystem.exists(caPath) ? localRuntimeStateFileSystem.readText(caPath) : undefined;
  return await new Promise((resolve) => {
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(
      parsed,
      {
        method: "HEAD",
        timeout: cliOperationalPolicy.defaultValue.probe.timeoutMs,
        ...(parsed.protocol === "https:" && ca ? { ca } : {}),
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
