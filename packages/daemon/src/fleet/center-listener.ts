import { fetchWorkerDelivery } from "../runtime-worker-push.ts";
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
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { SnapshotCut } from "./replica-cut-store.ts";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import { createServer, type Server, type TLSSocket } from "node:tls";
import { edgeReadAuthorizationShapeDigest, resolveHarnessLayout, sha256Bytes } from "@harness-anything/kernel";
import { readFileWindow, syncDirectory, syncFile } from "../durable-file.ts";
import { openPersistentWriterEpoch, readLedgerWriterEpoch, type PersistentWriterEpoch } from "../writer-epoch.ts";
import { runtimeErrorCode, runtimeErrorMessage } from "../runtime-spawn-errors.ts";
import {
  discardOwnedClaims as discardOwnedClaimsImpl,
  findOwnedClaim as findOwnedClaimImpl,
  verifyOwnedClaims as verifyOwnedClaimsImpl,
} from "./center-lease-claims.ts";
import { makeOffer, offerFrames } from "./center-replica-offer.ts";
import { deriveReplicaReceipt, replicaStatus } from "./center-replica-receipt.ts";
import {
  digestId,
  immediate,
  loadState,
  mid,
  ownedUpload,
  serve,
  wireCut,
  writeCenterDurableJson,
} from "./center-transport.ts";
import type { Delivery, FleetCenterOptions, FleetTlsCenter, SessionWindow } from "./center-types.ts";
import { FleetFault } from "./center-types.ts";
import { FLEET_SESSION_SEND_WINDOW_BYTES, FLEET_CHUNK_BYTES, type FleetFrameV1 } from "./contract.ts";
import { openReplicaAckStore, type ReplicaDeliveryKey } from "./replica-ack-store.ts";

