import { sha256Bytes } from "@harness-anything/kernel";
import { FLEET_CHUNK_BYTES, type FleetFrameV1, type FleetDescriptor } from "./command-protocol.ts";
import type { FleetEdgeChange } from "./peer.ts";

type FleetUploadSession = {
  readonly messageId: () => string;
  readonly request: (frame: FleetFrameV1) => Promise<FleetFrameV1>;
};
/**
 * Stage one change and return the claim descriptor the next frame references.
 *
 * The request id is part of the claim identity (`fleet.upload.begin/v1`). The default request id
 * is derived from the bytes, so an identical retry — including one from a process that restarted
 * after losing its reply — resumes the same claim and returns the same descriptor. That stability
 * is load-bearing for command uploads: the descriptor travels inside the command's declared
 * changes, and the center replays a command only when the whole intent, descriptor included,
 * identifies an event it has already stored.
 *
 * A caller whose bytes are attempt-scoped rather than command-scoped must pass its own request id.
 * Runtime result bodies are one such case: two dispatches can fail with the same message, and each
 * publish must own its claim.
 */
export async function uploadFleetChange(
  session: FleetUploadSession,
  repoId: string,
  input: FleetEdgeChange,
  opId?: string,
): Promise<FleetDescriptor> {
  const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body),
    content = {
      sha256: sha256Bytes(body),
      size: body.byteLength,
      mediaType: input.mediaType ?? (input.path.endsWith(".md") ? "text/markdown" : "text/plain"),
    },
    requestId =
      opId ??
      sha256Bytes(
        Buffer.from(["fleet-upload", content.sha256, String(content.size), content.mediaType].join("\0")),
      ).slice(0, 32),
    ready = await session.request({
      schema: "fleet.upload.begin/v1",
      messageId: session.messageId(),
      opId: requestId,
      repoId,
      content,
    });
  if (ready.schema !== "fleet.upload.ready/v1") throw new Error("upload ready expected");
  let offset = ready.resumeOffset;
  while (offset < body.length) {
    const response = await session.request({
      schema: "fleet.upload.chunk/v1",
      messageId: session.messageId(),
      opId: requestId,
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
    opId: requestId,
    uploadId: ready.uploadId,
  });
  if (uploaded.schema !== "fleet.upload.result/v1") throw new Error("upload result expected");
  return uploaded.descriptor;
}
