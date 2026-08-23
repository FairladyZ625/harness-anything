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
import { createServer, type Server } from "node:tls";
import { resolveHarnessLayout, sha256Bytes } from "../../../kernel/src/index.ts";
import { syncDirectory, syncFile } from "../durable-file.ts";
import { openFleetLeaseBroker } from "../lease-broker.ts";
import { openPersistentWriterEpoch, type PersistentWriterEpoch } from "../writer-epoch.ts";
import {
  brokerHost as brokerHostImpl,
  discardOwnedClaims as discardOwnedClaimsImpl,
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
import type {
  Delivery,
  FleetAssignmentRecord,
  FleetCenterOptions,
  FleetTlsCenter,
  SessionWindow,
} from "./center-types.ts";
import { FleetFault } from "./center-types.ts";
import { FLEET_SESSION_SEND_WINDOW_BYTES, type FleetFrameV1 } from "./contract.ts";
import { openReplicaAckStore, type ReplicaDeliveryKey } from "./replica-ack-store.ts";

export async function listenFleetTls(options: FleetCenterOptions): Promise<FleetTlsCenter> {
  mkdirSync(options.stateRoot, { recursive: true });
  const stateFile = path.join(options.stateRoot, "state.json"),
    state = loadState(stateFile),
    ackStore = openReplicaAckStore(options.stateRoot),
    now = options.now ?? (() => new Date().toISOString()),
    knownKeys = new Map<string, ReplicaDeliveryKey>(),
    writerEpoch = openPersistentWriterEpoch({
      stateRoot: options.stateRoot,
      holderId: options.writerId,
      now,
    }),
    ownedEpochs = new Map<string, ReturnType<PersistentWriterEpoch["acquire"]>>();
  for (const repo of options.host.status().repos)
    if (repo.state === "attached") ownedEpochs.set(repo.repoId, writerEpoch.acquire(repo.repoId));
  // A center must keep using the epoch it acquired, even after another center
  // advances the shared state. Reading the latest row here would let a stale
  // process silently adopt its successor's epoch and defeat fencing.
  const ownedEpochFor = (repoId: string) => {
      const owned = ownedEpochs.get(repoId);
      if (owned) return owned;
      const lease = writerEpoch.acquire(repoId);
      ownedEpochs.set(repoId, lease);
      return lease;
    },
    currentEpochFor = (repoId: string) => writerEpoch.current(repoId) ?? ownedEpochFor(repoId),
    writerAuth = (assignment: FleetAssignmentRecord) => {
      const lease = ownedEpochFor(assignment.repoId);
      return {
        transportKind: "fleet-tls" as const,
        assignmentBinding: assignment,
        writerEpoch: lease.epoch,
        assertWriterEpoch: () => writerEpoch.assert(assignment.repoId, lease.epoch, lease.holderId),
        withWriterEpochFence: <T>(operation: () => T) =>
          writerEpoch.withAppendFence(assignment.repoId, lease.epoch, lease.holderId, operation),
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

  const leaseBroker = openFleetLeaseBroker({
    stateRoot: options.stateRoot,
    host: brokerHost(options.host),
    resolveAssignment: options.resolveAssignment,
    now,
    env: process.env,
    auth: writerAuth,
  });
  function brokerHost(host: FleetCenterOptions["host"]): FleetCenterOptions["host"] {
    return brokerHostImpl(extracted, host);
  }
  function verifyOwnedClaims(
    nodeId: string,
    assignmentId: string,
    changes: readonly { readonly candidate: { readonly ref: string } }[],
  ): void {
    return verifyOwnedClaimsImpl(extracted, nodeId, assignmentId, changes);
  }
  function discardOwnedClaims(
    nodeId: string,
    assignmentId: string,
    changes: readonly { readonly candidate: { readonly ref: string } }[],
  ): void {
    return discardOwnedClaimsImpl(extracted, nodeId, assignmentId, changes);
  }
  const persist = () => writeCenterDurableJson(stateFile, state),
    keyId = (key: ReplicaDeliveryKey) => `${key.nodeId}\0${key.viewId}\0${key.repoId}`,
    auth = writerAuth;
  const assignment = async (nodeId: string, assignmentId: string) => {
    const value = await options.resolveAssignment(assignmentId);
    if (
      !value ||
      value.nodeId !== nodeId ||
      value.paths.length === 0 ||
      value.paths.length > 128 ||
      Date.parse(value.expiresAt) <= Date.parse(now())
    )
      throw new FleetFault("assignment_rejected", "Assignment is absent, expired, or bound to another node.");
    return value;
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
  const handle = async (
    nodeId: string,
    frame: FleetFrameV1,
    window: SessionWindow,
    clientGone: () => boolean = () => false,
  ): Promise<Delivery> => {
    if (frame.schema === "fleet.assignment.get/v1") {
      const a = await assignment(nodeId, frame.assignmentId),
        status = await options.host.run(a.repoId, { kind: "doc-status", paths: a.paths }, auth(a)),
        baseLedgerSha = status.detail?.kind === "doc_sync" ? status.detail.currentLedgerSha : null;
      if (!baseLedgerSha) throw new FleetFault("projection_pending", "Current ledger cut is unavailable.", true);
      return immediate({
        schema: "fleet.assignment.result/v1",
        messageId: mid(frame.messageId, "assignment"),
        inReplyTo: frame.messageId,
        assignmentId: a.assignmentId,
        repoId: a.repoId,
        taskId: a.taskId,
        executionId: a.executionId,
        paths: a.paths,
        baseLedgerSha,
        expiresAt: a.expiresAt,
        writerEpoch: ownedEpochFor(a.repoId).epoch,
      });
    }
    if (frame.schema === "fleet.receipt.get/v1") {
      const a = await assignment(nodeId, frame.assignmentId),
        receipt = await options.host.run(a.repoId, { kind: "receipt-show", opId: frame.opId }, auth(a));
      return immediate({
        schema: "fleet.receipt.result/v1",
        messageId: mid(frame.messageId, "receipt"),
        inReplyTo: frame.messageId,
        opId: frame.opId,
        receipt: receipt as unknown as Record<string, unknown>,
      });
    }
    if (frame.schema === "fleet.upload.begin/v1") {
      const a = await assignment(nodeId, frame.assignmentId),
        uploadId = digestId(
          nodeId,
          a.assignmentId,
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
          assignmentId: a.assignmentId,
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
        if (
          !readFileSync(file)
            .subarray(frame.offset, frame.offset + bytes.length)
            .equals(bytes)
        )
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
        a = await assignment(nodeId, upload.assignmentId),
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
      const a = await assignment(nodeId, frame.assignmentId);
      assertFrameEpoch(a.repoId, frame.writerEpoch);
      const completed: string[] = [];
      for (const change of frame.changes) {
        const owned = Object.entries(state.uploads).find(
            ([, candidate]) =>
              candidate.nodeId === nodeId &&
              candidate.assignmentId === a.assignmentId &&
              candidate.descriptor?.ref === change.candidate.ref,
          ),
          upload = owned?.[1];
        if (!owned || !upload || JSON.stringify(upload.descriptor) !== JSON.stringify(change.candidate))
          throw new FleetFault("claim_not_owned", "Descriptor was not issued to this assignment.");
        completed.push(owned[0]);
      }
      // The submit names its execution channel itself: shared-surface prose
      // rides the repository channel (null) while task-context pushes name the
      // leased execution — decideDocWrite then arbitrates the holder against
      // the re-bound assignment actor, never against a client claim.
      const receipt = await options.host.run(
        a.repoId,
        {
          kind: "doc-submit",
          executionId: frame.executionId,
          baseLedgerSha: frame.baseLedgerSha,
          changes: frame.changes,
        },
        auth(a),
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
    if (frame.schema === "fleet.replica.pull/v1") {
      if (!Number.isSafeInteger(options.replicaDiskQuotaBytes) || options.replicaDiskQuotaBytes! <= 0)
        throw new FleetFault("replica_quota_required", "Replica admission requires an explicit persistent disk quota.");
      const a = await assignment(nodeId, frame.assignmentId),
        replica = options.host.replica(a.repoId);
      replica.activate();
      const exactRevision = replica.exactRevision();
      if (exactRevision === null) throw new FleetFault("replica_pending", "No exact center cut is ready.", true);
      const latest = await replica.waitForCut(exactRevision),
        key = { nodeId, viewId: a.viewId, repoId: a.repoId },
        id = keyId(key);
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
      return { key: id, frames: offerFrames(offer, replica) };
    }
    if (frame.schema === "fleet.task.command/v1") {
      const a = await assignment(nodeId, frame.assignmentId);
      try {
        assertFrameEpoch(a.repoId, frame.writerEpoch);
      } catch (error) {
        if (error instanceof FleetFault && error.code === "writer_epoch_stale" && frame.docChanges !== null)
          discardOwnedClaims(nodeId, a.assignmentId, frame.docChanges);
        throw error;
      }
      if (frame.docChanges !== null) verifyOwnedClaims(nodeId, a.assignmentId, frame.docChanges);
      const result = await leaseBroker.handleTaskCommand(nodeId, frame, clientGone);
      return immediate({
        schema: "fleet.task.result/v1",
        messageId: mid(frame.messageId, "task"),
        inReplyTo: frame.messageId,
        ...result,
      });
    }
    if (frame.schema === "fleet.runtime.event/v1") {
      const a = await assignment(nodeId, frame.assignmentId);
      if (frame.repoId !== a.repoId)
        throw new FleetFault(
          "assignment_scope_mismatch",
          "Runtime event repository must match the authenticated assignment.",
        );
      assertFrameEpoch(a.repoId, frame.writerEpoch);
      let resultBody: string | undefined, uploadId: string | undefined;
      if (frame.result) {
        const owned = Object.entries(state.uploads).find(
          ([, candidate]) =>
            candidate.nodeId === nodeId &&
            candidate.assignmentId === a.assignmentId &&
            JSON.stringify(candidate.descriptor) === JSON.stringify(frame.result),
        );
        if (!owned)
          throw new FleetFault("claim_not_owned", "Runtime result descriptor was not issued to this assignment.");
        uploadId = owned[0];
        const claim = path.join(safeLocal(a.repoId, "doc-sync-claims"), path.basename(frame.result.ref)),
          bytes = readFileSync(claim);
        if (bytes.byteLength !== frame.result.size || sha256Bytes(bytes) !== frame.result.sha256)
          throw new FleetFault("content_claim_mismatch", "Runtime result bytes do not match the staged descriptor.");
        resultBody = bytes.toString("utf8");
      }
      const receipt = await options.host.runtimeIngress(
        a.repoId,
        {
          kind: "event",
          type: frame.eventType as import("../../../kernel/src/index.ts").AgentRuntimeEventV1["type"],
          payload: frame.payload,
          opId: frame.opId,
          ...(resultBody === undefined ? {} : { resultBody }),
        },
        auth(a),
      );
      if (uploadId && receipt.outcome === "applied") {
        discardOwnedClaims(nodeId, a.assignmentId, [{ candidate: frame.result! }]);
      }
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
      const a = await assignment(nodeId, frame.assignmentId);
      if (frame.repoId !== a.repoId)
        throw new FleetFault(
          "assignment_scope_mismatch",
          "Runtime archive repository must match the authenticated assignment.",
        );
      assertFrameEpoch(a.repoId, frame.writerEpoch);
      const receipt = await options.host.runtimeIngress(
        a.repoId,
        {
          kind: "archive",
          archive: frame.archive as unknown as import("../doc-sync-actions.ts").RuntimeDispatchArchive,
        },
        auth(a),
      );
      return immediate({
        schema: "fleet.runtime.archive.result/v1",
        messageId: mid(frame.messageId, "runtime-archive"),
        inReplyTo: frame.messageId,
        receipt,
      });
    }
    if (frame.schema === "fleet.runtime.read/v1") {
      const a = await assignment(nodeId, frame.assignmentId);
      if (frame.repoId !== a.repoId)
        throw new FleetFault(
          "assignment_scope_mismatch",
          "Runtime read repository must match the authenticated assignment.",
        );
      const result = await options.host.read(a.repoId, frame.method, frame.payload, auth(a));
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
  const server: Server = createServer({ key: options.key, cert: options.cert }, (socket) =>
    serve(socket, options, handle),
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
    close: async () => {
      if (closed) return;
      closed = true;
      leaseBroker.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      ackStore.close();
      writerEpoch.close();
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
        leases: leaseBroker.status(),
      };
    },
  };
}
