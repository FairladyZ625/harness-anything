import { digestId, mid, wireCut } from "./center-transport.ts";
import { FleetFault } from "./center-types.ts";
import { FLEET_CHUNK_BYTES, type FleetCut, type FleetEntry, type FleetFrameV1 } from "./contract.ts";
import { type ReplicaAckStore, type ReplicaDeliveryKey, type ReplicaOffer } from "./replica-ack-store.ts";
import type { ReplicaCutSource, SnapshotCut } from "./replica-cut-store.ts";
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
    changeCount: changes.length,
    resultManifestDigest: offer.manifestDigest,
    authorizationOwner: authorization.owner,
    authorizationShapeDigest: authorization.digest,
  };
  for (let offset = 0; offset < changes.length; offset += 128)
    yield {
      schema: "fleet.delta.page/v1",
      messageId: mid(offer.transferId, `page${offset / 128}`),
      transferId: offer.transferId,
      pageIndex: offset / 128,
      changes: changes.slice(offset, offset + 128),
    };
  for (const change of changes)
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

/** Page buffers are bounded; full reconciliation completes before any snapshot blob or finish. */
async function* manifestPages(replica: ReplicaCutSource, cut: SnapshotCut) {
  let digest = "0".repeat(64);
  let offset = 0,
    index = 0,
    totalBytes = 0;
  for (;;) {
    const page = await replica.delivery.manifestPage(cut.revision, offset);
    if (!page || (!page.done && page.entries.length === 0))
      throw new FleetFault("snapshot_required", "Replica cut manifest is unavailable or corrupt.", true);
    for (const entry of page.entries) {
      digest = updateReplicaManifestDigest(digest, entry);
      totalBytes += entry.blob.size;
      offset += 1;
    }
    if (page.entries.length) yield { index: index++, entries: page.entries };
    if (page.done) {
      if (
        digest !== cut.manifest.digest ||
        offset !== cut.manifest.entryCount ||
        totalBytes !== cut.manifest.totalBytes
      )
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
