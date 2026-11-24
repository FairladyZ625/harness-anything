import { createPrivateKey, hash, sign, verify, X509Certificate } from "node:crypto";
import { readFileSync, statfsSync } from "node:fs";
import { isIP } from "node:net";
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
  openSqliteEventStore,
  promoteReplicaForSwitchover,
  writeFileDurably,
  type CenterReplicationLogRow,
  type ReplicationAcknowledgement,
} from "@harness-anything/storage";
import type { CenterSwitchoverCededProofV1 } from "../../../../storage/src/center-relocation-state.ts";
import { readExistingWriterEpochHighWatermark } from "../../../../storage/src/center-switchover.ts";
import {
  fleetEdgeConfigDir,
  readFleetEdgeConfig,
  removeFleetEdgeConfig,
  type FleetEdgeConfig,
} from "../client/fleet-edge-config.ts";
import { readFleetCenterConfig } from "../fleet-center-config.ts";
import { readReplicaGeneration } from "../../fleet-sync/fleet/replica-generation.ts";
import { readReplicaHealth } from "../../fleet-sync/fleet/replica-health.ts";
import { immediate, mid } from "./center-transport.ts";
import { FleetFault, type Delivery } from "./center-types.ts";
import { FLEET_UPLOAD_MAX_BYTES, measureFleetTransferPayload, type FleetFrameV1 } from "./command-protocol.ts";
import { openPeer, type FleetPeerOptions } from "./peer.ts";
import { waitForFleetReplicaRevision } from "./replica-sync.ts";
import { createFleetReplicaAccessTokenReader } from "./replica-token.ts";
import { resolveBoundAccessToken } from "../daemon-host-binding.ts";
import { oidcCenterSelections } from "../oidc-center-selection.ts";

export type { CenterSwitchoverCededProofV1 };

export const SWITCHOVER_SLOT_BATCH_SIZE = 512;
const MAX_STAGED_SLOTS_PER_SWITCHOVER = 100_000;
const MAX_STAGED_SWITCHOVER_SESSIONS = 16;

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
  readonly targetLoginCertificate?: string;
  readonly targetLoginServername?: string;
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

export interface SwitchoverStageSlotsRequest {
  readonly repoId: string;
  readonly switchoverId: string;
  readonly expectedTargetNodeId: string;
  readonly batchIndex: number;
  readonly totalBatches: number;
  readonly totalSlots: number;
  readonly slots: readonly SwitchoverReplicationSlotRow[];
  readonly cededProof: CenterSwitchoverCededProofV1;
  readonly callerNodeId?: string;
}

export interface SwitchoverStageSlotsResult {
  readonly repoId: string;
  readonly switchoverId: string;
  readonly batchIndex: number;
  readonly receivedSlots: number;
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
  readonly stagedSlotCount?: number;
  readonly stagedSlotsDigest?: string;
  readonly cededProof: CenterSwitchoverCededProofV1;
  readonly callerNodeId?: string;
  readonly targetExternalUrl?: string;
  readonly targetLoginUrl?: string;
}

export interface SwitchoverInvalidateRequest {
  readonly repoId: string;
  readonly switchoverId: string;
  readonly expectedTargetNodeId: string;
  readonly cededEpoch: number;
  readonly cededProof: CenterSwitchoverCededProofV1;
  readonly callerNodeId?: string;
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
  readonly stageSlots?: (input: SwitchoverStageSlotsRequest) => Promise<SwitchoverStageSlotsResult>;
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
  readonly targetLoginCertificate?: string;
  readonly targetLoginServername?: string;
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
    ...(input.targetLoginCertificate ? { targetLoginCertificate: input.targetLoginCertificate } : {}),
    ...(input.targetLoginServername ? { targetLoginServername: input.targetLoginServername } : {}),
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
    (parsed.targetLoginCertificate !== undefined && typeof parsed.targetLoginCertificate !== "string") ||
    (parsed.targetLoginServername !== undefined && typeof parsed.targetLoginServername !== "string") ||
    typeof parsed.updatedAt !== "string"
  )
    return null;
  return parsed as CenterSwitchoverCandidateV1;
}

/** F10: Strictly read-only writer-epoch watermark lookup; never mkdirs or opens SQLite writable. */
function readExistingEpochWatermark(stateRoot: string, repoId: string): number {
  return readExistingWriterEpochHighWatermark(stateRoot, repoId) ?? 0;
}

