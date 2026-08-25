import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { type TLSSocket } from "node:tls";
import { consumeKnownError, isContractVersionCompatible } from "../../../kernel/src/index.ts";
import { writeFileDurably } from "../durable-file.ts";
import type { Delivery, FleetCenterOptions, SessionWindow, State, Upload } from "./center-types.ts";
import { FleetFault } from "./center-types.ts";
import {
  FLEET_CHUNK_BYTES,
  FLEET_FRAME_BYTES,
  FLEET_KEY_SEND_WINDOW_BYTES,
  FLEET_SESSION_SEND_WINDOW_BYTES,
  currentFleetProtocolVersion,
  FleetUtf8LineDecoder,
  parseFleetFrame,
  serializeFleetFrame,
  type FleetCut,
  type FleetFrameV1,
} from "./contract.ts";
import type { SnapshotCut } from "./replica-cut-store.ts";

export async function serve(
  socket: TLSSocket,
  options: FleetCenterOptions,
  handle: (nodeId: string, frame: FleetFrameV1, window: SessionWindow, clientGone: () => boolean) => Promise<Delivery>,
): Promise<void> {
  let nodeId: string | null = null,
    pumping = false;
  const reader = new FleetUtf8LineDecoder(),
    window: SessionWindow = {
      uploads: new Set(),
      keys: new Set(),
      offers: new Map(),
    },
    jobs: Array<{
      delivery: Delivery;
      iterator: AsyncIterator<FleetFrameV1>;
      resolve: () => void;
      reject: (error: unknown) => void;
    }> = [],
    send = async (frame: FleetFrameV1) => {
      const line = serializeFleetFrame(frame),
        bytes = Buffer.byteLength(line);
      if (bytes > FLEET_KEY_SEND_WINDOW_BYTES) throw new FleetFault("busy", "Per-key send window is full.", true);
      if (socket.writableLength + bytes > FLEET_SESSION_SEND_WINDOW_BYTES)
        await new Promise<void>((resolve) => socket.once("drain", resolve));
      if (!socket.write(line)) await new Promise<void>((resolve) => socket.once("drain", resolve));
    },
    enqueue = (delivery: Delivery) =>
      new Promise<void>((resolve, reject) => {
        jobs.push({
          delivery,
          iterator: delivery.frames[Symbol.asyncIterator](),
          resolve,
          reject,
        });
        void pump();
      }),
    pump = async () => {
      if (pumping) return;
      pumping = true;
      try {
        while (jobs.length) {
          const job = jobs.shift()!;
          try {
            const next = await job.iterator.next();
            if (next.done) job.resolve();
            else {
              await send(next.value);
              jobs.push(job);
            }
          } catch (error) {
            consumeKnownError(error);
            job.reject(error);
          }
        }
      } finally {
        pumping = false;
      }
    };
  socket.on("data", (chunk) => {
    try {
      for (const line of reader.push(chunk)) void dispatch(line);
    } catch (error) {
      consumeKnownError(error);
      socket.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  socket.on("end", () => {
    try {
      reader.finish();
    } catch (error) {
      consumeKnownError(error);
      socket.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const dispatch = async (line: string) => {
    let frame: FleetFrameV1 | null = null;
    try {
      frame = parseFleetFrame(line);
      if (nodeId === null) {
        if (
          frame.schema !== "fleet.session.hello/v1" ||
          !isContractVersionCompatible(frame.protocolVersion, currentFleetProtocolVersion) ||
          !(await options.authenticate(frame.nodeId, frame.credential))
        )
          throw new FleetFault("authentication_failed", "Machine credential was rejected.");
        nodeId = frame.nodeId;
        return enqueue(
          immediate({
            schema: "fleet.session.ready/v1",
            messageId: mid(frame.messageId, "session"),
            inReplyTo: frame.messageId,
            sessionId: digestId(nodeId, String(Date.now())),
            maxFrameBytes: FLEET_FRAME_BYTES,
            chunkBytes: FLEET_CHUNK_BYTES,
          }),
        );
      }
      if (frame.schema === "fleet.session.hello/v1")
        throw new FleetFault("hello_replayed", "Session hello is only valid as the first frame.");
      if (options.isNodeActive && !(await options.isNodeActive(nodeId)))
        throw new FleetFault("credential_revoked", "Node credential was revoked.");
      await enqueue(await handle(nodeId, frame, window, () => socket.destroyed));
    } catch (error) {
      consumeKnownError(error);
      const fault =
        error instanceof FleetFault
          ? error
          : new FleetFault("invalid_frame", error instanceof Error ? error.message : String(error));
      await enqueue(
        immediate({
          schema: "fleet.error/v1",
          messageId: mid(frame?.messageId ?? "invalid", "error"),
          inReplyTo: frame?.messageId ?? "invalid",
          code: fault.code,
          retryable: fault.retryable,
          resumeOffset: fault.resumeOffset,
          nextAction: fault.message,
        }),
      );
      if (fault.code === "authentication_failed" || fault.code === "credential_revoked") socket.end();
    }
  };
}

export function immediate(frame: FleetFrameV1): Delivery {
  return {
    key: null,
    frames: (async function* () {
      yield frame;
    })(),
  };
}

export function loadState(file: string): State {
  if (!existsSync(file)) return { uploads: {} };
  const value = JSON.parse(readFileSync(file, "utf8")) as State & Record<string, unknown>;
  if (!value.uploads || Object.keys(value.uploads).length > 64 || "transfers" in value || "cursors" in value)
    throw new Error("Fleet durable state contains retired delivery state");
  return { uploads: value.uploads };
}

export function writeCenterDurableJson(file: string, value: unknown): void {
  writeFileDurably(file, `${JSON.stringify(value)}\n`);
}

export function ownedUpload(state: State, nodeId: string, uploadId: string): Upload {
  const upload = state.uploads[uploadId];
  if (!upload || upload.nodeId !== nodeId || upload.descriptor)
    throw new FleetFault("upload_unknown", "Upload is unknown, completed, or belongs to another node.");
  return upload;
}

export function wireCut(cut: SnapshotCut): FleetCut {
  return { revision: cut.revision, headDigest: cut.headDigest };
}

export function digestId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

export function mid(seed: string, suffix: string): string {
  return `${seed.slice(0, 64)}_${suffix}`.slice(0, 96);
}
