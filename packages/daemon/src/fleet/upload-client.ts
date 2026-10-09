import { sha256Bytes } from "@harness-anything/kernel";
import { FLEET_CHUNK_BYTES, type FleetFrameV1, type FleetDescriptor } from "./contract.ts";
import type { FleetEdgeChange } from "./edge.ts";

type FleetUploadSession = {
  readonly messageId: () => string;
  readonly request: (frame: FleetFrameV1) => Promise<FleetFrameV1>;
};
export async function uploadFleetChange(
  session: FleetUploadSession,
  repoId: string,
  input: FleetEdgeChange,
): Promise<FleetDescriptor> {
  const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body),
    content = {
      sha256: sha256Bytes(body),
      size: body.byteLength,
      mediaType: input.mediaType ?? (input.path.endsWith(".md") ? "text/markdown" : "text/plain"),
    },
    ready = await session.request({
      schema: "fleet.upload.begin/v1",
      messageId: session.messageId(),
      repoId,
      content,
    });
  if (ready.schema !== "fleet.upload.ready/v1") throw new Error("upload ready expected");
  let offset = ready.resumeOffset;
  while (offset < body.length) {
    const response = await session.request({
      schema: "fleet.upload.chunk/v1",
      messageId: session.messageId(),
      uploadId: ready.uploadId,
      offset,
      dataBase64: body.subarray(offset, offset + FLEET_CHUNK_BYTES).toString("base64"),
    });
    if (response.schema !== "fleet.upload.ready/v1") throw new Error("chunk receipt expected");
    offset = response.resumeOffset;
  }
  const uploaded = await session.request({
    schema: "fleet.upload.finish/v1",
    messageId: session.messageId(),
    uploadId: ready.uploadId,
  });
  if (uploaded.schema !== "fleet.upload.result/v1") throw new Error("upload result expected");
  return uploaded.descriptor;
}
