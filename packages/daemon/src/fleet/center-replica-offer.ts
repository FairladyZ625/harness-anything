import { digestId, mid, wireCut } from "./center-transport.ts";
import type { Delivery, SessionWindow } from "./center-types.ts";
import type { ReplicaDeliveryLease } from "./replica-delivery-lease.ts";
import type { createFleetDeliveryDrain } from "./center-delivery-drain.ts";
import { untilAborted } from "./center-replica-wait.ts";
import { replicaDeliveryFenced as fenced } from "./center-replica-receipt.ts";
import { runtimeErrorCode } from "../runtime-spawn-errors.ts";
import { FleetFault } from "./center-types.ts";
import { FLEET_CHUNK_BYTES, type FleetCut, type FleetEntry, type FleetFrameV1 } from "./contract.ts";
import { type ReplicaAckStore, type ReplicaDeliveryKey, type ReplicaOffer } from "./replica-ack-store.ts";
import type { ReplicaChanges, ReplicaCutSource, SnapshotCut } from "./replica-cut-store.ts";
import { parseEdgeReadModelMeta, READ_MODEL_META_PATH, updateReplicaManifestDigest } from "@harness-anything/kernel";

export async function makeOffer(
  key: ReplicaDeliveryKey,
  cursor: ReturnType<ReplicaAckStore["cursor"]>,
  latest: SnapshotCut,
  replica: ReplicaCutSource,
  issuedAt: string,
): Promise<Omit<ReplicaOffer, keyof ReplicaDeliveryKey>> {
  const model = await replica.delivery.manifestEntry(latest.revision, READ_MODEL_META_PATH);
  if (
    model &&
    parseEdgeReadModelMeta(Buffer.from(await replica.delivery.content(model.blob)).toString("utf8")).sourceRevision !==
      latest.revision
  )
    throw new FleetFault("replica_pending", "The target cut has no read model at its canonical revision.", true);
  let fromCut: FleetCut | null = null,
    kind: "snapshot" | "delta" = "snapshot";
  if (cursor) {
    const retained = replica.cut(cursor.revision);
    if (
      retained &&
      retained.headDigest === cursor.headDigest &&
      retained.manifest.digest === cursor.manifestDigest &&
      latest.revision > cursor.revision &&
      (await replica.delivery.changes(cursor.revision, latest.revision)) !== null
    ) {
      fromCut = wireCut(retained);
      // Fold the shared canonical sequence from the independently acknowledged node cursor.
      kind = "delta";
    }
  }
  const toCut = wireCut(latest),
    manifestDigest = latest.manifest.digest;
  return {
    transferId: digestId(
      key.nodeId,
      key.viewId,
      key.repoId,
      String(fromCut?.revision ?? 0),
      String(fromCut?.schemaGeneration ?? 0),
      String(toCut.revision),
      String(toCut.schemaGeneration),
      manifestDigest,
    ),
    fromCut,
    toCut,
    manifestDigest,
    kind,
    issuedAt,
  };
}