export async function listenFleetTls(options: FleetCenterOptions): Promise<FleetTlsCenter> {
  mkdirSync(options.stateRoot, { recursive: true });
  const closing = new AbortController();
  const stateFile = path.join(options.stateRoot, "state.json"),
    state = loadState(stateFile),
    ackStore = openReplicaAckStore(options.stateRoot),
    now = options.now ?? (() => new Date().toISOString()),
    knownKeys = new Map<string, ReplicaDeliveryKey>(),
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
    // The owner is read from the registry for each use, so re-registering a node changes who its next
    // frame acts for; nothing a frame carries can name the person.
    readerAuth = async (node: { nodeId: string; repoId: string }) => {
      const personId = await options.nodeOwner(node.nodeId);
      if (!personId) throw new FleetFault("node_owner_unregistered", `Node ${node.nodeId} has no registered owner.`);
      return {
        transportKind: "fleet-tls" as const,
        nodePrincipal: { nodeId: node.nodeId, personId },
      };
    },
    principalAuth = async (
      node: { nodeId: string; repoId: string },
      accessToken?: string,
      executionCredential?: string,
    ) => {
      const machine = await readerAuth(node);
      if (accessToken && !options.verifyHuman)
        throw new FleetFault("human_confirmation_required", "Human sessions are unavailable at this center.");
      if (executionCredential && accessToken)
        throw new FleetFault("execution_credential_rejected", "Execution authentication cannot carry a human session.");
      let principal: DaemonAuthenticationContext = {
        ...machine,
        ...(executionCredential ? { executionCredential } : {}),
      };
      if (accessToken) {
        try {
          principal = await options.verifyHuman!({ ...machine, humanAccessToken: accessToken });
        } catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string")
            throw new FleetFault(
              error.code,
              error instanceof Error ? error.message : "Human authentication was rejected.",
            );
          throw error;
        }
      }
      return principal;
    },
    writerAuth = async (
      node: { nodeId: string; repoId: string },
      accessToken?: string,
      executionCredential?: string,
    ) => {
      const lease = ownedEpochFor(node.repoId);
      const principal = await principalAuth(node, accessToken, executionCredential);
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
    keyId = (key: ReplicaDeliveryKey) => `${key.nodeId}\0${key.viewId}\0${key.repoId}`,
    auth = writerAuth;
  const nodeContext = async (nodeId: string, repoId: string) => {
    const node = { nodeId, repoId };
    repoRoot(repoId);
    await readerAuth(node);
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
  const admitReplica = async (nodeId: string, repoId: string) => {
    if (!Number.isSafeInteger(options.replicaDiskQuotaBytes) || options.replicaDiskQuotaBytes! <= 0)
      throw new FleetFault("replica_quota_required", "Replica admission requires an explicit persistent disk quota.");
    const a = await nodeContext(nodeId, repoId),
      owner = await options.nodeOwner(nodeId);
    if (!owner) throw new FleetFault("node_owner_unregistered", `Node ${nodeId} has no registered owner.`);
    const replica = options.host.replica(a.repoId),
      // Mirroring is reading: the node owner's repository-read admits the replica, the same authority
      // a center-forwarded read checks (dec_B6AC9F76D9D6591A3F54802BF3, refining dec_D8497012 CH4).
      decision = await options.host.authorize(a.repoId, "repository-read", {
        transportKind: "fleet-tls" as const,
        nodePrincipal: { nodeId, personId: owner },
      });
    if (decision.outcome !== "allowed")
      throw new FleetFault("authorization_denied", "The node owner may not read this repository.");
    replica.activate();
    return { a, replica, owner };
  };
  // A watch that sees no new cut still answers on the progress interval with the unchanged head, so a
  // connected edge can keep confirming freshness without pulling (the same role as etcd's progress notify).
  const headAfterOrProgress = (
    replica: ReturnType<typeof options.host.replica>,
    afterRevision: number,
    progressMs: number,
  ) =>
    new Promise<SnapshotCut>((resolve, reject) => {
      const timer = setTimeout(() => {
        const current = replica.latest();
        if (current) resolve(current);
      }, progressMs);
      timer.unref();
      replica.waitForCut(afterRevision + 1).then(
        (cut) => {
          clearTimeout(timer);
          resolve(cut);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  // The wait starts only once the session is known to be open: a wait started during shutdown would be
  // rejected by the closing cut source with nobody left to observe it.
  const untilAborted = <T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const stop = signal ? AbortSignal.any([signal, closing.signal]) : closing.signal;
    if (stop.aborted) return Promise.reject(new FleetFault("busy", "The replica session closed.", true));
    const pending = start();
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new FleetFault("busy", "The replica session closed.", true));
      stop.addEventListener("abort", abort, { once: true });
      pending.then(
        (value) => {
          stop.removeEventListener("abort", abort);
          resolve(value);
        },
        (error: unknown) => {
          stop.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  };
  const handle = async (
    nodeId: string,
    frame: FleetFrameV1,
    window: SessionWindow,
    _clientGone: () => boolean = () => false,
    connectionSignal?: AbortSignal,
  ): Promise<Delivery> => {
    if (frame.schema === "fleet.repo.metadata.get/v1") {
      const a = await nodeContext(nodeId, frame.repoId),
        baseLedgerSha = options.host.replica(a.repoId).ledgerCut(),
        principal = await readerAuth(a),
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
      return immediate({
        schema: "fleet.repo.metadata.result/v1",
        personId: principal.nodePrincipal.personId,
        actionAllowed,
        messageId: mid(frame.messageId, "metadata"),
        inReplyTo: frame.messageId,
        repoId: a.repoId,
        baseLedgerSha,
        writerEpoch: ownedEpochFor(a.repoId).epoch,
      });
    }
    if (frame.schema === "fleet.receipt.get/v1") {
      const a = await nodeContext(nodeId, frame.repoId),
        receipt = await options.host.run(a.repoId, { kind: "receipt-show", opId: frame.opId }, await readerAuth(a));
      return immediate({
        schema: "fleet.receipt.result/v1",
        messageId: mid(frame.messageId, "receipt"),
        inReplyTo: frame.messageId,
        opId: frame.opId,
        receipt: receipt as unknown as Record<string, unknown>,
      });
    }
    if (frame.schema === "fleet.upload.begin/v1") {
      const a = await nodeContext(nodeId, frame.repoId),
        uploadId = digestId(
          nodeId,
          a.repoId,
          frame.content.sha256,
          String(frame.content.size),
          frame.content.mediaType,
        );
      let upload = state.uploads[uploadId];
      if (upload && JSON.stringify(upload.content) !== JSON.stringify(frame.content))
        throw new FleetFault("upload_conflict", "Upload identity conflicts with persisted metadata.");
      if (!upload && Object.keys(state.uploads).length >= 64)
        throw new FleetFault("busy", "Upload recovery window is full.", true);
      if (!upload)
        upload = state.uploads[uploadId] = {
          nodeId,
          repoId: a.repoId,
          content: frame.content,
          descriptor: null,
        };
      const file = uploadPath(uploadId, upload);
      if (
        upload.descriptor &&
        !existsSync(path.join(safeLocal(a.repoId, "doc-sync-claims"), path.basename(upload.descriptor.ref)))
      )
        upload.descriptor = null;
      if (!upload.descriptor) {
        mkdirSync(path.dirname(file), { recursive: true });
        if (!existsSync(file)) writeFileSync(file, "");
      }
      persist();
      if (!window.uploads.has(uploadId) && window.uploads.size >= 8)
        throw new FleetFault(
          "busy",
          "Session already has eight active uploads.",
          true,
          existsSync(file) ? statSync(file).size : 0,
        );
      window.uploads.add(uploadId);
      return immediate({
        schema: "fleet.upload.ready/v1",
        messageId: mid(frame.messageId, "ready"),
        inReplyTo: frame.messageId,
        uploadId,
        resumeOffset: upload.descriptor ? upload.content.size : existsSync(file) ? statSync(file).size : 0,
        status: upload.descriptor ? "already_staged" : "receiving",
      });
    }
    if (frame.schema === "fleet.upload.chunk/v1") {
      ownedUpload(state, nodeId, frame.uploadId);
      const file = uploadPath(frame.uploadId),
        bytes = Buffer.from(frame.dataBase64, "base64"),
        length = existsSync(file) ? statSync(file).size : 0;
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
      });
    }
    if (frame.schema === "fleet.upload.finish/v1") {
      const upload = state.uploads[frame.uploadId];
      if (!upload || upload.nodeId !== nodeId)
        throw new FleetFault("upload_unknown", "Upload is unknown or belongs to another node.");
      const wasStaged = upload.descriptor !== null,
        file = uploadPath(frame.uploadId, upload),
        a = await nodeContext(nodeId, upload.repoId),
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
        persist();
      }
      window.uploads.delete(frame.uploadId);
      return immediate({
        schema: "fleet.upload.result/v1",
        messageId: mid(frame.messageId, "result"),
        inReplyTo: frame.messageId,
        status: wasStaged ? "already_staged" : "staged",
        descriptor,
      });
    }
    if (frame.schema === "fleet.doc.submit/v1") {
      const a = await nodeContext(nodeId, frame.repoId);
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
        const shown = await options.host.run(
          a.repoId,
          { kind: "task-show", taskId: frame.taskId },
          await auth(a, undefined, frame.executionCredential),
        );
        if (shown.outcome !== "applied" || typeof shown.evidence !== "string")
          throw new FleetFault("task_read_failed", "Cannot read the document task at the center.");
        const snapshot = JSON.parse(shown.evidence) as { readonly lease?: { readonly executionId?: unknown } | null };
        executionId = typeof snapshot.lease?.executionId === "string" ? snapshot.lease.executionId : null;
      }
      const receipt = await options.host.run(
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
        code: receipt.code ?? null,
      });
    }
    if (frame.schema === "fleet.replica.watch/v1") {
      const { replica } = await admitReplica(nodeId, frame.repoId),
        latest = replica.latest(),
        // Cuts are contiguous per workspace revision and every center write kicks the cut source, so the
        // next revision's cut is the event a caught-up edge waits on instead of polling.
        next =
          latest && latest.revision > frame.afterRevision
            ? latest
            : await untilAborted(
                () => headAfterOrProgress(replica, frame.afterRevision, options.replicaWatchProgressMs ?? 20_000),
                connectionSignal,
              );
      return immediate({
        schema: "fleet.replica.head-hint/v1",
        messageId: mid(frame.messageId, "head-hint"),
        inReplyTo: frame.messageId,
        repoId: frame.repoId,
        cut: wireCut(next),
      });
    }
    if (frame.schema === "fleet.replica.pull/v1") {
      const { a, replica, owner } = await admitReplica(nodeId, frame.repoId);
      const ledgerCut = replica.ledgerCut();
      if (!ledgerCut || ledgerCut.revision === 0)
        throw new FleetFault("replica_pending", "No exact center cut is ready.", true);
      const latest = await replica.waitForCut(ledgerCut.revision),
        key = { nodeId, viewId: nodeId, repoId: a.repoId },
        id = keyId(key);
      if (latest.headDigest !== ledgerCut.headDigest)
        throw new FleetFault("replica_pending", "The exact center cut is not ready.", true);
      if (!window.keys.has(id) && window.keys.size >= 8)
        throw new FleetFault("busy", "Session already has eight active replica keys.", true);
      if (latest.manifest.totalBytes * 2 + FLEET_SESSION_SEND_WINDOW_BYTES > options.replicaDiskQuotaBytes!)
        throw new FleetFault(
          "replica_quota_insufficient",
          "Replica quota cannot hold current, incoming, and staging reserve.",
        );
      window.keys.add(id);
      knownKeys.set(id, key);
      ackStore.register(key, latest.revision);
      const cursor = ackStore.cursor(key);
      if (
        cursor?.revision === latest.revision &&
        cursor.headDigest === latest.headDigest &&
        cursor.manifestDigest === latest.manifest.digest
      ) {
        window.keys.delete(id);
        return immediate({
          schema: "fleet.replica.current/v1",
          messageId: mid(frame.messageId, "current"),
          inReplyTo: frame.messageId,
          repoId: key.repoId,
          viewId: key.viewId,
          cut: wireCut(latest),
          manifestDigest: latest.manifest.digest,
          authorizationOwner: owner,
          authorizationShapeDigest: edgeReadAuthorizationShapeDigest({ repoId: a.repoId, owner }),
        });
      }
      let active = ackStore.offerFor(key);
      if (
        active &&
        (!replica.cut(active.toCut.revision) ||
          replica.cut(active.toCut.revision)?.manifest.digest !== active.manifestDigest ||
          (active.fromCut && replica.changes(active.fromCut.revision, active.toCut.revision) === null))
      ) {
        ackStore.clearOffer(key);
        active = null;
      }
      const next = active ?? makeOffer(key, cursor, latest, replica, now());
      const offer = active ?? ackStore.offer(key, next);
      window.offers.set(offer.transferId, key);
      return {
        key: id,
        frames: offerFrames(offer, replica, {
          owner,
          digest: edgeReadAuthorizationShapeDigest({ repoId: a.repoId, owner }),
        }),
      };
    }
    if (frame.schema === "fleet.task.command/v1") {
      const a = await nodeContext(nodeId, frame.repoId);
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
        const candidate = command.candidate as import("./contract.ts").FleetDescriptor;
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
          const shown = await options.host.run(a.repoId, { kind: "task-show", taskId: command.taskId }, submitAuth);
          if (shown.outcome !== "applied" || typeof shown.evidence !== "string")
            throw new FleetFault("task_read_failed", "Cannot read the delivery task.");
          const snapshot = JSON.parse(shown.evidence) as FleetDeliveryTask;
          if (snapshot.workspace?.kind === "worktree" && snapshot.lease) {
            const executionId = assertFleetDeliveryHolder(snapshot, {
              nodeId,
              personId: (await readerAuth(a)).nodePrincipal.personId,
              ...(typeof command.executionId === "string" ? { executionId: command.executionId } : {}),
            });
            const commitSha = await fetchWorkerDelivery(
              repoRoot(a.repoId),
              command.taskId,
              typeof command.commitSha === "string" ? command.commitSha : undefined,
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
      const receipt = await options.host.run(
        a.repoId,
        action,
        await writerAuth(a, frame.accessToken, frame.executionCredential),
      );
      const result = {
        outcome:
          receipt.outcome === "op_rejected" || receipt.outcome === "indeterminate"
            ? ("op_rejected" as const)
            : ("applied" as const),
        opId: frame.opId,
        revision: receipt.revision ?? null,
        ...(receipt.outcome === "applied" &&
        receipt.cut &&
        typeof receipt.cut.revision === "number" &&
        typeof receipt.cut.headDigest === "string"
          ? { appliedCut: { revision: receipt.cut.revision, headDigest: receipt.cut.headDigest } }
          : {}),
        code: receipt.code ?? null,
        receipt: receipt as unknown as Readonly<Record<string, unknown>>,
      };
      if (receipt.outcome === "applied" && frame.docChanges) discardOwnedClaims(nodeId, a.repoId, frame.docChanges);
      if (command.kind === "runtime-handoff-export" && command.candidate)
        discardOwnedClaims(nodeId, a.repoId, [
          { candidate: command.candidate as import("./contract.ts").FleetDescriptor },
        ]);
      if (receipt.outcome === "applied" && frame.artifact)
        discardOwnedClaims(nodeId, a.repoId, [{ candidate: frame.artifact }]);
      return immediate({
        schema: "fleet.task.result/v1",
        messageId: mid(frame.messageId, "task"),
        inReplyTo: frame.messageId,
        ...result,
      });
    }
    if (frame.schema === "fleet.schedule.command/v1") {
      const a = await nodeContext(nodeId, frame.repoId);
      if (frame.scheduleId !== frame.action.scheduleId)
        throw new FleetFault("schedule_scope_mismatch", "Schedule command IDs must match.");
      assertFrameEpoch(a.repoId, frame.writerEpoch);
      const ingressAuth = await auth(a),
        receipt = await options.host.run(a.repoId, { ...frame.action, idempotencyKey: frame.opId }, ingressAuth);
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
        code: receipt.code ?? null,
        receipt: receipt as unknown as Readonly<Record<string, unknown>>,
      });
    }
    if (frame.schema === "fleet.runtime.event/v1") {
      const a = await nodeContext(nodeId, frame.repoId);
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
      if (!event || typeof event !== "object" || Array.isArray(event))
        throw new FleetFault("runtime_event_missing", "Center runtime ingress did not return its authoritative event.");
      return immediate({
        schema: "fleet.runtime.event.result/v1",
        messageId: mid(frame.messageId, "runtime-event"),
        inReplyTo: frame.messageId,
        event: event as Readonly<Record<string, unknown>>,
        receipt,
      });
    }
    if (frame.schema === "fleet.runtime.archive/v1") {
      const a = await nodeContext(nodeId, frame.repoId);
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
        receipt,
      });
    }
    if (frame.schema === "fleet.repository.read/v1") {
      if (frame.executionCredential && frame.method !== "repo.task.read")
        throw new FleetFault("execution_credential_rejected", "Execution reads must name their task action.");
      const node = await nodeContext(nodeId, frame.repoId);
      const principal = await principalAuth(node, frame.accessToken ?? undefined, frame.executionCredential);
      let result;
      try {
        result =
          frame.method === "repo.task.read"
            ? await options.host.run(node.repoId, frame.payload as { readonly kind: string }, principal)
            : await options.host.read(node.repoId, frame.method, frame.payload, principal);
      } catch (error) {
        const code = runtimeErrorCode(error);
        if (code) throw new FleetFault(code, runtimeErrorMessage(error));
        throw error;
      }
      const bytes = Buffer.from(JSON.stringify(result));
      return {
        key: null,
        frames: (async function* () {
          for (let offset = 0; offset < bytes.length; offset += FLEET_CHUNK_BYTES) {
            const end = Math.min(offset + FLEET_CHUNK_BYTES, bytes.length);
            yield {
              schema: "fleet.repository.read.result/v1" as const,
              messageId: mid(frame.messageId, `read-${offset}`),
              inReplyTo: frame.messageId,
              offset,
              dataBase64: bytes.subarray(offset, end).toString("base64"),
              done: end === bytes.length,
            };
          }
        })(),
      };
    }

    if (frame.schema === "fleet.runtime.read/v1") {
      const a = await nodeContext(nodeId, frame.repoId);
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
        result =
          frame.method === "repo.agentRuntime.sessions.await"
            ? await options.host.awaitRuntimeSessions(a.repoId, frame.payload as JsonObject, binding)
            : await options.host.read(a.repoId, frame.method, frame.payload, binding);
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
        schema: "fleet.runtime.read.result/v1",
        messageId: mid(frame.messageId, "runtime-read"),
        inReplyTo: frame.messageId,
        result: result as unknown as Readonly<Record<string, unknown>>,
      });
    }
    if (frame.schema === "fleet.ack/v1") {
      const key = window.offers.get(frame.transferId);
      if (!key || key.nodeId !== nodeId)
        throw new FleetFault("invalid_ack", "ACK does not match an offer issued in this authenticated session.");
      const cutEventAt = options.host.replica(key.repoId).eventAt(frame.cut.revision);
      if (!cutEventAt) throw new FleetFault("invalid_ack", "ACK cut is no longer exact at the center.");
      const result = ackStore.ack(key, frame.transferId, frame.cut, frame.manifestDigest, now(), cutEventAt);
      if (result.outcome === "op_rejected" || !result.cursor)
        throw new FleetFault("invalid_ack", "ACK cut or manifest differs from its exact active offer.");
      window.offers.delete(frame.transferId);
      window.keys.delete(keyId(key));
      return immediate({
        schema: "fleet.ack.result/v1",
        messageId: mid(frame.messageId, "ack"),
        inReplyTo: frame.messageId,
        outcome: result.outcome,
        viewId: key.viewId,
        ackCut: result.cursor.revision,
        code: null,
      });
    }
    throw new FleetFault("unexpected_direction", `Frame ${frame.schema} is not accepted by the center.`);
  };
  // One row per node for every TLS session it holds, from the moment its hello is dispatched.
  // Unregistration settles in the access-admin queue; this table is how that cut reaches sockets.
  const sessions = new Map<string, Set<TLSSocket>>();
  const server: Server = createServer({ key: options.key, cert: options.cert }, (socket) =>
    serve(socket, options, handle, sessions),
  );
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
      // Edges keep replica sessions open between pulls, so a session is never idle long enough to end on its own;
      // `server.close` only resolves once every authenticated socket is gone.
      const drained = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      for (const live of sessions.values()) for (const socket of live) socket.destroy();
      sessions.clear();
      await drained;
      try {
        for (const [repoId, owned] of ownedEpochs) {
          const current = writerEpoch.current(repoId);
          if (current?.epoch === owned.epoch && current.holderId === owned.holderId)
            await options.host.settleMaterialization(repoId, "fleet center close");
        }
      } finally {
        ackStore.close();
        writerEpoch.close();
      }
    },
    replicaReceipt: (opId, nodeId, viewId, repoId) =>
      deriveReplicaReceipt(options.host.replica(repoId), ackStore, { nodeId, viewId, repoId }, opId),
    status: () => {
      const keys = new Map(ackStore.keys().map((key) => [keyId(key), key]));
      for (const [id, key] of knownKeys) keys.set(id, key);
      return {
        replicas: [...keys.values()].map((key) =>
          replicaStatus(options.host.replica(key.repoId), ackStore, key, options.replicaDiskQuotaBytes ?? null),
        ),
      };
    },
  };
}