function canonicalSwitchoverCededProofPayload(
  proof: Omit<CenterSwitchoverCededProofV1, "sourceCertificatePem" | "signatureBase64">,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: proof.schema,
      repoId: proof.repoId,
      switchoverId: proof.switchoverId,
      sourceNodeId: proof.sourceNodeId,
      targetNodeId: proof.targetNodeId,
      oldEpoch: proof.oldEpoch,
      cededEpoch: proof.cededEpoch,
      finalRevision: proof.finalRevision,
      tipHash: proof.tipHash,
      fencedAt: proof.fencedAt,
    }),
    "utf8",
  );
}

/** F8: Cryptographically sign a persisted Phase 1 ceded fence using the source center's Fleet TLS key. */
export function signSwitchoverCededProof(input: {
  readonly repoId: string;
  readonly switchoverId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly oldEpoch: number;
  readonly cededEpoch: number;
  readonly finalRevision: number;
  readonly tipHash: string;
  readonly fencedAt: string;
  readonly sourceKeyPem: string | Buffer;
  readonly sourceCertificatePem: string;
}): CenterSwitchoverCededProofV1 {
  const key = createPrivateKey(input.sourceKeyPem);
  const algorithm = key.asymmetricKeyType === "ed25519" || key.asymmetricKeyType === "ed448" ? null : "sha256";
  const body = {
    schema: "center-switchover-ceded-proof/v1" as const,
    repoId: input.repoId,
    switchoverId: input.switchoverId,
    sourceNodeId: input.sourceNodeId,
    targetNodeId: input.targetNodeId,
    oldEpoch: input.oldEpoch,
    cededEpoch: input.cededEpoch,
    finalRevision: input.finalRevision,
    tipHash: input.tipHash,
    fencedAt: input.fencedAt,
  };
  const signatureBase64 = sign(algorithm, canonicalSwitchoverCededProofPayload(body), key).toString("base64");
  return { ...body, sourceCertificatePem: input.sourceCertificatePem, signatureBase64 };
}

function parseCertificateChain(pem: string): readonly X509Certificate[] {
  const matches = [...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu)];
  return matches.map(([block]) => new X509Certificate(block!));
}

