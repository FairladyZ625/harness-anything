import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { sha256Bytes, type CiDetailRef } from "@harness-anything/kernel";
import { readEdgeViewBlob } from "./runtime-result-read.ts";
import type { FleetMirrorView } from "./fleet-edge-mirror.ts";
import { openPeer, type FleetPeerOptions } from "./fleet/edge.ts";
import { writeFileDurably } from "./durable-file.ts";

type Descriptor = { eventId: string; ref: CiDetailRef };
export function edgeCiDetailDescriptors(viewRoot: string, view: FleetMirrorView): readonly Descriptor[] {
  return [...view.entries]
    .filter(([logical]) => logical.startsWith(".read-model/ci-details/"))
    .map(
      ([, blob]) =>
        JSON.parse(Buffer.from(readEdgeViewBlob(viewRoot, view, blob.sha256)).toString("utf8")) as Descriptor,
    );
}
function cachePath(view: FleetMirrorView, digest: string): string {
  return path.join(view.viewDir, "ci-detail-cache", digest);
}
export function readEdgeCiDetail(viewRoot: string, view: FleetMirrorView, digest: string): Uint8Array | null {
  const descriptor = edgeCiDetailDescriptors(viewRoot, view).find((row) => row.ref.sha256 === digest);
  if (!descriptor) throw new Error("CI detail is not in the authorized cut");
  const file = cachePath(view, digest);
  if (!existsSync(file)) return null;
  const bytes = readFileSync(file);
  if (bytes.byteLength !== descriptor.ref.encodedBytes || sha256Bytes(bytes) !== digest)
    throw new Error("CI detail cache is corrupt");
  return bytes;
}
export async function fetchEdgeCiDetails(input: {
  readonly peer: FleetPeerOptions;
  readonly viewRoot: string;
  readonly view: FleetMirrorView;
  readonly eventIds: readonly string[];
  readonly quotaBytes: number;
}): Promise<void> {
  const descriptors = edgeCiDetailDescriptors(input.viewRoot, input.view);
  const needed = input.eventIds
    .map((id) => {
      const row = descriptors.find((row) => row.eventId === id);
      if (!row) throw new Error(`CI observation ${id} is not in the authorized cut`);
      return row;
    })
    .filter((row) => !readEdgeCiDetail(input.viewRoot, input.view, row.ref.sha256));
  if (!needed.length) return;
  const usage = (root: string): number =>
    !existsSync(root)
      ? 0
      : statSync(root).isDirectory()
        ? readdirSync(root).reduce((sum, name) => sum + usage(path.join(root, name)), 0)
        : statSync(root).size;
  if (usage(input.viewRoot) + needed.reduce((sum, row) => sum + row.ref.encodedBytes, 0) > input.quotaBytes)
    throw new Error("replica_quota_exceeded: CI detail cache exceeds persistent quota");
  const session = await openPeer(input.peer);
  try {
    for (const row of needed) {
      const chunks: Buffer[] = [];
      let offset = 0;
      while (true) {
        const frame = await session.request({
          schema: "fleet.ci-detail.get/v1",
          messageId: session.messageId(),
          repoId: input.view.repoId,
          revision: input.view.revision,
          headDigest: input.view.headDigest,
          eventId: row.eventId,
          offset,
        });
        if (frame.schema !== "fleet.ci-detail.chunk/v1" || frame.eventId !== row.eventId || frame.offset !== offset)
          throw new Error("CI detail response does not match the requested observation");
        const bytes = Buffer.from(frame.dataBase64, "base64");
        chunks.push(bytes);
        offset += bytes.byteLength;
        if (offset > row.ref.encodedBytes) throw new Error("CI detail exceeds declared size");
        if (frame.done) break;
        if (!bytes.byteLength) throw new Error("CI detail reader did not advance");
      }
      const bytes = Buffer.concat(chunks);
      if (offset !== row.ref.encodedBytes || sha256Bytes(bytes) !== row.ref.sha256)
        throw new Error("CI detail bytes do not match the cut reference");
      writeFileDurably(cachePath(input.view, row.ref.sha256), bytes);
    }
  } finally {
    session.close();
  }
}
