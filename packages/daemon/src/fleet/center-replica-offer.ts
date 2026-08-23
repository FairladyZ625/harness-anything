import { digestId, mid, wireCut } from "./center-transport.ts";
import { FleetFault } from "./center-types.ts";
import {
  FLEET_CHUNK_BYTES,
  fleetManifestDigest,
  type FleetCut,
  type FleetEntry,
  type FleetFrameV1,
} from "./contract.ts";
import { type ReplicaAckStore, type ReplicaDeliveryKey, type ReplicaOffer } from "./replica-ack-store.ts";
import type { ReplicaCutSource, SnapshotCut } from "./replica-cut-store.ts";

export function makeOffer(
  key: ReplicaDeliveryKey,
  cursor: ReturnType<ReplicaAckStore["cursor"]>,
  latest: SnapshotCut,
  replica: ReplicaCutSource,
  issuedAt: string,
): Omit<ReplicaOffer, keyof ReplicaDeliveryKey> {
  let fromCut: FleetCut | null = null,
    to = latest,
    kind: "snapshot" | "delta" = "snapshot";
  if (cursor) {
    const retained = replica.cut(cursor.revision),
      next = replica.cut(cursor.revision + 1);
    if (
      retained &&
      retained.headDigest === cursor.headDigest &&
      retained.manifest.digest === cursor.manifestDigest &&
      next &&
      replica.changes(cursor.revision, next.revision) !== null
    ) {
      fromCut = wireCut(retained);
      to = next;
      kind = "delta";
    }
  }
  const toCut = wireCut(to),
    manifestDigest = to.manifest.digest;
  return {
    transferId: digestId(
      key.nodeId,
      key.viewId,
      key.repoId,
      String(fromCut?.revision ?? 0),
      String(toCut.revision),
      manifestDigest,
    ),
    fromCut,
    toCut,
    manifestDigest,
    kind,
    issuedAt,
  };
}

export async function* offerFrames(offer: ReplicaOffer, replica: ReplicaCutSource): AsyncGenerator<FleetFrameV1> {
  const entries = replica.manifest(offer.toCut.revision);
  if (!entries || fleetManifestDigest(entries) !== offer.manifestDigest)
    throw new FleetFault("snapshot_required", "Replica cut manifest is unavailable or corrupt.", true);
  if (offer.kind === "snapshot") {
    yield {
      schema: "fleet.snapshot.begin/v1",
      messageId: mid(offer.transferId, "begin"),
      transferId: offer.transferId,
      repoId: offer.repoId,
      viewId: offer.viewId,
      cut: offer.toCut,
      manifest: {
        digest: offer.manifestDigest,
        entryCount: entries.length,
        totalBytes: entries.reduce((sum, entry) => sum + entry.blob.size, 0),
      },
    };
    for (let offset = 0; offset < entries.length; offset += 128)
      yield {
        schema: "fleet.snapshot.page/v1",
        messageId: mid(offer.transferId, `page${offset / 128}`),
        transferId: offer.transferId,
        pageIndex: offset / 128,
        entries: entries.slice(offset, offset + 128),
      };
    for (const entry of entries) yield* blobFrames("snapshot", offer.transferId, entry, replica.content(entry.blob));
    yield {
      schema: "fleet.snapshot.finish/v1",
      messageId: mid(offer.transferId, "finish"),
      transferId: offer.transferId,
      manifestDigest: offer.manifestDigest,
    };
    return;
  }
  const changes = offer.fromCut && replica.changes(offer.fromCut.revision, offer.toCut.revision);
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
        replica.content(change.blob),
      );
  yield {
    schema: "fleet.delta.finish/v1",
    messageId: mid(offer.transferId, "finish"),
    transferId: offer.transferId,
    resultManifestDigest: offer.manifestDigest,
  };
}

export function* blobFrames(
  kind: "snapshot" | "delta",
  transferId: string,
  entry: FleetEntry,
  bytes: Uint8Array,
): Generator<FleetFrameV1> {
  const body = Buffer.from(bytes);
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