function normalizeSpkiDigestHex(value: string): string {
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

function verifySwitchoverCededProof(input: {
  readonly proof: CenterSwitchoverCededProofV1;
  readonly edge: FleetEdgeConfig;
  readonly userRoot: string;
  readonly repoId: string;
  readonly callerNodeId: string;
  readonly expectedTargetNodeId: string;
  readonly switchoverId: string;
  readonly expectedOldEpoch?: number;
  readonly expectedCededEpoch: number;
  readonly frozenCut?: SwitchoverFrozenCut;
}): void {
  const { proof, edge } = input;
  const reject = (detail: string): never => {
    throw new FleetFault("switchover_ceded_proof_invalid", detail);
  };
  if (
    proof.schema !== "center-switchover-ceded-proof/v1" ||
    proof.repoId !== input.repoId ||
    proof.switchoverId !== input.switchoverId ||
    proof.sourceNodeId !== input.callerNodeId ||
    proof.targetNodeId !== input.expectedTargetNodeId ||
    proof.cededEpoch !== input.expectedCededEpoch ||
    proof.cededEpoch < proof.oldEpoch + 1 ||
    (input.expectedOldEpoch !== undefined && proof.oldEpoch !== input.expectedOldEpoch) ||
    (input.frozenCut !== undefined &&
      (proof.finalRevision !== input.frozenCut.finalRevision || proof.tipHash !== input.frozenCut.tipHash))
  ) {
    reject("Switchover ceded proof does not match the authenticated source node, repository, switchoverId, or epoch.");
  }
  let sourceCert: X509Certificate;
  try {
    sourceCert = new X509Certificate(proof.sourceCertificatePem);
  } catch (error) {
    throw new FleetFault(
      "switchover_ceded_proof_invalid",
      `Switchover ceded proof carries an unreadable source certificate: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const nowMs = Date.now();
  if (nowMs < Date.parse(sourceCert!.validFrom) || nowMs > Date.parse(sourceCert!.validTo)) {
    reject("Switchover ceded proof source certificate is outside its validity window.");
  }
  const sourceSpki = normalizeSpkiDigestHex(spkiSha256FromCertificatePem(proof.sourceCertificatePem));
  if (edge.spkiSha256 && sourceSpki !== normalizeSpkiDigestHex(edge.spkiSha256)) {
    reject(
      "Switchover ceded proof source certificate SPKI does not match this repository's configured center authority.",
    );
  }
  const expectedHost = (edge.servername ?? edge.host).replace(/^\[|\]$/gu, "");
  const hostMatched =
    isIP(expectedHost) !== 0
      ? sourceCert!.checkIP(expectedHost) !== undefined
      : sourceCert!.checkHost(expectedHost) !== undefined;
  if (!hostMatched) {
    reject(`Switchover ceded proof source certificate does not match configured center host ${expectedHost}.`);
  }
  const caPath = path.isAbsolute(edge.caPath)
    ? edge.caPath
    : path.resolve(fleetEdgeConfigDir(input.userRoot, input.repoId), edge.caPath);
  if (!localRuntimeStateFileSystem.exists(caPath)) {
    reject("Configured source center CA bundle is unavailable to verify switchover ceded proof.");
  }
  const trustedCerts = parseCertificateChain(readFileSync(caPath, "utf8"));
  const trustedByCa = trustedCerts.some(
    (caCert) =>
      sourceCert!.raw.equals(caCert.raw) || (sourceCert!.checkIssued(caCert) && sourceCert!.verify(caCert.publicKey)),
  );
  if (!trustedByCa && !(edge.spkiPinOnly === true && Boolean(edge.spkiSha256))) {
    reject("Switchover ceded proof source certificate is not trusted by this repository's configured center CA.");
  }
  const publicKey = sourceCert!.publicKey;
  const algorithm =
    publicKey.asymmetricKeyType === "ed25519" || publicKey.asymmetricKeyType === "ed448" ? null : "sha256";
  const signatureBytes = Buffer.from(proof.signatureBase64, "base64");
  const validSignature = verify(algorithm, canonicalSwitchoverCededProofPayload(proof), publicKey, signatureBytes);
  if (!validSignature) {
    reject("Switchover ceded proof signature verification failed.");
  }
}

export function computeSwitchoverSlotsDigest(slots: readonly SwitchoverReplicationSlotRow[]): string {
  return hash("sha256", JSON.stringify(slots), "hex");
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
  const stagedSlotsBySwitchover: Record<
    string,
    | {
        readonly repoId: string;
        readonly switchoverId: string;
        readonly totalBatches: number;
        readonly totalSlots: number;
        readonly batches: Map<number, readonly SwitchoverReplicationSlotRow[]>;
      }
    | undefined
  > = {};
  const stageKey = (repoId: string, switchoverId: string): string => `${repoId}\0${switchoverId}`;

  return {
    registerCandidate: async (candidate) => {
      const saved = prepareCenterSwitchoverCandidate(userRoot, {
        repoId: candidate.repoId,
        nodeId: candidate.nodeId,
        targetExternalUrl: candidate.targetExternalUrl,
        targetLoginUrl: candidate.targetLoginUrl,
        targetSpkiSha256: candidate.targetSpkiSha256,
        ...(candidate.targetServername ? { targetServername: candidate.targetServername } : {}),
        ...(candidate.targetLoginCertificate ? { targetLoginCertificate: candidate.targetLoginCertificate } : {}),
        ...(candidate.targetLoginServername ? { targetLoginServername: candidate.targetLoginServername } : {}),
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

    stageSlots: async (request) => {
      const repo = readDaemonRegistry({ userRoot }).repos.find((entry) => entry.repoId === request.repoId);
      if (!repo || repo.canonicalRoot === null || repo.mode !== "remote-edge") {
        throw new FleetFault(
          "target_not_remote_edge",
          `Target repository ${request.repoId} must be registered in remote-edge mode to stage switchover slots.`,
        );
      }
      const edge = readFleetEdgeConfig(userRoot, request.repoId);
      if (!edge || edge.nodeId !== request.expectedTargetNodeId) {
        throw new FleetFault(
          "target_node_mismatch",
          `Switchover slot staging target mismatch for ${request.repoId}: expected ${request.expectedTargetNodeId}.`,
        );
      }
      if (!request.callerNodeId) {
        throw new FleetFault(
          "switchover_ceded_proof_invalid",
          "Switchover slot staging requires an authenticated caller.",
        );
      }
      verifySwitchoverCededProof({
        proof: request.cededProof,
        edge,
        userRoot,
        repoId: request.repoId,
        callerNodeId: request.callerNodeId,
        expectedTargetNodeId: edge.nodeId,
        switchoverId: request.switchoverId,
        expectedCededEpoch: request.cededProof.cededEpoch,
      });
      if (
        request.batchIndex >= request.totalBatches ||
        request.totalSlots > MAX_STAGED_SLOTS_PER_SWITCHOVER ||
        request.slots.length > SWITCHOVER_SLOT_BATCH_SIZE ||
        request.slots.some((slot) => slot.repoId !== request.repoId)
      ) {
        throw new FleetFault("invalid_field", "Switchover slot batch exceeds bounds or mismatches repository.");
      }
      const key = stageKey(request.repoId, request.switchoverId);
      let session = Object.hasOwn(stagedSlotsBySwitchover, key) ? stagedSlotsBySwitchover[key] : undefined;
      if (!session) {
        const keys = Object.keys(stagedSlotsBySwitchover);
        while (keys.length >= MAX_STAGED_SWITCHOVER_SESSIONS) {
          const oldest = keys.shift();
          if (oldest === undefined) break;
          Reflect.deleteProperty(stagedSlotsBySwitchover, oldest);
        }
        session = {
          repoId: request.repoId,
          switchoverId: request.switchoverId,
          totalBatches: request.totalBatches,
          totalSlots: request.totalSlots,
          batches: new Map(),
        };
        stagedSlotsBySwitchover[key] = session;
      } else if (session.totalBatches !== request.totalBatches || session.totalSlots !== request.totalSlots) {
        throw new FleetFault("invalid_field", "Switchover slot staging metadata differs across batches.");
      }
      session.batches.set(request.batchIndex, request.slots);
      let receivedSlots = 0;
      for (const rows of session.batches.values()) receivedSlots += rows.length;
      if (receivedSlots > MAX_STAGED_SLOTS_PER_SWITCHOVER || receivedSlots > session.totalSlots) {
        Reflect.deleteProperty(stagedSlotsBySwitchover, key);
        throw new FleetFault("invalid_field", "Staged switchover replication slots exceed declared totalSlots.");
      }
      return {
        repoId: request.repoId,
        switchoverId: request.switchoverId,
        batchIndex: request.batchIndex,
        receivedSlots,
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
        if (repo.mode !== "remote-edge" || !edge) {
          throw new FleetFault(
            "target_not_remote_edge",
            `Target repository ${request.repoId} is in mode ${repo.mode}, expected remote-edge for switchover activation.`,
          );
        }
        if (!request.callerNodeId) {
          throw new FleetFault(
            "switchover_ceded_proof_invalid",
            "Switchover activation requires an authenticated caller.",
          );
        }
        verifySwitchoverCededProof({
          proof: request.cededProof,
          edge,
          userRoot,
          repoId: request.repoId,
          callerNodeId: request.callerNodeId,
          expectedTargetNodeId: localNodeId,
          switchoverId: request.switchoverId,
          expectedOldEpoch: request.expectedOldEpoch,
          expectedCededEpoch: request.newEpoch,
          frozenCut: request.frozenCut,
        });
        const key = stageKey(request.repoId, request.switchoverId);
        let effectiveSlots: readonly SwitchoverReplicationSlotRow[] | undefined = request.replicationSlots;
        if (request.stagedSlotCount !== undefined) {
          const session = Object.hasOwn(stagedSlotsBySwitchover, key) ? stagedSlotsBySwitchover[key] : undefined;
          if (
            !session ||
            session.batches.size !== session.totalBatches ||
            session.totalSlots !== request.stagedSlotCount
          ) {
            throw new FleetFault(
              "switchover_slots_incomplete",
              `Switchover activation expected ${String(request.stagedSlotCount)} staged replication slots for ${request.switchoverId}, but batches are incomplete.`,
            );
          }
          const assembled: SwitchoverReplicationSlotRow[] = [];
          for (let batchIndex = 0; batchIndex < session.totalBatches; batchIndex += 1) {
            const batch = session.batches.get(batchIndex);
            if (!batch) {
              throw new FleetFault(
                "switchover_slots_incomplete",
                `Missing staged replication slot batch ${String(batchIndex)} for ${request.switchoverId}.`,
              );
            }
            assembled.push(...batch);
          }
          if (
            assembled.length !== request.stagedSlotCount ||
            !request.stagedSlotsDigest ||
            computeSwitchoverSlotsDigest(assembled) !== request.stagedSlotsDigest
          ) {
            throw new FleetFault(
              "switchover_slots_digest_mismatch",
              `Staged replication slot digest or count mismatch for ${request.switchoverId}.`,
            );
          }
          effectiveSlots = assembled;
        }
        const replicaInfo = resolveLocalEdgeReplicaCut(repo.canonicalRoot, userRoot, request.repoId, localNodeId, edge);
        if (!replicaInfo.generation) {
          throw new FleetFault(
            "replica_unavailable",
            `Target replica generation is unavailable for ${request.repoId} on ${localNodeId}.`,
          );
        }
        prepareCenterSymmetricIdentity(userRoot, {
          repoId: request.repoId,
          nodeId: edge.nodeId,
          credential: edge.credential,
          viewRoot: path.isAbsolute(edge.viewRoot) ? edge.viewRoot : path.resolve(repo.canonicalRoot, edge.viewRoot),
          quotaBytes: edge.quotaBytes,
          updatedAt: now(),
        });
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
          ...(effectiveSlots && effectiveSlots.length > 0 ? { replicationSlots: effectiveSlots } : {}),
          now,
        });
        Reflect.deleteProperty(stagedSlotsBySwitchover, key);
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
      const existingWatermark = readExistingEpochWatermark(stateRoot, request.repoId);
      // If this target already promoted/activated >= cededEpoch (or is already running in local center mode),
      // refuse invalidation without mutating disk (preserves F3 refusal after live activation).
      if (existingWatermark >= request.cededEpoch || repo?.mode === "local") {
        return { targetNeverActivated: false, targetInvalidated: false, observedTargetEpoch: existingWatermark };
      }
      const edge = readFleetEdgeConfig(userRoot, request.repoId);
      if (!edge || !request.callerNodeId) {
        throw new FleetFault(
          "switchover_ceded_proof_invalid",
          `Cannot verify switchover invalidation authority for ${request.repoId}: configured source center edge config is missing.`,
        );
      }
      verifySwitchoverCededProof({
        proof: request.cededProof,
        edge,
        userRoot,
        repoId: request.repoId,
        callerNodeId: request.callerNodeId,
        expectedTargetNodeId: localNodeId,
        switchoverId: request.switchoverId,
        expectedCededEpoch: request.cededEpoch,
      });
      Reflect.deleteProperty(stagedSlotsBySwitchover, stageKey(request.repoId, request.switchoverId));
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
  readonly admitSwitchoverAdmin: (node: {
    readonly nodeId: string;
    readonly repoId: string;
    readonly accessToken?: string;
  }) => Promise<unknown>;
  readonly onActivated?: (repoId: string) => void;
}): Promise<Delivery | null> {
  const { nodeId, frame, control, admit, admitSwitchoverAdmin, onActivated } = input;
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
      ...(frame.targetLoginCertificate ? { targetLoginCertificate: frame.targetLoginCertificate } : {}),
      ...(frame.targetLoginServername ? { targetLoginServername: frame.targetLoginServername } : {}),
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
  if (frame.schema === "fleet.switchover.slots.stage/v1") {
    await admitSwitchoverAdmin({ nodeId, repoId: frame.repoId, accessToken: frame.accessToken });
    if (!control?.stageSlots)
      throw new FleetFault("switchover_control_unavailable", "Switchover slot staging endpoint is unavailable.");
    const result = await control.stageSlots({
      repoId: frame.repoId,
      switchoverId: frame.switchoverId,
      expectedTargetNodeId: frame.expectedTargetNodeId,
      batchIndex: frame.batchIndex,
      totalBatches: frame.totalBatches,
      totalSlots: frame.totalSlots,
      slots: frame.slots,
      cededProof: frame.cededProof,
      callerNodeId: nodeId,
    });
    return immediate({
      schema: "fleet.switchover.slots.stage.result/v1",
      messageId: mid(frame.messageId, "sw-slots-stage"),
      inReplyTo: frame.messageId,
      ...result,
    });
  }
  if (frame.schema === "fleet.switchover.activate/v1") {
    await admitSwitchoverAdmin({ nodeId, repoId: frame.repoId, accessToken: frame.accessToken });
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
      ...(frame.stagedSlotCount !== undefined ? { stagedSlotCount: frame.stagedSlotCount } : {}),
      ...(frame.stagedSlotsDigest ? { stagedSlotsDigest: frame.stagedSlotsDigest } : {}),
      cededProof: frame.cededProof,
      callerNodeId: nodeId,
      ...(frame.targetExternalUrl ? { targetExternalUrl: frame.targetExternalUrl } : {}),
      ...(frame.targetLoginUrl ? { targetLoginUrl: frame.targetLoginUrl } : {}),
    });
    onActivated?.(frame.repoId);
    return immediate({
      schema: "fleet.switchover.activate.result/v1",
      messageId: mid(frame.messageId, "sw-activate"),
      inReplyTo: frame.messageId,
      activation,
    });
  }
  if (frame.schema === "fleet.switchover.invalidate/v1") {
    await admitSwitchoverAdmin({ nodeId, repoId: frame.repoId, accessToken: frame.accessToken });
    if (!control?.invalidate)
      throw new FleetFault("switchover_control_unavailable", "Switchover invalidation endpoint is unavailable.");
    const result = await control.invalidate({
      repoId: frame.repoId,
      switchoverId: frame.switchoverId,
      expectedTargetNodeId: frame.expectedTargetNodeId,
      cededEpoch: frame.cededEpoch,
      cededProof: frame.cededProof,
      callerNodeId: nodeId,
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
      ...(payload.targetLoginCertificate ? { targetLoginCertificate: payload.targetLoginCertificate } : {}),
      ...(payload.targetLoginServername ? { targetLoginServername: payload.targetLoginServername } : {}),
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

/** F11: Pre-validate that every outbound slot batch and the final activation frame pass closed wire schema & size caps BEFORE Phase 1 cedes write authority. */
export function measureSwitchoverRemoteActivationTransfer(input: {
  readonly repoId: string;
  readonly switchoverId: string;
  readonly expectedTargetNodeId: string;
  readonly expectedOldEpoch: number;
  readonly newEpoch: number;
  readonly frozenCut: SwitchoverFrozenCut;
  readonly sourceReplicationLogWindow: readonly CenterReplicationLogRow[];
  readonly retentionWindowCommits: number;
  readonly replicationSlots: readonly SwitchoverReplicationSlotRow[];
  readonly cededProof: CenterSwitchoverCededProofV1;
  readonly targetExternalUrl?: string;
  readonly targetLoginUrl?: string;
}): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
  if (input.replicationSlots.length > MAX_STAGED_SLOTS_PER_SWITCHOVER) {
    return {
      ok: false,
      detail: `Replication slot count (${String(input.replicationSlots.length)}) exceeds bounded switchover limit (${String(MAX_STAGED_SLOTS_PER_SWITCHOVER)}).`,
    };
  }
  const useBatchedStaging = input.replicationSlots.length > SWITCHOVER_SLOT_BATCH_SIZE;
  try {
    if (useBatchedStaging) {
      const totalBatches = Math.ceil(input.replicationSlots.length / SWITCHOVER_SLOT_BATCH_SIZE);
      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
        const batch = input.replicationSlots.slice(
          batchIndex * SWITCHOVER_SLOT_BATCH_SIZE,
          (batchIndex + 1) * SWITCHOVER_SLOT_BATCH_SIZE,
        );
        const bytes = measureFleetTransferPayload({
          schema: "fleet.switchover.slots.stage/v1",
          messageId: `precheck_batch_${String(batchIndex)}`,
          repoId: input.repoId,
          switchoverId: input.switchoverId,
          expectedTargetNodeId: input.expectedTargetNodeId,
          batchIndex,
          totalBatches,
          totalSlots: input.replicationSlots.length,
          slots: batch,
          cededProof: input.cededProof,
        });
        if (bytes > FLEET_UPLOAD_MAX_BYTES) {
          return { ok: false, detail: `Switchover slot batch ${String(batchIndex)} exceeds 64 MiB transfer limit.` };
        }
      }
    }
    const activateBytes = measureFleetTransferPayload({
      schema: "fleet.switchover.activate/v1",
      messageId: "precheck_activate",
      repoId: input.repoId,
      switchoverId: input.switchoverId,
      expectedTargetNodeId: input.expectedTargetNodeId,
      expectedOldEpoch: input.expectedOldEpoch,
      newEpoch: input.newEpoch,
      frozenCut: input.frozenCut,
      sourceReplicationLogWindow: input.sourceReplicationLogWindow,
      retentionWindowCommits: input.retentionWindowCommits,
      ...(useBatchedStaging
        ? {
            stagedSlotCount: input.replicationSlots.length,
            stagedSlotsDigest: computeSwitchoverSlotsDigest(input.replicationSlots),
          }
        : input.replicationSlots.length > 0
          ? { replicationSlots: input.replicationSlots }
          : {}),
      cededProof: input.cededProof,
      ...(input.targetExternalUrl ? { targetExternalUrl: input.targetExternalUrl } : {}),
      ...(input.targetLoginUrl ? { targetLoginUrl: input.targetLoginUrl } : {}),
    });
    if (activateBytes > FLEET_UPLOAD_MAX_BYTES) {
      return { ok: false, detail: "Switchover activation payload exceeds 64 MiB transfer limit." };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
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
    const slots = payload.replicationSlots ?? [];
    const useBatchedStaging = slots.length > SWITCHOVER_SLOT_BATCH_SIZE;
    let stagedSlotCount: number | undefined;
    let stagedSlotsDigest: string | undefined;
    if (useBatchedStaging) {
      const totalBatches = Math.ceil(slots.length / SWITCHOVER_SLOT_BATCH_SIZE);
      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
        const batch = slots.slice(
          batchIndex * SWITCHOVER_SLOT_BATCH_SIZE,
          (batchIndex + 1) * SWITCHOVER_SLOT_BATCH_SIZE,
        );
        const stageReply = await peer.request(
          {
            schema: "fleet.switchover.slots.stage/v1",
            messageId: peer.messageId(),
            repoId: payload.repoId,
            switchoverId: payload.switchoverId,
            expectedTargetNodeId: payload.expectedTargetNodeId,
            batchIndex,
            totalBatches,
            totalSlots: slots.length,
            slots: batch,
            cededProof: payload.cededProof,
          },
          options.timeoutMs ?? 60_000,
        );
        if (stageReply.schema !== "fleet.switchover.slots.stage.result/v1")
          throw new Error("Switchover slot staging result expected.");
      }
      stagedSlotCount = slots.length;
      stagedSlotsDigest = computeSwitchoverSlotsDigest(slots);
    }
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
        ...(!useBatchedStaging && slots.length > 0 ? { replicationSlots: slots } : {}),
        ...(stagedSlotCount !== undefined ? { stagedSlotCount } : {}),
        ...(stagedSlotsDigest ? { stagedSlotsDigest } : {}),
        cededProof: payload.cededProof,
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
        cededProof: payload.cededProof,
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
  readonly fallbackLoginCertificate?: string;
  readonly fallbackLoginServername?: string;
  readonly readAccessToken?: () => Promise<string | undefined>;
}): Promise<{ readonly registered: boolean; readonly nodeId?: string; readonly error?: string }> {
  const edge = readFleetEdgeConfig(input.userRoot, input.repoId);
  if (!edge || edge.repoId !== input.repoId) return { registered: false };
  try {
    const certPem = readFileSync(input.listenerCertPath);
    const targetSpkiSha256 = spkiSha256FromCertificatePem(certPem);
    const fallbackHost =
      input.listenerBind === "0.0.0.0" || input.listenerBind === "::" ? "127.0.0.1" : input.listenerBind;
    const targetExternalUrl = input.listenerExternalUrl ?? `https://${fallbackHost}:${String(input.listenerPort)}`;
    const selectedAuthority = input.canonicalRoot
      ? oidcCenterSelections(input.userRoot).read(input.canonicalRoot)?.authority
      : undefined;
    let targetLoginUrl = targetExternalUrl;
    let targetLoginCertificate: string | undefined;
    let targetLoginServername: string | undefined;
    if (edge.loginUrl) {
      targetLoginUrl = edge.loginUrl;
      targetLoginCertificate = edge.loginCertificate;
      targetLoginServername = edge.loginServername;
    } else if (input.fallbackLoginUrl) {
      targetLoginUrl = input.fallbackLoginUrl;
      targetLoginCertificate = input.fallbackLoginCertificate;
      targetLoginServername = input.fallbackLoginServername;
    } else if (selectedAuthority?.url) {
      targetLoginUrl = selectedAuthority.url;
      targetLoginCertificate = selectedAuthority.certificate;
      targetLoginServername = selectedAuthority.servername;
    }
    const targetServername = extractCertificateDnsName(certPem) ?? new URL(targetExternalUrl).hostname;
    const caPath = path.isAbsolute(edge.caPath)
      ? edge.caPath
      : path.resolve(fleetEdgeConfigDir(input.userRoot, input.repoId), edge.caPath);
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
        ...(targetLoginCertificate ? { targetLoginCertificate } : {}),
        ...(targetLoginServername ? { targetLoginServername } : {}),
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
): Promise<boolean> {
  if (authorityRepo.mode !== "remote-edge" || !authorityRepo.canonicalRoot) return false;
  const { repoId, canonicalRoot } = authorityRepo;
  const edgeConfig = readFleetEdgeConfig(userRoot, repoId);
  if (!edgeConfig) return false;
  const discoveredLogin = oidc.discovery(edgeConfig.nodeId);
  const outcome = await announceSwitchoverCandidateToCenter({
    userRoot,
    repoId,
    canonicalRoot,
    listenerPort,
    listenerBind: config.bind,
    ...(config.externalUrl ? { listenerExternalUrl: config.externalUrl } : {}),
    listenerCertPath: config.certPath,
    ...(discoveredLogin?.url ? { fallbackLoginUrl: discoveredLogin.url } : {}),
    ...(discoveredLogin?.certificate ? { fallbackLoginCertificate: discoveredLogin.certificate } : {}),
    ...(discoveredLogin?.servername ? { fallbackLoginServername: discoveredLogin.servername } : {}),
    readAccessToken: createFleetReplicaAccessTokenReader({
      config: edgeConfig,
      configDir: fleetEdgeConfigDir(userRoot, repoId),
      readUserAccessToken: async () =>
        resolveBoundAccessToken(await oidc.bind({ transportKind: "unix-socket" }, canonicalRoot)),
    }),
  });
  return outcome.registered;
}

/**
 * F1: Tracks standby-candidate registration across live mode transitions (e.g. old Center A demoted
 * in place to `remote-edge` while keeping its existing TLS listener running) and replica recovery transitions.
 * Deduplicates successful announcements per `(centerEndpoint, listenerPort, certPath)` and retries automatically
 * after any failed attempt once the replica stream confirms connectivity.
 */
export function createStandbyCandidateAnnouncer(input: {
  readonly userRoot: string;
  readonly daemonId: string;
  readonly getFleetCenter: () => { readonly port: number } | null;
  readonly oidc: import("@harness-anything/kernel").IdentitySessionPort;
}) {
  const announcedKeys = new Map<string, string | undefined>();
  const inFlight = new Map<string, boolean>();
  return {
    announceIfReady: (repoId: string, canonicalRoot: string): void => {
      const center = input.getFleetCenter();
      if (!center || inFlight.get(repoId) === true) return;
      const config = readFleetCenterConfig(input.userRoot, input.daemonId);
      if (!config || config.repoId !== repoId) return;
      const edge = readFleetEdgeConfig(input.userRoot, repoId);
      if (!edge || edge.repoId !== repoId) return;
      const key = `${edge.host}:${String(edge.port)}:${edge.spkiSha256 ?? ""}:${String(center.port)}:${config.certPath}:${config.externalUrl ?? ""}`;
      if (announcedKeys.get(repoId) === key) return;
      inFlight.set(repoId, true);
      void announceRestoredStandbyCandidate(
        input.userRoot,
        { repoId, mode: "remote-edge", canonicalRoot },
        center.port,
        config,
        input.oidc,
      )
        .then((registered) => {
          if (registered) announcedKeys.set(repoId, key);
        })
        .finally(() => {
          inFlight.set(repoId, false);
        });
    },
    clear: (repoId: string): void => {
      announcedKeys.set(repoId, undefined);
    },
  };
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
