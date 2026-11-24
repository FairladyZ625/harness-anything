import { hash, X509Certificate } from "node:crypto";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import path from "node:path";
import type { SwitchoverTargetActivationReceipt } from "@harness-anything/application/internal/commands/center-switchover.ts";
import {
  readDaemonRegistry,
  writeDaemonRegistryRepo,
  type DaemonRepoMode,
} from "@harness-anything/kernel/daemon-registry";
import type {
  SwitchoverFrozenCut,
  SwitchoverReplicaCut,
} from "@harness-anything/kernel/internal/domain/center-switchover.ts";
import { localRuntimeStateFileSystem } from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";
import { canonicalLedgerCut } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import {
  DEFAULT_REPLICA_LOG_WINDOW_COMMITS,
  invalidateTargetSwitchoverAttempt,
  openPersistentWriterEpoch,
  openSqliteEventStore,
  promoteReplicaForSwitchover,
  writeFileDurably,
  type CenterReplicationLogRow,
  type ReplicationAcknowledgement,
} from "@harness-anything/storage";
import {
  fleetEdgeConfigDir,
  readFleetEdgeConfig,
  removeFleetEdgeConfig,
  type FleetEdgeConfig,
} from "../client/fleet-edge-config.ts";
import { readReplicaGeneration } from "../../fleet-sync/fleet/replica-generation.ts";
import { readReplicaHealth } from "../../fleet-sync/fleet/replica-health.ts";
import { immediate, mid } from "./center-transport.ts";
import { FleetFault, type Delivery } from "./center-types.ts";
import type { FleetFrameV1 } from "./command-protocol.ts";
import { openPeer, type FleetPeerOptions } from "./peer.ts";
import { waitForFleetReplicaRevision } from "./replica-sync.ts";
import { createFleetReplicaAccessTokenReader } from "./replica-token.ts";
import { resolveBoundAccessToken } from "../daemon-host-binding.ts";
import { oidcCenterSelections } from "../oidc-center-selection.ts";

export interface SwitchoverReplicationSlotRow {
  readonly repoId: string;
  readonly nodeId: string;
  readonly history: string;
  readonly ack: ReplicationAcknowledgement | null;
}

export interface SwitchoverCandidateRegisterInput {
  readonly repoId: string;
  readonly nodeId: string;
  readonly targetExternalUrl: string;
  readonly targetLoginUrl: string;
  readonly targetSpkiSha256: string;
  readonly targetServername?: string;
}

export interface SwitchoverStatusWaitCut {
  readonly finalRevision: number;
  readonly tipHash: string;
  readonly history: string;
  readonly sequence: number;
  readonly timeoutMs: number;
}

export interface SwitchoverStatusResult {
  readonly repoId: string;
  readonly nodeId: string;
  readonly mode: DaemonRepoMode | null;
  readonly connected: boolean;
  readonly syncFailureCode: string | null;
  readonly availableDiskBytes: number;
  readonly writerEpoch: number;
  readonly cut: SwitchoverReplicaCut | null;
}

export interface SwitchoverActivateRequest {
  readonly repoId: string;
  readonly switchoverId: string;
  readonly expectedTargetNodeId: string;
  readonly expectedOldEpoch: number;
  readonly newEpoch: number;
  readonly frozenCut: SwitchoverFrozenCut;
  readonly sourceReplicationLogWindow: readonly CenterReplicationLogRow[];
  readonly retentionWindowCommits: number;
  readonly replicationSlots?: readonly SwitchoverReplicationSlotRow[];
  readonly targetExternalUrl?: string;
  readonly targetLoginUrl?: string;
}

export interface SwitchoverInvalidateRequest {
  readonly repoId: string;
  readonly switchoverId: string;
  readonly expectedTargetNodeId: string;
  readonly cededEpoch: number;
}

export interface SwitchoverInvalidateResult {
  readonly targetNeverActivated: boolean;
  readonly targetInvalidated: boolean;
  readonly observedTargetEpoch: number;
}

