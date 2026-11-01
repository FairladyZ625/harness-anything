import { validateTaskDispatchesPayload } from "../protocol/daemon-protocol-rpc-validation.ts";
import { createFleetDeliveryDrain } from "./center-delivery-drain.ts";
import { createResourceBudget, DOC_SHOW_BUDGET_LIMITS, ResourceBudgetExceeded } from "./resource-budget.ts";
import { fetchWorkerDelivery, workerGitIdentityForPerson } from "../runtime-worker-push.ts";
import { assertFleetDeliveryHolder, type FleetDeliveryTask } from "../fleet-task-delivery.ts";
import type { JsonObject } from "../protocol/json-rpc-types.ts";
import { isSquadControlResult } from "../squad-control-result.ts";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import { createServer, type Server, type TLSSocket } from "node:tls";
import { resolveHarnessLayout, sha256Bytes, TASK_EVENT_SHAPE_COMPAT_VERSION } from "@harness-anything/kernel";
import { daemonBuildStamp } from "../build-identity.ts";
import { readFileWindow, syncDirectory, syncFile } from "@harness-anything/storage";
import {
  openPersistentWriterEpoch,
  readLedgerWriterEpoch,
  type PersistentWriterEpoch,
} from "@harness-anything/storage";
import { runtimeErrorCode, runtimeErrorMessage } from "../runtime-spawn-errors.ts";
import {
  discardOwnedClaims as discardOwnedClaimsImpl,
  findOwnedClaim as findOwnedClaimImpl,
  reclaimConsumedClaims,
  uploadWindow,
  verifyOwnedClaims as verifyOwnedClaimsImpl,
} from "./center-lease-claims.ts";
import { digestId, immediate, loadState, mid, ownedUpload, serve, writeCenterDurableJson } from "./center-transport.ts";
import { createHelloRateLimiter } from "./center-hello-guard.ts";
import type { Delivery, FleetCenterOptions, FleetTlsCenter, SessionWindow } from "./center-types.ts";
import { FleetFault } from "./center-types.ts";
import { FLEET_CHUNK_BYTES, type FleetFrameV1 } from "./command-protocol.ts";
import {
  makeTaskEventReader,
  makeTaskProjection,
  openSqliteEventStore,
  sqliteLedgerPath,
} from "@harness-anything/storage";
import { runWalSender } from "./walsender.ts";
import { createReplicationRetention, openReplicationSlots, replicationSlotKey } from "@harness-anything/storage";
import { startBaseBackup } from "@harness-anything/storage";
import { createNodeRetirementAdmission } from "./node-retirement.ts";
import { createReplicaStatusTracker } from "./replica-status.ts";
import { readFleetCenterGitMetadata } from "../fleet-edge-git-preflight.ts";
/** The replication head poll interval: commit-to-edge latency floor versus idle reads. */
const REPLICATION_HEAD_POLL_MS = 50;
/** Edges treat three missed keepalives as a dead connection (peer.ts). */
export const REPLICATION_KEEPALIVE_MS = 15_000;
/** Active (unfinished) uploads one node may hold across all of its sessions. */
const FLEET_NODE_ACTIVE_UPLOADS = 16;
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
export async function listenFleetTls(options: FleetCenterOptions): Promise<FleetTlsCenter> {
  mkdirSync(options.stateRoot, { recursive: true });
  const closing = new AbortController();
  const nodeAdmission = createNodeRetirementAdmission();
  const deliveries = createFleetDeliveryDrain(options.onDeliverySettled);
  const resourceBudget = createResourceBudget(DOC_SHOW_BUDGET_LIMITS);
  const stateFile = path.join(options.stateRoot, "state.json"),
    state = loadState(stateFile),
    now = options.now ?? (() => new Date().toISOString()),
    writerEpoch = openPersistentWriterEpoch({
      stateRoot: options.writerEpochStateRoot ?? options.stateRoot,
      holderId: options.writerId,
      now,
    }),
    ownedEpochs = new Map<string, ReturnType<PersistentWriterEpoch["acquire"]>>(),
    acquireWriterEpoch =
      options.writerEpochLease ??
      ((repoId: string) => {
        const rootDir = options.host.status().repos.find((repo) => repo.repoId === repoId)?.rootDir;
        return writerEpoch.acquire(repoId, readLedgerWriterEpoch(repoId, rootDir));
      });
  for (const repo of options.host.status().repos)
    if (repo.state === "attached") ownedEpochs.set(repo.repoId, acquireWriterEpoch(repo.repoId));
  // A center must keep using the epoch it acquired, even after another center
  // advances the shared state. Reading the latest row here would let a stale
  // process silently adopt its successor's epoch and defeat fencing.
  const ownedEpochFor = (repoId: string) => {
      const owned = ownedEpochs.get(repoId);
      if (owned) return owned;
      const lease = acquireWriterEpoch(repoId);
      ownedEpochs.set(repoId, lease);
      return lease;
    },
    currentEpochFor = (repoId: string) => writerEpoch.current(repoId) ?? ownedEpochFor(repoId),
    // dec_F01770FD0DCF72683B7C4C7A47: each request presents this device owner's user session.
    readerAuth = async (node: { nodeId: string; repoId: string; accessToken?: string }) => {
      nodeAdmission.assertOpen(node.nodeId);
      const personId = await options.nodeOwner(node.nodeId);
      if (!personId) throw new FleetFault("node_owner_unregistered", `Node ${node.nodeId} has no registered owner.`);
      if (!node.accessToken || !options.verifyHuman)
        throw new FleetFault("authentication_required", "Sign in on this device before using Fleet.");
      try {
        const invitation = options.invitationClientForNode?.(node.nodeId);
        const principal = await options.verifyHuman({
          transportKind: "fleet-tls",
          nodePrincipal: { nodeId: node.nodeId, personId },
          humanAccessToken: node.accessToken,
          ...(invitation && invitation.personId === personId
            ? { fleetExpectedAzps: [{ clientId: invitation.clientId, personId: invitation.personId }] }
            : {}),
        });
        nodeAdmission.assertOpen(node.nodeId);
        return principal;
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string")
          throw new FleetFault(error.code, error instanceof Error ? error.message : "Device session was rejected.");
        throw error;
      }
    },
    principalAuth = async (
      node: { nodeId: string; repoId: string; accessToken?: string },
      accessToken?: string,
      executionCredential?: string,
    ): Promise<DaemonAuthenticationContext> => ({
      ...(await readerAuth({ ...node, accessToken: accessToken ?? node.accessToken })),
      ...(executionCredential ? { executionCredential } : {}),
    }),
    writerAuth = async (
      node: { nodeId: string; repoId: string; accessToken?: string },
      accessToken?: string,
      executionCredential?: string,
    ) => {
      const lease = ownedEpochFor(node.repoId);
      const principal = await principalAuth(node, accessToken, executionCredential);
      nodeAdmission.assertOpen(node.nodeId);
      return {
        ...principal,
        writerEpoch: lease.epoch,
        withWriterEpochFence: <T>(operation: () => T) =>
          writerEpoch.withAppendFence(node.repoId, lease.epoch, lease.holderId, operation),
        writerEpochFence: {
          schema: "harness-writer-epoch-fence/v1" as const,
          stateRoot: options.writerEpochStateRoot ?? options.stateRoot,
          repoId: node.repoId,
          epoch: lease.epoch,
          holderId: lease.holderId,
        },
      };
    };
  // The one repository admission port: reader identity plus the node owner's grant on this
  // repository (dec_66CE6F92 — a cross-cutting responsibility has a single implementation that
  // callers reuse instead of copying).
  const repoAdmission = async (node: { nodeId: string; repoId: string; accessToken?: string }) => {
    const principal = await readerAuth(node),
      decision = await options.host.authorize(node.repoId, "repository-read", principal);
    if (decision.outcome !== "allowed")
      throw new FleetFault("authorization_denied", "The node owner may not read this repository.");
    return principal;
  };
  const extracted = {
    get state() {
      return state;
    },
    get persist() {
      return persist;
    },
    get FleetFault() {
      return FleetFault;
    },
    get safeLocal() {
      return safeLocal;
    },
    get uploadPath() {
      return uploadPath;
    },
  };
  const replicationSlots = openReplicationSlots(path.join(options.stateRoot, "replication-slots.sqlite"));
  // The cap only bounds a slot that never returns: log rows are a few columns, while a slot past the cap
  // costs a full base backup. A busy center writes thousands of commits a day; keep months of them.
  const retentionWindowCommits = options.replicationRetentionWindowCommits ?? 1_000_000;
  const retentions = new Map<string, ReturnType<typeof createReplicationRetention>>();
  // Slots hold the log back to their slowest ACK, capped by the window; pruning is a write, so it
  // runs on the repository's single writer, never on a replication reader's read-only connection.
  const retentionFor = (repoId: string) => {
    let retention = retentions.get(repoId);
    if (!retention)
      retentions.set(
        repoId,
        (retention = createReplicationRetention({
          windowCommits: retentionWindowCommits,
          slotFloor: (head) => replicationSlots.minimumAck(repoId, head.history),
          prune: (beforeSequence) => options.host.pruneReplicationLog(repoId, beforeSequence),
        })),
      );
    return retention;
  };
  const readReplicationHead = (repoId: string) => {
    const rootDir = repoRoot(repoId),
      store = openSqliteEventStore({
        databasePath: sqliteLedgerPath(rootDir),
        rootInput: rootDir,
        repoId,
        readOnly: true,
      });
    try {
      return store.replicationPosition();
    } finally {
      store.close();
    }
  };
  const replicationHead = (repoId: string): number => readReplicationHead(repoId).sequence;
  // The only center write entry for transport frames. The writer callback is
  // deliberately private to this listener; callers must supply the frame so
  // the gate can prove every write branch crosses this boundary.
  const runFleetCenterWrite = async <T>(frame: FleetFrameV1, execute: () => T | Promise<T>): Promise<T> => {
    if (!frame.schema.startsWith("fleet.") || frame.schema.endsWith(".result/v1"))
      throw new FleetFault("invalid_write_frame", "Center write entry requires a Fleet request frame.");
    return execute();
  };
  const runCenterWriter = (...args: Parameters<typeof options.host.run>) => options.host.run(...args);
  const writeReplicationSequence = (repoId: string, receipt: unknown): number | null =>
    typeof receipt === "object" && receipt !== null && "outcome" in receipt && receipt.outcome === "applied"
      ? replicationHead(repoId)
      : null;
  const projectionReady = new Map<string, Promise<void>>();
  const backupQueues = new Map<string, Promise<void>>();
  type CachedBackup = {
    readonly archive: Promise<import("@harness-anything/storage").BaseBackupArchive>;
    readonly directory: string;
    users: number;
    readonly releaseQueue: () => void;
  };
  const backupCache = new Map<string, CachedBackup>();
  // Each backup owns a directory under replication-backups; none outlives the process that built it.
  const backupsRoot = path.join(options.stateRoot, "replication-backups");
  rmSync(backupsRoot, { recursive: true, force: true });
  const retireBackup = (repoId: string, cached: CachedBackup): void => {
    if (backupCache.get(repoId) === cached) backupCache.delete(repoId);
    cached.releaseQueue();
    rmSync(cached.directory, { recursive: true, force: true });
  };
  // Concurrent edges share one archive. It is deleted with its last user: kept longer, its retention pin
  // would hold the log back and a later edge could get a start already past the retention window.
  const releaseBackupUser = (repoId: string, cached: CachedBackup): void => {
    cached.users -= 1;
    if (cached.users === 0) retireBackup(repoId, cached);
  };
  const onReplicationStart = async (
    nodeId: string,
    accessToken: string | undefined,
    frame: import("./protocol.ts").ReplicationFrame & { readonly type: "replica.start" },
    peer: import("./protocol.ts").ReplicationPeer,
    signal: AbortSignal,
  ) => {
    let readerProfile: { personId: string; nodeId: string };
    try {
      ({ readerProfile } = await admitReplica(nodeId, frame.repoId, accessToken));
      nodeAdmission.assertOpen(nodeId);
    } catch (error) {
      if (error instanceof FleetFault && error.code === "authorization_denied") {
        await peer.send({ type: "replica.resync", reason: "authorization_denied" });
        throw error;
      }
      throw error;
    }
    const centerBuildCommit = daemonBuildStamp().commit,
      replicaKeyForNode = { nodeId, repoId: frame.repoId };
    if ((frame.taskEventShapeVersion ?? 0) < TASK_EVENT_SHAPE_COMPAT_VERSION) {
      const failure = {
        code: "edge_upgrade_required",
        message: `Edge must upgrade to center build ${centerBuildCommit?.slice(0, 7) ?? "unknown"} before applying task event shape ${TASK_EVENT_SHAPE_COMPAT_VERSION}.`,
      };
      replicaStatus.recordFailure(replicaKeyForNode, failure);
      await peer.send({
        type: "replica.reject",
        ...failure,
        centerBuildCommit,
        taskEventShapeVersion: TASK_EVENT_SHAPE_COMPAT_VERSION,
      });
      throw new FleetFault(failure.code, failure.message);
    }
    await peer.send({
      type: "replica.accept",
      centerBuildCommit,
      taskEventShapeVersion: TASK_EVENT_SHAPE_COMPAT_VERSION,
    });
    const rootDir = repoRoot(frame.repoId),
      layout = resolveHarnessLayout(rootDir);
    const store = openSqliteEventStore({
      databasePath: sqliteLedgerPath(rootDir),
      rootInput: rootDir,
      repoId: frame.repoId,
      readOnly: true,
    });
    let ready = projectionReady.get(frame.repoId);
    if (!ready) {
      ready = (async () => {
        const events = makeTaskEventReader({ rootDir, repoId: frame.repoId });
        const projection = makeTaskProjection({
          rootDir,
          projectionPath: path.join(layout.localRoot, "cache", "task.sqlite"),
          eventStore: events,
        });
        projection.catchUp?.();
        projection.close();
        await events.drain();
      })();
      projectionReady.set(frame.repoId, ready);
    }
    try {
      await ready;
    } catch (error) {
      // A failed catch-up fails this session; the next one tries again instead of reusing the rejection.
      if (projectionReady.get(frame.repoId) === ready) projectionReady.delete(frame.repoId);
      throw error;
    }
    const slots = replicationSlots;
    nodeAdmission.assertOpen(nodeId);
    const lease = slots.claim({ repoId: frame.repoId, nodeId }, store.replicationPosition().history);
    const retention = retentionFor(frame.repoId);
    const source = {
      read: (after: import("@harness-anything/storage").ReplicationPosition) => {
        const head = store.replicationPosition();
        // A slot beyond the retention cap has lost its suffix (max_slot_wal_keep_size): resync.
        if (head.sequence - after.sequence > retentionWindowCommits) return null;
        return store.replicationCommits(after, 64);
      },
      acknowledged: () => retention.advance(store.replicationPosition()),
      // Commits land in the repo writer process, so this process polls the head on a short timer; an
      // idle stream costs one indexed read per interval, never a spinning event loop.
      // Returning without a new commit makes the sender emit `replica.progress`: the idle keepalive.
      wait: async (after: import("@harness-anything/storage").ReplicationPosition, waitSignal: AbortSignal) => {
        const until = AbortSignal.any([
          waitSignal,
          AbortSignal.timeout(options.replicationKeepaliveMs ?? REPLICATION_KEEPALIVE_MS),
        ]);
        while (!until.aborted && store.replicationPosition().sequence <= after.sequence)
          await delay(REPLICATION_HEAD_POLL_MS, until);
      },
      backup: async (backupSignal: AbortSignal) => {
        const cached = backupCache.get(frame.repoId);
        if (cached) {
          cached.users += 1;
          return {
            ...(await cached.archive),
            metadata: { ...(await cached.archive).metadata, readerProfile },
            release: async () => releaseBackupUser(frame.repoId, cached),
          };
        }
        const previous = backupQueues.get(frame.repoId) ?? Promise.resolve();
        let release!: () => void;
        const turn = new Promise<void>((resolve) => (release = resolve));
        backupQueues.set(
          frame.repoId,
          previous.then(() => turn),
        );
        await previous;
        // Pin a start no later than the snapshot, so the log keeps the suffix this backup resumes from.
        const unpin = retention.pin(store.replicationPosition());
        const directory = path.join(backupsRoot, randomUUID());
        const started = startBaseBackup(
          {
            ledgerPath: store.databasePath,
            projectionPath: path.join(layout.localRoot, "cache", "task.sqlite"),
            directory,
          },
          backupSignal,
        );
        const archivePromise = started.then((pinned) => pinned.complete).then((archive) => archive);
        const cachedArchive: CachedBackup = {
          archive: archivePromise,
          directory,
          users: 1,
          releaseQueue: () => {
            unpin();
            release();
          },
        };
        backupCache.set(frame.repoId, cachedArchive);
        try {
          const archive = await archivePromise;
          return {
            ...archive,
            metadata: { ...archive.metadata, readerProfile },
            release: async () => releaseBackupUser(frame.repoId, cachedArchive),
          };
        } catch (error) {
          retireBackup(frame.repoId, cachedArchive);
          throw error;
        }
      },
      object: async function* (sha256: string) {
        const bytes = store.readContentObject(sha256);
        if (bytes === null) throw new Error(`replication content object missing: ${sha256}`);
        yield bytes;
      },
    };
    try {
      await runWalSender({
        peer,
        source,
        slots,
        lease,
        signal,
        onFailure: (failure) => replicaStatus.recordFailure(replicaKeyForNode, failure),
        onAcknowledged: () => replicaStatus.clearFailure(replicaKeyForNode),
      });
    } finally {
      store.close();
    }
  };
  function verifyOwnedClaims(
    nodeId: string,
    repoId: string,
    changes: Parameters<typeof verifyOwnedClaimsImpl>[3],
  ): void {
    return verifyOwnedClaimsImpl(extracted, nodeId, repoId, changes);
  }
  function findOwnedClaim(nodeId: string, repoId: string, descriptor: Parameters<typeof findOwnedClaimImpl>[3]) {
    return findOwnedClaimImpl(extracted, nodeId, repoId, descriptor);
  }
  function discardOwnedClaims(
    nodeId: string,
    repoId: string,
    changes: readonly { readonly candidate: { readonly ref: string } }[],
  ): void {
    return discardOwnedClaimsImpl(extracted, nodeId, repoId, changes);
  }
  const persist = () => writeCenterDurableJson(stateFile, state),
    auth = writerAuth;
  // Every frame after the hello belongs to one TLS session, and that session's hello named the
  // interactive client Keycloak minted its human token under. Carrying it here means each branch
  // inherits the session's client instead of re-deriving one per frame (the center audits `azp`).
  const nodeContext = async (nodeId: string, repoId: string, accessToken?: string) => {
    const node = { nodeId, repoId, accessToken };
    repoRoot(repoId);
    return node;
  };
  const repoRoot = (repoId: string) => {
    const found = options.host.status().repos.find((repo) => repo.repoId === repoId && repo.state === "attached");
    if (!found) throw new FleetFault("repo_unavailable", `Repo ${repoId} is unavailable.`, true);
    return found.rootDir;
  };
  const assertFrameEpoch = (repoId: string, provided: number): void => {
    const current = currentEpochFor(repoId);
    if (provided !== current.epoch)
      throw new FleetFault(
        "writer_epoch_stale",
        [
          "writer epoch ",
          `${provided}`,
          " is stale for ",
          `${repoId}`,
          "; current epoch is ",
          `${current.epoch}`,
          ". Query the receipt or reacquire admission before retrying.",
        ].join(""),
      );
  };
  const safeLocal = (repoId: string, child: string) => {
      const local = resolveHarnessLayout(repoRoot(repoId)).localRoot,
        target = path.join(local, child);
      if (
        (existsSync(local) && lstatSync(local).isSymbolicLink()) ||
        (existsSync(target) && lstatSync(target).isSymbolicLink())
      )
        throw new FleetFault("unsafe_staging", "Fleet staging cannot traverse a symbolic link.");
      return target;
    },
    uploadPath = (uploadId: string, upload = state.uploads[uploadId]) => {
      if (!upload) throw new FleetFault("upload_unknown", "Upload metadata is missing.");
      return path.join(safeLocal(upload.repoId, "fleet-uploads"), `${uploadId}.part`);
    };
  for (const repo of options.host.status().repos)
    if (repo.state === "attached") reclaimConsumedClaims(extracted, repo.repoId);
  const admitReplica = async (nodeId: string, repoId: string, accessToken?: string) => {
    if (!Number.isSafeInteger(options.replicaDiskQuotaBytes) || options.replicaDiskQuotaBytes! <= 0)
      throw new FleetFault("replica_quota_required", "Replica admission requires an explicit persistent disk quota.");
    const a = await nodeContext(nodeId, repoId, accessToken);
    // The node owner's repository-read authority admits the replica
    // (dec_B6AC9F76D9D6591A3F54802BF3, refining dec_D8497012 CH4).
    await repoAdmission(a);
    const owner = await options.nodeOwner(nodeId);
    if (!owner) throw new FleetFault("node_owner_unregistered", `Node ${nodeId} has no registered owner.`);
    const replica = options.host.replica(a.repoId);
    return { a, replica, readerProfile: { personId: owner, nodeId } };
  };
  const handle = async (
    nodeId: string,
    frame: FleetFrameV1,
    window: SessionWindow,
    _clientGone: () => boolean = () => false,
    connectionSignal: AbortSignal,
    _progress: (frame: FleetFrameV1) => Promise<void>,
  ): Promise<Delivery> => {
    if (frame.schema === "fleet.device.sessions.revoke/v1") {
      if (!(await options.nodeOwner(nodeId)))
        throw new FleetFault("node_owner_unregistered", `Node ${nodeId} is not active.`);
      if (!options.revokeDeviceSessions)
        throw new FleetFault("device_login_unavailable", "Device session revocation is unavailable.");
      await options.revokeDeviceSessions(nodeId);
      return immediate({
        schema: "fleet.device.sessions.revoked/v1",
        messageId: mid(frame.messageId, "device"),
        inReplyTo: frame.messageId,
      });
    }
    if (frame.schema === "fleet.device.login/v1") {
      const personId = await options.nodeOwner(nodeId);
      if (!personId) throw new FleetFault("node_owner_unregistered", `Node ${nodeId} has no registered owner.`);
      if (!options.deviceLoginNotice)
        throw new FleetFault("device_login_unavailable", "Device login notices are unavailable.");
      options.deviceLoginNotice(nodeId, personId, frame);
      return immediate({
        schema: "fleet.device.login.result/v1",
        messageId: mid(frame.messageId, "device"),
        inReplyTo: frame.messageId,
      });
    }
    if (frame.schema === "fleet.repo.metadata.get/v1") {
      const a = await nodeContext(nodeId, frame.repoId, frame.accessToken),
        principal = await readerAuth(a),
        baseLedgerSha = options.host.replica(a.repoId).ledgerCut(),
        actionAllowed =
          frame.actionKind === undefined
            ? null
            : (
                await options.host.authorize(
                  a.repoId,
                  frame.actionKind,
                  {
                    ...principal,
                    ...(frame.executionCredential ? { executionCredential: frame.executionCredential } : {}),
                  },
                  frame.taskId ? { taskId: frame.taskId } : undefined,
                )
              ).outcome === "allowed";
      if (!baseLedgerSha) throw new FleetFault("projection_pending", "Current ledger cut is unavailable.", true);
      const centerGit = frame.includeGitMetadata
        ? await readFleetCenterGitMetadata(
            options.host.status().repos.find((repo) => repo.repoId === a.repoId)?.rootDir ?? "",
          )
        : { originUrl: null, originPushUrls: [], defaultBranch: null, defaultBranchCommit: null };
      return immediate({
        schema: "fleet.repo.metadata.result/v1",
        personId: principal.nodePrincipal!.personId,
        actionAllowed,
        messageId: mid(frame.messageId, "metadata"),
        inReplyTo: frame.messageId,
        repoId: a.repoId,
        baseLedgerSha,
        writerEpoch: ownedEpochFor(a.repoId).epoch,
        replicationSequence: replicationHead(a.repoId),
        originUrl: centerGit.originUrl,
        originPushUrls: centerGit.originPushUrls,
        defaultBranch: centerGit.defaultBranch,
        defaultBranchCommit: centerGit.defaultBranchCommit,
      });
    }
    if (frame.schema === "fleet.receipt.get/v1") {
      const a = await nodeContext(nodeId, frame.repoId, frame.accessToken),
        receipt = await runCenterWriter(a.repoId, { kind: "receipt-show", opId: frame.opId }, await readerAuth(a));
      return immediate({
        schema: "fleet.receipt.result/v1",
        messageId: mid(frame.messageId, "receipt"),
        inReplyTo: frame.messageId,
        opId: frame.opId,
        receipt: receipt as unknown as Record<string, unknown>,
      });
    }
    if (frame.schema === "fleet.upload.begin/v1") {
      return runFleetCenterWrite(frame, async () => {
        const a = await nodeContext(nodeId, frame.repoId, frame.accessToken),
          uploadId = digestId(
            nodeId,
            a.repoId,
            frame.content.sha256,
            String(frame.content.size),
            frame.content.mediaType,
          );
        await repoAdmission(a);
        reclaimConsumedClaims(extracted, a.repoId);
        for (const id of window.uploads) if (state.uploads[id]?.descriptor !== null) window.uploads.delete(id);
        let upload = state.uploads[uploadId];
        if (upload && JSON.stringify(upload.content) !== JSON.stringify(frame.content))
          throw new FleetFault("upload_conflict", "Upload identity conflicts with persisted metadata.");
        const occupancy = uploadWindow(state),
          node = occupancy.nodes.find((entry) => entry.nodeId === nodeId),
          detail = `receiving=${occupancy.receiving}, staged=${occupancy.staged}, limit=${occupancy.limit}`;
        if (!upload && occupancy.receiving >= occupancy.limit)
          throw new FleetFault("busy", `Upload recovery window is full (${detail}).`, true);
        if (!upload && (node?.receiving ?? 0) >= FLEET_NODE_ACTIVE_UPLOADS)
          throw new FleetFault(
            "busy",
            `Node already has ${FLEET_NODE_ACTIVE_UPLOADS} active uploads (node staged=${node?.staged ?? 0}; ${detail}).`,
            true,
          );
        if (!upload?.descriptor && !window.uploads.has(uploadId) && window.uploads.size >= 8) {
          const file = upload ? uploadPath(uploadId, upload) : null;
          throw new FleetFault(
            "busy",
            `Session upload window is full (receiving=${window.uploads.size}, limit=8; global ${detail}).`,
            true,
            file && existsSync(file) ? statSync(file).size : 0,
          );
        }
        if (!upload)
          upload = state.uploads[uploadId] = {
            nodeId,
            repoId: a.repoId,
            content: frame.content,
            descriptor: null,
          };
        const file = uploadPath(uploadId, upload);
        if (!upload.descriptor) {
          mkdirSync(path.dirname(file), { recursive: true });
          if (!existsSync(file)) writeFileSync(file, "");
        }
        if (!upload.descriptor) window.uploads.add(uploadId);
        persist();
        return immediate({
          schema: "fleet.upload.ready/v1",
          messageId: mid(frame.messageId, "ready"),
          inReplyTo: frame.messageId,
          uploadId,
          resumeOffset: upload.descriptor ? upload.content.size : existsSync(file) ? statSync(file).size : 0,
          status: upload.descriptor ? "already_staged" : "receiving",
          replicationSequence: null,
        });
      });
    }
    if (frame.schema === "fleet.upload.chunk/v1") {
      return runFleetCenterWrite(frame, async () => {
        const upload = ownedUpload(state, nodeId, frame.uploadId);
        await repoAdmission({ nodeId, repoId: upload.repoId, accessToken: frame.accessToken });
        const file = uploadPath(frame.uploadId),
          bytes = Buffer.from(frame.dataBase64, "base64");
        if (frame.offset + bytes.length > upload.content.size)
          throw new FleetFault(
            "upload_oversize",
            "Chunk extends past the declared upload size.",
            false,
            upload.content.size,
          );
        const length = existsSync(file) ? statSync(file).size : 0;
        if (frame.offset > length)
          throw new FleetFault("upload_gap", "Chunk offset is beyond the durable prefix.", true, length);
        if (frame.offset < length) {
          // Replay comparison reads only the contested window; the durable
          // prefix can be far larger than the chunk being retried.
          if (!readFileWindow(file, frame.offset, bytes.length).equals(bytes))
            throw new FleetFault("upload_replay_mismatch", "Replayed chunk differs from durable bytes.");
        } else {
          appendFileSync(file, bytes);
          syncFile(file);
        }
        return immediate({
          schema: "fleet.upload.ready/v1",
          messageId: mid(frame.messageId, "chunk"),
          inReplyTo: frame.messageId,
          uploadId: frame.uploadId,
          resumeOffset: statSync(file).size,
          status: "receiving",
          replicationSequence: null,
        });
      });
    }
    if (frame.schema === "fleet.upload.finish/v1") {
      return runFleetCenterWrite(frame, async () => {
        const upload = state.uploads[frame.uploadId];
        if (!upload || upload.nodeId !== nodeId)
          throw new FleetFault("upload_unknown", "Upload is unknown or belongs to another node.");
        await readerAuth({ nodeId, repoId: upload.repoId, accessToken: frame.accessToken });
        const wasStaged = upload.descriptor !== null,
          file = uploadPath(frame.uploadId, upload),
          a = await nodeContext(nodeId, upload.repoId, frame.accessToken),
          descriptor = upload.descriptor ?? {
            ref: `doc-sync-claims/${frame.uploadId}`,
            ...upload.content,
          },
          target = path.join(safeLocal(a.repoId, "doc-sync-claims"), frame.uploadId);
        if (!upload.descriptor) {
          const source = existsSync(file) ? file : target;
          if (!existsSync(source)) throw new FleetFault("upload_missing", "Durable upload prefix is missing.", true, 0);
          const bytes = readFileSync(source);
          if (bytes.byteLength !== upload.content.size || sha256Bytes(bytes) !== upload.content.sha256)
            throw new FleetFault(
              "content_claim_mismatch",
              "Upload size or digest does not match the declaration.",
              true,
              bytes.byteLength,
            );
          mkdirSync(path.dirname(target), { recursive: true });
          if (source !== target) {
            renameSync(source, target);
            syncDirectory(path.dirname(source));
          }
          syncDirectory(path.dirname(target));
          upload.descriptor = descriptor;
          await persist();
        }
        window.uploads.delete(frame.uploadId);
        return immediate({
          schema: "fleet.upload.result/v1",
          messageId: mid(frame.messageId, "result"),
          inReplyTo: frame.messageId,
          status: wasStaged ? "already_staged" : "staged",
          descriptor,
          replicationSequence: null,
        });
      });
    }
    if (frame.schema === "fleet.doc.submit/v1") {
      return runFleetCenterWrite(frame, async () => {
        const a = await nodeContext(nodeId, frame.repoId, frame.accessToken);
        assertFrameEpoch(a.repoId, frame.writerEpoch);
        const completed: string[] = [];
        for (const change of frame.changes) {
          const owned = findOwnedClaim(nodeId, a.repoId, change.candidate);
          if (!owned) throw new FleetFault("claim_not_owned", "Descriptor was not issued to this node.");
          completed.push(owned[0]);
        }
        // The submit names its execution channel itself: shared-surface prose
        // rides the repository channel (null) while task-context pushes name the
        // leased execution — decideDocWrite then arbitrates the holder against
        // the node's registered owner, never against a client claim.
        let executionId = frame.executionId;
        if (executionId === null && frame.taskId) {
          const shown = await runCenterWriter(
            a.repoId,
            { kind: "task-show", taskId: frame.taskId },
            await auth(a, undefined, frame.executionCredential),
          );
          if (shown.outcome !== "applied" || typeof shown.evidence !== "string")
            throw new FleetFault("task_read_failed", "Cannot read the document task at the center.");
          const snapshot = JSON.parse(shown.evidence) as { readonly lease?: { readonly executionId?: unknown } | null };
          executionId = typeof snapshot.lease?.executionId === "string" ? snapshot.lease.executionId : null;
        }
        const receipt = await runCenterWriter(
          a.repoId,
          {
            kind: "doc-submit",
            ...(frame.taskId ? { taskId: frame.taskId } : {}),
            executionId,
            baseLedgerSha: frame.baseLedgerSha,
            changes: frame.changes,
          },
          await auth(a, undefined, frame.executionCredential),
        );
        if (isSquadControlResult(receipt))
          throw new FleetFault(
            "execution_scope_mismatch",
            "Fleet document writes cannot return runtime control results.",
          );
        if (receipt.outcome === "applied") {
          for (const uploadId of completed) delete state.uploads[uploadId];
          persist();
        }
        return immediate({
          schema: "fleet.doc.result/v1",
          messageId: mid(frame.messageId, "doc"),
          inReplyTo: frame.messageId,
          outcome: receipt.outcome,
          opId: receipt.opId,
          revision: receipt.revision ?? null,
          replicationSequence: writeReplicationSequence(a.repoId, receipt),
          code: receipt.code ?? null,
          receipt: {
            ...(receipt as unknown as Readonly<Record<string, unknown>>),
            ...(frame.taskId ? { taskId: frame.taskId } : {}),
          },
        });
      });
    }
    if (frame.schema === "fleet.task.command/v1") {
      return runFleetCenterWrite(frame, async () => {
        const a = await nodeContext(nodeId, frame.repoId, frame.accessToken);
        try {
          assertFrameEpoch(a.repoId, frame.writerEpoch);
        } catch (error) {
          if (error instanceof FleetFault && error.code === "writer_epoch_stale" && frame.docChanges !== null)
            discardOwnedClaims(nodeId, a.repoId, frame.docChanges);
          throw error;
        }
        if (frame.docChanges !== null) verifyOwnedClaims(nodeId, a.repoId, frame.docChanges);
        let command = frame.action;
        if (command.kind === "runtime-handoff-export") {
          const candidate = command.candidate as import("./command-protocol.ts").FleetDescriptor;
          if (!candidate || !findOwnedClaim(nodeId, a.repoId, candidate))
            throw new FleetFault(
              "claim_not_owned",
              "Native checkpoint upload must belong to the authenticated source node.",
            );
        }
        if (frame.artifact) {
          if (
            command.kind !== "task-artifact-add" ||
            command.source !== undefined ||
            command.content !== undefined ||
            !findOwnedClaim(nodeId, a.repoId, frame.artifact)
          )
            throw new FleetFault("claim_not_owned", "Artifact must name this node's staged claim.");
          command = {
            ...command,
            source: path.join(safeLocal(a.repoId, "doc-sync-claims"), path.basename(frame.artifact.ref)),
          };
        } else if (command.kind === "task-artifact-add")
          throw new FleetFault("claim_not_owned", "Edge artifacts require staged bytes.");
        try {
          if (command.kind === "task-submit" && typeof command.taskId === "string") {
            const submitAuth = await writerAuth(a, frame.accessToken, frame.executionCredential);
            const admission = await options.host.authorize(a.repoId, command.kind, submitAuth, {
              taskId: command.taskId,
            });
            if (admission.outcome !== "allowed")
              throw new FleetFault("authorization_denied", "Task delivery is not authorized.");
            const shown = await runCenterWriter(a.repoId, { kind: "task-show", taskId: command.taskId }, submitAuth);
            if (shown.outcome !== "applied" || typeof shown.evidence !== "string")
              throw new FleetFault("task_read_failed", "Cannot read the delivery task.");
            const snapshot = JSON.parse(shown.evidence) as FleetDeliveryTask;
            if (snapshot.workspace?.kind === "worktree" && snapshot.lease) {
              const executionId = assertFleetDeliveryHolder(snapshot, {
                nodeId,
                personId: (await readerAuth(a)).nodePrincipal!.personId,
                ...(typeof command.executionId === "string" ? { executionId: command.executionId } : {}),
              });
              const commitSha = await fetchWorkerDelivery(
                repoRoot(a.repoId),
                command.taskId,
                typeof command.commitSha === "string" ? command.commitSha : undefined,
                workerGitIdentityForPerson(snapshot.lease.actor.principal.personId),
              ).catch((error: unknown) => {
                throw new FleetFault("delivery_fetch_failed", runtimeErrorMessage(error));
              });
              command = { ...command, executionId, commitSha };
            }
          }
        } catch (error) {
          const code = runtimeErrorCode(error);
          if (code && ["lease_holder_mismatch", "delivery_fetch_failed"].includes(code))
            throw new FleetFault(code, runtimeErrorMessage(error));
          throw error;
        }
        const action = {
          ...command,
          ...(frame.docChanges === null ? {} : { docChanges: frame.docChanges }),
          ...(frame.mirrorBaseCut === null ? {} : { mirrorBaseCut: frame.mirrorBaseCut }),
        };
        const commandAuth = await writerAuth(a, frame.accessToken, frame.executionCredential);
        let reservation;
        try {
          reservation =
            command.kind === "doc-show"
              ? resourceBudget.reserve({ nodeId, repoId: a.repoId, sessionId: window.holderId }, { bulkTransfers: 1 })
              : null;
        } catch (error) {
          if (error instanceof ResourceBudgetExceeded) throw new FleetFault("busy", error.message, true);
          throw error;
        }
        try {
          const receipt = await runCenterWriter(a.repoId, action, commandAuth);
          if (reservation) connectionSignal.throwIfAborted();
          const result = {
            outcome:
              receipt.outcome === "op_rejected" || receipt.outcome === "indeterminate"
                ? ("op_rejected" as const)
                : ("applied" as const),
            opId: frame.opId,
            revision: receipt.revision ?? null,
            replicationSequence: writeReplicationSequence(a.repoId, receipt),
            ...(receipt.outcome === "applied" &&
            receipt.cut &&
            typeof receipt.cut.revision === "number" &&
            typeof receipt.cut.headDigest === "string"
              ? {
                  appliedCut: {
                    revision: receipt.cut.revision,
                    headDigest: receipt.cut.headDigest,
                    schemaGeneration: 0,
                  },
                }
              : {}),
            code: receipt.code ?? null,
            receipt: receipt as unknown as Readonly<Record<string, unknown>>,
          };
          if (receipt.outcome === "applied" && frame.docChanges) discardOwnedClaims(nodeId, a.repoId, frame.docChanges);
          if (command.kind === "runtime-handoff-export" && command.candidate)
            discardOwnedClaims(nodeId, a.repoId, [
              { candidate: command.candidate as import("./command-protocol.ts").FleetDescriptor },
            ]);
          if (receipt.outcome === "applied" && frame.artifact)
            discardOwnedClaims(nodeId, a.repoId, [{ candidate: frame.artifact }]);
          const response: Extract<FleetFrameV1, { schema: "fleet.task.result/v1" }> = {
            schema: "fleet.task.result/v1",
            messageId: mid(frame.messageId, "task"),
            inReplyTo: frame.messageId,
            ...result,
          };
          if (command.kind === "doc-show" && receipt.outcome === "applied") {
            const { evidence, ...metadata } = result.receipt,
              bytes = Buffer.from(evidence as string);
            return {
              key: null,
              onComplete: () => reservation?.release(),
              onFailure: () => reservation?.release(),
              frames: (async function* () {
                for (let offset = 0; offset < bytes.length; offset += FLEET_CHUNK_BYTES) {
                  yield {
                    schema: "fleet.task.evidence/v1" as const,
                    messageId: mid(frame.messageId, `evidence-${offset}`),
                    inReplyTo: frame.messageId,
                    dataBase64: bytes.subarray(offset, offset + FLEET_CHUNK_BYTES).toString("base64"),
                  };
                }
                yield { ...response, receipt: metadata };
              })(),
            };
          }
          reservation?.release();
          return immediate(response);
        } catch (error) {
          reservation?.release();
          throw error;
        }
      });
    }
    if (frame.schema === "fleet.schedule.command/v1") {
      return runFleetCenterWrite(frame, async () => {
        const a = await nodeContext(nodeId, frame.repoId, frame.accessToken);
        if (frame.scheduleId !== frame.action.scheduleId)
          throw new FleetFault("schedule_scope_mismatch", "Schedule command IDs must match.");
        assertFrameEpoch(a.repoId, frame.writerEpoch);
        const ingressAuth = await auth(a),
          receipt = await runCenterWriter(a.repoId, { ...frame.action, idempotencyKey: frame.opId }, ingressAuth);
        if (isSquadControlResult(receipt))
          throw new FleetFault(
            "execution_scope_mismatch",
            "Fleet schedule writes cannot return runtime control results.",
          );
        return immediate({
          schema: "fleet.schedule.result/v1",
          messageId: mid(frame.messageId, "schedule"),
          inReplyTo: frame.messageId,
          opId: frame.opId,
          outcome: receipt.outcome,
          revision: receipt.revision ?? null,
          replicationSequence: writeReplicationSequence(a.repoId, receipt),
          code: receipt.code ?? null,
          receipt: receipt as unknown as Readonly<Record<string, unknown>>,
        });
      });
    }
    if (frame.schema === "fleet.runtime.event/v1") {
      return runFleetCenterWrite(frame, async () => {
        const a = await nodeContext(nodeId, frame.repoId, frame.accessToken);
        if (frame.repoId !== a.repoId)
          throw new FleetFault(
            "execution_scope_mismatch",
            "Runtime event repository must match the authenticated node request.",
          );
        assertFrameEpoch(a.repoId, frame.writerEpoch);
        if ((frame.eventType === "runtime_dispatch_requested") !== (frame.dispatchContext !== null))
          throw new FleetFault(
            "invalid_runtime_event",
            "Only a runtime dispatch carries its center admission context, and every remote dispatch must carry it.",
          );
        let resultBody: string | undefined, uploadId: string | undefined;
        if (frame.result) {
          const owned = findOwnedClaim(nodeId, a.repoId, frame.result);
          if (!owned) throw new FleetFault("claim_not_owned", "Runtime result descriptor was not issued to this node.");
          uploadId = owned[0];
          const claim = path.join(safeLocal(a.repoId, "doc-sync-claims"), path.basename(frame.result.ref)),
            bytes = readFileSync(claim);
          if (bytes.byteLength !== frame.result.size || sha256Bytes(bytes) !== frame.result.sha256)
            throw new FleetFault("content_claim_mismatch", "Runtime result bytes do not match the staged descriptor.");
          resultBody = bytes.toString("utf8");
        }
        let receipt: Awaited<ReturnType<typeof options.host.runtimeIngress>>;
        try {
          receipt = await options.host.runtimeIngress(
            a.repoId,
            {
              kind: "event",
              type: frame.eventType as import("@harness-anything/kernel").AgentRuntimeEventV1["type"],
              payload: frame.payload,
              opId: frame.opId,
              ...(resultBody === undefined ? {} : { resultBody }),
              ...(frame.dispatchContext === null ? {} : { dispatchContext: frame.dispatchContext }),
            },
            await auth(a),
          );
        } catch (error) {
          const code = runtimeErrorCode(error);
          if (code) throw new FleetFault(code, runtimeErrorMessage(error));
          throw error;
        }
        if (uploadId && receipt.outcome === "applied") {
          discardOwnedClaims(nodeId, a.repoId, [{ candidate: frame.result! }]);
        }
        if (receipt.outcome === "op_rejected" && typeof receipt.code === "string")
          throw new FleetFault(receipt.code, String(receipt.rejectionExplanation ?? receipt.code));
        const event = receipt.event;
        if (!event && receipt.outcome === "no_changes")
          return immediate({
            schema: "fleet.runtime.event.result/v1",
            messageId: mid(frame.messageId, "runtime-event"),
            inReplyTo: frame.messageId,
            replicationSequence: writeReplicationSequence(a.repoId, receipt),
            event: null,
            receipt,
          });
        if (!event || typeof event !== "object" || Array.isArray(event))
          throw new FleetFault(
            "runtime_event_missing",
            "Center runtime ingress did not return its authoritative event.",
          );
        return immediate({
          schema: "fleet.runtime.event.result/v1",
          messageId: mid(frame.messageId, "runtime-event"),
          inReplyTo: frame.messageId,
          replicationSequence: writeReplicationSequence(a.repoId, receipt),
          event: event as Readonly<Record<string, unknown>>,
          receipt,
        });
      });
    }
    if (frame.schema === "fleet.runtime.archive/v1") {
      return runFleetCenterWrite(frame, async () => {
        const a = await nodeContext(nodeId, frame.repoId, frame.accessToken);
        if (frame.repoId !== a.repoId)
          throw new FleetFault(
            "execution_scope_mismatch",
            "Runtime archive repository must match the authenticated node request.",
          );
        assertFrameEpoch(a.repoId, frame.writerEpoch);
        let receipt;
        try {
          receipt = await options.host.runtimeIngress(
            a.repoId,
            {
              kind: "archive",
              archive: frame.archive as unknown as import("../doc-sync-actions.ts").RuntimeDispatchArchive,
            },
            await auth(a),
          );
        } catch (error) {
          const code = runtimeErrorCode(error);
          if (code) throw new FleetFault(code, runtimeErrorMessage(error));
          throw error;
        }
        return immediate({
          schema: "fleet.runtime.archive.result/v1",
          messageId: mid(frame.messageId, "runtime-archive"),
          inReplyTo: frame.messageId,
          replicationSequence: writeReplicationSequence(a.repoId, receipt),
          receipt,
        });
      });
    }
    if (frame.schema === "fleet.operational.read/v1") {
      const a = await nodeContext(nodeId, frame.repoId, frame.accessToken);
      if (frame.repoId !== a.repoId)
        throw new FleetFault(
          "execution_scope_mismatch",
          "Runtime read repository must match the authenticated node request.",
        );
      const binding = {
        ...(await auth(a)),
        connectionSignal: connectionSignal ? AbortSignal.any([connectionSignal, closing.signal]) : closing.signal,
      };
      let result;
      try {
        if (frame.method === "repo.task.dispatches" || frame.method === "repo.fleet.overview.read") {
          if (frame.method === "repo.fleet.overview.read") {
            result = await options.host.read(a.repoId, frame.method, frame.payload as JsonObject, binding);
            return immediate({
              schema: "fleet.operational.read.result/v1",
              messageId: mid(frame.messageId, "runtime-read"),
              inReplyTo: frame.messageId,
              result: result as unknown as Readonly<Record<string, unknown>>,
            });
          }
          const errors = validateTaskDispatchesPayload(frame.payload);
          if (errors.length) throw new FleetFault("invalid_field", errors.join("; "));
          result = await options.host.read(a.repoId, frame.method, frame.payload as JsonObject, binding);
        } else result = await options.host.awaitRuntimeSessions(a.repoId, frame.payload as JsonObject, binding);
      } catch (error) {
        const code = runtimeErrorCode(error);
        if (
          code &&
          ["authentication_required", "authorization_denied", "keycloak_unavailable", "projection_pending"].includes(
            code,
          )
        )
          throw new FleetFault(code, runtimeErrorMessage(error));
        throw error;
      }
      return immediate({
        schema: "fleet.operational.read.result/v1",
        messageId: mid(frame.messageId, "runtime-read"),
        inReplyTo: frame.messageId,
        result: result as unknown as Readonly<Record<string, unknown>>,
      });
    }
    throw new FleetFault("unexpected_direction", `Frame ${frame.schema} is not accepted by the center.`);
  };
  // One row per node for every TLS session it holds, from the moment its hello is dispatched.
  // Unregistration settles in the access-admin queue; this table is how that cut reaches sockets.
  const sessions = new Map<string, Set<TLSSocket>>();
  // Every accepted TCP socket, from `connection` until `close`. `sessions` only holds sockets whose
  // hello was dispatched, so it cannot be the close() cut: a peer that completes the handshake and
  // stalls before its hello — or one still in the handshake — is owned by this listener and by no
  // session row, and `server.close()` waits for it indefinitely.
  const connections = new Set<TLSSocket>();
  const replicationOwners = new Map<string, TLSSocket>();
  // Slot ACKs against each repository's log head; a slot on another history must base-backup again.
  const replicaStatus = createReplicaStatusTracker({
    slots: replicationSlots,
    attachedRepositories: () =>
      new Set(
        options.host
          .status()
          .repos.filter((repo) => repo.state === "attached")
          .map((repo) => repo.repoId),
      ),
    head: readReplicationHead,
    isConnected: (key) => replicationOwners.has(replicationSlotKey(key)),
    diskQuotaBytes: options.replicaDiskQuotaBytes ?? null,
  });
  // One limiter for every connection: the failure budget lives per connection source across
  // sessions, not per socket and not per claimed node id. Each unauthenticated socket holds a
  // session slot and a credential check it may still trigger; the limiter bounds the credential
  // cost of a source that keeps failing its hello.
  const guardedAuthenticate = createHelloRateLimiter(async (nodeId, credential, source) => {
    if (!nodeAdmission.isOpen(nodeId)) return false;
    return (await options.authenticate(nodeId, credential, source)) && nodeAdmission.isOpen(nodeId);
  });
  const server: Server = createServer({ key: options.key, cert: options.cert }, (socket) =>
    serve(
      socket,
      { ...options, authenticate: guardedAuthenticate, onReplicationStart },
      (nodeId, ...args) => nodeAdmission.run(nodeId, () => handle(nodeId, ...args)),
      sessions,
      replicationOwners,
    ),
  );
  server.on("connection", (socket: TLSSocket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.hostname ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fleet TLS server did not bind a TCP port");
  let closed = false;
  return {
    port: address.port,
    pendingDeliveries: deliveries.pending,
    inspectNode: (nodeId) => ({
      online: (sessions.get(nodeId)?.size ?? 0) > 0,
      inFlight: nodeAdmission.inFlight(nodeId),
      slots: replicationSlots.list().filter((slot) => slot.nodeId === nodeId),
    }),
    drainNode: nodeAdmission.drain,
    fenceNode: nodeAdmission.fence,
    removeNode: (nodeId) => {
      nodeAdmission.remove(nodeId);
      for (const socket of sessions.get(nodeId) ?? []) socket.destroy();
      sessions.delete(nodeId);
      replicationSlots.removeNode(nodeId);
      replicaStatus.removeNode(nodeId);
    },
    disconnectNode: (nodeId: string) => {
      const live = sessions.get(nodeId);
      if (!live) return;
      sessions.delete(nodeId);
      for (const socket of live) socket.destroy();
    },
    close: async () => {
      if (closed) return;
      closed = true;
      closing.abort();
      // `server.close` only resolves once every accepted socket is gone, and an edge keeps replica
      // sessions open between pulls, so none of them ends on its own. Cut every socket this listener
      // accepted — not just the hello-registered ones — or a peer that never reached its hello holds
      // close() open for as long as it stays connected.
      const drained = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      for (const socket of connections) socket.destroy();
      sessions.clear();
      await drained;
      try {
        for (const [repoId, owned] of ownedEpochs) {
          const current = writerEpoch.current(repoId);
          if (current?.epoch === owned.epoch && current.holderId === owned.holderId)
            await options.host.settleMaterialization(repoId, "fleet center close");
        }
      } finally {
        writerEpoch.close();
      }
    },
    replicaReceipt: () => {
      throw new Error("replica receipt is retired");
    },
    status: () => ({ replicas: replicaStatus.snapshot(), uploads: uploadWindow(state) }),
  };
}