export async function* offerFrames(
  offer: ReplicaOffer,
  replica: ReplicaCutSource,
  authorization: { readonly owner: string; readonly digest: string },
): AsyncGenerator<FleetFrameV1> {
  const target = replica.cut(offer.toCut.revision);
  if (!target || target.manifest.digest !== offer.manifestDigest)
    throw new FleetFault("snapshot_required", "Replica cut manifest is unavailable or corrupt.", true);
  if (offer.kind === "snapshot") {
    yield {
      schema: "fleet.snapshot.begin/v1",
      messageId: mid(offer.transferId, "begin"),
      transferId: offer.transferId,
      repoId: offer.repoId,
      viewId: offer.viewId,
      cut: offer.toCut,
      authorizationOwner: authorization.owner,
      authorizationShapeDigest: authorization.digest,
      manifest: target.manifest,
    };
    for await (const page of manifestPages(replica, target))
      yield {
        schema: "fleet.snapshot.page/v1",
        messageId: mid(offer.transferId, `page${page.index}`),
        transferId: offer.transferId,
        pageIndex: page.index,
        entries: page.entries,
      };
    for await (const page of manifestPages(replica, target))
      for (const entry of page.entries)
        yield* blobFrames("snapshot", offer.transferId, entry, await replica.delivery.content(entry.blob));
    yield {
      schema: "fleet.snapshot.finish/v1",
      messageId: mid(offer.transferId, "finish"),
      transferId: offer.transferId,
      manifestDigest: offer.manifestDigest,
    };
    return;
  }
  const changes = offer.fromCut && (await replica.delivery.changes(offer.fromCut.revision, offer.toCut.revision));
  if (!offer.fromCut || !changes)
    throw new FleetFault("snapshot_required", "Adjacent replica changelog is outside retention.", true);
  yield {
    schema: "fleet.delta.begin/v1",
    messageId: mid(offer.transferId, "begin"),
    transferId: offer.transferId,
    repoId: offer.repoId,
    viewId: offer.viewId,
    fromCut: offer.fromCut,
    toCut: offer.toCut,
    changeCount: changes.count,
    resultManifestDigest: offer.manifestDigest,
    authorizationOwner: authorization.owner,
    authorizationShapeDigest: authorization.digest,
  };
  for (const page of changePages(changes))
    yield {
      schema: "fleet.delta.page/v1",
      messageId: mid(offer.transferId, `page${page.index}`),
      transferId: offer.transferId,
      pageIndex: page.index,
      changes: page.changes,
    };
  for (const page of changePages(changes))
    for (const change of page.changes)
      if (change.op === "put")
        yield* blobFrames(
          "delta",
          offer.transferId,
          { path: change.path, blob: change.blob },
          await replica.delivery.content(change.blob),
        );
  yield {
    schema: "fleet.delta.finish/v1",
    messageId: mid(offer.transferId, "finish"),
    transferId: offer.transferId,
    resultManifestDigest: offer.manifestDigest,
  };
}

function* changePages(sequence: ReplicaChanges) {
  let index = 0;
  let cursor: readonly [number, number] | null = null;
  for (;;) {
    const page = sequence.page(cursor);
    if (page.changes.length) yield { ...page, index: index++ };
    if (page.done) return;
    cursor = page.cursor;
  }
}

/** Page buffers are bounded; full reconciliation completes before any snapshot blob or finish. */
async function* manifestPages(replica: ReplicaCutSource, cut: SnapshotCut) {
  let digest = "0".repeat(64);
  let afterPath = "",
    count = 0,
    index = 0,
    totalBytes = 0;
  for (;;) {
    const page = await replica.delivery.manifestPage(cut.revision, afterPath);
    if (!page || (!page.done && page.entries.length === 0))
      throw new FleetFault("snapshot_required", "Replica cut manifest is unavailable or corrupt.", true);
    for (const entry of page.entries) {
      digest = updateReplicaManifestDigest(digest, entry);
      totalBytes += entry.blob.size;
      count += 1;
      afterPath = entry.path;
    }
    if (page.entries.length) yield { index: index++, entries: page.entries };
    if (page.done) {
      if (digest !== cut.manifest.digest || count !== cut.manifest.entryCount || totalBytes !== cut.manifest.totalBytes)
        throw new FleetFault("snapshot_required", "Replica cut manifest is unavailable or corrupt.", true);
      return;
    }
  }
}

export function* blobFrames(
  kind: "snapshot" | "delta",
  transferId: string,
  entry: FleetEntry,
  bytes: Uint8Array,
): Generator<FleetFrameV1> {
  const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < body.length; offset += FLEET_CHUNK_BYTES)
    yield {
      schema: `fleet.${kind}.chunk/v1`,
      messageId: mid(transferId, `chunk${offset}`),
      transferId,
      blobSha256: entry.blob.sha256,
      offset,
      dataBase64: body.subarray(offset, offset + FLEET_CHUNK_BYTES).toString("base64"),
    } as FleetFrameV1;
}

// Resource occupancy bound: the measured Windows first sync took 538s for 3.5GB / 380k entries.
// Thirty minutes allows about three times that duration, without extending the 30s delivery lease.
const REPLICA_DELIVERY_DEADLINE_MS = 30 * 60_000;