export interface FleetSwitchoverControlPort {
  readonly registerCandidate?: (
    input: SwitchoverCandidateRegisterInput,
  ) => Promise<{ readonly repoId: string; readonly nodeId: string; readonly registeredAt: string }>;
  readonly status?: (input: {
    readonly repoId: string;
    readonly expectedTargetNodeId: string;
    readonly waitForCut?: SwitchoverStatusWaitCut;
  }) => Promise<SwitchoverStatusResult>;
  readonly activate?: (input: SwitchoverActivateRequest) => Promise<SwitchoverTargetActivationReceipt>;
  readonly invalidate?: (input: SwitchoverInvalidateRequest) => Promise<SwitchoverInvalidateResult>;
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

export interface CenterSwitchoverCandidateV1 {
  readonly schema: "fleet-center-switchover-candidate/v1";
  readonly repoId: string;
  readonly nodeId: string;
  readonly targetExternalUrl: string;
  readonly targetLoginUrl: string;
  readonly targetSpkiSha256: string;
  readonly targetRoot?: string;
  readonly targetUserRoot?: string;
  readonly targetStateRoot?: string;
  readonly targetCaPath?: string;
  readonly targetServername?: string;
  readonly updatedAt: string;
}

function isPositiveSafeByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseCandidateHttpsOrigin(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const parsed = new URL(value);
  return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.pathname === "/"
    ? parsed.origin
    : null;
}

function parseCandidateLoginUrl(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const parsed = new URL(value);
  return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
    parsed.username === "" &&
    parsed.password === ""
    ? parsed.toString()
    : null;
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
  if (!isPositiveSafeByteCount(input.quotaBytes))
    throw new Error("Symmetric center identity requires a positive quotaBytes.");
  const resolvedViewRoot = path.resolve(input.viewRoot);
  localRuntimeStateFileSystem.mkdirp(resolvedViewRoot);
  const record: CenterSymmetricNodeIdentityV1 = {
    schema: "fleet-center-node-identity/v1",
    repoId: input.repoId,
    nodeId: input.nodeId,
    credential: input.credential,
    viewRoot: resolvedViewRoot,
    quotaBytes: input.quotaBytes,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
  writeFileDurably(centerSymmetricIdentityPath(userRoot, input.repoId), `${JSON.stringify(record, null, 2)}\n`, 0o600);
  return record;
}

export function readCenterSymmetricIdentity(userRoot: string, repoId: string): CenterSymmetricNodeIdentityV1 | null {
  const file = centerSymmetricIdentityPath(userRoot, repoId);
  if (!localRuntimeStateFileSystem.exists(file)) return null;
  const parsed = JSON.parse(localRuntimeStateFileSystem.readText(file)) as Partial<CenterSymmetricNodeIdentityV1>;
  if (!isPositiveSafeByteCount(parsed.quotaBytes)) return null;
  if (
    parsed.schema !== "fleet-center-node-identity/v1" ||
    parsed.repoId !== repoId ||
    typeof parsed.nodeId !== "string" ||
    typeof parsed.credential !== "string" ||
    typeof parsed.viewRoot !== "string" ||
    typeof parsed.updatedAt !== "string"
  )
    return null;
  return parsed as CenterSymmetricNodeIdentityV1;
}

export function centerSwitchoverCandidatePath(userRoot: string, repoId: string, nodeId: string): string {
  return path.join(path.resolve(userRoot), "fleet", "center-switchover-candidates", repoId, `${nodeId}.json`);
}

export function prepareCenterSwitchoverCandidate(
  userRoot: string,
  input: Omit<CenterSwitchoverCandidateV1, "schema" | "updatedAt"> & { readonly updatedAt?: string },
): CenterSwitchoverCandidateV1 {
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(input.repoId))
    throw new Error(`Invalid repoId for switchover candidate: ${input.repoId}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.nodeId))
    throw new Error(`Invalid nodeId for switchover candidate: ${input.nodeId}`);
  const externalUrl = parseCandidateHttpsOrigin(input.targetExternalUrl);
  if (!externalUrl)
    throw new Error(`Switchover candidate targetExternalUrl must be an HTTPS origin: ${input.targetExternalUrl}`);
  if (!parseCandidateLoginUrl(input.targetLoginUrl))
    throw new Error(`Switchover candidate targetLoginUrl must be an HTTP(S) URL: ${input.targetLoginUrl}`);
  if (!/^(?:sha256:)?[0-9a-f]{64}$/u.test(input.targetSpkiSha256))
    throw new Error("Switchover candidate targetSpkiSha256 must be a lowercase SHA-256 digest.");
  if (input.targetRoot !== undefined && !path.isAbsolute(input.targetRoot))
    throw new Error("Switchover candidate targetRoot must be an absolute path.");
  if (input.targetUserRoot !== undefined && !path.isAbsolute(input.targetUserRoot))
    throw new Error("Switchover candidate targetUserRoot must be an absolute path.");
  if (input.targetStateRoot !== undefined && !path.isAbsolute(input.targetStateRoot))
    throw new Error("Switchover candidate targetStateRoot must be an absolute path.");
  if (input.targetCaPath !== undefined && !path.isAbsolute(input.targetCaPath))
    throw new Error("Switchover candidate targetCaPath must be an absolute path.");
  const record: CenterSwitchoverCandidateV1 = {
    schema: "fleet-center-switchover-candidate/v1",
    repoId: input.repoId,
    nodeId: input.nodeId,
    targetExternalUrl: externalUrl,
    targetLoginUrl: input.targetLoginUrl,
    targetSpkiSha256: input.targetSpkiSha256,
    ...(input.targetRoot ? { targetRoot: path.resolve(input.targetRoot) } : {}),
    ...(input.targetUserRoot ? { targetUserRoot: path.resolve(input.targetUserRoot) } : {}),
    ...(input.targetStateRoot ? { targetStateRoot: path.resolve(input.targetStateRoot) } : {}),
    ...(input.targetCaPath ? { targetCaPath: path.resolve(input.targetCaPath) } : {}),
    ...(input.targetServername ? { targetServername: input.targetServername } : {}),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
  writeFileDurably(
    centerSwitchoverCandidatePath(userRoot, input.repoId, input.nodeId),
    `${JSON.stringify(record, null, 2)}\n`,
    0o600,
  );
  return record;
}

export function readCenterSwitchoverCandidate(
  userRoot: string,
  repoId: string,
  nodeId: string,
): CenterSwitchoverCandidateV1 | null {
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(repoId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(nodeId)) return null;
  const file = centerSwitchoverCandidatePath(userRoot, repoId, nodeId);
  if (!localRuntimeStateFileSystem.exists(file)) return null;
  const parsed = JSON.parse(localRuntimeStateFileSystem.readText(file)) as Partial<CenterSwitchoverCandidateV1>;
  if (
    parsed.schema !== "fleet-center-switchover-candidate/v1" ||
    parsed.repoId !== repoId ||
    parsed.nodeId !== nodeId ||
    typeof parsed.targetExternalUrl !== "string" ||
    parseCandidateHttpsOrigin(parsed.targetExternalUrl) === null ||
    typeof parsed.targetLoginUrl !== "string" ||
    parseCandidateLoginUrl(parsed.targetLoginUrl) === null ||
    typeof parsed.targetSpkiSha256 !== "string" ||
    !/^(?:sha256:)?[0-9a-f]{64}$/u.test(parsed.targetSpkiSha256) ||
    (parsed.targetRoot !== undefined &&
      (typeof parsed.targetRoot !== "string" || !path.isAbsolute(parsed.targetRoot))) ||
    (parsed.targetUserRoot !== undefined &&
      (typeof parsed.targetUserRoot !== "string" || !path.isAbsolute(parsed.targetUserRoot))) ||
    (parsed.targetStateRoot !== undefined &&
      (typeof parsed.targetStateRoot !== "string" || !path.isAbsolute(parsed.targetStateRoot))) ||
    (parsed.targetCaPath !== undefined &&
      (typeof parsed.targetCaPath !== "string" || !path.isAbsolute(parsed.targetCaPath))) ||
    (parsed.targetServername !== undefined && typeof parsed.targetServername !== "string") ||
    typeof parsed.updatedAt !== "string"
  )
    return null;
  return parsed as CenterSwitchoverCandidateV1;
}

function readExistingEpochWatermark(stateRoot: string, repoId: string): number {
  const epochDbPath = path.join(path.resolve(stateRoot), "writer-epochs", `${repoId}.sqlite`);
  if (!existsSync(epochDbPath)) return 0;
  const authority = openPersistentWriterEpoch({
    stateRoot: path.resolve(stateRoot),
    holderId: `switchover-status-reader-${process.pid}`,
  });
  try {
    return authority.highWatermark(repoId);
  } finally {
    authority.close();
  }
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

function resolveLocalEdgeReplicaCut(
  canonicalRoot: string,
  userRoot: string,
  repoId: string,
  nodeId: string,
  edge: FleetEdgeConfig | null,
): {
  readonly viewRoot: string;
  readonly generation: ReturnType<typeof readReplicaGeneration>;
  readonly cut: SwitchoverReplicaCut | null;
  readonly connected: boolean;
  readonly syncFailureCode: string | null;
} {
  const viewRoot = edge
      ? path.isAbsolute(edge.viewRoot)
        ? edge.viewRoot
        : path.resolve(canonicalRoot, edge.viewRoot)
      : path.join(path.resolve(userRoot), "fleet", "views"),
    viewDir = path.join(viewRoot, "repos", repoId, "views", nodeId),
    generation = readReplicaGeneration(viewDir);
  if (!generation)
    return { viewRoot, generation: null, cut: null, connected: false, syncFailureCode: "replica_unavailable" };
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
      viewRoot,
      generation,
      cut: { repoId, revision, tipHash, history: position.history, sequence: position.sequence },
      connected: health.syncFailure === null,
      syncFailureCode: health.syncFailure?.code ?? null,
    };
  } finally {
    ledger.close();
  }
}

function isReplicaCutCaughtUp(cut: SwitchoverReplicaCut | null, target: SwitchoverStatusWaitCut): boolean {
  return (
    cut !== null &&
    cut.revision === target.finalRevision &&
    cut.sequence === target.sequence &&
    cut.history === target.history &&
    cut.tipHash === target.tipHash
  );
}

/**
 * Production host-side switchover control handler for a running daemon:
 * - On Center A: persists trusted remote candidate registrations (network endpoints/SPKI only, zero target disk paths).
 * - On Candidate B: inspects B's own private replica/disk/epoch, executes Phase 2 activation inside B's replica fence
 *   and reloads B's live RepoCell to `local`, and executes F3 target invalidation against B's own private state.
 */
export function createDaemonSwitchoverControlHandler(input: {
  readonly userRoot: string;
  readonly stateRoot?: string;
  readonly withReplicaSyncFence?: <T>(repoId: string, operation: () => Promise<T>) => Promise<T>;
  readonly closeCell?: (repoId: string) => Promise<void>;
  readonly attachLocalRepo?: (canonicalRoot: string, repoId: string) => Promise<void>;
  readonly resetWriterEpochCache?: (repoId: string) => void;
  readonly rebindRouting?: (params: {
    readonly repoId: string;
    readonly writerEpoch: number;
    readonly externalUrl?: string;
    readonly loginUrl?: string;
  }) => void;
  readonly now?: () => string;
}): FleetSwitchoverControlPort {
  const userRoot = path.resolve(input.userRoot),
    stateRoot = path.resolve(input.stateRoot ?? path.join(userRoot, "fleet")),
    now = input.now ?? (() => new Date().toISOString());

  const resolveLocalNodeId = (repoId: string): string | null =>
    readFleetEdgeConfig(userRoot, repoId)?.nodeId ?? readCenterSymmetricIdentity(userRoot, repoId)?.nodeId ?? null;

  return {
    registerCandidate: async (candidate) => {
      const saved = prepareCenterSwitchoverCandidate(userRoot, {
        repoId: candidate.repoId,
        nodeId: candidate.nodeId,
        targetExternalUrl: candidate.targetExternalUrl,
        targetLoginUrl: candidate.targetLoginUrl,
        targetSpkiSha256: candidate.targetSpkiSha256,
        ...(candidate.targetServername ? { targetServername: candidate.targetServername } : {}),
        updatedAt: now(),
      });
      return { repoId: saved.repoId, nodeId: saved.nodeId, registeredAt: saved.updatedAt };
    },

    status: async ({ repoId, expectedTargetNodeId, waitForCut }) => {
      const repo = readDaemonRegistry({ userRoot }).repos.find((entry) => entry.repoId === repoId);
      const edge = readFleetEdgeConfig(userRoot, repoId);
      const localNodeId = resolveLocalNodeId(repoId);
      if (localNodeId !== expectedTargetNodeId) {
        throw new FleetFault(
          "target_node_mismatch",
          `Switchover target node mismatch for ${repoId}: expected ${expectedTargetNodeId}, found ${localNodeId ?? "unconfigured"}.`,
        );
      }
      if (!repo || repo.canonicalRoot === null) {
        return {
          repoId,
          nodeId: localNodeId,
          mode: repo?.mode ?? null,
          connected: false,
          syncFailureCode: "repo_canonical_root_missing",
          availableDiskBytes: 0,
          writerEpoch: readExistingEpochWatermark(stateRoot, repoId),
          cut: null,
        };
      }
      let info = resolveLocalEdgeReplicaCut(repo.canonicalRoot, userRoot, repoId, localNodeId, edge);
      if (waitForCut && !isReplicaCutCaughtUp(info.cut, waitForCut)) {
        await waitForFleetReplicaRevision(
          { viewRoot: info.viewRoot, repoId, nodeId: localNodeId },
          waitForCut.finalRevision,
          AbortSignal.timeout(waitForCut.timeoutMs),
        ).then(
          () => true,
          () => false,
        );
        info = resolveLocalEdgeReplicaCut(
          repo.canonicalRoot,
          userRoot,
          repoId,
          localNodeId,
          readFleetEdgeConfig(userRoot, repoId),
        );
      }
      return {
        repoId,
        nodeId: localNodeId,
        mode: repo.mode,
        connected: info.connected,
        syncFailureCode: info.syncFailureCode,
        availableDiskBytes: availableDiskBytesAt(repo.canonicalRoot),
        writerEpoch: readExistingEpochWatermark(stateRoot, repoId),
        cut: info.cut,
      };
    },

    activate: async (request) => {
      const runActivation = async (): Promise<SwitchoverTargetActivationReceipt> => {
        const repo = readDaemonRegistry({ userRoot }).repos.find((entry) => entry.repoId === request.repoId);
        if (!repo || repo.canonicalRoot === null) {
          throw new FleetFault(
            "repo_unavailable",
            `Target repository ${request.repoId} has no registered canonical root on candidate host.`,
          );
        }
        const edge = readFleetEdgeConfig(userRoot, request.repoId);
        const localNodeId = edge?.nodeId ?? readCenterSymmetricIdentity(userRoot, request.repoId)?.nodeId ?? null;
        if (localNodeId !== request.expectedTargetNodeId) {
          throw new FleetFault(
            "target_node_mismatch",
            `Switchover activation target mismatch: expected ${request.expectedTargetNodeId}, found ${localNodeId ?? "unconfigured"}.`,
          );
        }
        if (repo.mode !== "remote-edge") {
          throw new FleetFault(
            "target_not_remote_edge",
            `Target repository ${request.repoId} is in mode ${repo.mode}, expected remote-edge for switchover activation.`,
          );
        }
        const replicaInfo = resolveLocalEdgeReplicaCut(repo.canonicalRoot, userRoot, request.repoId, localNodeId, edge);
        if (!replicaInfo.generation) {
          throw new FleetFault(
            "replica_unavailable",
            `Target replica generation is unavailable for ${request.repoId} on ${localNodeId}.`,
          );
        }
        if (edge) {
          prepareCenterSymmetricIdentity(userRoot, {
            repoId: request.repoId,
            nodeId: edge.nodeId,
            credential: edge.credential,
            viewRoot: path.isAbsolute(edge.viewRoot) ? edge.viewRoot : path.resolve(repo.canonicalRoot, edge.viewRoot),
            quotaBytes: edge.quotaBytes,
            updatedAt: now(),
          });
        }
        await input.closeCell?.(request.repoId);
        const promoted = await promoteReplicaForSwitchover({
          rootInput: repo.canonicalRoot,
          userRoot,
          stateRoot,
          repoId: request.repoId,
          switchoverId: request.switchoverId,
          replicaDatabasePath: replicaInfo.generation.ledgerPath,
          replicaGeneration: replicaInfo.generation.metadata.ledgerGeneration,
          replicaPosition: replicaInfo.generation.metadata.position,
          expectedOldEpoch: request.expectedOldEpoch,
          newEpoch: request.newEpoch,
          expectedFrozenCut: request.frozenCut,
          sourceReplicationLogWindow: request.sourceReplicationLogWindow,
          retentionWindowCommits: request.retentionWindowCommits ?? DEFAULT_REPLICA_LOG_WINDOW_COMMITS,
          ...(request.replicationSlots && request.replicationSlots.length > 0
            ? { replicationSlots: request.replicationSlots }
            : {}),
          now,
        });
        writeDaemonRegistryRepo({
          canonicalRoot: repo.canonicalRoot,
          repoId: request.repoId,
          mode: "local",
          userRoot,
          createConvenienceLinks: false,
        });
        removeFleetEdgeConfig(userRoot, request.repoId);
        input.rebindRouting?.({
          repoId: request.repoId,
          writerEpoch: promoted.newEpoch,
          ...(request.targetExternalUrl ? { externalUrl: request.targetExternalUrl } : {}),
          ...(request.targetLoginUrl ? { loginUrl: request.targetLoginUrl } : {}),
        });
        input.resetWriterEpochCache?.(request.repoId);
        await input.attachLocalRepo?.(repo.canonicalRoot, request.repoId);
        return {
          switchoverId: promoted.switchoverId,
          repoId: promoted.repoId,
          oldEpoch: promoted.oldEpoch,
          newEpoch: promoted.newEpoch,
          finalRevision: promoted.finalRevision,
          tipHash: promoted.tipHash,
          replicationHistory: promoted.replicationHistory,
          replicationSequence: promoted.replicationSequence,
          retainedLogMinSequence: promoted.retainedLogMinSequence,
          retainedLogRowCount: promoted.retainedLogRowCount,
          promotedAt: promoted.promotedAt,
        };
      };
      return input.withReplicaSyncFence
        ? await input.withReplicaSyncFence(request.repoId, runActivation)
        : await runActivation();
    },

    invalidate: async (request) => {
      const repo = readDaemonRegistry({ userRoot }).repos.find((entry) => entry.repoId === request.repoId);
      const localNodeId = resolveLocalNodeId(request.repoId);
      if (localNodeId !== request.expectedTargetNodeId) {
        return { targetNeverActivated: false, targetInvalidated: false, observedTargetEpoch: 0 };
      }
      return invalidateTargetSwitchoverAttempt({
        targetStateRoot: stateRoot,
        ...(repo?.canonicalRoot ? { targetRootInput: repo.canonicalRoot } : {}),
        expectedTargetNodeId: request.expectedTargetNodeId,
        repoId: request.repoId,
        switchoverId: request.switchoverId,
        cededEpoch: request.cededEpoch,
        now,
      });
    },
  };
}

/** Dispatches authenticated Fleet TLS switchover control frames on a running listener. */
export async function handleSwitchoverFleetFrame(input: {
  readonly nodeId: string;
  readonly frame: FleetFrameV1;
  readonly control?: FleetSwitchoverControlPort;
  readonly admit: (
    node: { readonly nodeId: string; readonly repoId: string; readonly accessToken?: string },
    forSwitchoverControl: boolean,
  ) => Promise<unknown>;
}): Promise<Delivery | null> {
  const { nodeId, frame, control, admit } = input;
  if (frame.schema === "fleet.switchover.candidate.register/v1") {
    await admit({ nodeId, repoId: frame.repoId, accessToken: frame.accessToken }, false);
    if (!control?.registerCandidate)
      throw new FleetFault("switchover_control_unavailable", "Switchover candidate registration is unavailable.");
    const result = await control.registerCandidate({
      repoId: frame.repoId,
      nodeId,
      targetExternalUrl: frame.targetExternalUrl,
      targetLoginUrl: frame.targetLoginUrl,
      targetSpkiSha256: frame.targetSpkiSha256,
      ...(frame.targetServername ? { targetServername: frame.targetServername } : {}),
    });
    return immediate({
      schema: "fleet.switchover.candidate.register.result/v1",
      messageId: mid(frame.messageId, "sw-candidate"),
      inReplyTo: frame.messageId,
      ...result,
    });
  }
  if (frame.schema === "fleet.switchover.status/v1") {
    await admit({ nodeId, repoId: frame.repoId, accessToken: frame.accessToken }, true);
    if (!control?.status)
      throw new FleetFault("switchover_control_unavailable", "Switchover status probe is unavailable.");
    const result = await control.status({
      repoId: frame.repoId,
      expectedTargetNodeId: frame.expectedTargetNodeId,
      ...(frame.waitForCut ? { waitForCut: frame.waitForCut } : {}),
    });
    return immediate({
      schema: "fleet.switchover.status.result/v1",
      messageId: mid(frame.messageId, "sw-status"),
      inReplyTo: frame.messageId,
      ...result,
    });
  }
  if (frame.schema === "fleet.switchover.activate/v1") {
    await admit({ nodeId, repoId: frame.repoId, accessToken: frame.accessToken }, true);
    if (!control?.activate)
      throw new FleetFault("switchover_control_unavailable", "Switchover activation endpoint is unavailable.");
    const activation = await control.activate({
      repoId: frame.repoId,
      switchoverId: frame.switchoverId,
      expectedTargetNodeId: frame.expectedTargetNodeId,
      expectedOldEpoch: frame.expectedOldEpoch,
      newEpoch: frame.newEpoch,
      frozenCut: frame.frozenCut,
      sourceReplicationLogWindow: frame.sourceReplicationLogWindow,
      retentionWindowCommits: frame.retentionWindowCommits,
      ...(frame.replicationSlots ? { replicationSlots: frame.replicationSlots } : {}),
      ...(frame.targetExternalUrl ? { targetExternalUrl: frame.targetExternalUrl } : {}),
      ...(frame.targetLoginUrl ? { targetLoginUrl: frame.targetLoginUrl } : {}),
    });
    return immediate({
      schema: "fleet.switchover.activate.result/v1",
      messageId: mid(frame.messageId, "sw-activate"),
      inReplyTo: frame.messageId,
      activation,
    });
  }
  if (frame.schema === "fleet.switchover.invalidate/v1") {
    await admit({ nodeId, repoId: frame.repoId, accessToken: frame.accessToken }, true);
    if (!control?.invalidate)
      throw new FleetFault("switchover_control_unavailable", "Switchover invalidation endpoint is unavailable.");
    const result = await control.invalidate({
      repoId: frame.repoId,
      switchoverId: frame.switchoverId,
      expectedTargetNodeId: frame.expectedTargetNodeId,
      cededEpoch: frame.cededEpoch,
    });
    return immediate({
      schema: "fleet.switchover.invalidate.result/v1",
      messageId: mid(frame.messageId, "sw-invalidate"),
      inReplyTo: frame.messageId,
      ...result,
    });
  }
  return null;
}

export async function registerSwitchoverCandidateClient(
  options: Omit<FleetPeerOptions, "repoId">,
  payload: Omit<SwitchoverCandidateRegisterInput, "nodeId">,
): Promise<{ readonly repoId: string; readonly nodeId: string; readonly registeredAt: string }> {
  const peer = await openPeer(options);
  try {
    const reply = await peer.request({
      schema: "fleet.switchover.candidate.register/v1",
      messageId: peer.messageId(),
      repoId: payload.repoId,
      targetExternalUrl: payload.targetExternalUrl,
      targetLoginUrl: payload.targetLoginUrl,
      targetSpkiSha256: payload.targetSpkiSha256,
      ...(payload.targetServername ? { targetServername: payload.targetServername } : {}),
    });
    if (reply.schema !== "fleet.switchover.candidate.register.result/v1")
      throw new Error("Switchover candidate registration result expected.");
    return { repoId: reply.repoId, nodeId: reply.nodeId, registeredAt: reply.registeredAt };
  } finally {
    peer.close();
  }
}

export async function queryRemoteSwitchoverStatusClient(
  options: Omit<FleetPeerOptions, "repoId">,
  payload: {
    readonly repoId: string;
    readonly expectedTargetNodeId: string;
    readonly waitForCut?: SwitchoverStatusWaitCut;
  },
): Promise<SwitchoverStatusResult & { readonly peerCertificatePem: string | null }> {
  const peer = await openPeer(options);
  try {
    const timeoutMs = payload.waitForCut
      ? Math.max(options.timeoutMs ?? 15_000, payload.waitForCut.timeoutMs + 5_000)
      : options.timeoutMs;
    const reply = await peer.request(
      {
        schema: "fleet.switchover.status/v1",
        messageId: peer.messageId(),
        repoId: payload.repoId,
        expectedTargetNodeId: payload.expectedTargetNodeId,
        ...(payload.waitForCut ? { waitForCut: payload.waitForCut } : {}),
      },
      timeoutMs,
    );
    if (reply.schema !== "fleet.switchover.status.result/v1") throw new Error("Switchover status result expected.");
    return {
      repoId: reply.repoId,
      nodeId: reply.nodeId,
      mode: reply.mode,
      connected: reply.connected,
      syncFailureCode: reply.syncFailureCode,
      availableDiskBytes: reply.availableDiskBytes,
      writerEpoch: reply.writerEpoch,
      cut: reply.cut,
      peerCertificatePem: peer.peerCertificatePem,
    };
  } finally {
    peer.close();
  }
}

export async function activateRemoteSwitchoverClient(
  options: Omit<FleetPeerOptions, "repoId">,
  payload: SwitchoverActivateRequest,
): Promise<{
  readonly activation: SwitchoverTargetActivationReceipt;
  readonly peerCertificatePem: string | null;
}> {
  const peer = await openPeer(options);
  try {
    const reply = await peer.request(
      {
        schema: "fleet.switchover.activate/v1",
        messageId: peer.messageId(),
        repoId: payload.repoId,
        switchoverId: payload.switchoverId,
        expectedTargetNodeId: payload.expectedTargetNodeId,
        expectedOldEpoch: payload.expectedOldEpoch,
        newEpoch: payload.newEpoch,
        frozenCut: payload.frozenCut,
        sourceReplicationLogWindow: payload.sourceReplicationLogWindow,
        retentionWindowCommits: payload.retentionWindowCommits,
        ...(payload.replicationSlots ? { replicationSlots: payload.replicationSlots } : {}),
        ...(payload.targetExternalUrl ? { targetExternalUrl: payload.targetExternalUrl } : {}),
        ...(payload.targetLoginUrl ? { targetLoginUrl: payload.targetLoginUrl } : {}),
      },
      options.timeoutMs ?? 60_000,
    );
    if (reply.schema !== "fleet.switchover.activate.result/v1")
      throw new Error("Switchover activation result expected.");
    return {
      activation: reply.activation,
      peerCertificatePem: peer.peerCertificatePem,
    };
  } finally {
    peer.close();
  }
}

export async function invalidateRemoteSwitchoverClient(
  options: Omit<FleetPeerOptions, "repoId">,
  payload: SwitchoverInvalidateRequest,
): Promise<SwitchoverInvalidateResult> {
  const peer = await openPeer(options);
  try {
    const reply = await peer.request(
      {
        schema: "fleet.switchover.invalidate/v1",
        messageId: peer.messageId(),
        repoId: payload.repoId,
        switchoverId: payload.switchoverId,
        expectedTargetNodeId: payload.expectedTargetNodeId,
        cededEpoch: payload.cededEpoch,
      },
      options.timeoutMs ?? 15_000,
    );
    if (reply.schema !== "fleet.switchover.invalidate.result/v1")
      throw new Error("Switchover invalidation result expected.");
    return {
      targetNeverActivated: reply.targetNeverActivated,
      targetInvalidated: reply.targetInvalidated,
      observedTargetEpoch: reply.observedTargetEpoch,
    };
  } finally {
    peer.close();
  }
}

export function spkiSha256FromCertificatePem(certPem: string | Buffer): string {
  const x509 = new X509Certificate(certPem);
  return `sha256:${hash("sha256", x509.publicKey.export({ type: "spki", format: "der" }), "hex")}`;
}

/**
 * Automatic runtime candidate provisioning: when a running `remote-edge` daemon starts or restores its
 * standby Fleet TLS listener, it announces its own verified external URL, login URL, and certificate SPKI
 * to the active Center over the authenticated Fleet TLS channel (F1).
 */
export async function announceSwitchoverCandidateToCenter(input: {
  readonly userRoot: string;
  readonly repoId: string;
  readonly canonicalRoot?: string;
  readonly listenerPort: number;
  readonly listenerBind: string;
  readonly listenerExternalUrl?: string;
  readonly listenerCertPath: string;
  readonly fallbackLoginUrl?: string;
  readonly readAccessToken?: () => Promise<string | undefined>;
}): Promise<{ readonly registered: boolean; readonly nodeId?: string; readonly error?: string }> {
  const edge = readFleetEdgeConfig(input.userRoot, input.repoId);
  if (!edge || edge.repoId !== input.repoId) return { registered: false };
  const certPem = readFileSync(input.listenerCertPath);
  const targetSpkiSha256 = spkiSha256FromCertificatePem(certPem);
  const fallbackHost =
    input.listenerBind === "0.0.0.0" || input.listenerBind === "::" ? "127.0.0.1" : input.listenerBind;
  const targetExternalUrl = input.listenerExternalUrl ?? `https://${fallbackHost}:${String(input.listenerPort)}`;
  const selectedLoginUrl = input.canonicalRoot
    ? oidcCenterSelections(input.userRoot).read(input.canonicalRoot)?.authority.url
    : undefined;
  const targetLoginUrl = edge.loginUrl ?? input.fallbackLoginUrl ?? selectedLoginUrl ?? targetExternalUrl;
  const targetServername = extractCertificateDnsName(certPem) ?? new URL(targetExternalUrl).hostname;
  const caPath = path.isAbsolute(edge.caPath)
    ? edge.caPath
    : path.resolve(fleetEdgeConfigDir(input.userRoot, input.repoId), edge.caPath);
  try {
    const result = await registerSwitchoverCandidateClient(
      {
        hostname: edge.host,
        port: edge.port,
        ca: readFileSync(caPath),
        ...(edge.servername ? { servername: edge.servername } : {}),
        ...(edge.spkiSha256 ? { spkiSha256: edge.spkiSha256 } : {}),
        ...(edge.spkiPinOnly ? { spkiPinOnly: true } : {}),
        nodeId: edge.nodeId,
        credential: edge.credential,
        ...(input.readAccessToken ? { readAccessToken: input.readAccessToken } : {}),
      },
      {
        repoId: input.repoId,
        targetExternalUrl,
        targetLoginUrl,
        targetSpkiSha256,
        ...(targetServername ? { targetServername } : {}),
      },
    );
    return { registered: true, nodeId: result.nodeId };
  } catch (error) {
    return { registered: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function announceRestoredStandbyCandidate(
  userRoot: string,
  authorityRepo: { readonly repoId: string; readonly mode: DaemonRepoMode; readonly canonicalRoot: string | null },
  listenerPort: number,
  config: { readonly bind: string; readonly externalUrl?: string; readonly certPath: string },
  oidc: import("@harness-anything/kernel").IdentitySessionPort,
): Promise<void> {
  if (authorityRepo.mode !== "remote-edge" || !authorityRepo.canonicalRoot) return;
  const { repoId, canonicalRoot } = authorityRepo;
  const edgeConfig = readFleetEdgeConfig(userRoot, repoId);
  if (!edgeConfig) return;
  const discoveredLogin = oidc.discovery(edgeConfig.nodeId);
  await announceSwitchoverCandidateToCenter({
    userRoot,
    repoId,
    canonicalRoot,
    listenerPort,
    listenerBind: config.bind,
    ...(config.externalUrl ? { listenerExternalUrl: config.externalUrl } : {}),
    listenerCertPath: config.certPath,
    ...(discoveredLogin?.url ? { fallbackLoginUrl: discoveredLogin.url } : {}),
    readAccessToken: createFleetReplicaAccessTokenReader({
      config: edgeConfig,
      configDir: fleetEdgeConfigDir(userRoot, repoId),
      readUserAccessToken: async () =>
        resolveBoundAccessToken(await oidc.bind({ transportKind: "unix-socket" }, canonicalRoot)),
    }),
  });
}

export function resolveListenerSwitchoverControl(options: {
  readonly onSwitchoverControl?: FleetSwitchoverControlPort;
  readonly relocationRoot?: string;
  readonly writerEpochStateRoot?: string;
  readonly stateRoot: string;
}): FleetSwitchoverControlPort | undefined {
  if (options.onSwitchoverControl) return options.onSwitchoverControl;
  const userRoot =
    options.relocationRoot ?? (options.writerEpochStateRoot ? path.dirname(options.writerEpochStateRoot) : undefined);
  return userRoot
    ? createDaemonSwitchoverControlHandler({ userRoot, stateRoot: options.writerEpochStateRoot ?? options.stateRoot })
    : undefined;
}

export function createHostContextSwitchoverControl(
  hostContext: {
    readonly input: { readonly userRoot: string; readonly daemonId: string };
    readonly withReplicaSyncFence: <T>(repoId: string, operation: () => Promise<T>) => Promise<T>;
    readonly closeCell: (repoId: string) => Promise<void>;
    readonly attach: (rootDir: string, repoId: string, mode?: DaemonRepoMode) => Promise<unknown>;
    readonly resetWriterEpochHandle: (repoId: string) => void;
    readonly now: () => string;
  },
  stateRoot: string,
  rebind: (input: {
    readonly userRoot: string;
    readonly daemonId: string;
    readonly stateRoot: string;
    readonly repoId: string;
    readonly writerEpoch: number;
    readonly externalUrl?: string;
    readonly loginUrl?: string;
  }) => unknown,
): FleetSwitchoverControlPort {
  return createDaemonSwitchoverControlHandler({
    userRoot: hostContext.input.userRoot,
    stateRoot,
    withReplicaSyncFence: hostContext.withReplicaSyncFence,
    closeCell: hostContext.closeCell,
    attachLocalRepo: async (rootDir, repoId) => {
      await hostContext.attach(rootDir, repoId, "local");
    },
    resetWriterEpochCache: hostContext.resetWriterEpochHandle,
    rebindRouting: (params) =>
      rebind({
        ...params,
        userRoot: hostContext.input.userRoot,
        daemonId: hostContext.input.daemonId,
        stateRoot,
      }),
    now: hostContext.now,
  });
}

function extractCertificateDnsName(certPem: string | Buffer): string | undefined {
  const x509 = new X509Certificate(certPem);
  const altName = x509.subjectAltName ?? "";
  for (const part of altName.split(",")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("DNS:")) {
      const dns = trimmed.slice("DNS:".length).trim();
      if (dns.length > 0) return dns;
    }
  }
  return undefined;
}