/** Owns one pinned offer until ACK, failure or expiry, including otherwise unobservable waits. */
export async function deliverReplicaOffer(input: {
  key: ReplicaDeliveryKey;
  replica: ReplicaCutSource;
  ackStore: ReplicaAckStore;
  window: SessionWindow;
  lifecycle: ReturnType<ReturnType<typeof createFleetDeliveryDrain>["admit"]>;
  signal: AbortSignal;
  connectionSignal: AbortSignal;
  quotaBytes: number;
  stateRoot: string;
  issuedAt: string;
  authorization: { owner: string; digest: string };
}): Promise<Delivery> {
  const { key, replica, ackStore, window, lifecycle } = input;
  const ttlMs = 30_000;
  const renewalFailure = new AbortController();
  const signal = AbortSignal.any([input.connectionSignal, renewalFailure.signal]);
  let lease: ReplicaDeliveryLease | undefined, offer: ReplicaOffer | undefined;
  let renewalTimer: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let preparing = true,
    awaitingAck = false,
    expiresAt = 0;
  let drainedAtRenewal = window.drainedBytes();
  const release = (acknowledged = false) => {
    clearInterval(renewalTimer);
    clearTimeout(deadline);
    if (lease) {
      ackStore.clearOffer(lease);
      ackStore.delivery.release(lease);
      if (!acknowledged) replica.releasePin(lease);
    }
    input.connectionSignal.removeEventListener("abort", disconnected);
    lifecycle.released();
  };
  const disconnected = () => release();
  const fail = (error: unknown) => {
    renewalFailure.abort(error);
    release();
  };
  const guard = () => {
    signal.throwIfAborted();
    if (!replica.pinActive(lease!))
      throw fenced(lease!, "Delivery", false, ackStore.delivery.inspect(lease!, Date.now()));
    const at = Date.now(),
      drained = window.drainedBytes();
    // Queuing a frame is not transport progress. An idle sender keeps the last expiry;
    // when it arrives the original conditional renewal supplies the fenced failure.
    if (!preparing && !awaitingAck && drained <= drainedAtRenewal && at < expiresAt) return;
    const renewal = ackStore.delivery.renew(lease!, at, ttlMs);
    if (!renewal.renewed) throw fenced(lease!, "Delivery", true, renewal.evidence);
    expiresAt = at + ttlMs;
    drainedAtRenewal = drained;
  };
  input.connectionSignal.addEventListener("abort", disconnected, { once: true });
  try {
    input.signal.throwIfAborted();
    const pinned = await replica.pin(
      key,
      window.holderId,
      ackStore.cursor(key)?.revision ?? null,
      input.quotaBytes,
      input.stateRoot,
    );
    lease = pinned.lease;
    expiresAt = lease.expiresAt;
    input.signal.throwIfAborted();
    deadline = setTimeout(
      () => fail(new FleetFault("replica_delivery_fenced", "Replica delivery deadline exceeded.")),
      REPLICA_DELIVERY_DEADLINE_MS,
    );
    renewalTimer = setInterval(() => {
      void Promise.resolve().then(guard).then(undefined, fail);
    }, ttlMs / 3);
    const prepared = await untilAborted(
      () => makeOffer(key, ackStore.cursor(key), pinned.cut, replica, input.issuedAt),
      AbortSignal.any([input.signal, signal]),
    );
    guard();
    ackStore.clearOffer(lease);
    offer = ackStore.offer(key, prepared);
  } catch (error) {
    lifecycle.sendingFinished();
    if (runtimeErrorCode(error) === "replica_delivery_busy")
      ackStore.delivery.record(key, { failureCode: "replica_delivery_busy" });
    release();
    throw error;
  } finally {
    preparing = false;
    lifecycle.preparationFinished();
  }
  window.offers.set(offer.transferId, { key, lease, renewalFailure: renewalFailure.signal, release });
  ackStore.delivery.record(key, { started: offer.kind });
  return {
    key: `${key.nodeId}\0${key.viewId}\0${key.repoId}`,
    signal,
    beforeSend: guard,
    onSent: (bytes) => ackStore.delivery.record(key, { bytes }),
    onComplete: () => {
      awaitingAck = true;
      lifecycle.sendingFinished();
    },
    onFailure: (error) => {
      lifecycle.sendingFinished();
      ackStore.delivery.record(key, { failureCode: runtimeErrorCode(error) ?? "replica_delivery_failed" });
      fail(error);
    },
    frames: (async function* () {
      // Preparation bounds admission only. Once pinned, center reads and transport share the
      // delivery deadline; a slow page must not spend the next request's budget rebuilding it.
      const iterator = offerFrames(offer, replica, input.authorization);
      for (;;) {
        preparing = true;
        let next;
        try {
          next = await untilAborted(() => iterator.next(), signal);
        } finally {
          preparing = false;
        }
        if (next.done) return;
        yield next.value;
      }
    })(),
  };
}
